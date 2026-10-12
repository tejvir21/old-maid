import { describe, expect, it } from "vitest";
import { buildSlotTable, shuffleIndices, SHUFFLE_ATTEMPTS } from "../src/rooms/drawSlots.js";

/**
 * The privacy property under test is not "slot ids are fresh" - they always are.
 * It is "the rendered permutation DIFFERS between turns", because screen position only stops
 * identifying a card if position -> card changes.
 *
 * A uniform Fisher-Yates reproduces the previous order with probability 1/n!. For a player
 * holding TWO cards that is 1/2 - so roughly half of all two-card turns would leave position 0
 * pointing at the same physical card as the turn before, and the reshuffle would be invisible.
 */

/** Adversarial RNG: always returns 0, so a naive Fisher-Yates always yields the same order. */
const alwaysZero = () => 0;
/** Always the maximum, likewise degenerate. */
const alwaysMax = () => 0.999999;

describe("shuffleIndices guarantees a different order", () => {
  it("never repeats the previous permutation for n=2", () => {
    // A naive shuffle would return [0,1] every time under these generators.
    for (const rand of [alwaysZero, alwaysMax]) {
      let prev: number[] = [0, 1];
      for (let i = 0; i < 50; i++) {
        const next = shuffleIndices(2, rand, prev);
        expect(next).not.toEqual(prev);
        expect([...next].sort()).toEqual([0, 1]);
        prev = next;
      }
    }
  });

  it("never repeats the previous permutation for every size", () => {
    for (const rand of [alwaysZero, alwaysMax, () => 0.5]) {
      for (let n = 2; n <= 12; n++) {
        let prev = Array.from({ length: n }, (_, i) => i);
        for (let turn = 0; turn < 30; turn++) {
          const next = shuffleIndices(n, rand, prev);
          expect(next, `n=${n} turn=${turn} rand=${rand()}`).not.toEqual(prev);
          expect([...next].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
          prev = next;
        }
      }
    }
  });

  it("returns the single permutation unchanged when n=1 (nothing to permute)", () => {
    expect(shuffleIndices(1, alwaysZero, [0])).toEqual([0]);
    expect(shuffleIndices(0, alwaysZero, [])).toEqual([]);
  });

  it("falls back to a rotated order after a bounded number of attempts", () => {
    // Always-zero RNG with an `avoid` that rotation can always satisfy: the fallback path.
    const avoid = [0, 1, 2, 3, 4];
    const result = shuffleIndices(5, alwaysZero, avoid);
    expect(result).not.toEqual(avoid);
    expect([...result].sort((a, b) => a - b)).toEqual(avoid);
    expect(SHUFFLE_ATTEMPTS).toBeGreaterThan(0);
    expect(SHUFFLE_ATTEMPTS).toBeLessThanOrEqual(64); // bounded
  });

  it("produces a valid permutation with no previous order to avoid", () => {
    for (const rand of [alwaysZero, alwaysMax, () => 0.42]) {
      for (let n = 1; n <= 10; n++) {
        const r = shuffleIndices(n, rand);
        expect([...r].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      }
    }
  });

  it("actually uses the randomness (not a fixed rotation) when a previous order is absent", () => {
    // With a real RNG and no `avoid`, many distinct orders should appear.
    const seen = new Set<string>();
    let s = 12345;
    const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    for (let i = 0; i < 40; i++) seen.add(shuffleIndices(5, rand).join(","));
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe("buildSlotTable avoids repeating the displayed order", () => {
  const build = (n: number, previous?: Map<string, readonly number[]>, rand: () => number = alwaysZero) =>
    buildSlotTable({
      roomCode: "ABCDE", viewerId: "v1", turnId: 1,
      targets: [{ playerId: "t1", cardCount: n }],
      rand,
      slotId: (() => { let c = 0; return () => `slot${(c++).toString().padStart(6, "0")}`; })(),
      ...(previous ? { previous } : {}),
    });

  /** The permutation the viewer actually sees, read back from the slot table. */
  const orderOf = (r: ReturnType<typeof build>, target = "t1"): number[] => {
    const payloadSlots = r.payload.targets.find((t) => t.targetPlayerId === target)!.slots;
    const map = r.table.targets.get(target)!;
    return payloadSlots.map((s) => map.get(s)!);
  };

  it("emits a different rendered order on the next turn even with a degenerate RNG", () => {
    let previous: Map<string, readonly number[]> | undefined;
    let prevOrder: number[] | undefined;
    for (let turn = 0; turn < 20; turn++) {
      const r = build(2, previous);
      const order = orderOf(r);
      expect(order, `turn ${turn}`).not.toEqual(prevOrder);
      previous = new Map([["t1", order]]);
      prevOrder = order;
    }
  });

  it("still emits exactly one slot per card", () => {
    for (const n of [1, 2, 3, 7, 13]) {
      const r = build(n);
      expect(r.payload.targets[0]!.slots).toHaveLength(n);
      expect(new Set(r.payload.targets[0]!.slots).size).toBe(n);
    }
  });

  it("does not leak the permutation in the payload", () => {
    const r = build(4);
    const body = JSON.stringify(r.payload);
    expect(body).not.toMatch(/index|order|hand/i);
  });
});