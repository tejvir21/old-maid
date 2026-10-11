import { randomUUID } from "node:crypto";
import {
  aiConfigFor, chooseMove, createGame, drawCard, getCurrentPlayer, newMemory, observeDraw, randomInt, totalCards, viewFor,
  type AiConfig, type AiLevel, type AiMemory, type AiMove, type Card, type DrawOutcome, type EngineErrorCode,
  type ErrorCode, type GameEvent, type GameState, type PublicEvent, type Rng,
} from "@old-maid/shared";

export interface SessionSeed {
  id: string;
  name: string;
  isAi: boolean;
  aiLevel?: AiLevel;
}

export type SessionDrawResult =
  | { ok: true; outcome: DrawOutcome }
  | { ok: false; code: ErrorCode; message: string };

const ENGINE_TO_API: Record<EngineErrorCode, ErrorCode> = {
  GAME_NOT_ACTIVE: "BAD_REQUEST",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  STALE_TURN: "STALE_TURN",
  UNKNOWN_PLAYER: "NOT_IN_ROOM",
  INVALID_TARGET: "INVALID_TARGET",
  TARGET_IS_SELF: "INVALID_TARGET",
  TARGET_EMPTY: "INVALID_TARGET",
  INVALID_CARD_INDEX: "INVALID_CARD",
};

const MAX_PUBLIC = 80;
const MAX_SEEN = 500;

/**
 * The server-side authoritative game. Owns the shared-engine state (deck, hands, Joker, turns).
 * Nothing in here is ever serialized to clients except through RoomManager.buildView().
 */
export class GameSession {
  readonly gameId = randomUUID();
  state: GameState;
  abandoned = false;
  readonly publicEvents: PublicEvent[] = [];
  readonly allEvents: GameEvent[] = [];
  private memories = new Map<string, AiMemory>();
  private aiConfigs = new Map<string, AiConfig>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];

  constructor(
    seeds: readonly SessionSeed[],
    private readonly rng: Rng,
    readonly startedAt: number,
    private readonly aiTuning: Partial<AiConfig> = {},
  ) {
    const created = createGame(
      seeds.map((s) => ({ id: s.id, name: s.name, kind: s.isAi ? ("ai" as const) : ("human" as const), ...(s.aiLevel ? { aiLevel: s.aiLevel } : {}) })),
      rng,
    );
    this.state = created.state;
    for (const s of seeds) if (s.isAi) this.takeOver(s.id, s.aiLevel ?? "normal");
    this.record(created.events);
  }

  /** Make a seat AI-controlled (AI fill, or a human who left mid-game). */
  takeOver(playerId: string, level: AiLevel): void {
    this.memories.set(playerId, newMemory());
    this.aiConfigs.set(playerId, aiConfigFor(level, this.aiTuning));
  }

  isAiControlled(playerId: string): boolean {
    return this.aiConfigs.has(playerId);
  }

  get finished(): boolean {
    return this.state.phase === "finished" || this.abandoned;
  }
  get currentPlayerId(): string {
    return getCurrentPlayer(this.state).id;
  }
  get turnId(): number {
    return this.state.turnId;
  }
  get cardsRemaining(): number {
    return totalCards(this.state);
  }
  get winnerId(): string | null {
    return this.abandoned ? null : this.state.winnerId;
  }

  hand(playerId: string): Card[] {
    return (this.state.players.find((p) => p.id === playerId)?.hand ?? []).map((c) => ({ ...c }));
  }
  cardCount(playerId: string): number {
    return this.state.players.find((p) => p.id === playerId)?.hand.length ?? 0;
  }
  hasPlayer(playerId: string): boolean {
    return this.state.players.some((p) => p.id === playerId);
  }

  private record(events: GameEvent[]): void {
    for (const e of events) {
      this.allEvents.push(e);
      this.publicEvents.push({
        seq: e.seq, text: e.text, type: e.type,
        ...(e.actorId ? { actorId: e.actorId } : {}), ...(e.targetId ? { targetId: e.targetId } : {}),
      });
    }
    if (this.publicEvents.length > MAX_PUBLIC) this.publicEvents.splice(0, this.publicEvents.length - MAX_PUBLIC);
  }

  applyDraw(req: { actorId: string; targetId: string; cardIndex: number; turnId: number; actionId: string }): SessionDrawResult {
    if (this.abandoned) return { ok: false, code: "BAD_REQUEST", message: "The game is over." };
    const key = `${req.actorId}:${req.actionId}`;
    if (this.seen.has(key)) return { ok: false, code: "DUPLICATE_ACTION", message: "That action was already processed." };

    const r = drawCard(this.state, { actorId: req.actorId, targetId: req.targetId, cardIndex: req.cardIndex, turnId: req.turnId });
    if (!r.ok) return { ok: false, code: ENGINE_TO_API[r.error], message: r.message };

    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > MAX_SEEN) this.seen.delete(this.seenOrder.shift() as string);

    const { state, events, result } = r.value;
    this.state = state;
    this.record(events);

    // Each AI observes only what it is entitled to see (public event + cards it personally touched).
    const ev = events.find((e) => e.type === "card_drawn");
    if (ev) {
      for (const [aiId, mem] of this.memories) {
        const own = aiId === result.actorId || aiId === result.targetId ? result.card : undefined;
        this.memories.set(aiId, observeDraw(mem, aiId, ev, own));
      }
    }
    return { ok: true, outcome: r.value };
  }

  /**
   * Marks that the server (not the player) is about to act because the turn timer expired.
   * Public text only; recorded as TIMEOUT_AUTO_DRAW when events are persisted.
   */
  noteTimeoutAutoDraw(playerId: string): void {
    const p = this.state.players.find((x) => x.id === playerId);
    this.state.eventSeq += 1;
    this.record([{ seq: this.state.eventSeq, turnId: this.state.turnId, type: "timeout_auto_draw", actorId: playerId, text: `${p?.name ?? "A player"} ran out of time.` }]);
  }

  /** Move chosen by the AI controlling `playerId`. */
  aiMove(playerId: string): AiMove {
    const cfg = this.aiConfigs.get(playerId);
    if (!cfg) throw new Error("Not an AI-controlled player");
    return chooseMove(viewFor(this.state, playerId), this.memories.get(playerId) ?? newMemory(), cfg, this.rng);
  }

  /** Random legal move – used when a connected human runs out of time. */
  randomMove(playerId: string): AiMove {
    const targets = this.state.players.filter((p) => p.id !== playerId && p.hand.length > 0);
    if (targets.length === 0) throw new Error("No legal target");
    const t = targets[randomInt(this.rng, targets.length)] as GameState["players"][number];
    return { targetId: t.id, cardIndex: randomInt(this.rng, t.hand.length) };
  }

  abandon(): void {
    this.abandoned = true;
  }
}
