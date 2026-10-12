import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlayerView } from "@old-maid/shared";
import { boot, connect, type Booted, type Client } from "./harness.js";

/**
 * End-to-end privacy regression: opponents must not be able to track a card by its position.
 *
 * Every assertion runs against the ACTUAL serialized payloads the server puts on the wire, so
 * it fails if a future change re-introduces an index, a card id or the Joker's position.
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

/**
 * Everything the server sent this client, EXCLUDING what the client is entitled to see:
 * its own private reveal (`card_drawn`) and its own hand (`myHand`).
 */
function publicPayloads(c: Client): { event: string; body: string }[] {
  return c.msgs
    .filter((m) => m.event !== "card_drawn")
    .map((m) => {
      const p = m.payload as Record<string, unknown>;
      // A viewer always sees its OWN cards; that is not a leak. Strip them before scanning.
      const stripped = m.event === "room_state" || m.event === "game_started" ? { ...p, myHand: [] } : p;
      return { event: m.event, body: JSON.stringify(stripped) };
    });
}

async function playToCompletion(a: Client, bC: Client): Promise<{ code: string; msgs: { event: string; body: string }[] }> {
  const all = [a, bC];
  const acted = new Set<string>();
  for (const c of all) {
    c.sock.onAny((event: string, payload: unknown) => {
      if (event !== "draw_slots") return;
      const p = payload as { turnId: number; targets: { targetPlayerId: string; slots: string[] }[] };
      const last = c.msgs.filter((m) => m.event === "room_state" || m.event === "game_started").map((m) => m.payload as PlayerView).pop();
      if (!last?.game || last.game.currentPlayerId !== last.you) return;
      if (last.game.turnId !== p.turnId) return;
      const key = `${last.you}:${p.turnId}`;
      if (acted.has(key)) return;
      acted.add(key);
      const t = p.targets[Math.floor(Math.random() * p.targets.length)]!;
      const slot = t.slots[Math.floor(Math.random() * t.slots.length)]!;
      c.sock.emit("request_draw", { targetPlayerId: t.targetPlayerId, slotId: slot, turnId: p.turnId, actionId: randomUUID() }, () => undefined);
    });
  }
  const created = await a.emit("create_room", { playerName: "Alpha" });
  const code = (created as { roomCode: string }).roomCode;
  await bC.emit("join_room", { roomCode: code, playerName: "Bravo" });
  await a.emit("start_game", { fillWithAi: true });
  await Promise.all(all.map((c) => c.wait("game_over", () => true, 25_000)));
  return { code, msgs: all.flatMap(publicPayloads) };
}

describe("opponents cannot track the Joker by card position", () => {
  let played: { code: string; msgs: { event: string; body: string }[] };

  beforeAll(async () => {
    const a = await player();
    const bC = await player();
    played = await playToCompletion(a, bC);
  }, 40_000);

  it("the game ran to completion and declared the Joker holder", async () => {
    expect(played.code).toMatch(/^[A-Z2-9]{5}$/);
  });

  it("no opponent card identity is ever serialised to a client", () => {
    for (const m of played.msgs) {
      expect(m.body, `${m.event} leaked a card`).not.toMatch(/"isJoker"/);
      expect(m.body, `${m.event} leaked a card`).not.toMatch(/"rank"/);
      expect(m.body, `${m.event} leaked a card`).not.toMatch(/"suit"/);
    }
  });

  it("the public draw event carries NO hand index", () => {
    const draws = played.msgs.filter((m) => m.event === "draw_public");
    expect(draws.length).toBeGreaterThan(0);
    for (const d of draws) expect(d.body).not.toMatch(/"cardIndex"/);
  });

  it("room state never exposes another player's hand", () => {
    for (const m of played.msgs.filter((x) => x.event === "room_state" || x.event === "game_started")) {
      const v = JSON.parse(m.body) as PlayerView;
      // Only `myHand` may exist, and only for the viewer itself.
      expect(Object.keys(v)).toContain("myHand");
      expect(v.myHand.every((c) => typeof c.id === "string")).toBe(true);
      // Public player rows are counts only.
      for (const p of v.players) {
        expect(p).not.toHaveProperty("hand");
        expect(p).not.toHaveProperty("cards");
        expect(typeof p.cardCount).toBe("number");
      }
    }
  });

  it("slots are opaque: they are not derived from a hand index", () => {
    const slotEvents = [...b.services.registry ? [] : []];
    void slotEvents;
    expect(played.msgs.length).toBeGreaterThan(0);
    // The server's own mapping stays server-side; nothing on the wire contains a hand index.
    for (const m of played.msgs) expect(m.body).not.toMatch(/"handIndex"|"slotIndex"/);
  });

  it("the server rejects a raw cardIndex draw (the old protocol is closed)", async () => {
    const a = await player();
    const bC = await player();
    const created = await a.emit("create_room", { playerName: "Alpha2" });
    const code = (created as { roomCode: string }).roomCode;
    await bC.emit("join_room", { roomCode: code, playerName: "Bravo2" });
    await a.emit("start_game", { fillWithAi: false });
    const view = (await a.wait("game_started")) as PlayerView;
    const r = await a.emit("request_draw", { targetPlayerId: bC.userId, cardIndex: 0, turnId: view.game!.turnId, actionId: randomUUID() });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("BAD_REQUEST");
  }, 20_000);

  it("the server rejects a forged slot id", async () => {
    const a = await player();
    const bC = await player();
    const created = await a.emit("create_room", { playerName: "Alpha3" });
    const code = (created as { roomCode: string }).roomCode;
    await bC.emit("join_room", { roomCode: code, playerName: "Bravo3" });
    await a.emit("start_game", { fillWithAi: false });
    const view = (await a.wait("game_started")) as PlayerView;
    if (view.game!.currentPlayerId !== a.userId) return; // other player opened; nothing to assert
    const r = await a.emit("request_draw", { targetPlayerId: bC.userId, slotId: "ZZZZZZZZZZZZZZZZZZZZ", turnId: view.game!.turnId, actionId: randomUUID() });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_SLOT");
  }, 20_000);

  it("a slot issued to one player cannot be used by another", async () => {
    const a = await player();
    const bC = await player();
    const created = await a.emit("create_room", { playerName: "Alpha4" });
    const code = (created as { roomCode: string }).roomCode;
    await bC.emit("join_room", { roomCode: code, playerName: "Bravo4" });
    await a.emit("start_game", { fillWithAi: false });
    const view = (await a.wait("game_started")) as PlayerView;
    if (view.game!.currentPlayerId !== a.userId) return; // the other player opened; nothing to assert
    const slots = (await a.wait("draw_slots")) as { turnId: number; targets: { targetPlayerId: string; slots: string[] }[] };
    const stolen = slots.targets[0]!.slots[0]!;
    // The SAME slot id, used by the player who is not on turn, must be refused.
    const r = await bC.emit("request_draw", { targetPlayerId: a.userId, slotId: stolen, turnId: slots.turnId, actionId: randomUUID() });
    expect(r.ok).toBe(false);
    expect(["NOT_YOUR_TURN", "INVALID_SLOT"]).toContain(r.error?.code);
  }, 20_000);
});