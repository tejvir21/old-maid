import { randomInt } from "./rng.js";
import type { AiLevel, Card, GameEvent, GameState, Rng } from "./types.js";

/** Tunable AI parameters (also editable by admins). All values 0..1 except delay. */
export interface AiConfig {
  level: AiLevel;
  aggressiveness: number;
  memory: number;
  /** Min/max "thinking" delay in ms. */
  delayMinMs: number;
  delayMaxMs: number;
}

export const AI_PRESETS: Record<AiLevel, AiConfig> = {
  easy: { level: "easy", aggressiveness: 0.15, memory: 0.1, delayMinMs: 800, delayMaxMs: 1500 },
  normal: { level: "normal", aggressiveness: 0.5, memory: 0.6, delayMinMs: 800, delayMaxMs: 1500 },
  hard: { level: "hard", aggressiveness: 0.85, memory: 0.95, delayMinMs: 800, delayMaxMs: 1500 },
};

export function aiConfigFor(level: AiLevel, overrides: Partial<AiConfig> = {}): AiConfig {
  return { ...AI_PRESETS[level], ...overrides, level };
}

export function aiDelay(config: AiConfig, rng: Rng): number {
  const span = Math.max(0, config.delayMaxMs - config.delayMinMs);
  return config.delayMinMs + Math.floor(rng() * (span + 1));
}

/** What the AI remembers about another player's hand. Built ONLY from information it legitimately saw. */
export interface KnownCard {
  cardId: string;
  rank: string;
  isJoker: boolean;
  /** Position in the owner's hand, or null if it has become uncertain. */
  index: number | null;
}

export interface AiMemory {
  known: Record<string, KnownCard[]>;
}

export function newMemory(): AiMemory {
  return { known: {} };
}

function toKnown(card: Card, index: number | null): KnownCard {
  return { cardId: card.id, rank: card.rank, isJoker: card.isJoker, index };
}

/**
 * Update memory after a public draw event.
 * `ownCard` is supplied ONLY when the AI itself was the actor (the card it drew)
 * or the target (the card that was taken from it) – both legitimately known to it.
 */
export function observeDraw(memory: AiMemory, selfId: string, ev: GameEvent, ownCard?: Card): AiMemory {
  if (ev.type !== "card_drawn" || !ev.actorId || !ev.targetId || ev.cardIndex === undefined) return memory;
  const A = ev.actorId;
  const T = ev.targetId;
  const i = ev.cardIndex;
  const known: Record<string, KnownCard[]> = {};
  for (const [k, v] of Object.entries(memory.known)) known[k] = v.map((x) => ({ ...x }));

  // Identify the moved card, if we can.
  let moved: KnownCard | null = null;
  if (ownCard && (selfId === A || selfId === T)) moved = toKnown(ownCard, null);
  else if (selfId !== T) {
    const hit = (known[T] ?? []).find((k) => k.index === i);
    if (hit) moved = { ...hit, index: null };
  }

  // Remove it from the target's memory and shift positions behind it.
  if (selfId !== T) {
    known[T] = (known[T] ?? [])
      .filter((k) => !(k.index === i || (moved && k.cardId === moved.cardId)))
      .map((k) => (k.index !== null && k.index > i ? { ...k, index: k.index - 1 } : k));
  }

  // Add it to the actor (the card is appended at the end of the actor's hand).
  if (selfId !== A) {
    const list = known[A] ?? [];
    if (ev.pairFormed) {
      // The drawn card paired off with a card of the same rank; positions in A's hand are now uncertain.
      known[A] = list
        .filter((k) => !(moved && k.rank === moved.rank && !k.isJoker))
        .map((k) => ({ ...k, index: null }));
    } else if (moved) {
      list.push({ ...moved, index: ev.actorCountBefore ?? null });
      known[A] = list;
    } else {
      known[A] = list;
    }
  }
  return { known };
}

export interface AiView {
  selfId: string;
  hand: readonly Card[];
  players: readonly { id: string; cardCount: number }[];
}

export function viewFor(state: GameState, selfId: string): AiView {
  const me = state.players.find((p) => p.id === selfId);
  return {
    selfId,
    hand: me ? me.hand : [],
    players: state.players.map((p) => ({ id: p.id, cardCount: p.hand.length })),
  };
}

export interface AiMove {
  targetId: string;
  cardIndex: number;
}

/**
 * Chooses a draw. Win condition: hold the Joker when the last pair disappears.
 *  - Non-holders hunt the Joker and avoid helping the game end by pairing.
 *  - The holder looks for pairs (to end the game) and otherwise plays randomly.
 */
export function chooseMove(view: AiView, memory: AiMemory, config: AiConfig, rng: Rng): AiMove {
  const targets = view.players.filter((p) => p.id !== view.selfId && p.cardCount > 0);
  if (targets.length === 0) throw new Error("AI has no legal target");

  const holdsJoker = view.hand.some((c) => c.isJoker);
  const myRanks = new Set(view.hand.filter((c) => !c.isJoker).map((c) => c.rank));
  const useMemory = rng() < config.memory;
  const noise = 5 + (1 - config.aggressiveness) * 25;

  let best: { targetId: string; cardIndex: number; score: number }[] = [];
  let bestScore = -Infinity;

  for (const t of targets) {
    const known = useMemory ? (memory.known[t.id] ?? []).filter((k) => k.index === null || k.index < t.cardCount) : [];
    const jokerSuspected = known.some((k) => k.isJoker);
    for (let idx = 0; idx < t.cardCount; idx++) {
      let score = rng() * noise;
      const k = known.find((x) => x.index === idx);
      if (k) {
        if (k.isJoker) score += holdsJoker ? -50 : 120 * (0.5 + config.aggressiveness / 2);
        else if (myRanks.has(k.rank)) score += holdsJoker ? 80 : -40 * config.aggressiveness;
        else score += holdsJoker ? -10 : 6;
      } else if (jokerSuspected && !holdsJoker) {
        // We know who has the Joker but not where – pressure that player.
        score += 30 * config.aggressiveness;
      }
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = [{ targetId: t.id, cardIndex: idx, score }];
      } else if (Math.abs(score - bestScore) <= 1e-9) {
        best.push({ targetId: t.id, cardIndex: idx, score });
      }
    }
  }
  const pick = best[randomInt(rng, best.length)] as { targetId: string; cardIndex: number };
  return { targetId: pick.targetId, cardIndex: pick.cardIndex };
}
