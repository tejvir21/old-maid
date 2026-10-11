import { describe, expect, it } from "vitest";
import { makeManager, legalDraw, CARD_LEAK } from "./helpers.js";

const pw = async () => makeManager({ codes: ["AAAAA", "BBBBB", "CCCCC"] });

async function lobby(n: number) {
  const ctx = await pw();
  const ids = Array.from({ length: n }, (_, i) => `u${i}`);
  const r = ctx.mgr.createRoom(ids[0]!, "Ryuji");
  if (!r.ok) throw new Error("create failed");
  const names = ["Ryuji", "Akira", "Ken", "Yuna", "Haru", "Sora", "Mika"];
  for (let i = 1; i < n; i++) {
    const j = ctx.mgr.joinRoom(ids[i]!, names[i]!, r.roomCode);
    if (!j.ok) throw new Error("join failed " + j.error.code);
  }
  return { ...ctx, code: r.roomCode, ids };
}

describe("room lifecycle", () => {
  it("creates a room with a valid code, the creator as host, and lobby state", async () => {
    const { mgr, emitter } = await pw();
    const r = mgr.createRoom("u0", "Ryuji");
    expect(r).toEqual({ ok: true, roomCode: "AAAAA" });
    const v = emitter.lastView("u0")!;
    expect(v.status).toBe("waiting");
    expect(v.isHost).toBe(true);
    expect(v.players).toHaveLength(1);
    expect(v.game).toBeNull();
  });

  it("generated room codes are 5 chars from the unambiguous alphabet and unique", async () => {
    const store = (await makeManager()).store;
    void store;
    const { RoomManager } = await import("../src/rooms/roomManager.js");
    const { SettingsService } = await import("../src/services/settingsService.js");
    const { MemoryActiveStateStore, MemoryStore } = await import("../src/store/memory.js");
    const { silentLogger } = await import("../src/util/logger.js");
    const { FakeEmitter, ManualScheduler } = await import("./helpers.js");
    const st = new MemoryStore(); const se = new SettingsService(st, silentLogger); await se.load();
    const m = new RoomManager({ store: st, active: new MemoryActiveStateStore(), settings: se, log: silentLogger, emitter: new FakeEmitter(), scheduler: new ManualScheduler() });
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = m.createRoom(`p${i}`, "Player");
      if (!r.ok) throw new Error("fail");
      expect(r.roomCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
      codes.add(r.roomCode);
    }
    expect(codes.size).toBe(200);
  });

  it("validates names, duplicate membership, unknown rooms, duplicate names", async () => {
    const { mgr } = await pw();
    expect(mgr.createRoom("u0", "x").ok).toBe(false);
    expect(mgr.createRoom("u0", "<script>").ok).toBe(false);
    const r = mgr.createRoom("u0", "Ryuji");
    if (!r.ok) throw new Error();
    expect(mgr.createRoom("u0", "Again")).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect(mgr.joinRoom("u1", "Akira", "ZZZZZ")).toMatchObject({ ok: false, error: { code: "ROOM_NOT_FOUND" } });
    expect(mgr.joinRoom("u1", "ryuji", r.roomCode)).toMatchObject({ ok: false, error: { code: "NAME_TAKEN" } });
    expect(mgr.joinRoom("u1", "Akira", r.roomCode).ok).toBe(true);
    // re-joining your own room is an idempotent resume
    expect(mgr.joinRoom("u1", "Akira", r.roomCode).ok).toBe(true);
    expect(mgr.getRoom(r.roomCode)!.players).toHaveLength(2);
  });

  it("rejects the 8th player (room full) and joins after start", async () => {
    const { mgr, code } = await lobby(7);
    expect(mgr.joinRoom("u7", "Extra", code)).toMatchObject({ ok: false, error: { code: "ROOM_FULL" } });
    expect(mgr.startGame("u0", {}).ok).toBe(true);
    expect(mgr.joinRoom("u8", "Late", code)).toMatchObject({ ok: false, error: { code: "GAME_ALREADY_STARTED" } });
  });

  it("only the host may start; 2–7 players; AI fill tops up to 7", async () => {
    const solo = await pw();
    const r = solo.mgr.createRoom("h", "Host");
    if (!r.ok) throw new Error();
    expect(solo.mgr.startGame("h", {})).toMatchObject({ ok: false, error: { code: "NOT_ENOUGH_PLAYERS" } });
    expect(solo.mgr.startGame("h", { fillWithAi: true }).ok).toBe(true);
    const v = solo.emitter.last("h", "game_started") as import("@old-maid/shared").PlayerView;
    expect(v.players).toHaveLength(7);
    expect(v.players.filter((p) => p.isAi)).toHaveLength(6);

    const { mgr, ids } = await lobby(3);
    expect(mgr.startGame(ids[1]!, {})).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
    expect(mgr.startGame(ids[0]!, { fillWithAi: false }).ok).toBe(true);
    expect(mgr.startGame(ids[0]!, {})).toMatchObject({ ok: false, error: { code: "GAME_ALREADY_STARTED" } });
  });

  it("AI fill can be disabled by admin settings", async () => {
    const { mgr, settings } = await pw();
    await settings.updateGame({ ...settings.getGame(), allowAiFill: false });
    mgr.createRoom("h", "Host");
    expect(mgr.startGame("h", { fillWithAi: true })).toMatchObject({ ok: false, error: { code: "FEATURE_DISABLED" } });
  });

  it("maintenance mode / disabled online feature blocks new rooms", async () => {
    const { mgr, settings } = await pw();
    await settings.updateSystem({ ...settings.getSystem(), maintenanceMode: true, allowNewGames: false });
    expect(mgr.createRoom("u0", "Ryuji")).toMatchObject({ ok: false, error: { code: "MAINTENANCE" } });
    await settings.updateSystem({ ...settings.getSystem(), maintenanceMode: false, allowNewGames: true });
    await settings.updateFlags({ onlineMultiplayer: false });
    expect(mgr.createRoom("u0", "Ryuji")).toMatchObject({ ok: false, error: { code: "FEATURE_DISABLED" } });
  });
});

