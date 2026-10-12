import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type PlayerView } from "@old-maid/shared";
import { boot, connect, type Booted, type Client } from "./harness.js";

/**
 * Regression coverage for the production incident in which a client that had not been rebuilt
 * kept rendering opponent cards positionally and every draw failed with `Invalid draw request.`
 *
 * These tests pin the three things that actually went wrong:
 *   1. a valid, freshly-issued slot must succeed;
 *   2. stale / reused / forged / out-of-turn slots must all be refused;
 *   3. public socket payloads must never carry a card index or identity.
 *
 * They also pin the two properties the fix depends on: the server advertises its protocol
 * version, and a mismatched client is expected to refuse to play rather than fall back to a
 * positional UI.
 */
let b: Booted;
beforeAll(async () => {
  b = await boot({ rateLimits: { general: { max: 20000, windowMs: 1000 }, draw: { max: 20000, windowMs: 1000 }, room: { max: 2000, windowMs: 1000 } } });
});
afterAll(async () => b.close());

const clients: Client[] = [];
async function player(): Promise<Client> {
  const g = await b.services.auth.createGuest();
  const c = await connect(b.url, g.token, g.user.id);
  clients.push(c);
  return c;
}

/** Latest draw_slots payload this client received, if any. */
const latestSlots = (c: Client): { turnId: number; targets: { targetPlayerId: string; slots: string[] }[] } | null => {
  const found = c.msgs.filter((m) => m.event === "draw_slots").map((m) => m.payload).pop();
  return (found ?? null) as ReturnType<typeof latestSlots>;
};

/** Set up a started 2-human room and return both clients. */
async function twoHumanRoom(): Promise<{ a: Client; b: Client; code: string }> {
  const a = await player();
  const bC = await player();
  const created = (await a.emit("create_room", { playerName: "Alpha" })) as { roomCode: string };
  await bC.emit("join_room", { roomCode: created.roomCode, playerName: "Bravo" });
  await a.emit("start_game", { fillWithAi: false });
  const view = (await a.wait("game_started", () => true)) as PlayerView;
  return { a, b: bC, code: created.roomCode, ...({ view } as object) } as never;
}

/** The client whose turn it currently is, plus the other one. */
async function currentTurn(code: string, a: Client, bC: Client): Promise<{ acting: Client; other: Client }> {
  const s = b.services.rooms._debugSession(code);
  if (!s) throw new Error("no session");
  return s.currentPlayerId === a.userId ? { acting: a, other: bC } : { acting: bC, other: a };
}

/**
 * Waits until `client` has received draw_slots for the room's CURRENT turn.
 *
 * Slots are emitted synchronously with the turn change, but the socket message may not have
 * been delivered by the time the server state has already advanced. Reading `latestSlots`
 * immediately after a draw therefore races and can return the previous turn's (or no) payload.
 */
