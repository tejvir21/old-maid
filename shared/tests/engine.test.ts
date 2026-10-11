import { describe, expect, it } from "vitest";
import {
  assertInvariants, chooseMove, aiConfigFor, createDeck, createGame, dealCards, drawCard, findPairs,
  getEligibleTargets, getJokerHolder, isGameOver, newMemory, nextPlayer, observeDraw, removePairs,
  seededRng, shuffleDeck, viewFor, type Card, type GameEvent, type GameState, type PlayerSeed,
} from "../src/index";

const seeds = (n: number): PlayerSeed[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, kind: i === 0 ? "human" : "ai", aiLevel: "normal" as const }));
const c = (rank: string, suit: Card["suit"]): Card => ({ id: `${rank}-${suit}`, rank, suit, isJoker: false });
const joker: Card = { id: "joker", rank: "JOKER", isJoker: true };

describe("deck", () => {
  it("has 53 cards, 52 normal, 1 joker, no duplicates", () => {
    const d = createDeck();
    expect(d).toHaveLength(53);
    expect(d.filter((x) => x.isJoker)).toHaveLength(1);
    expect(d.filter((x) => !x.isJoker)).toHaveLength(52);
    expect(new Set(d.map((x) => x.id)).size).toBe(53);
  });
  it("shuffle keeps all cards and is deterministic for a seed", () => {
    const a = shuffleDeck(createDeck(), seededRng(1));
    const b = shuffleDeck(createDeck(), seededRng(1));
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(new Set(a.map((x) => x.id)).size).toBe(53);
    expect(a.map((x) => x.id)).not.toEqual(createDeck().map((x) => x.id));
  });
});

describe("pairs", () => {
  it("pairs same ranks, never the joker", () => {
    const r = findPairs([c("4", "hearts"), c("4", "clubs"), c("9", "diamonds"), c("9", "spades"), joker]);
    expect(r.pairs).toHaveLength(2);
    expect(r.remaining).toEqual([joker]);
  });
  it("joker + anything is no pair", () => {
    expect(findPairs([joker, c("K", "hearts")]).pairs).toHaveLength(0);
  });
  it("three of a rank leaves one; four leaves none", () => {
    expect(removePairs([c("3", "hearts"), c("3", "clubs"), c("3", "spades")])).toHaveLength(1);
    expect(removePairs([c("3", "hearts"), c("3", "clubs"), c("3", "spades"), c("3", "diamonds")])).toHaveLength(0);
  });
});