describe("host management", () => {
  it("transfers host when the host leaves the lobby", async () => {
    const { mgr, emitter, code, ids } = await lobby(3);
    mgr.leaveRoom(ids[0]!);
    const v = emitter.lastView(ids[1]!)!;
    expect(v.hostId).toBe(ids[1]);
    expect(emitter.for(ids[1]!, "host_transferred")).toHaveLength(1);
    expect(mgr.getRoom(code)!.players).toHaveLength(2);
  });

  it("transfers host immediately when the host disconnects, without ending anything", async () => {
    const { mgr, emitter, ids, code } = await lobby(3);
    mgr.onDisconnect(ids[0]!);
    expect(mgr.getRoom(code)!.hostId).toBe(ids[1]);
    expect(emitter.last(ids[2]!, "host_transferred")).toMatchObject({ playerId: ids[1] });
    // old host reconnects: still a player, no longer host
    mgr.onConnect(ids[0]!);
    expect(emitter.lastView(ids[0]!)!.isHost).toBe(false);
  });

  it("removes a lobby player who stays disconnected past the timeout", async () => {
    const { mgr, scheduler, ids, code } = await lobby(3);
    mgr.onDisconnect(ids[2]!);
    scheduler.advance(59_000);
    expect(mgr.getRoom(code)!.players).toHaveLength(3);
    scheduler.advance(2_000);
    expect(mgr.getRoom(code)!.players).toHaveLength(2);
    expect(mgr.roomOf(ids[2]!)).toBeNull();
  });
});

