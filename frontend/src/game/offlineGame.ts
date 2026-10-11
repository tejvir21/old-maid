import {
  aiConfigFor, cardLabel, chooseMove, createGame, drawCard, newMemory, observeDraw, viewFor,
  type AiLevel, type AiMemory, type Card, type EngineErrorCode, type GameEvent, type GameState, type Rng,
} from "@old-maid/shared";
import type { OfflineGameRecord, StoredEvent } from "../offline/types";

export const HUMAN_ID = "human";
const AI_NAMES = ["Akira", "Ken", "Yuna", "Haru", "Sora", "Mika"];

export interface OfflineConfig {
  humanName: string;
  aiCount: number;
  level: AiLevel;
  localPlayerId: string;
}
export interface LogLine { id: number; text: string; kind: "public" | "private" | "system" }

export interface OfflineSnapshot {
  version: 1;
  localGameId: string;
  config: OfflineConfig;
  startedAt: number;
  activeMs: number;
  lastActionAt: number;
  state: GameState;
  memories: Record<string, AiMemory>;
  log: LogLine[];
  logSeq: number;
  storedEvents: { seq: number; text: string; type: string }[];
}

export interface HumanDrawResult {
  ok: true;
  card: Card;
  pairFormed: boolean;
  pairCards: [Card, Card] | null;
  targetId: string;
  gameOver: boolean;
}
export interface AiStepResult {
  ok: true;
  actorId: string;
  targetId: string;
  pairFormed: boolean;
  gameOver: boolean;
  /** A deliberately unreliable "tell": fires for Joker draws most of the time, and as a decoy otherwise. */
  reaction: boolean;
}
export type Failure = { ok: false; error: EngineErrorCode; message: string };

const MAX_STEP_MS = 120_000;
const MAX_LOG = 60;

/**
 * Pure (React-free, network-free) offline game. Uses the shared engine locally; the client is
 * authoritative here by design. It never imports fetch/socket code.
 */
export class OfflineGame {
  private snap: OfflineSnapshot;
  private memories: Map<string, AiMemory>;

  private constructor(snap: OfflineSnapshot, private readonly rng: Rng) {
    this.snap = snap;
    this.memories = new Map(Object.entries(snap.memories));
  }

  static create(config: OfflineConfig, rng: Rng, now: number, localGameId: string): OfflineGame {
    if (config.aiCount < 1 || config.aiCount > 6) throw new RangeError("aiCount must be 1–6");
    const used = new Set([config.humanName.toLowerCase()]);
    const pool = AI_NAMES.filter((n) => !used.has(n.toLowerCase()));
    const seeds = [
      { id: HUMAN_ID, name: config.humanName, kind: "human" as const },
      ...Array.from({ length: config.aiCount }, (_, i) => ({ id: `ai-${i}`, name: pool[i] ?? `Bot ${i + 1}`, kind: "ai" as const, aiLevel: config.level })),
    ];
    const { state, events } = createGame(seeds, rng);
    const memories: Record<string, AiMemory> = {};
    for (const s of seeds) if (s.kind === "ai") memories[s.id] = newMemory();
    const g = new OfflineGame(
      { version: 1, localGameId, config, startedAt: now, activeMs: 0, lastActionAt: now, state, memories, log: [], logSeq: 0, storedEvents: [] },
      rng,
    );
    g.ingest(events);
    g.say("The game begins.", "system");
    const mine = events.find((e) => e.type === "initial_pairs" && e.actorId === HUMAN_ID);
    if (mine) g.say(mine.text.replace(`${config.humanName} discarded`, "You discarded"), "private");
    g.say("Whoever holds the Joker at the end wins.", "system");
    return g;
  }

  static restore(snapshot: OfflineSnapshot, rng: Rng, now: number): OfflineGame {
    const g = new OfflineGame(structuredClone(snapshot), rng);
    g.snap.lastActionAt = now; // time the app was closed does not count as play time
    return g;
  }

  toSnapshot(): OfflineSnapshot {
    this.snap.memories = Object.fromEntries(this.memories);
    return structuredClone(this.snap);
  }

  /* ---------- read model ---------- */
  get localGameId(): string { return this.snap.localGameId; }
  get state(): GameState { return this.snap.state; }
  get config(): OfflineConfig { return this.snap.config; }
  get log(): readonly LogLine[] { return this.snap.log; }
  get finished(): boolean { return this.snap.state.phase === "finished"; }
  get winnerId(): string | null { return this.snap.state.winnerId; }
  get humanWon(): boolean { return this.finished && this.winnerId === HUMAN_ID; }
  get currentPlayerId(): string { return this.snap.state.players[this.snap.state.currentPlayerIndex]!.id; }
  get isHumanTurn(): boolean { return !this.finished && this.currentPlayerId === HUMAN_ID; }
  get cardsRemaining(): number { return this.snap.state.players.reduce((n, p) => n + p.hand.length, 0); }
  get playerCount(): number { return this.snap.state.players.length; }
  hand(id: string): Card[] { return this.snap.state.players.find((p) => p.id === id)?.hand.map((c) => ({ ...c })) ?? []; }
  name(id: string): string { return this.snap.state.players.find((p) => p.id === id)?.name ?? id; }

