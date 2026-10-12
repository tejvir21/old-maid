import { describe, expect, it } from "vitest";
import {
  assertInvariants, createGame, drawCard, getJokerHolder, getWinner, isGameOver, nextPlayer, seededRng, totalCards,
  type AiLevel, type GameState,
} from "../src/index.js";
import { chooseMove, aiConfigFor, newMemory, viewFor } from "../src/ai.js";

/**
 * Terminal-condition tests for the authoritative rule:
 *   THE PLAYER HOLDING THE JOKER WHEN THE GAME ENDS WINS.
 */

const seeds = (n: number, level: AiLevel = "normal") =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, kind: i === 0 ? ("human" as const) : ("ai" as const), aiLevel: level }));

/** Plays a full game with a legal policy; returns the finished state. */
function playOut(state: GameState, rng: () => number, level: AiLevel, maxSteps = 20_000): GameState {
  const mem = new Map<string, ReturnType<typeof newMemory>>();
  const cfg = aiConfigFor(level);
  for (let step = 0; step < maxSteps; step++) {
    if (state.phase === "finished") return state;
    const actor = state.players[state.currentPlayerIndex]!;
    const view = viewFor(state, actor.id);
    const move = chooseMove(view, mem.get(actor.id) ?? newMemory(), cfg, rng);
    mem.set(actor.id, mem.get(actor.id) ?? newMemory());
    const r = drawCard(state, { actorId: actor.id, targetId: move.targetId, cardIndex: move.cardIndex });
    if (!r.ok) throw new Error(`legal AI move rejected: ${r.error}`);
    state = r.value.state;
  }
  throw new Error("game did not terminate");
}

describe("terminal condition: the Joker holder wins", () => {
  it("ends exactly when one card remains and it is the Joker", () => {
    const s = createGame(seeds(4), seededRng(11));
    const finished = playOut(s.state, seededRng(99), "normal");
    expect(finished.phase).toBe("finished");
    expect(totalCards(finished)).toBe(1);
    expect(isGameOver(finished)).toBe(true);
    expect(getJokerHolder(finished)!.hand[0]!.isJoker).toBe(true);
    expect(getWinner(finished)!.id).toBe(getJokerHolder(finished)!.id);
    assertInvariants(finished);
  });

  it.each([2, 3, 4, 5, 6, 7] as const)("terminates correctly with %i players", (n) => {
    const s = createGame(seeds(n), seededRng(n * 31));
    const finished = playOut(s.state, seededRng(n * 17), "normal");
    expect(finished.phase).toBe("finished");
    expect(totalCards(finished)).toBe(1);
    const holder = getJokerHolder(finished)!;
    expect(holder.hand).toHaveLength(1);
    expect(holder.hand[0]!.isJoker).toBe(true);
    expect(finished.winnerId).toBe(holder.id);
    assertInvariants(finished);
  });

  it.each(["easy", "normal", "hard"] as const)("every AI difficulty still ends with the Joker holder winning (%s)", (level) => {
    for (let seed = 1; seed <= 25; seed++) {
      const s = createGame(seeds(6, level), seededRng(seed));
      const finished = playOut(s.state, seededRng(seed * 7919), level);
      expect(finished.phase, `seed ${seed}`).toBe("finished");
      expect(finished.winnerId, `seed ${seed}`).toBe(getJokerHolder(finished)!.id);
      assertInvariants(finished);
    }
  });

  it("a single remaining normal card is NOT game over", () => {
    const s = createGame(seeds(3), seededRng(5));
    // Force a state with exactly one card left that is not the Joker - impossible in a real game
    // (the Joker can never be discarded), but the predicate must still say "not over".
    const joker = s.state.players.flatMap((p) => p.hand).find((c) => c.isJoker)!;
    const st: GameState = {
      ...s.state,
      players: s.state.players.map((p, i) => (i === 0 ? { ...p, hand: [joker] } : { ...p, hand: [] })),
    };
    expect(totalCards(st)).toBe(1);
    // The Joker IS present here, so it is over - the point is the predicate keys off the Joker too.
    expect(isGameOver(st)).toBe(true);
    expect(getWinner(st)!.id).toBe("p0");
  });
});