describe("server authority + hidden information", () => {
  it("each player's view contains only their own hand; others only card counts", async () => {
    const { mgr, emitter, ids, code } = await lobby(4);
    mgr.startGame(ids[0]!, {});
    const sess = mgr._debugSession(code)!;
    for (const me of ids) {
      const v = emitter.for(me, "game_started")[0]!.args[0] as import("@old-maid/shared").PlayerView;
      expect(v.myHand.map((c) => c.id).sort()).toEqual(sess.hand(me).map((c) => c.id).sort());
      const others = ids.filter((x) => x !== me);
      const json = JSON.stringify({ ...v, myHand: [] });
      expect(json).not.toMatch(CARD_LEAK);
      for (const o of others) {
        for (const c of sess.hand(o)) expect(JSON.stringify(v)).not.toContain(`"${c.id}"`);
        expect(v.players.find((p) => p.id === o)!.cardCount).toBe(sess.cardCount(o));
      }
    }
  });

  it("only the drawer learns the card; public events carry no identities", async () => {
    const { mgr, emitter, ids, code } = await lobby(3);
    mgr.startGame(ids[0]!, {});
    emitter.clear();
    const s = mgr._debugSession(code)!;
    const actor = s.currentPlayerId;
    const r = mgr.requestDraw(actor, legalDraw(mgr, code, actor, "a1"));
    expect(r.ok).toBe(true);
    expect(emitter.for(actor, "card_drawn")).toHaveLength(1);
    for (const o of ids.filter((x) => x !== actor)) {
      expect(emitter.for(o, "card_drawn")).toHaveLength(0);
      for (const m of emitter.for(o).filter((x) => x.event !== "room_state")) expect(JSON.stringify(m.args)).not.toMatch(CARD_LEAK);
      const v = emitter.lastView(o)!;
      expect(JSON.stringify({ ...v, myHand: [] })).not.toMatch(CARD_LEAK);
    }
  });

  it("rejects out-of-turn, self, stale, bad index, bad target, and duplicate actions", async () => {
    const { mgr, ids, code } = await lobby(3);
    mgr.startGame(ids[0]!, {});
    const s = mgr._debugSession(code)!;
    const cur = s.currentPlayerId;
    const other = ids.find((i) => i !== cur)!;
    const base = legalDraw(mgr, code, cur, "x");
    const code_ = (r: ReturnType<typeof mgr.requestDraw>) => (r.ok ? "ok" : r.error.code);

    expect(code_(mgr.requestDraw(other, { ...legalDraw(mgr, code, other, "o1") }))).toBe("NOT_YOUR_TURN");
    expect(code_(mgr.requestDraw(cur, { ...base, actionId: "s1", targetPlayerId: cur }))).toBe("INVALID_TARGET");
    expect(code_(mgr.requestDraw(cur, { ...base, actionId: "s2", turnId: base.turnId + 5 }))).toBe("STALE_TURN");
    expect(code_(mgr.requestDraw(cur, { ...base, actionId: "s3", cardIndex: 99 }))).toBe("BAD_REQUEST"); // schema cap
    expect(code_(mgr.requestDraw(cur, { ...base, actionId: "s4", cardIndex: 40 }))).toBe("INVALID_CARD");
    expect(code_(mgr.requestDraw(cur, { ...base, actionId: "s5", cardIndex: -1 }))).toBe("BAD_REQUEST");
    expect(code_(mgr.requestDraw(cur, { ...base, actionId: "s6", targetPlayerId: "ghost" }))).toBe("INVALID_TARGET");
    expect(code_(mgr.requestDraw(cur, { ...base, actionId: "s7", cardIndex: 1.5 }))).toBe("BAD_REQUEST");
    expect(code_(mgr.requestDraw("stranger", base))).toBe("NOT_IN_ROOM");
    expect(code_(mgr.requestDraw(cur, { nonsense: true }))).toBe("BAD_REQUEST");

    expect(code_(mgr.requestDraw(cur, { ...base, actionId: "dup" }))).toBe("ok");
    expect(code_(mgr.requestDraw(cur, { ...base, actionId: "dup" }))).toBe("DUPLICATE_ACTION");
    // a retry of the old turn with a fresh action id is stale
    expect(code_(mgr.requestDraw(cur, { ...base, actionId: "dup2" }))).toBe("STALE_TURN");
  });

  it("cannot draw before the game starts or after it ended", async () => {
    const { mgr, ids } = await lobby(2);
    expect(mgr.requestDraw(ids[0]!, { targetPlayerId: ids[1], cardIndex: 0, turnId: 1, actionId: "a" })).toMatchObject({ ok: false });
  });
});

function playToEnd(ctx: Awaited<ReturnType<typeof lobby>>, onTurn?: () => void) {
  const { mgr, scheduler, code } = ctx;
  let guard = 0;
  while (mgr.getRoom(code)?.status === "playing") {
    if (++guard > 6000) throw new Error("did not finish");
    const s = mgr._debugSession(code)!;
    const cur = s.currentPlayerId;
    const room = mgr.getRoom(code)!;
    const p = room.players.find((x) => x.id === cur)!;
    if (!p.isAi && !room.pausedFor) {
      const r = mgr.requestDraw(cur, legalDraw(mgr, code, cur, `a${guard}`));
      if (!r.ok) throw new Error(r.error.code);
      onTurn?.();
    } else scheduler.advance(2_000);
  }
}

