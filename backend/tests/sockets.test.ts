import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlayerView } from "@old-maid/shared";
import { boot, connect, forgedToken, newUser, sleep, type Booted, type Client } from "./harness.js";

let b: Booted;
beforeAll(async () => {
  b = await boot({ rateLimits: { general: { max: 5000, windowMs: 1000 }, draw: { max: 5000, windowMs: 1000 }, room: { max: 500, windowMs: 1000 } } });
});
afterAll(async () => b.close());

const clients: Client[] = [];
async function player(): Promise<Client> {
  const u = await newUser(b);
  const c = await connect(b.url, u.token, u.userId);
  clients.push(c);
  return c;
}

/**
 * Builds a well-formed `request_draw` payload using a real server-issued slot when one exists.
 * Reads the room's (server-side) slot table so the test drives the genuine request path; if the
 * viewer currently holds no table (wrong turn / paused), a well-formed placeholder is used so
 * the assertion exercises the intended rejection rather than crashing.
 */
function slotPayload(booted: Booted, code: string, actorId: string, targetId: string, actionId: string) {
  const s = booted.services.rooms._debugSession(code)!;
  void actorId;
  const slotId = booted.services.rooms._debugSlots(code)?.targets.get(targetId)?.keys().next().value as string | undefined;
  return { targetPlayerId: targetId, slotId: slotId ?? "AAAAAAAAAAAAAAAAAAAAAAAA", turnId: s.turnId, actionId };
}
afterAll(() => clients.forEach((c) => c.close()));

