import type { Repo } from "../offline/db";
import type { SyncQueueItem } from "../offline/types";
import type { NetworkMonitor } from "../net/network";
import { ApiError, NetworkError, type ApiClient } from "./api";

export type SyncState = "idle" | "offline" | "syncing" | "error";
export interface SyncStatus {
  state: SyncState;
  pending: number;
  syncing: number;
  failed: number;
  /** Items completed during the current/last run (for "3 / 3 complete"). */
  done: number;
  total: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface SyncDeps {
  repo: Repo;
  api: Pick<ApiClient, "sync" | "myStats">;
  network: Pick<NetworkMonitor, "canUseNetwork">;
  now?: () => number;
  /** 0..1 jitter source (injectable for deterministic tests). */
  random?: () => number;
  onStatus?: (s: SyncStatus) => void;
}

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5 * 60_000;
const BATCH = 25;

export function backoffMs(attempts: number, random: () => number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempts);
  return Math.round(exp * (0.75 + random() * 0.5));
}

/**
 * Uploads the offline queue. Guarantees:
 *  - nothing is deleted because a request failed (retry with exponential backoff);
 *  - safe to re-send anything: the server is idempotent per (user, localId);
 *  - the server's verdict is applied item-by-item, so one bad record never blocks the rest.
 */
export class SyncEngine {
  private running = false;
  private status: SyncStatus = { state: "idle", pending: 0, syncing: 0, failed: 0, done: 0, total: 0, lastSyncAt: null, lastError: null };
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly d: SyncDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
  }

  getStatus(): SyncStatus { return this.status; }

  private async publish(patch: Partial<SyncStatus> = {}): Promise<void> {
    const c = await this.d.repo.queueCounts();
    this.status = { ...this.status, ...patch, pending: c.pending, syncing: c.syncing, failed: c.failed };
    this.d.onStatus?.(this.status);
  }

  async init(): Promise<void> {
    await this.d.repo.resetStuckSyncing();
    await this.d.repo.pruneSynced();
    const p = await this.d.repo.getProfile();
    await this.publish({ lastSyncAt: p.lastSyncAt ?? null, state: this.d.network.canUseNetwork ? "idle" : "offline" });
  }

  /** Runs until nothing is due. Re-entrant calls while a run is active are ignored. */
  async run(): Promise<SyncStatus> {
    if (this.running) return this.status;
    if (!this.d.network.canUseNetwork) {
      await this.publish({ state: "offline" });
      return this.status;
    }
    this.running = true;
    let done = 0;
    let total = 0;
    let retryReason: string | null = null;
    try {
      await this.d.repo.resetStuckSyncing();
      for (let guard = 0; guard < 200; guard++) {
        if (!this.d.network.canUseNetwork) break; // went offline / an offline game started mid-run
        const items = await this.d.repo.queueDue(this.now(), BATCH);
        if (items.length === 0) break;
        total += items.length;
        await this.d.repo.markSyncing(items.map((i) => i.id));
        await this.publish({ state: "syncing", done, total, lastError: null });
        const r = await this.sendBatch(items);
        done += r.finalised;
        if (r.retryReason) { retryReason = r.retryReason; break; } // retry later; don't hammer the server
        await this.publish({ state: "syncing", done, total });
      }
      if (retryReason) {
        await this.publish({ state: "error", lastError: retryReason, done, total });
      } else {
        const c = await this.d.repo.queueCounts();
        if (total > 0 && c.pending === 0) {
          const at = this.now();
          await this.d.repo.patchProfile({ lastSyncAt: at });
          await this.refreshOnlineStats();
          await this.publish({ state: "idle", lastSyncAt: at, lastError: null, done, total });
        } else {
          await this.publish({ state: this.d.network.canUseNetwork ? "idle" : "offline", done, total });
        }
      }
    } finally {
      this.running = false;
    }
    return this.status;
  }

  /** `finalised` = items that reached a final state (synced or permanently rejected). */
  private async sendBatch(items: SyncQueueItem[]): Promise<{ finalised: number; retryReason: string | null }> {
    let results;
    try {
      results = await this.d.api.sync(items.map((i) => ({ id: i.id, type: i.type, payload: i.payload })));
    } catch (e) {
      const reason = e instanceof NetworkError ? "Server unreachable" : e instanceof ApiError ? `${e.status} ${e.message}` : "Unexpected error";
      for (const it of items) {
        await this.d.repo.resolveItem(it.id, { kind: "retry", reason, nextAttemptAt: this.now() + backoffMs(it.attempts, this.random) });
      }
      return { finalised: 0, retryReason: reason };
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    let finalised = 0;
    let retryReason: string | null = null;
    for (const it of items) {
      const r = byId.get(it.id);
      if (r && (r.status === "synced" || r.status === "duplicate" || r.status === "stale")) {
        await this.d.repo.resolveItem(it.id, { kind: "synced" });
        finalised++;
      } else if (r && r.status === "rejected") {
        // The server will never accept this record; keep it visible instead of retrying forever.
        await this.d.repo.resolveItem(it.id, { kind: "failed", reason: r.reason ?? "Rejected by server" });
        finalised++;
      } else {
        retryReason = r?.reason ?? "No result from server";
        await this.d.repo.resolveItem(it.id, { kind: "retry", reason: retryReason, nextAttemptAt: this.now() + backoffMs(it.attempts, this.random) });
      }
    }
    return { finalised, retryReason };
  }

  private async refreshOnlineStats(): Promise<void> {
    try {
      const { stats } = await this.d.api.myStats();
      await this.d.repo.cacheOnlineStats(stats.online);
    } catch {
      /* best effort – display cache only */
    }
  }
}