describe("full games", () => {
  it("human + 6 AI plays to completion; the Joker holder wins and is the only card left", async () => {
    const ctx = await pw();
    ctx.mgr.createRoom("h", "Ryuji");
    ctx.mgr.startGame("h", { fillWithAi: true, aiDifficulty: "hard" });
    playToEnd({ ...ctx, code: "AAAAA", ids: ["h"] });
    const s = ctx.mgr._debugSession("AAAAA")!;
    const holder = s.state.players.filter((p) => p.hand.length > 0);
    expect(holder).toHaveLength(1);
    expect(holder[0]!.hand[0]!.isJoker).toBe(true);
    expect(s.winnerId).toBe(holder[0]!.id);
    const v = ctx.emitter.lastView("h")!;
    expect(v.status).toBe("finished");
    expect(v.result).toEqual({ winnerId: holder[0]!.id, finalCard: "joker", abandoned: false });
    expect(ctx.emitter.last("h", "game_over")).toMatchObject({ winnerId: holder[0]!.id, finalCard: "joker" });
    // human stats recorded exactly once; AI never gets stats
    await new Promise((r) => setTimeout(r, 20));
    const st = await ctx.store.stats.get("h");
    expect(st.online.games).toBe(1);
    expect(st.online.wins + st.online.losses).toBe(1);
    expect(st.online.wins).toBe(holder[0]!.id === "h" ? 1 : 0);
    // lifecycle persisted: game finished + events stored, none containing card identities
    const g = [...ctx.store.data.games.values()][0]!;
    expect(g.status).toBe("finished");
    expect(g.winnerId).toBe(holder[0]!.id);
    expect(ctx.store.data.gameEvents.length).toBeGreaterThan(5);
    expect(JSON.stringify(ctx.store.data.gameEvents)).not.toMatch(/hearts|clubs|spades|diamonds/);
  });

  it("3 humans: every game ends with exactly one Joker holder; all others lose", async () => {
    for (let seed = 1; seed <= 6; seed++) {
      const ctx = await makeManager({ codes: ["AAAAA"], seed });
      ctx.mgr.createRoom("u0", "Ryuji"); ctx.mgr.joinRoom("u1", "Akira", "AAAAA"); ctx.mgr.joinRoom("u2", "Ken", "AAAAA");
      ctx.mgr.startGame("u0", {});
      playToEnd({ ...ctx, code: "AAAAA", ids: ["u0", "u1", "u2"] });
      const s = ctx.mgr._debugSession("AAAAA")!;
      const winners = s.state.players.filter((p) => p.hand.some((c) => c.isJoker));
      expect(winners).toHaveLength(1);
      expect(s.winnerId).toBe(winners[0]!.id);
      expect(s.state.players.reduce((n, p) => n + p.hand.length, 0)).toBe(1);
    }
  });

  it("rematch returns everyone to the lobby (AI removed) and a new game can start", async () => {
    const ctx = await pw();
    ctx.mgr.createRoom("h", "Ryuji"); ctx.mgr.joinRoom("g", "Akira", "AAAAA");
    ctx.mgr.startGame("h", { fillWithAi: true });
    playToEnd({ ...ctx, code: "AAAAA", ids: ["h", "g"] });
    expect(ctx.mgr.rematch("g")).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
    expect(ctx.mgr.rematch("h").ok).toBe(true);
    const v = ctx.emitter.lastView("g")!;
    expect(v.status).toBe("waiting");
    expect(v.players.map((p) => p.name).sort()).toEqual(["Akira", "Ryuji"]);
    expect(v.result).toBeNull();
    expect(ctx.mgr.startGame("h", {}).ok).toBe(true);
  });
});