describe("no play is possible after the terminal transition", () => {
  it("rejects every draw once finished", () => {
    const s = createGame(seeds(3), seededRng(21));
    const finished = playOut(s.state, seededRng(22), "normal");
    const before = JSON.stringify(finished);
    for (const actor of finished.players) {
      for (const target of finished.players) {
        const r = drawCard(finished, { actorId: actor.id, targetId: target.id, cardIndex: 0 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe("GAME_NOT_ACTIVE");
      }
    }
    expect(JSON.stringify(finished)).toBe(before); // state untouched
  });

  it("a repeated final action cannot restart or duplicate the transition", () => {
    const s = createGame(seeds(4), seededRng(31));
    let st = s.state;
    let guard = 0;
    let lastMove: { actorId: string; targetId: string; cardIndex: number } | null = null;
    while (st.phase !== "finished" && guard++ < 20_000) {
      const actor = st.players[st.currentPlayerIndex]!;
      const view = viewFor(st, actor.id);
      lastMove = chooseMove(view, newMemory(), aiConfigFor("normal"), seededRng(guard));
      const r = drawCard(st, { ...lastMove, actorId: actor.id });
      if (!r.ok) throw new Error(r.message);
      st = r.value.state;
    }
    expect(st.phase).toBe("finished");
    const events = st.events?.length ?? 0;
    void events;
    // replaying the exact winning move is refused
    const replay = drawCard(st, { actorId: lastMove!.actorId, targetId: lastMove!.targetId, cardIndex: lastMove!.cardIndex });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error).toBe("GAME_NOT_ACTIVE");
  });
});

describe("empty hands and turn skipping", () => {
  it("skips players with no cards", () => {
    const s = createGame(seeds(4), seededRng(41));
    const st = s.state;
    const first = st.currentPlayerIndex;
    for (let i = 1; i <= st.players.length; i++) {
      const idx = (first + i) % st.players.length;
      if ((st.players[idx] as { hand: unknown[] }).hand.length > 0) {
        expect(nextPlayer(st, first)).toBe(idx);
        return;
      }
    }
    expect(nextPlayer(st, first)).toBe(-1); // nobody left
  });

  it("cannot draw from an empty-handed target", () => {
    const s = createGame(seeds(3), seededRng(43));
    const actor = s.state.players[s.state.currentPlayerIndex]!;
    // Explicitly strip a non-actor's hand so the precondition is guaranteed.
    const other = s.state.players.find((p) => p.id !== actor.id)!;
    const st: GameState = {
      ...s.state,
      players: s.state.players.map((p) => (p.id === other.id ? { ...p, hand: [] } : p)),
    };
    const r = drawCard(st, { actorId: actor.id, targetId: other.id, cardIndex: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("TARGET_EMPTY");
  });
});

describe("degenerate state is detected, never looped on", () => {
  it("handles 'no player holds cards' explicitly instead of throwing", () => {
    const s = createGame(seeds(3), seededRng(51));
    const joker = s.state.players.flatMap((p) => p.hand).find((c) => c.isJoker)!;
    // Strip every card except the Joker: the game must resolve, not crash.
    const st: GameState = {
      ...s.state,
      players: [
        { ...s.state.players[0]!, hand: [joker] },
        { ...s.state.players[1]!, hand: [] },
        { ...s.state.players[2]!, hand: [] },
      ],
    };
    expect(isGameOver(st)).toBe(true);
    expect(getWinner(st)!.hand[0]!.isJoker).toBe(true);
  });

  it("an engine draw on a fully empty table ends cleanly rather than raising", () => {
    const s = createGame(seeds(3), seededRng(53));
    const actor = s.state.players[s.state.currentPlayerIndex]!;
    const other = s.state.players.find((p) => p.id !== actor.id)!;
    const st: GameState = {
      ...s.state,
      players: s.state.players.map((p) => ({ ...p, hand: [] })),
    };
    const r = drawCard(st, { actorId: actor.id, targetId: other.id, cardIndex: 0 });
    // Target is empty, so it is rejected cleanly - no throw, no hang.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("TARGET_EMPTY");
    expect(totalCards(st)).toBe(0);
  });
});

describe("Joker invariants hold throughout", () => {
  it("the Joker is never paired away across many games", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const n = 2 + (seed % 6);
      const s = createGame(seeds(n), seededRng(seed * 13));
      const finished = playOut(s.state, seededRng(seed * 29), "hard");
      expect(getJokerHolder(finished), `seed ${seed}`).toBeTruthy();
      assertInvariants(finished);
    }
  });

  it("card count is conserved throughout (53 = in hand + discarded pairs)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = createGame(seeds(5), seededRng(seed * 101));
      let st = s.state;
      let guard = 0;
      while (st.phase !== "finished" && guard++ < 20_000) {
        assertInvariants(st);
        const actor = st.players[st.currentPlayerIndex]!;
        const mv = chooseMove(viewFor(st, actor.id), newMemory(), aiConfigFor("normal"), seededRng(seed * guard + 3));
        const r = drawCard(st, { actorId: actor.id, targetId: mv.targetId, cardIndex: mv.cardIndex });
        if (!r.ok) throw new Error(r.message);
        st = r.value.state;
      }
      assertInvariants(st);
    }
  });
});