describe("dealing", () => {
  for (const n of [2, 3, 4, 5, 6, 7]) {
    it(`distributes all 53 cards among ${n} players with no duplicates`, () => {
      const hands = dealCards(shuffleDeck(createDeck(), seededRng(n)), n);
      const ids = hands.flat().map((x) => x.id);
      expect(ids).toHaveLength(53);
      expect(new Set(ids).size).toBe(53);
      const sizes = hands.map((h) => h.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    });
  }
});

describe("game creation", () => {
  it("removes initial pairs and starts on a player with cards", () => {
    const { state } = createGame(seeds(7), seededRng(42));
    assertInvariants(state);
    for (const p of state.players) expect(findPairs(p.hand).pairs).toHaveLength(0);
    expect(state.players[state.currentPlayerIndex]!.hand.length).toBeGreaterThan(0);
  });
  it("rejects bad player counts", () => {
    expect(() => createGame(seeds(1), seededRng(1))).toThrow();
    expect(() => createGame(seeds(8), seededRng(1))).toThrow();
  });
});

function stateOf(hands: Card[][], cur = 0): GameState {
  const total = hands.flat().length;
  return {
    players: hands.map((hand, i) => ({ id: `p${i}`, name: `P${i}`, kind: "ai", hand })),
    currentPlayerIndex: cur, turnId: 1, drawCount: 0, phase: "playing", winnerId: null,
    discardedPairs: (53 - total) / 2, eventSeq: 0,
  };
}

describe("drawing + validation", () => {
  const base = () => stateOf([[joker, c("5", "hearts")], [c("5", "clubs"), c("7", "spades")], [c("7", "hearts")]]);
  it("rejects out-of-turn, self, empty, bad index, stale turn", () => {
    const s = base();
    const bad = (r: ReturnType<typeof drawCard>) => (r.ok ? "ok" : r.error);
    expect(bad(drawCard(s, { actorId: "p1", targetId: "p0", cardIndex: 0 }))).toBe("NOT_YOUR_TURN");
    expect(bad(drawCard(s, { actorId: "p0", targetId: "p0", cardIndex: 0 }))).toBe("TARGET_IS_SELF");
    expect(bad(drawCard(s, { actorId: "p0", targetId: "p9", cardIndex: 0 }))).toBe("INVALID_TARGET");
    expect(bad(drawCard(s, { actorId: "p0", targetId: "p1", cardIndex: 2 }))).toBe("INVALID_CARD_INDEX");
    expect(bad(drawCard(s, { actorId: "p0", targetId: "p1", cardIndex: -1 }))).toBe("INVALID_CARD_INDEX");
    expect(bad(drawCard(s, { actorId: "p0", targetId: "p1", cardIndex: 0.5 }))).toBe("INVALID_CARD_INDEX");
    expect(bad(drawCard(s, { actorId: "p0", targetId: "p1", cardIndex: 0, turnId: 99 }))).toBe("STALE_TURN");
  });
  it("rejects drawing from an empty hand", () => {
    const s = stateOf([[joker, c("5", "hearts")], [], [c("5", "clubs")]]);
    const r = drawCard(s, { actorId: "p0", targetId: "p1", cardIndex: 0 });
    expect(r.ok ? "ok" : r.error).toBe("TARGET_EMPTY");
  });
  it("draw forms a pair immediately and does not mutate the input state", () => {
    const s = base();
    const before = JSON.stringify(s);
    const r = drawCard(s, { actorId: "p0", targetId: "p1", cardIndex: 0, turnId: 1 });
    expect(JSON.stringify(s)).toBe(before);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.result.pairFormed).toBe(true);
    expect(r.value.state.players[0]!.hand).toEqual([joker]);
    expect(r.value.state.turnId).toBe(2);
    expect(r.value.state.currentPlayerIndex).toBe(1);
    assertInvariants(r.value.state);
  });
  it("skips players with no cards when advancing", () => {
    const s = stateOf([[joker, c("5", "hearts")], [c("5", "clubs"), c("7", "spades")], [], [c("7", "hearts")]], 1);
    const r = drawCard(s, { actorId: "p1", targetId: "p3", cardIndex: 0 });
    if (!r.ok) throw new Error("ok expected");
    expect(r.value.state.players[3]!.hand).toHaveLength(0);
    expect(r.value.state.currentPlayerIndex).toBe(0);
    expect(nextPlayer(s, 1)).toBe(3);
  });
  it("public events never contain card identities", () => {
    const s = base();
    const r = drawCard(s, { actorId: "p0", targetId: "p1", cardIndex: 0 });
    if (!r.ok) throw new Error("ok expected");
    const text = JSON.stringify(r.value.events);
    expect(text).not.toMatch(/hearts|clubs|spades|diamonds|joker/i);
  });
  it("eligible targets exclude self and empty hands", () => {
    const s = stateOf([[joker, c("5", "hearts")], [], [c("5", "clubs")]]);
    expect(getEligibleTargets(s, "p0").map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("game over + winner", () => {
  it("ends exactly when only the joker remains; joker holder wins", () => {
    const s = stateOf([[joker, c("5", "hearts")], [c("5", "clubs")]]);
    expect(isGameOver(s)).toBe(false);
    const r = drawCard(s, { actorId: "p0", targetId: "p1", cardIndex: 0 });
    if (!r.ok) throw new Error("ok expected");
    expect(r.value.result.gameOver).toBe(true);
    expect(r.value.state.phase).toBe("finished");
    expect(r.value.state.winnerId).toBe("p0");
    expect(getJokerHolder(r.value.state)?.id).toBe("p0");
    expect(drawCard(r.value.state, { actorId: "p0", targetId: "p1", cardIndex: 0 }).ok).toBe(false);
  });
  it("does not end while normal cards remain", () => {
    const s = stateOf([[joker], [c("5", "clubs")], [c("5", "hearts")]]);
    expect(isGameOver(s)).toBe(false);
  });
});

describe("full simulated games (all AI levels)", () => {
  for (const level of ["easy", "normal", "hard"] as const) {
    for (const n of [2, 3, 5, 7]) {
      it(`${level} AI, ${n} players: always terminates with the joker holder as winner`, () => {
        for (let seed = 1; seed <= 15; seed++) {
          const rng = seededRng(seed * 977 + n);
          let { state } = createGame(
            seeds(n).map((s) => ({ ...s, kind: "ai" as const, aiLevel: level })), rng);
          const memories = state.players.map(() => newMemory());
          let guard = 0;
          while (state.phase === "playing") {
            if (++guard > 2000) throw new Error("infinite loop");
            assertInvariants(state);
            const idx = state.currentPlayerIndex;
            const me = state.players[idx]!;
            const move = chooseMove(viewFor(state, me.id), memories[idx]!, aiConfigFor(level), rng);
            const r = drawCard(state, { actorId: me.id, targetId: move.targetId, cardIndex: move.cardIndex, turnId: state.turnId });
            if (!r.ok) throw new Error(`AI made illegal move: ${r.error}`);
            const ev = r.value.events.find((e: GameEvent) => e.type === "card_drawn")!;
            state.players.forEach((p, i) => {
              const own = p.id === me.id || p.id === move.targetId ? r.value.result.card : undefined;
              memories[i] = observeDraw(memories[i]!, p.id, ev, own);
            });
            state = r.value.state;
          }
          expect(state.winnerId).not.toBeNull();
          expect(state.players.find((p) => p.id === state.winnerId)!.hand).toEqual([joker]);
          expect(state.players.filter((p) => p.hand.length > 0)).toHaveLength(1);
          assertInvariants(state);
        }
      });
    }
  }
});

describe("AI memory", () => {
  it("learns where a card it gave away went, and hunts the joker", () => {
    // p0 holds the joker; p1 draws it at index 0 (no pair formed). p0 should remember p1 has it.
    const ev: GameEvent = { seq: 1, turnId: 1, type: "card_drawn", actorId: "p1", targetId: "p0", cardIndex: 0,
      actorCountBefore: 2, targetCountBefore: 2, pairFormed: false, text: "" };
    const mem = observeDraw(newMemory(), "p0", ev, joker);
    expect(mem.known["p1"]).toEqual([{ cardId: "joker", rank: "JOKER", isJoker: true, index: 2 }]);
    // p2 (non-holder) now watching nothing; but p0 (no longer holding joker) should target p1's index 2
    const view = { selfId: "p0", hand: [c("8", "hearts")], players: [{ id: "p0", cardCount: 1 }, { id: "p1", cardCount: 3 }, { id: "p2", cardCount: 2 }] };
    const mv = chooseMove(view, mem, aiConfigFor("hard", { memory: 1 }), seededRng(3));
    expect(mv).toEqual({ targetId: "p1", cardIndex: 2 });
  });
  it("never uses information it was not given", () => {
    const mem = observeDraw(newMemory(), "p3", { seq: 1, turnId: 1, type: "card_drawn", actorId: "p1", targetId: "p0",
      cardIndex: 0, actorCountBefore: 2, targetCountBefore: 2, pairFormed: false, text: "" });
    expect(mem.known["p1"] ?? []).toHaveLength(0);
  });
});