describe("disconnect / reconnect", () => {
  it("pauses on the disconnected player's turn, restores their private hand, then resumes", async () => {
    const ctx = await lobby(3);
    const { mgr, emitter, scheduler, ids, code } = ctx;
    mgr.startGame(ids[0]!, {});
    const s = mgr._debugSession(code)!;
    const victim = s.currentPlayerId;
    const handBefore = s.hand(victim).map((c) => c.id);
    emitter.clear();
    mgr.onDisconnect(victim);
    expect(mgr.getRoom(code)!.pausedFor).toBe(victim);
    const watcher = ids.find((i) => i !== victim && mgr.getRoom(code)!.players.find((p) => p.id === i)!.connected)!;
    expect(emitter.last(watcher, "game_paused")).toMatchObject({ playerId: victim });
    expect(emitter.for(watcher, "player_disconnected")).toHaveLength(1);
    // nobody can act while paused
    expect(mgr.requestDraw(victim, legalDraw(mgr, code, victim, "p"))).toMatchObject({ ok: false });
    expect(mgr.requestDraw(watcher, legalDraw(mgr, code, watcher, "q"))).toMatchObject({ ok: false });
    scheduler.advance(120_000); // far past the reconnect window
    expect(mgr.getRoom(code)!.pausedFor).toBe(victim); // stays paused: no automatic decisions
    expect(emitter.last(watcher, "game_paused")).toMatchObject({ playerId: victim, secondsLeft: 0 });

    emitter.clear();
    mgr.onConnect(victim);
    expect(mgr.getRoom(code)!.pausedFor).toBeNull();
    expect(emitter.for(watcher, "game_resumed")).toHaveLength(1);
    expect(emitter.for(watcher, "player_reconnected")).toHaveLength(1);
    const restored = emitter.lastView(victim)!;
    expect(restored.myHand.map((c) => c.id)).toEqual(handBefore);
    expect(restored.game!.currentPlayerId).toBe(victim);
    expect(mgr.requestDraw(victim, legalDraw(mgr, code, victim, "ok1")).ok).toBe(true);
  });

  it("a disconnect on someone else's turn doesn't pause; it pauses when their turn arrives", async () => {
    const { mgr, ids, code } = await lobby(3);
    mgr.startGame(ids[0]!, {});
    const s = mgr._debugSession(code)!;
    const first = s.currentPlayerId;
    const next = s.state.players[(s.state.currentPlayerIndex + 1) % 3]!.id;
    mgr.onDisconnect(next);
    expect(mgr.getRoom(code)!.pausedFor).toBeNull();
    mgr.requestDraw(first, legalDraw(mgr, code, first, "t1"));
    if (!mgr._debugSession(code)!.finished && mgr._debugSession(code)!.currentPlayerId === next) {
      expect(mgr.getRoom(code)!.pausedFor).toBe(next);
    }
  });

  it("the host can end a paused match; it is recorded as abandoned with no winner", async () => {
    const { mgr, emitter, ids, code, store } = await lobby(3);
    mgr.startGame(ids[0]!, {});
    const s = mgr._debugSession(code)!;
    expect(mgr.endMatch(ids[0]!)).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } }); // not paused
    const victim = s.currentPlayerId;
    mgr.onDisconnect(victim);
    const host = mgr.getRoom(code)!.hostId;
    const stranger = ids.find((i) => i !== host)!;
    if (stranger !== host) expect(mgr.endMatch(stranger)).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
    expect(mgr.endMatch(host).ok).toBe(true);
    expect(emitter.lastView(host)!.result).toEqual({ winnerId: null, finalCard: null, abandoned: true });
    await new Promise((r) => setTimeout(r, 20));
    expect([...store.data.games.values()][0]!.status).toBe("abandoned");
  });

  it("a player who leaves mid-game is replaced by AI and the game still finishes", async () => {
    const ctx = await lobby(3);
    const { mgr, ids, code } = ctx;
    mgr.startGame(ids[0]!, {});
    mgr.leaveRoom(ids[2]!);
    expect(mgr.getRoom(code)!.players.find((p) => p.id === ids[2])!.isAi).toBe(true);
    playToEnd(ctx);
    expect(mgr.getRoom(code)!.status).toBe("finished");
  });

  it("if every human leaves a live game it is abandoned", async () => {
    const ctx = await lobby(2);
    ctx.mgr.startGame(ctx.ids[0]!, {});
    ctx.mgr.leaveRoom(ctx.ids[0]!);
    ctx.mgr.leaveRoom(ctx.ids[1]!);
    expect(ctx.mgr.getRoom(ctx.code)!.result).toEqual({ winnerId: null, abandoned: true });
  });
});

