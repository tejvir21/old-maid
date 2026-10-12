import { secureRng, type Rng } from "@old-maid/shared";
import { OfflineSession, type SessionUpdate } from "../game/offlineSession";
import type { OfflineConfig } from "../game/offlineGame";
import { NetworkMonitor, type NetSnapshot } from "../net/network";
import { realScheduler, type Scheduler } from "../net/scheduler";
import { openDatabase, Repo } from "../offline/db";
import { createOnlineController, type OnlineController } from "../store/onlineStore";
import { ApiClient } from "../sync/api";
import { SyncEngine, type SyncStatus } from "../sync/syncEngine";

export interface ServicesOptions {
  apiUrl: string;
  socketUrl: string;
  dbName?: string;
  scheduler?: Scheduler;
  rng?: Rng;
  isBrowserOnline?: () => boolean;
  listen?: (onUp: () => void, onDown: () => void) => () => void;
  fetchImpl?: typeof fetch;
  aiDelay?: (level: OfflineConfig["level"]) => number;
  transports?: string[];
  onOfflineUpdate?: (u: SessionUpdate) => void;
  onNet?: (s: NetSnapshot) => void;
  onSync?: (s: SyncStatus) => void;
}

const GATE = "offline-game";

/**
 * Composition root for the client. Wires:
 *   shared engine → OfflineSession → IndexedDB → SyncEngine → API
 *                                 └→ NetworkMonitor gate (no requests during an offline game)
 *   OnlineController → Socket.IO (server-authoritative)
 */
export class AppServices {
  readonly repo: Repo;
  readonly api: ApiClient;
  readonly net: NetworkMonitor;
  readonly sync: SyncEngine;
  readonly offline: OfflineSession;
  readonly online: OnlineController;
  private inOfflineGame = false;

  private constructor(repo: Repo, readonly opts: ServicesOptions) {
    const scheduler = opts.scheduler ?? realScheduler;
    this.repo = repo;
    this.api = new ApiClient({ baseUrl: opts.apiUrl, repo, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    this.net = new NetworkMonitor({
      isBrowserOnline: opts.isBrowserOnline ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine)),
      // Layered probe: a blocked /health must not be mistaken for a dead backend.
      probe: () => this.api.probe(),
      scheduler,
      ...(opts.listen ? { listen: opts.listen } : {}),
    });
    this.sync = new SyncEngine({ repo, api: this.api, network: this.net, now: () => scheduler.now(), ...(opts.onSync ? { onStatus: opts.onSync } : {}) });
    this.offline = new OfflineSession({
      repo, scheduler, rng: opts.rng ?? secureRng, ...(opts.aiDelay ? { aiDelay: opts.aiDelay } : {}),
      onUpdate: (u) => {
        opts.onOfflineUpdate?.(u);
        if (u.finished) this.onOfflineFinished();
      },
    });
    this.online = createOnlineController({
      url: opts.socketUrl, getToken: (force) => this.api.ensureToken(force),
      // Frontend and backend deploy independently; refuse to play against a mismatched server.
      checkProtocol: () => this.api.isProtocolSkewed(),
      ...(opts.transports ? { transports: opts.transports } : {}),
    });
    if (opts.onNet) this.net.subscribe(opts.onNet);
    // Connectivity came back → push the queue.
    this.net.onReconnect(() => void this.sync.run());
  }

  static async create(opts: ServicesOptions): Promise<AppServices> {
    const db = await openDatabase(opts.dbName ?? "old-maid");
    const s = new AppServices(new Repo(db, () => (opts.scheduler ?? realScheduler).now()), opts);
    await s.sync.init();
    return s;
  }

  /** Start background connectivity checks + a first sync attempt. */
  start(): void {
    this.net.start();
  }
  stop(): void {
    this.net.stop();
  }

  /** Offline play: sockets closed, background network paused, everything local. */
  async startOffline(config: OfflineConfig, opts: { hold?: boolean } = {}): Promise<void> {
    this.beginGate();
    await this.offline.start(config, opts);
  }
  async resumeOffline(): Promise<boolean> {
    this.beginGate();
    const ok = await this.offline.resume();
    if (!ok) this.endGate();
    return ok;
  }
  async hasActiveOffline(): Promise<boolean> {
    return (await this.repo.loadActive()) !== null;
  }
  /** Leave the offline screen (keeps an unfinished game saved so it can be resumed). */
  leaveOffline(): void {
    this.offline.dispose();
    this.endGate();
  }

  private beginGate(): void {
    if (this.inOfflineGame) return;
    this.inOfflineGame = true;
    this.online.disconnect();
    this.net.suspend(GATE);
  }
  private endGate(): void {
    if (!this.inOfflineGame) return;
    this.inOfflineGame = false;
    this.net.resume(GATE); // → probes, fires onReconnect → sync.run()
  }

  /** Game over: the result is already safely in IndexedDB + the queue; let the network back in. */
  private onOfflineFinished(): void {
    this.endGate();
    void this.sync.run();
  }
}