  /* ---------- internals ---------- */
  private say(text: string, kind: LogLine["kind"]): void {
    this.snap.logSeq += 1;
    this.snap.log.push({ id: this.snap.logSeq, text, kind });
    if (this.snap.log.length > MAX_LOG) this.snap.log.splice(0, this.snap.log.length - MAX_LOG);
  }
  private ingest(events: GameEvent[]): void {
    for (const e of events) this.snap.storedEvents.push({ seq: e.seq, text: e.text, type: e.type });
  }
  private tick(now: number): void {
    this.snap.activeMs += Math.max(0, Math.min(now - this.snap.lastActionAt, MAX_STEP_MS));
    this.snap.lastActionAt = now;
  }
  private observe(events: GameEvent[], actorId: string, targetId: string, card: Card): void {
    const ev = events.find((e) => e.type === "card_drawn");
    if (!ev) return;
    for (const [aiId, mem] of this.memories) {
      // An AI only ever learns the card identity if it was the one holding or receiving it.
      const own = aiId === actorId || aiId === targetId ? card : undefined;
      this.memories.set(aiId, observeDraw(mem, aiId, ev, own));
    }
  }

  /* ---------- actions ---------- */
  humanDraw(targetId: string, cardIndex: number, now: number): HumanDrawResult | Failure {
    const r = drawCard(this.snap.state, { actorId: HUMAN_ID, targetId, cardIndex, turnId: this.snap.state.turnId });
    if (!r.ok) return { ok: false, error: r.error, message: r.message };
    const { state, events, result } = r.value;
    this.snap.state = state;
    this.ingest(events);
    this.observe(events, HUMAN_ID, targetId, result.card);
    this.tick(now);
    this.say(`You drew ${cardLabel(result.card)} from ${this.name(targetId)}.`, "private");
    if (result.pairFormed && result.pairCards) this.say(`Pair: ${cardLabel(result.pairCards[0])} + ${cardLabel(result.pairCards[1])} discarded.`, "private");
    else if (result.card.isJoker) this.say("The Joker. Keep it.", "private");
    if (result.gameOver) this.say("One card remains.", "system");
    return { ok: true, card: result.card, pairFormed: result.pairFormed, pairCards: result.pairCards, targetId, gameOver: result.gameOver };
  }

  aiStep(now: number): AiStepResult | Failure {
    const state = this.snap.state;
    const actor = state.players[state.currentPlayerIndex]!;
    if (actor.id === HUMAN_ID || state.phase !== "playing") return { ok: false, error: "NOT_YOUR_TURN", message: "Not an AI turn." };
    const cfg = aiConfigFor(this.snap.config.level);
    const mv = chooseMove(viewFor(state, actor.id), this.memories.get(actor.id) ?? newMemory(), cfg, this.rng);
    const r = drawCard(state, { actorId: actor.id, targetId: mv.targetId, cardIndex: mv.cardIndex, turnId: state.turnId });
    if (!r.ok) return { ok: false, error: r.error, message: r.message };
    const { state: next, events, result } = r.value;
    this.snap.state = next;
    this.ingest(events);
    this.observe(events, actor.id, mv.targetId, result.card);
    this.tick(now);

    if (mv.targetId === HUMAN_ID) {
      this.say(`${actor.name} took your ${cardLabel(result.card)}.`, "private");
    } else {
      this.say(`${actor.name} drew a card from ${this.name(mv.targetId)}.`, "public");
    }
    if (result.pairFormed) this.say(`${actor.name} formed a pair and discarded it.`, "public");
    const reaction = this.rng() < (result.card.isJoker ? 0.7 : 0.2);
    if (reaction) this.say(`${actor.name} pauses.`, "public");
    if (result.gameOver) this.say("One card remains.", "system");
    return { ok: true, actorId: actor.id, targetId: mv.targetId, pairFormed: result.pairFormed, gameOver: result.gameOver, reaction };
  }

  toRecord(now: number): OfflineGameRecord {
    if (!this.finished) throw new Error("Game is not finished");
    this.tick(now);
    const span = Math.max(0, now - this.snap.startedAt);
    return {
      localGameId: this.snap.localGameId,
      startedAt: this.snap.startedAt,
      finishedAt: now,
      mode: "offline-ai",
      playerId: this.snap.config.localPlayerId,
      playerCount: this.playerCount,
      aiDifficulty: this.snap.config.level,
      result: this.humanWon ? "win" : "loss",
      durationSeconds: Math.max(1, Math.ceil(Math.min(this.snap.activeMs, span) / 1000)),
      turnCount: this.snap.state.drawCount,
      syncStatus: "pending",
    };
  }

  storedEvents(): StoredEvent[] {
    return this.snap.storedEvents.map((e) => ({ localGameId: this.snap.localGameId, ...e }));
  }
}