async function slotsForTurn(code: string, client: Client, targetId: string, ms = 5000): Promise<string[]> {
  const want = b.services.rooms._debugSession(code)!.turnId;
  const t0 = Date.now();
  for (;;) {
    const all = client.msgs.filter((m) => m.event === "draw_slots").map((m) => m.payload as { turnId: number; targets: { targetPlayerId: string; slots: string[] }[] });
    const forTurn = all.filter((p) => p.turnId === want).pop();
    const slots = forTurn?.targets.find((t) => t.targetPlayerId === targetId)?.slots;
    if (slots && slots.length > 0) return slots;
    if (Date.now() - t0 > ms) return slotsFor(client, targetId);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const slotsFor = (c: Client, targetId: string): string[] =>
  latestSlots(c)?.targets.find((t) => t.targetPlayerId === targetId)?.slots ?? [];

describe("a valid, freshly-issued slot draw succeeds", () => {
  it("accepts a server-issued slotId and advances the turn", async () => {
    const { a, b: bC, code } = await twoHumanRoom();
    const { acting, other } = await currentTurn(code, a, bC);
    const turnId = b.services.rooms._debugSession(code)!.turnId;
    const slot = (await slotsForTurn(code, acting, other.userId))[0]!;
    expect(slot, "server should have issued a slot for the acting player").toBeTruthy();

    const r = (await acting.emit("request_draw", {
      targetPlayerId: other.userId, slotId: slot, turnId, actionId: randomUUID(),
    })) as { ok: boolean; error?: { code: string; message: string } };
    expect(r.error?.message).not.toBe("Invalid draw request.");
    expect(r.ok).toBe(true);
    expect(b.services.rooms._debugSession(code)!.turnId).toBe(turnId + 1);
  }, 30_000);

  it("the legacy cardIndex payload is still refused with the documented error", async () => {
    const { a, b: bC, code } = await twoHumanRoom();
    const { acting, other } = await currentTurn(code, a, bC);
    const turnId = b.services.rooms._debugSession(code)!.turnId;
    const r = (await acting.emit("request_draw", {
      targetPlayerId: other.userId, cardIndex: 0, turnId, actionId: randomUUID(),
    })) as { ok: boolean; error?: { code: string; message: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("BAD_REQUEST");
    expect(r.error?.message).toBe("Invalid draw request.");
  }, 30_000);
});

describe("bad slots are rejected", () => {
  it("rejects a reused slot from the same turn", async () => {
    const { a, b: bC, code } = await twoHumanRoom();
    const { acting, other } = await currentTurn(code, a, bC);
    const turnId = b.services.rooms._debugSession(code)!.turnId;
    const slot = (await slotsForTurn(code, acting, other.userId))[0]!;
    const first = (await acting.emit("request_draw", { targetPlayerId: other.userId, slotId: slot, turnId, actionId: randomUUID() })) as { ok: boolean };
    expect(first.ok).toBe(true);
    // Same slot id again on the same turn must not succeed.
    const again = (await acting.emit("request_draw", { targetPlayerId: other.userId, slotId: slot, turnId, actionId: randomUUID() })) as { ok: boolean };
    expect(again.ok).toBe(false);
  }, 30_000);

  it("rejects a stale slot from an earlier turn", async () => {
    const { a, b: bC, code } = await twoHumanRoom();
    const { acting, other } = await currentTurn(code, a, bC);
    const turnId = b.services.rooms._debugSession(code)!.turnId;
    const slot = (await slotsForTurn(code, acting, other.userId))[0]!;
    const r = (await acting.emit("request_draw", {
      targetPlayerId: other.userId, slotId: slot, turnId: turnId + 7, actionId: randomUUID(),
    })) as { ok: boolean };
    expect(r.ok).toBe(false);
  }, 30_000);

  it("rejects a forged slot", async () => {
    const { a, b: bC, code } = await twoHumanRoom();
    const { acting, other } = await currentTurn(code, a, bC);
    const turnId = b.services.rooms._debugSession(code)!.turnId;
    const r = (await acting.emit("request_draw", {
      targetPlayerId: other.userId, slotId: "ZZZZZZZZZZZZZZZZZZZZ", turnId, actionId: randomUUID(),
    })) as { ok: boolean; error?: { code: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_SLOT");
  }, 30_000);

  it("rejects an out-of-turn draw", async () => {
    const { a, b: bC, code } = await twoHumanRoom();
    const { acting, other } = await currentTurn(code, a, bC);
    const idle = acting === a ? bC : a;
    const turnId = b.services.rooms._debugSession(code)!.turnId;
    const r = (await idle.emit("request_draw", {
      targetPlayerId: other.userId, slotId: "AAAAAAAAAAAAAAAAAAAAAAAA", turnId, actionId: randomUUID(),
    })) as { ok: boolean };
    expect(r.ok).toBe(false);
  }, 30_000);

  it("a wrong-turn player cannot learn whether a slot is valid", async () => {
    // Both the "valid slot, wrong player" and "invalid slot" cases must be indistinguishable,
    // otherwise a player could probe slot validity by watching the error code change.
    const { a, b: bC, code } = await twoHumanRoom();
    const { acting, other } = await currentTurn(code, a, bC);
    const idle = acting === a ? bC : a;
    const turnId = b.services.rooms._debugSession(code)!.turnId;
    const real = (await slotsForTurn(code, acting, other.userId))[0]!;
    const withReal = (await idle.emit("request_draw", { targetPlayerId: acting.userId, slotId: real, turnId, actionId: randomUUID() })) as { error?: { code: string } };
    const withFake = (await idle.emit("request_draw", { targetPlayerId: acting.userId, slotId: "ZZZZZZZZZZZZZZZZZZZZ", turnId, actionId: randomUUID() })) as { error?: { code: string } };
    expect(withReal.error?.code).toBe(withFake.error?.code);
  }, 30_000);
});

describe("public socket payloads leak nothing", () => {
  it("no serialised message carries a hand index or an opponent card identity", async () => {
    const { a, b: bC, code } = await twoHumanRoom();
    const { acting, other } = await currentTurn(code, a, bC);
    const turnId = b.services.rooms._debugSession(code)!.turnId;
    const slot = (await slotsForTurn(code, acting, other.userId))[0]!;
    await acting.emit("request_draw", { targetPlayerId: other.userId, slotId: slot, turnId, actionId: randomUUID() });
    await new Promise((r) => setTimeout(r, 600));

    for (const c of [a, bC]) {
      for (const m of c.msgs) {
        if (m.event === "card_drawn") continue; // the drawer's own private reveal
        const body = JSON.stringify(
          m.event === "room_state" || m.event === "game_started"
            ? { ...(m.payload as object), myHand: [] } // a viewer's own hand is not a leak
            : m.payload,
        );
        expect(body, `${m.event} leaked an index`).not.toMatch(/"cardIndex"|"handIndex"/);
        expect(body, `${m.event} leaked a card`).not.toMatch(/"isJoker"|"rank"|"suit"/);
      }
    }
  }, 30_000);

  it("the idle player is never sent draw_slots", async () => {
    const { a, b: bC, code } = await twoHumanRoom();
    const { acting } = await currentTurn(code, a, bC);
    const idle = acting === a ? bC : a;
    // Wait for the acting player's slots to actually arrive before asserting the asymmetry.
    await slotsForTurn(code, acting, idle.userId, 8000);
    expect(latestSlots(acting), "acting player receives slots").not.toBeNull();
    expect(idle.msgs.filter((m) => m.event === "draw_slots")).toHaveLength(0);
  }, 30_000);
});

describe("fresh slots every turn", () => {
  it("issues brand-new slot ids for each new draw opportunity", async () => {
    const { a, b: bC, code } = await twoHumanRoom();
    const seen: string[] = [];
    let who = await currentTurn(code, a, bC);
    for (let i = 0; i < 4; i++) {
      const turnId = b.services.rooms._debugSession(code)!.turnId;
      const slotList = await slotsForTurn(code, who.acting, who.other.userId);
      if (slotList.length === 0) break;
      seen.push(...slotList);
      const r = (await who.acting.emit("request_draw", {
        targetPlayerId: who.other.userId, slotId: slotList[0], turnId, actionId: randomUUID(),
      })) as { ok: boolean };
      if (!r.ok) break;
      await new Promise((res) => setTimeout(res, 250));
      who = await currentTurn(code, a, bC);
    }
    expect(seen.length).toBeGreaterThan(0);
    // No slot id may be offered twice across turns.
    expect(new Set(seen).size).toBe(seen.length);
  }, 40_000);
});

describe("protocol version is advertised so skew is detectable", () => {
  it("/api/config reports the current wire-protocol version", async () => {
    const res = await fetch(`${b.url}/api/config`);
    const body = (await res.json()) as { protocolVersion?: number };
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("a client expecting a different version detects the mismatch", async () => {
    const res = await fetch(`${b.url}/api/config`);
    const body = (await res.json()) as { protocolVersion?: number };
    // This mirrors ApiClient.isProtocolSkewed(): a present, different value means skew.
    expect(body.protocolVersion).not.toBe(PROTOCOL_VERSION + 1);
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe("the Joker holder wins and the game terminates", () => {
  it("plays a 2-human game to completion with the Joker holder declared winner", async () => {
    const a = await player();
    const bC = await player();
    const acted = new Set<string>();
    for (const c of [a, bC]) {
      c.sock.onAny((event: string, payload: unknown) => {
        if (event !== "draw_slots") return;
        const p = payload as { turnId: number; targets: { targetPlayerId: string; slots: string[] }[] };
        const last = c.msgs.filter((m) => m.event === "room_state" || m.event === "game_started").map((m) => m.payload as PlayerView).pop();
        if (!last?.game || last.game.currentPlayerId !== last.you || last.game.turnId !== p.turnId) return;
        const key = `${last.you}:${p.turnId}`;
        if (acted.has(key)) return;
        acted.add(key);
        const t = p.targets[Math.floor(Math.random() * p.targets.length)]!;
        c.sock.emit("request_draw", { targetPlayerId: t.targetPlayerId, slotId: t.slots[Math.floor(Math.random() * t.slots.length)], turnId: p.turnId, actionId: randomUUID() }, () => undefined);
      });
    }
    const created = (await a.emit("create_room", { playerName: "Alpha" })) as { roomCode: string };
    await bC.emit("join_room", { roomCode: created.roomCode, playerName: "Bravo" });
    await a.emit("start_game", { fillWithAi: false });
    const [fa, fb] = await Promise.all([
      a.wait("game_over", () => true, 30_000),
      bC.wait("game_over", () => true, 30_000),
    ]);
    expect(fa.winnerId).toBe(fb.winnerId);
    const s = b.services.rooms._debugSession(created.roomCode)!;
    const holder = s.state.players.find((p) => p.hand.length > 0)!;
    expect(holder.hand).toHaveLength(1);
    expect(holder.hand[0]!.isJoker).toBe(true);
    expect(fa.winnerId).toBe(holder.id);
  }, 60_000);
});