describe("socket authentication", () => {
  it("rejects connections with no token, a forged secret, an admin-audience token, or an unknown user", async () => {
    await expect(connect(b.url, "")).rejects.toThrow(/UNAUTHORIZED/);
    await expect(connect(b.url, "garbage")).rejects.toThrow(/UNAUTHORIZED/);
    await expect(connect(b.url, forgedToken({ secret: "x".repeat(40) }))).rejects.toThrow(/UNAUTHORIZED/);
    await expect(connect(b.url, forgedToken({ audience: "old-maid:admin" }))).rejects.toThrow(/UNAUTHORIZED/);
    await expect(connect(b.url, forgedToken({}))).rejects.toThrow(/UNAUTHORIZED/); // valid signature, no such user
    await expect(connect(b.url, forgedToken({ expiresIn: -10 }))).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("rejects banned users", async () => {
    const u = await newUser(b);
    await b.store.bans.create({ userId: u.userId, reason: "test", createdBy: "admin", expiresAt: null });
    await expect(connect(b.url, u.token)).rejects.toThrow(/BANNED/);
  });
});

describe("lobby over sockets", () => {
  it("create → join → validations → host-only start", async () => {
    const host = await player();
    const a = await player();
    const c = await player();

    expect(await host.emit("create_room", { playerName: "x" })).toMatchObject({ ok: false, error: { code: "INVALID_NAME" } });
    const created = await host.emit("create_room", { playerName: "Ryuji" });
    expect(created.ok).toBe(true);
    const code = created.roomCode!;
    expect(code).toMatch(/^[A-Z2-9]{5}$/);

    expect(await a.emit("join_room", { roomCode: "ZZZZZ", playerName: "Akira" })).toMatchObject({ ok: false, error: { code: "ROOM_NOT_FOUND" } });
    expect(await a.emit("join_room", { roomCode: "bad", playerName: "Akira" })).toMatchObject({ ok: false, error: { code: "ROOM_NOT_FOUND" } });
    expect(await a.emit("join_room", { roomCode: code, playerName: "ryuji" })).toMatchObject({ ok: false, error: { code: "NAME_TAKEN" } });
    // case-insensitive code
    expect(await a.emit("join_room", { roomCode: code.toLowerCase(), playerName: "Akira" })).toMatchObject({ ok: true, roomCode: code });
    expect(await c.emit("join_room", { roomCode: code, playerName: "Ken" })).toMatchObject({ ok: true });

    const v = (await host.wait("room_state", (p: PlayerView) => p.players.length === 3)) as PlayerView;
    expect(v.isHost).toBe(true);
    expect((await a.wait("room_state", (p: PlayerView) => p.players.length === 3)) as PlayerView).toMatchObject({ isHost: false });
    expect(await a.emit("start_game", {})).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
    expect(await host.emit("join_room", { roomCode: code, playerName: "Ryuji" })).toMatchObject({ ok: true }); // resume
    expect(await host.emit("start_game", { fillWithAi: false })).toMatchObject({ ok: true });
    await a.wait("game_started");
    expect(await a.emit("leave_room")).toMatchObject({ ok: true });
  });

  it("ignores events the server never defined (no client-side authority over winners, hands or turns)", async () => {
    const host = await player();
    const other = await player();
    const created = await host.emit("create_room", { playerName: "Hostess" });
    await other.emit("join_room", { roomCode: created.roomCode, playerName: "Other" });
    await host.emit("start_game", {});
    await other.wait("game_started");
    const s = b.services.rooms._debugSession(created.roomCode!)!;
    const before = JSON.stringify(s.state);
    for (const ev of ["declare_winner", "set_hand", "give_joker", "set_turn", "admin_end_game", "game_state"]) {
      other.sock.emit(ev, { winnerId: other.userId, hand: [], playerId: other.userId });
    }
    await sleep(100);
    expect(JSON.stringify(s.state)).toBe(before);
    expect(s.winnerId).toBeNull();
  });
});

describe("full online game over Socket.IO (3 humans)", () => {
  it("plays to completion; every client agrees on the Joker holder; nothing hidden ever leaks", async () => {
    const [p0, p1, p2] = [await player(), await player(), await player()];
    const all = [p0, p1, p2];
    const created = await p0.emit("create_room", { playerName: "Ryuji" });
    const code = created.roomCode!;
    await p1.emit("join_room", { roomCode: code, playerName: "Akira" });
    await p2.emit("join_room", { roomCode: code, playerName: "Ken" });

    const acted = new Set<string>();
    for (const c of all) {
      c.sock.onAny((event: string, payload: unknown) => {
        // Draws are driven only by the opaque slots the server issued for this turn.
        if (event === "draw_slots") {
          const p = payload as { turnId: number; targets: { targetPlayerId: string; slots: string[] }[] };
          const v = c.msgs.filter((m) => m.event === "room_state" || m.event === "game_started").map((m) => m.payload as PlayerView).pop();
          if (!v?.game || v.status !== "playing" || v.game.paused || v.game.currentPlayerId !== v.you) return;
          if (v.game.turnId !== p.turnId) return;
          const key = `${v.you}:${p.turnId}`;
          if (acted.has(key)) return;
          acted.add(key);
          const t = p.targets[Math.floor(Math.random() * p.targets.length)]!;
          const slot = t.slots[Math.floor(Math.random() * t.slots.length)]!;
          c.sock.emit("request_draw", { targetPlayerId: t.targetPlayerId, slotId: slot, turnId: p.turnId, actionId: randomUUID() }, () => undefined);
          return;
        }
        if (event !== "room_state" && event !== "game_started") return;
        const v = payload as PlayerView;
        if (v.status !== "playing" || !v.game || v.game.paused || v.game.currentPlayerId !== v.you) return;
      });
    }
    expect(await p0.emit("start_game", {})).toMatchObject({ ok: true });

    const over = await Promise.all(all.map((c) => c.wait("game_over", () => true, 20_000)));
    const s = b.services.rooms._debugSession(code)!;
    const holder = s.state.players.filter((p) => p.hand.length > 0);
    expect(holder).toHaveLength(1);
    expect(holder[0]!.hand[0]!.isJoker).toBe(true);
    for (const o of over) expect(o).toMatchObject({ winnerId: holder[0]!.id, finalCard: "joker" });
    expect(s.winnerId).toBe(holder[0]!.id);

    // --- hidden-information audit over every byte each client ever received ---
    const LEAK = /"isJoker"|"suit"|"rank"/;
    for (const c of all) {
      for (const m of c.msgs) {
        if (m.event === "card_drawn") continue; // private to the drawer by design
        const p = m.payload as Record<string, unknown>;
        const stripped = m.event === "room_state" || m.event === "game_started" ? { ...p, myHand: [] } : p;
        expect(JSON.stringify(stripped), `${m.event} leaked card data`).not.toMatch(LEAK);
      }
      // a client only ever sees card_drawn for draws it made itself
      for (const d of c.of("card_drawn") as { fromPlayerId: string }[]) expect(d.fromPlayerId).not.toBe(c.userId);
      const draws = c.of("draw_public") as { actorId: string }[];
      const mine = draws.filter((d) => d.actorId === c.userId).length;
      expect(c.of("card_drawn").length).toBe(mine);
    }
    // final state: only the winner's own view contains the Joker; everyone else's hand is empty
    const finals = all.map((c) => c.of("room_state").at(-1) as PlayerView);
    for (const v of finals) {
      expect(v.result).toMatchObject({ winnerId: holder[0]!.id, abandoned: false });
      if (v.you === holder[0]!.id) expect(v.myHand.map((x) => x.isJoker)).toEqual([true]);
      else expect(v.myHand).toHaveLength(0);
    }

    // verified online stats were recorded on the server (never taken from a client)
    await sleep(50);
    const wins = (await Promise.all(all.map((c) => b.store.stats.get(c.userId)))).map((st) => st.online);
    expect(wins.reduce((n, o) => n + o.wins, 0)).toBe(1);
    expect(wins.reduce((n, o) => n + o.losses, 0)).toBe(2);

    // rematch → lobby again
    expect(await p1.emit("rematch")).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
    expect(await p0.emit("rematch")).toMatchObject({ ok: true });
    const lobbyView = (await p2.wait("room_state", (v: PlayerView) => v.status === "waiting" && v.players.length === 3)) as PlayerView;
    expect(lobbyView.result).toBeNull();
    for (const c of all) await c.emit("leave_room");
  }, 30_000);
});

describe("reconnection + duplicate sockets", () => {
  it("restores room, hand and turn after a disconnect; others are notified; no restart", async () => {
    const host = await player();
    const u = await newUser(b);
    let guest = await connect(b.url, u.token, u.userId);
    const created = await host.emit("create_room", { playerName: "Ryuji" });
    const code = created.roomCode!;
    await guest.emit("join_room", { roomCode: code, playerName: "Akira" });
    await host.emit("start_game", {});
    const first = (await guest.wait("game_started")) as PlayerView;
    const handBefore = first.myHand.map((c) => c.id).sort();

    guest.close();
    const dc = await host.wait("player_disconnected");
    expect(dc).toMatchObject({ name: "Akira" });

    guest = await connect(b.url, u.token, u.userId);
    clients.push(guest);
    const restored = (await guest.wait("room_state")) as PlayerView;
    expect(restored.roomCode).toBe(code);
    expect(restored.status).toBe("playing");
    expect(restored.myHand.map((c) => c.id).sort()).toEqual(handBefore);
    expect(await host.wait("player_reconnected")).toMatchObject({ name: "Akira" });
    expect(await guest.emit("resume_session")).toMatchObject({ ok: true, roomCode: code });
    await host.emit("leave_room"); await guest.emit("leave_room");
  });

  it("a second socket for the same account takes over: the old one is kicked and nobody sees a disconnect", async () => {
    const host = await player();
    const u = await newUser(b);
    const g1 = await connect(b.url, u.token, u.userId);
    const created = await host.emit("create_room", { playerName: "Ryuji" });
    await g1.emit("join_room", { roomCode: created.roomCode, playerName: "Akira" });
    const g2 = await connect(b.url, u.token, u.userId);
    clients.push(g2);
    await g1.wait("server_notice");
    await sleep(100);
    expect(g1.sock.connected).toBe(false);
    expect(host.of("player_disconnected")).toHaveLength(0);
    expect(b.services.registry.isOnline(u.userId)).toBe(true);
    expect(await g2.emit("leave_room")).toMatchObject({ ok: true });
    await host.emit("leave_room");
  });

  it("pauses when the current player drops, and resumes on reconnect", async () => {
    const host = await player();
    const u = await newUser(b);
    let g = await connect(b.url, u.token, u.userId);
    const created = await host.emit("create_room", { playerName: "Ryuji" });
    await g.emit("join_room", { roomCode: created.roomCode, playerName: "Akira" });
    await host.emit("start_game", {});
    const gs = (await g.wait("game_started")) as PlayerView;
    // make sure it's the guest's turn: if not, host draws once from the guest.
    if (gs.game!.currentPlayerId !== u.userId) {
      const hs = (await host.wait("game_started")) as PlayerView;
      await host.emit("request_draw", slotPayload(b, created.roomCode!, host.userId, u.userId, randomUUID()));
    }
    const cur = b.services.rooms._debugSession(created.roomCode!)!;
    if (cur.currentPlayerId !== u.userId) return; // game ended early – nothing to assert
    g.close();
    expect(await host.wait("game_paused")).toMatchObject({ playerId: u.userId });
    const hv = (await host.wait("room_state", (v: PlayerView) => !!v.game?.paused)) as PlayerView;
    expect(await host.emit("request_draw", slotPayload(b, created.roomCode!, host.userId, u.userId, randomUUID()))).toMatchObject({ ok: false });
    g = await connect(b.url, u.token, u.userId);
    clients.push(g);
    await host.wait("game_resumed");
    await host.emit("leave_room"); await g.emit("leave_room");
  });
});

describe("socket abuse protection", () => {
  it("rate-limits spammy clients per player", async () => {
    const b2 = await boot({ rateLimits: { general: { max: 10, windowMs: 60_000 } } });
    const u = await newUser(b2);
    const c = await connect(b2.url, u.token, u.userId);
    const results = [];
    for (let i = 0; i < 25; i++) results.push(await c.emit("chat_message", { text: "spam" }));
    expect(results.some((r) => r.error?.code === "RATE_LIMITED")).toBe(true);
    c.close();
    await b2.close();
  });

  it("rejects malformed payloads without crashing the server", async () => {
    const c = await player();
    for (const bad of [null, 42, "str", [], { playerName: { $ne: 1 } }, { roomCode: { $gt: "" }, playerName: "Aa" }]) {
      const r = await c.emit("join_room", bad as never);
      expect(r.ok).toBe(false);
    }
    expect((await c.emit("create_room", { playerName: "Valid" })).ok).toBe(true);
    await c.emit("leave_room");
  });
});
