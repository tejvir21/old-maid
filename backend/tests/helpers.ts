import { seededRng, type PlayerView, type ServerToClientEvents } from "@old-maid/shared";
import { RoomManager } from "../src/rooms/roomManager.js";
import type { Emitter, EventArgs, Timing } from "../src/rooms/roomTypes.js";
import { SettingsService } from "../src/services/settingsService.js";
import { MemoryActiveStateStore, MemoryStore } from "../src/store/memory.js";
import { silentLogger } from "../src/util/logger.js";
import type { Scheduler } from "../src/util/scheduler.js";

export class ManualScheduler implements Scheduler {
  private t = 1_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown) { this.timers.delete(h as number); }
  get pending() { return this.timers.size; }
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

export interface Sent { to: string; event: string; args: unknown[] }
export class FakeEmitter implements Emitter {
  sent: Sent[] = [];
  emit<K extends keyof ServerToClientEvents>(playerId: string, event: K, ...args: EventArgs<K>): void {
    this.sent.push({ to: playerId, event, args: structuredClone(args) });
  }
  for(playerId: string, event?: string) { return this.sent.filter((s) => s.to === playerId && (!event || s.event === event)); }
  last(playerId: string, event: string) { return this.for(playerId, event).at(-1)?.args[0]; }
  lastView(playerId: string): PlayerView | undefined { return this.last(playerId, "room_state") as PlayerView | undefined; }
  clear() { this.sent = []; }
}

export async function makeManager(opts: { timing?: Partial<Timing>; seed?: number; codes?: string[] } = {}) {
  const store = new MemoryStore();
  const settings = new SettingsService(store, silentLogger);
  await settings.load();
  const emitter = new FakeEmitter();
  const scheduler = new ManualScheduler();
  const codes = opts.codes ? [...opts.codes] : null;
  let n = 0;
  const mgr = new RoomManager({
    store, active: new MemoryActiveStateStore(), settings, log: silentLogger, emitter, scheduler,
    rng: seededRng(opts.seed ?? 7),
    codeGen: () => (codes?.shift() ?? `ROOM${(n++).toString(36).toUpperCase()}`.slice(0, 5).padEnd(5, "X")),
    ...(opts.timing ? { timing: opts.timing } : {}),
  });
  return { mgr, store, settings, emitter, scheduler };
}

/**
 * Pick any legal move for `playerId`.
 *
 * Draws now travel as opaque, server-minted slots. The test peeks at the room's slot table to
 * obtain a real one (that table is server-side state, exactly as it is in production) so the
 * rest of the suite exercises the genuine request path rather than a shortcut.
 */
export function legalDraw(mgr: RoomManager, code: string, playerId: string, actionId: string) {
  const s = mgr._debugSession(code);
  if (!s) throw new Error("no session");
  const target = s.state.players.find((p) => p.id !== playerId && p.hand.length > 0);
  if (!target) throw new Error("no target");
  const slots = mgr._debugSlots(code);
  const slotId = slots?.targets.get(target.id)?.keys().next().value;
  if (!slotId) throw new Error("no slot issued for the acting player");
  return { targetPlayerId: target.id, slotId, turnId: s.turnId, actionId };
}

export const CARD_LEAK = /"isJoker"|"rank"|"suit"/;
