import { createDeck, dealCards, shuffleDeck } from "./deck.js";
import { findPairs } from "./rules.js";
import { randomInt } from "./rng.js";
import type {
  AiLevel,
  Card,
  DrawResult,
  EnginePlayer,
  EngineResult,
  GameEvent,
  GameEventType,
  GameState,
  PlayerKind,
  Rng,
} from "./types.js";

export interface PlayerSeed {
  id: string;
  name: string;
  kind: PlayerKind;
  aiLevel?: AiLevel;
}

export interface StartResult {
  state: GameState;
  events: GameEvent[];
}

function event(
  state: GameState,
  type: GameEventType,
  text: string,
  extra: Partial<GameEvent> = {},
): GameEvent {
  state.eventSeq += 1;
  return { seq: state.eventSeq, turnId: state.turnId, type, text, ...extra };
}

export function totalCards(state: GameState): number {
  return state.players.reduce((n, p) => n + p.hand.length, 0);
}

export function getJokerHolder(state: GameState): EnginePlayer | null {
  return state.players.find((p) => p.hand.some((c) => c.isJoker)) ?? null;
}

/** The game ends exactly when the Joker is the only card left in play. */
export function isGameOver(state: GameState): boolean {
  return totalCards(state) === 1 && getJokerHolder(state) !== null;
}

export function getWinner(state: GameState): EnginePlayer | null {
  return isGameOver(state) || state.phase === "finished" ? getJokerHolder(state) : null;
}

/** Clockwise next player (after `fromIndex`) who still has cards. -1 if none. */
export function nextPlayer(state: GameState, fromIndex: number): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    if ((state.players[idx] as EnginePlayer).hand.length > 0) return idx;
  }
  return -1;
}

export function getEligibleTargets(state: GameState, playerId: string): EnginePlayer[] {
  return state.players.filter((p) => p.id !== playerId && p.hand.length > 0);
}

export function getCurrentPlayer(state: GameState): EnginePlayer {
  return state.players[state.currentPlayerIndex] as EnginePlayer;
}

/**
 * Creates a game: deck → shuffle → deal → discard initial pairs → first turn.
 * `firstPlayerIndex` defaults to a random seat.
 */
export function createGame(
  seeds: readonly PlayerSeed[],
  rng: Rng,
  firstPlayerIndex?: number,
): StartResult {
  if (seeds.length < 2 || seeds.length > 7) throw new RangeError("Old Maid needs 2–7 players");
  if (new Set(seeds.map((s) => s.id)).size !== seeds.length) throw new Error("Duplicate player ids");

  const deck = shuffleDeck(createDeck(), rng);
  const hands = dealCards(deck, seeds.length);

  const state: GameState = {
    players: seeds.map((s, i) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      ...(s.aiLevel ? { aiLevel: s.aiLevel } : {}),
      hand: (hands[i] as Card[]).slice(),
    })),
    currentPlayerIndex: 0,
    turnId: 0,
    drawCount: 0,
    phase: "playing",
    winnerId: null,
    discardedPairs: 0,
    eventSeq: 0,
  };
  const events: GameEvent[] = [];
  events.push(event(state, "game_started", `${seeds.length} players. One Joker. Only one can win.`));

  for (const p of state.players) {
    const { pairs, remaining } = findPairs(p.hand);
    p.hand = remaining;
    state.discardedPairs += pairs.length;
    events.push(
      event(state, "initial_pairs", `${p.name} discarded ${pairs.length} pair${pairs.length === 1 ? "" : "s"}.`, {
        actorId: p.id,
      }),
    );
  }

  if (isGameOver(state)) return { state: finish(state, events), events };

  const start = firstPlayerIndex ?? randomInt(rng, state.players.length);
  const first = (state.players[start] as EnginePlayer).hand.length > 0 ? start : nextPlayer(state, start);
  state.currentPlayerIndex = first;
  state.turnId = 1;
  events.push(event(state, "turn_changed", `${getCurrentPlayer(state).name}'s turn.`, { actorId: getCurrentPlayer(state).id }));
  return { state, events };
}

function finish(state: GameState, events: GameEvent[]): GameState {
  state.phase = "finished";
  const holder = getJokerHolder(state);
  state.winnerId = holder ? holder.id : null;
  events.push(
    event(state, "game_over", holder ? `The Joker was held by ${holder.name}. ${holder.name} wins.` : "Game over.", {
      ...(holder ? { actorId: holder.id } : {}),
    }),
  );
  return state;
}

function cloneState(s: GameState): GameState {
  return { ...s, players: s.players.map((p) => ({ ...p, hand: p.hand.slice() })) };
}

export interface DrawRequest {
  actorId: string;
  targetId: string;
  cardIndex: number;
  /** If supplied, must equal state.turnId (duplicate / stale-action guard). */
  turnId?: number;
}

export interface DrawOutcome {
  state: GameState;
  events: GameEvent[];
  result: DrawResult;
}

