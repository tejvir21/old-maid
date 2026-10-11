import { seededRng } from "@old-maid/shared";
import { OfflineSession, type SessionUpdate } from "../src/game/offlineSession";
import { HUMAN_ID } from "../src/game/offlineGame";
import type { Scheduler } from "../src/net/scheduler";
import { openDatabase, Repo } from "../src/offline/db";

export class ManualScheduler implements Scheduler {
  private t = Date.now() - 3_600_000; // real-ish clock so the server's age checks pass
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(h: unknown) { this.timers.delete(h as number); }
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = target;
  }
}

let n = 0;
export const uniqueDb = () => `om-test-${Date.now()}-${n++}`;

export async function makeSession(dbName = uniqueDb(), seed = 11, scheduler = new ManualScheduler()) {
  const db = await openDatabase(dbName);
  const repo = new Repo(db, () => scheduler.now());
  const updates: SessionUpdate[] = [];
  const session = new OfflineSession({ repo, scheduler, rng: seededRng(seed), aiDelay: () => 1000, onUpdate: (u) => updates.push(u) });
  return { dbName, db, repo, scheduler, session, updates };
}

/** Plays the human's turns with a legal move until the game ends. */
export async function playOut(ctx: Awaited<ReturnType<typeof makeSession>>, maxSteps = 5000) {
  const { session, scheduler } = ctx;
  for (let i = 0; i < maxSteps; i++) {
    const g = session.current;
    if (!g || g.finished) return;
    if (g.isHumanTurn) {
      const t = g.state.players.find((p) => p.id !== HUMAN_ID && p.hand.length > 0)!;
      const r = await session.humanDraw(t.id, 0);
      if (!r.ok) throw new Error(r.message);
    } else {
      scheduler.advance(1001);
      await session.idle();
    }
  }
  throw new Error("game did not finish");
}

/**
 * Real timers running `speed`× faster, with a virtual clock that advances at the same rate.
 * Lets tests play a "real-paced" game (AI thinks ~1s) in milliseconds while the recorded
 * durations stay realistic – exactly what the server's plausibility checks expect.
 */
export class TimeWarpScheduler implements Scheduler {
  private readonly t0 = Date.now();
  constructor(private readonly speed = 200, private readonly base = Date.now() - 3_600_000) {}
  now() { return this.base + (Date.now() - this.t0) * this.speed; }
  setTimeout(fn: () => void, ms: number) { return setTimeout(fn, Math.max(0, ms / this.speed)); }
  clearTimeout(h: unknown) { clearTimeout(h as ReturnType<typeof setTimeout>); }
}
