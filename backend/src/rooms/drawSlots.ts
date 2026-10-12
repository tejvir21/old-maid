import { randomBytes } from "node:crypto";
import type { DrawTargetSlots } from "@old-maid/shared";

/**
 * Viewer-specific opaque card slots.
 *
 * The leak this prevents: the client used to send a raw `cardIndex` into the target's hand and
 * the UI rendered face-down cards in a stable order. An observer could therefore track a
 * physical card across turns and, in the worst case (a player holding two cards, one of them
 * the Joker), deduce which slot held the Joker.
 *
 * Instead, when a player becomes eligible to draw, the server:
 *   1. shuffles the target's real hand indices into a random presentation order,
 *   2. mints a cryptographically random, unguessable slot id for each,
 *   3. keeps the slot -> real-index mapping entirely server-side.
 *
 * Slots are scoped to (room, viewer, target, turnId) and are destroyed the moment the turn ends
 * or the slot is used, so they cannot be replayed, reused on a later turn, or used by anyone else.
 * Nothing about the mapping is derivable from a slot id.
 */

export interface SlotTable {
  roomCode: string;
  /** The turn these slots are valid for. */
  turnId: number;
  viewerId: string;
  /** targetId -> (slotId -> real hand index) */
  targets: Map<string, Map<string, number>>;
}

export const SLOT_ID_BYTES = 16; // 128 bits of entropy, base64url-encoded

/** Cryptographically random, opaque. Contains no rank/suit/index information. */
export function newSlotId(rand: () => number = Math.random): string {
  // randomBytes is the primary source; the rng hook exists only so unit tests can be deterministic.
  const b = randomBytes(SLOT_ID_BYTES);
  void rand;
  return b.toString("base64url");
}

export interface BuildSlotsInput {
  roomCode: string;
  viewerId: string;
  turnId: number;
  /** targetId -> the target's current hand size. */
  targets: { playerId: string; cardCount: number }[];
  /** Injected for deterministic tests; must return [0, n). */
  rand?: () => number;
  /** Injected for deterministic tests. */
  slotId?: () => string;
}

/**
 * Builds a fresh randomized slot mapping. Called every time the viewer gets a new draw
 * opportunity, so the visible order never implies a stable underlying card.
 */
export function buildSlotTable(input: BuildSlotsInput): { table: SlotTable; payload: { turnId: number; targets: DrawTargetSlots[] } } {
  const rand = input.rand ?? Math.random;
  const makeId = input.slotId ?? (() => newSlotId(rand));
  const targets = new Map<string, Map<string, number>>();
  const payload: DrawTargetSlots[] = [];

  for (const t of input.targets) {
    if (t.cardCount <= 0) continue;
    const n = t.cardCount;
    // Fisher-Yates over the real indices -> a random presentation order per turn.
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const a = order[i] as number;
      order[i] = order[j] as number;
      order[j] = a;
    }
    const slots: string[] = [];
    const map = new Map<string, number>();
    for (const idx of order) {
      const id = makeId();
      slots.push(id);
      map.set(id, idx);
    }
    targets.set(t.playerId, map);
    payload.push({ targetPlayerId: t.playerId, slots });
  }

  return {
    table: { roomCode: input.roomCode, turnId: input.turnId, viewerId: input.viewerId, targets },
    payload: { turnId: input.turnId, targets: payload },
  };
}

export type SlotResolution =
  | { ok: true; index: number }
  | { ok: false; reason: "STALE_TURN" | "INVALID_TARGET" | "INVALID_SLOT" };

/**
 * Resolves an opaque slot to the real hand index.
 *
 * Rejects (rather than throwing) when the slot does not belong to this viewer/target/turn, so a
 * forged, stale, cross-player or out-of-turn slot can never influence card selection.
 */
export function resolveSlot(table: SlotTable | null, viewerId: string, targetId: string, turnId: number, slotId: string): SlotResolution {
  if (!table) return { ok: false, reason: "STALE_TURN" };
  if (table.viewerId !== viewerId) return { ok: false, reason: "INVALID_SLOT" }; // another player's slots
  if (table.turnId !== turnId) return { ok: false, reason: "STALE_TURN" };       // replayed from an older turn
  const map = table.targets.get(targetId);
  if (!map) return { ok: false, reason: "INVALID_TARGET" };
  const index = map.get(slotId);
  if (index === undefined) return { ok: false, reason: "INVALID_SLOT" };
  return { ok: true, index };
}

/** Destroys a single slot so it cannot be used twice within the same turn. */
export function consumeSlot(table: SlotTable | null, targetId: string, slotId: string): void {
  table?.targets.get(targetId)?.delete(slotId);
}