/** Pure: validates, performs one draw, removes pairs, checks the end, advances the turn. */
export function drawCard(prev: GameState, req: DrawRequest): EngineResult<DrawOutcome> {
  const fail = (error: import("./types.js").EngineErrorCode, message: string) =>
    ({ ok: false, error, message }) as const;

  if (prev.phase !== "playing") return fail("GAME_NOT_ACTIVE", "The game is not active.");
  if (req.turnId !== undefined && req.turnId !== prev.turnId) return fail("STALE_TURN", "That action is out of date.");
  const actorIdx = prev.players.findIndex((p) => p.id === req.actorId);
  if (actorIdx < 0) return fail("UNKNOWN_PLAYER", "Unknown player.");
  if (actorIdx !== prev.currentPlayerIndex) return fail("NOT_YOUR_TURN", "It is not your turn.");
  if (req.targetId === req.actorId) return fail("TARGET_IS_SELF", "You cannot draw from yourself.");
  const targetIdx = prev.players.findIndex((p) => p.id === req.targetId);
  if (targetIdx < 0) return fail("INVALID_TARGET", "That player is not in the game.");
  const targetBefore = (prev.players[targetIdx] as EnginePlayer).hand;
  if (targetBefore.length === 0) return fail("TARGET_EMPTY", "That player has no cards.");
  if (!Number.isInteger(req.cardIndex) || req.cardIndex < 0 || req.cardIndex >= targetBefore.length) {
    return fail("INVALID_CARD_INDEX", "Invalid card.");
  }

  const state = cloneState(prev);
  const events: GameEvent[] = [];
  const actor = state.players[actorIdx] as EnginePlayer;
  const target = state.players[targetIdx] as EnginePlayer;
  const actorCountBefore = actor.hand.length;
  const targetCountBefore = target.hand.length;

  const [card] = target.hand.splice(req.cardIndex, 1) as [Card];
  actor.hand.push(card);
  state.drawCount += 1;

  const { pairs, remaining } = findPairs(actor.hand);
  const pairFormed = pairs.length > 0;
  actor.hand = remaining;
  state.discardedPairs += pairs.length;

  events.push(
    event(state, "card_drawn", `${actor.name} drew a card from ${target.name}.`, {
      actorId: actor.id,
      targetId: target.id,
      cardIndex: req.cardIndex,
      actorCountBefore,
      targetCountBefore,
      pairFormed,
    }),
  );
  if (pairFormed) {
    events.push(event(state, "pair_formed", `${actor.name} formed a pair and discarded it.`, { actorId: actor.id }));
  }
  const targetOut = target.hand.length === 0;
  const actorOut = actor.hand.length === 0;
  if (targetOut) events.push(event(state, "player_out", `${target.name} has no cards left.`, { actorId: target.id }));
  if (actorOut) events.push(event(state, "player_out", `${actor.name} has no cards left.`, { actorId: actor.id }));

  const gameOver = isGameOver(state);
  if (gameOver) {
    finish(state, events);
  } else {
    const nextIdx = nextPlayer(state, actorIdx);
    if (nextIdx < 0) throw new Error("Invariant violated: no player with cards but game not over");
    state.currentPlayerIndex = nextIdx;
    state.turnId += 1;
    const np = state.players[nextIdx] as EnginePlayer;
    events.push(event(state, "turn_changed", `${np.name}'s turn.`, { actorId: np.id }));
  }

  return {
    ok: true,
    value: {
      state,
      events,
      result: {
        actorId: actor.id,
        targetId: target.id,
        cardIndex: req.cardIndex,
        card,
        pairFormed,
        pairCards: pairs[0] ?? null,
        targetOut,
        actorOut,
        gameOver,
      },
    },
  };
}

/** Throws if any engine invariant is broken. Used by the server after every action and in tests. */
export function assertInvariants(state: GameState): void {
  const seen = new Set<string>();
  let jokers = 0;
  for (const p of state.players) {
    for (const c of p.hand) {
      if (seen.has(c.id)) throw new Error(`Card ${c.id} exists twice`);
      seen.add(c.id);
      if (c.isJoker) jokers++;
    }
  }
  if (jokers !== 1) throw new Error(`Expected exactly one Joker in play, found ${jokers}`);
  if (totalCards(state) + state.discardedPairs * 2 !== 53) throw new Error("Card conservation violated");
  if (state.phase === "playing") {
    const cur = state.players[state.currentPlayerIndex];
    if (!cur || cur.hand.length === 0) throw new Error("Current player must hold cards");
    for (const p of state.players) {
      const ranks = new Set<string>();
      for (const c of p.hand) {
        if (c.isJoker) continue;
        if (ranks.has(c.rank)) throw new Error(`Unpaired duplicate rank ${c.rank} in ${p.name}'s hand`);
        ranks.add(c.rank);
      }
    }
  }
}
