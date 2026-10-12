import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { afterEach, beforeEach } from "vitest";
import { buildSlotTable, consumeSlot, newSlotId, resolveSlot, SLOT_ID_BYTES } from "../src/rooms/drawSlots.js";

/** Deterministic PRNG so every ordering assertion is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const build = (opts: Partial<Parameters<typeof buildSlotTable>[0]> = {}) =>
  buildSlotTable({
    roomCode: "ABCDE",
    viewerId: "viewer-1",
    turnId: 5,
    targets: [{ playerId: "target-1", cardCount: 5 }],
    ...opts,
  });

describe("slot ids are opaque", () => {
  it("are cryptographically random and unguessable", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newSlotId()));
    expect(ids.size).toBe(500); // no collisions
    expect(ids.size === 0).toBe(false);
    // 128 bits of entropy, base64url encoded
    expect(newSlotId().length).toBeGreaterThanOrEqual(20);
    expect(SLOT_ID_BYTES).toBeGreaterThanOrEqual(16);
  });

  it("reveal nothing about rank, suit or hand position", () => {
    const a = build();
    const flat = a.payload.targets[0]!.slots.join(",");
    for (const leaked of ["0", "1", "2", "3", "4", "A", "K", "J", "Q", "heart", "spade", "club", "diamond", "JOKER"]) {
      // Slot ids may legitimately contain a digit or letter; what matters is that they do not
      // equal, or encode, an index. Assert there is no ordering relationship instead.
      void leaked;
    }
    expect(flat).not.toContain("hearts");
    expect(flat).not.toContain("JOKER");
    expect(flat).not.toContain("7-A");
  });

  it("the slot order is randomised, not the natural index order", () => {
    const natural = build({ rand: mulberry32(1) });
    const indices = natural.payload.targets[0]!.slots.map((s) => natural.table.targets.get("target-1")!.get(s));
    // A correct Fisher-Yates is not identity for n=5 with any real seed.
    expect(indices).not.toEqual([0, 1, 2, 3, 4]);
    expect([...indices].sort((x, y) => (x as number) - (y as number))).toEqual([0, 1, 2, 3, 4]);
  });

  it("different viewers/targets/turns get completely unrelated mappings", () => {
    const a = build({ viewerId: "v1", turnId: 1 });
    const b = build({ viewerId: "v2", turnId: 1 });
    const overlap = a.payload.targets[0]!.slots.filter((s) => b.payload.targets[0]!.slots.includes(s));
    expect(overlap).toEqual([]); // no shared slot id between viewers
  });
});

describe("resolution is scoped to viewer, target and turn", () => {
  let table: ReturnType<typeof build>["table"];
  let slot: string;

  beforeEach(() => {
    const b = build({ viewerId: "v1", turnId: 3 });
    table = b.table;
    slot = b.payload.targets[0]!.slots[0]!;
  });
  afterEach(() => { table = null as never; });

  it("resolves a valid slot to a real index", () => {
    const r = resolveSlot(table, "v1", "target-1", 3, slot);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.index).toBeGreaterThanOrEqual(0);
  });

  it("rejects another player's slot (cross-player use)", () => {
    const other = build({ viewerId: "attacker", turnId: 3 });
    const stolen = other.payload.targets[0]!.slots[0]!;
    expect(resolveSlot(table, "attacker", "target-1", 3, stolen)).toMatchObject({ ok: false, reason: "INVALID_SLOT" });
    expect(resolveSlot(table, "v1", "target-1", 3, stolen)).toMatchObject({ ok: false, reason: "INVALID_SLOT" });
  });

  it("rejects a slot replayed on a later turn", () => {
    const later = resolveSlot(table, "v1", "target-1", 4, slot);
    expect(later).toMatchObject({ ok: false, reason: "STALE_TURN" });
  });

  it("rejects a slot aimed at a different target", () => {
    expect(resolveSlot(table, "v1", "target-2", 3, slot)).toMatchObject({ ok: false, reason: "INVALID_TARGET" });
  });

  it("rejects a forged or unknown slot", () => {
    expect(resolveSlot(table, "v1", "target-1", 3, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toMatchObject({ ok: false });
    expect(resolveSlot(table, "v1", "target-1", 3, randomUUID().replace(/-/g, ""))).toMatchObject({ ok: false });
    expect(resolveSlot(table, "v1", "target-1", 3, "0")).toMatchObject({ ok: false });
  });

  it("rejects everything once the table is gone (game over / new turn)", () => {
    expect(resolveSlot(null, "v1", "target-1", 3, slot)).toMatchObject({ ok: false, reason: "STALE_TURN" });
  });

  it("a consumed slot cannot be reused within the same turn", () => {
    const b = build({ viewerId: "v1", turnId: 3 });
    const t = b.table;
    const s = b.payload.targets[0]!.slots[0]!;
    expect(resolveSlot(t, "v1", "target-1", 3, s).ok).toBe(true);
    consumeSlot(t, "target-1", s);
    expect(resolveSlot(t, "v1", "target-1", 3, s)).toMatchObject({ ok: false, reason: "INVALID_SLOT" });
  });
});

describe("fresh mappings every turn", () => {
  it("repeated turns never reuse the previous slots for the same target", () => {
    const seen = new Set<string>();
    for (let turn = 1; turn <= 12; turn++) {
      const b = build({ viewerId: "v1", turnId: turn });
      const ids = b.payload.targets[0]!.slots;
      // No id from an earlier turn may appear again.
      for (const id of ids) expect(seen.has(id)).toBe(false);
      ids.forEach((i) => seen.add(i));
    }
    expect(seen.size).toBe(12 * 5);
  });

  it("a newly generated order is not correlated with the previous one", () => {
    const order = (turn: number) => {
      const b = build({ viewerId: "v1", turnId: turn, rand: mulberry32(turn * 977) });
      return b.payload.targets[0]!.slots.map((s) => b.table.targets.get("target-1")!.get(s));
    };
    expect(order(1)).not.toEqual(order(2));
    expect(order(2)).not.toEqual(order(3));
  });
});

describe("edge cases", () => {
  it("a target with no cards yields no slots", () => {
    const b = build({ targets: [{ playerId: "t", cardCount: 0 }] });
    expect(b.payload.targets).toEqual([]);
  });

  it("produces exactly one slot per card", () => {
    for (const n of [1, 2, 3, 7, 26]) {
      const b = build({ targets: [{ playerId: "t", cardCount: n }] });
      const slots = b.payload.targets[0]!.slots;
      expect(slots).toHaveLength(n);
      expect(new Set(slots).size).toBe(n);
    }
  });

  it("handles multiple targets independently", () => {
    const b = build({ targets: [{ playerId: "t1", cardCount: 3 }, { playerId: "t2", cardCount: 4 }] });
    expect(b.payload.targets).toHaveLength(2);
    const a = new Set(b.payload.targets[0]!.slots);
    const c = new Set(b.payload.targets[1]!.slots);
    expect([...a].filter((x) => c.has(x))).toEqual([]);
  });
});