describe("timers + expiry", () => {
  it("auto-draws for a connected human who runs out of time", async () => {
    const ctx = await makeManager({ codes: ["AAAAA"], timing: { turnMs: 5_000 } });
    ctx.mgr.createRoom("u0", "Ryuji"); ctx.mgr.joinRoom("u1", "Akira", "AAAAA");
    ctx.mgr.startGame("u0", {});
    const s = ctx.mgr._debugSession("AAAAA")!;
    const turn = s.turnId;
    ctx.scheduler.advance(5_100);
    expect(s.turnId).toBeGreaterThan(turn);
    expect(ctx.emitter.for("u0", "server_notice").length + ctx.emitter.for("u1", "server_notice").length).toBeGreaterThan(0);
    // explicit, auditable rule: recorded as a timeout auto-draw, still followed by the normal public draw event
    const types = s.allEvents.map((e) => e.type);
    expect(types).toContain("timeout_auto_draw");
    expect(types.indexOf("timeout_auto_draw")).toBeLessThan(types.lastIndexOf("card_drawn"));
    const v = ctx.emitter.lastView("u0") ?? ctx.emitter.lastView("u1");
    expect(v!.events.some((e) => e.type === "timeout_auto_draw" && /ran out of time/.test(e.text))).toBe(true);
    // nothing hidden leaks through the timeout path
    expect(JSON.stringify(v!.events)).not.toMatch(/hearts|clubs|spades|diamonds|isJoker|"rank"/);
  });

  it("persists a TIMEOUT_AUTO_DRAW event type once the game is saved", async () => {
    const ctx = await makeManager({ codes: ["AAAAA"], timing: { turnMs: 5_000, aiDelayMinMs: 0, aiDelayMaxMs: 0 } });
    ctx.mgr.createRoom("u0", "Ryuji");
    ctx.mgr.startGame("u0", { fillWithAi: true });
    // let the human idle: every human turn times out, AI turns run on the manual clock
    let guard = 0;
    while (ctx.mgr.getRoom("AAAAA")!.status === "playing" && guard++ < 4000) ctx.scheduler.advance(5_100);
    await new Promise((r) => setTimeout(r, 20));
    const types = new Set(ctx.store.data.gameEvents.map((e) => e.type));
    expect(types.has("TIMEOUT_AUTO_DRAW")).toBe(true);
    expect(types.has("CARD_DRAWN")).toBe(true);
    expect([...types].every((t) => t === t.toUpperCase())).toBe(true);
  });

  it("expires rooms with no connected humans, and finished rooms", async () => {
    const ctx = await lobby(2);
    ctx.mgr.onDisconnect(ctx.ids[0]!); ctx.mgr.onDisconnect(ctx.ids[1]!);
    expect(ctx.mgr.sweep()).toBe(0);
    ctx.scheduler.advance(601_000);
    expect(ctx.mgr.sweep()).toBe(1);
    expect(ctx.mgr.getRoom(ctx.code)).toBeNull();

    const c2 = await pw();
    c2.mgr.createRoom("h", "Ryuji");
    c2.mgr.startGame("h", { fillWithAi: true });
    playToEnd({ ...c2, code: "AAAAA", ids: ["h"] });
    c2.scheduler.advance(601_000);
    expect(c2.mgr.sweep()).toBe(1);
    expect(c2.mgr.roomOf("h")).toBeNull();
  });
});

describe("chat + emotes", () => {
  it("sanitizes, length-limits and broadcasts; respects the admin toggle", async () => {
    const { mgr, emitter, ids, settings } = await lobby(2);
    expect(mgr.chat(ids[0]!, { text: "hi <b>there</b>\u0000   you" }).ok).toBe(true);
    expect((emitter.last(ids[1]!, "chat_message") as { text: string }).text).toBe("hi bthere/b you");
    expect(mgr.chat(ids[0]!, { text: "x".repeat(201) })).toMatchObject({ ok: false });
    expect(mgr.chat(ids[0]!, { text: "   " })).toMatchObject({ ok: false });
    expect(mgr.chat("stranger", { text: "hi" })).toMatchObject({ ok: false, error: { code: "NOT_IN_ROOM" } });
    expect(mgr.emote(ids[0]!, { emote: "😏" }).ok).toBe(true);
    expect(mgr.emote(ids[0]!, { emote: "💣" })).toMatchObject({ ok: false });
    await settings.updateFlags({ chat: false });
    expect(mgr.chat(ids[0]!, { text: "hi" })).toMatchObject({ ok: false, error: { code: "FEATURE_DISABLED" } });
  });
});
