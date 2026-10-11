import { aiConfigFor, type Rng } from "@old-maid/shared";
import type { FinishResult, Repo } from "../offline/db";
import { newId } from "../offline/ids";
import type { OfflineGameRecord } from "../offline/types";
import type { Scheduler } from "../net/scheduler";
import { OfflineGame, type AiStepResult, type Failure, type HumanDrawResult, type OfflineConfig, type OfflineSnapshot } from "./offlineGame";

export interface SessionUpdate {
  game: OfflineGame | null;
  thinking: boolean;
  humanDraw?: HumanDrawResult;
  aiStep?: AiStepResult;
  finished?: { record: OfflineGameRecord; newAchievements: string[] };
}

export interface OfflineSessionDeps {
  repo: Repo;
  scheduler: Scheduler;
  rng: Rng;
  /** Thinking delay for an AI move in ms. Defaults to the AI preset's 800–1500ms window. */
  aiDelay?: (level: OfflineConfig["level"]) => number;
  onUpdate: (u: SessionUpdate) => void;
}

/**
 * Drives an offline game: schedules AI turns, persists to IndexedDB after EVERY state change
 * (so a closed tab/browser can resume), and atomically records the result when the game ends.
 * No network access happens anywhere in here.
 */
export class OfflineSession {
  private game: OfflineGame | null = null;
  private timer: unknown = null;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private finishing = false;
  private inflight: Promise<void> | null = null;
  private failure: unknown = null;
  private held = false;

  constructor(private readonly d: OfflineSessionDeps) {}

  get current(): OfflineGame | null { return this.game; }

  private delay(level: OfflineConfig["level"]): number {
    if (this.d.aiDelay) return this.d.aiDelay(level);
    const c = aiConfigFor(level);
    return c.delayMinMs + Math.floor(this.d.rng() * (c.delayMaxMs - c.delayMinMs + 1));
  }

  private persist(): Promise<unknown> {
    const g = this.game;
    if (!g || g.finished) return this.chain;
    const snap = g.toSnapshot();
    this.chain = this.chain.then(() => this.d.repo.saveActive(snap.localGameId, snap));
    return this.chain;
  }

  /** `hold`: create the game but don't let AIs move until release() (used by the intro sequence). */
  async start(config: OfflineConfig, opts: { hold?: boolean } = {}): Promise<void> {
    this.held = opts.hold === true;
    this.disposed = false;
    this.failure = null;
    this.cancelTimer();
    this.finishing = false;
    this.game = OfflineGame.create(config, this.d.rng, this.d.scheduler.now(), newId());
    await this.persist();
    this.emit({});
    this.next();
  }

  /** Re-open a game that was in progress when the app/browser was closed. */
  async resume(): Promise<boolean> {
    this.held = false;
    const saved = await this.d.repo.loadActive<OfflineSnapshot>();
    if (!saved || saved.snapshot.version !== 1) return false;
    this.disposed = false;
    this.failure = null;
    this.cancelTimer();
    this.finishing = false;
    this.game = OfflineGame.restore(saved.snapshot, this.d.rng, this.d.scheduler.now());
    if (this.game.finished) {
      await this.finalize();
      return true;
    }
    this.emit({});
    this.next();
    return true;
  }

  async humanDraw(targetId: string, cardIndex: number): Promise<HumanDrawResult | Failure> {
    const g = this.game;
    if (!g || this.disposed) return { ok: false, error: "GAME_NOT_ACTIVE", message: "No game." };
    if (!g.isHumanTurn || this.timer) return { ok: false, error: "NOT_YOUR_TURN", message: "Not your turn." };
    const r = g.humanDraw(targetId, cardIndex, this.d.scheduler.now());
    if (!r.ok) return r;
    await this.persist();
    this.emit({ humanDraw: r });
    if (g.finished) await this.finalize();
    else this.next();
    return r;
  }

  /** Throw the in-progress game away without recording a result. */
  async abandon(): Promise<void> {
    this.cancelTimer();
    this.game = null;
    await this.chain;
    await this.d.repo.clearActive();
    this.emit({});
  }

  /** Resolves when no AI move / persistence is in flight (rethrows an AI failure). */
  async idle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await this.inflight;
      await this.chain;
    }
    if (this.failure) throw this.failure;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer) this.d.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  private emit(extra: Partial<SessionUpdate>): void {
    this.d.onUpdate({ game: this.game, thinking: this.timer !== null, ...extra });
  }

  release(): void {
    this.held = false;
    this.next();
  }

  private next(): void {
    const g = this.game;
    if (!g || g.finished || this.disposed || this.held) return;
    if (g.isHumanTurn) {
      this.emit({});
      return;
    }
    this.timer = this.d.scheduler.setTimeout(() => {
      this.inflight = this.runAi().catch((e: unknown) => { this.failure = e; });
    }, this.delay(g.config.level));
    this.emit({});
  }

  private async runAi(): Promise<void> {
    this.timer = null;
    const g = this.game;
    if (!g || g.finished || this.disposed || g.isHumanTurn) return;
    const r = g.aiStep(this.d.scheduler.now());
    if (!r.ok) throw new Error(`AI produced an illegal move: ${r.error}`);
    await this.persist();
    this.emit({ aiStep: r });
    if (g.finished) await this.finalize();
    else this.next();
  }

  private async finalize(): Promise<void> {
    const g = this.game;
    if (!g || !g.finished || this.finishing) return;
    this.finishing = true;
    await this.chain;
    const record = g.toRecord(this.d.scheduler.now());
    const res: FinishResult = await this.d.repo.finishOfflineGame(record, g.storedEvents());
    this.emit({ finished: { record, newAchievements: res.newAchievements } });
  }
}
