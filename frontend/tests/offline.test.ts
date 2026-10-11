import { afterEach, describe, expect, it, vi } from "vitest";
import { seededRng } from "@old-maid/shared";
import { HUMAN_ID, OfflineGame } from "../src/game/offlineGame";
import { OfflineSession } from "../src/game/offlineSession";
import { openDatabase, Repo } from "../src/offline/db";
import { makeSession, ManualScheduler, playOut, uniqueDb } from "./helpers";

const cfg = (aiCount: number, level: "easy" | "normal" | "hard") => ({ humanName: "Ryuji", aiCount, level, localPlayerId: "local-1234" });
afterEach(() => vi.restoreAllMocks());

describe("offline AI games (easy / normal / hard)", () => {
  for (const level of ["easy", "normal", "hard"] as const) {
    for (const ai of [1, 3, 6]) {
      it(`${level} vs ${ai} AI: completes; Joker holder is the winner; result stored atomically`, async () => {
        const ctx = await makeSession(uniqueDb(), 100 + ai);
        await ctx.session.start(cfg(ai, level));
        await playOut(ctx);
        const g = ctx.session.current!;
        const holders = g.state.players.filter((p) => p.hand.length > 0);
        expect(holders).toHaveLength(1);
        expect(holders[0]!.hand).toHaveLength(1);
        expect(holders[0]!.hand[0]!.isJoker).toBe(true);
        expect(g.winnerId).toBe(holders[0]!.id);

        const games = await ctx.repo.listGames();
        expect(games).toHaveLength(1);
        const rec = games[0]!;
        expect(rec).toMatchObject({ mode: "offline-ai", aiDifficulty: level, playerCount: ai + 1, syncStatus: "pending", result: g.humanWon ? "win" : "loss" });
        expect(rec.durationSeconds).toBeGreaterThanOrEqual(1);
        // must satisfy the server's plausibility rule so a real result is never rejected
        expect(rec.durationSeconds).toBeGreaterThanOrEqual(rec.turnCount * 0.15);
        expect(rec.turnCount).toBe(g.state.drawCount);
        expect(await ctx.repo.loadActive()).toBeNull();
        const q = await ctx.repo.queueAll();
        expect(q.filter((i) => i.type === "GAME_RESULT")).toHaveLength(1);
        expect(q[0]!.id).toBe(rec.localGameId);
        const st = (await ctx.repo.getStats()).offline;
        expect(st.games).toBe(1);
        expect(st.wins).toBe(g.humanWon ? 1 : 0);
        expect((await ctx.repo.getGameEvents(rec.localGameId)).length).toBeGreaterThan(3);
      });
    }
  }

  it("human goes first or later; AI turns wait for the thinking delay", async () => {
    const ctx = await makeSession(uniqueDb(), 5);
    await ctx.session.start(cfg(3, "normal"));
    const g = ctx.session.current!;
    if (!g.isHumanTurn) {
      const before = g.state.drawCount;
      ctx.scheduler.advance(999);
      await ctx.session.idle();
      expect(g.state.drawCount).toBe(before); // not yet
      ctx.scheduler.advance(2);
      await ctx.session.idle();
      expect(g.state.drawCount).toBeGreaterThan(before);
    }
  });
});

describe("no network is required for offline play", () => {
  it("plays complete games without touching fetch / XHR / WebSocket / EventSource", async () => {
    const calls: string[] = [];
    const trap = (name: string) => () => { calls.push(name); throw new Error(`network used: ${name}`); };
    vi.stubGlobal("fetch", trap("fetch"));
    vi.stubGlobal("XMLHttpRequest", trap("xhr"));
    vi.stubGlobal("WebSocket", trap("websocket"));
    vi.stubGlobal("EventSource", trap("eventsource"));
    vi.stubGlobal("navigator", { onLine: false });
    const ctx = await makeSession(uniqueDb(), 21);
    await ctx.session.start(cfg(6, "hard"));
    await playOut(ctx);
    expect(ctx.session.current!.finished).toBe(true);
    expect(calls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("the offline game modules import no network code", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/game/offlineGame.ts", "src/game/offlineSession.ts", "src/offline/db.ts"]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/socket\.io|fetch\(|XMLHttpRequest|WebSocket|\/sync\/|\.\.\/socket|\.\.\/net\/network/);
    }
  });
});

describe("survives closing and re-opening the browser", () => {
  it("resumes the exact in-progress game from IndexedDB and can finish it", async () => {
    const sched = new ManualScheduler();
    const a = await makeSession(uniqueDb(), 33, sched);
    await a.session.start(cfg(4, "normal"));
    // play a few moves
    for (let i = 0; i < 12 && !a.session.current!.finished; i++) {
      const g = a.session.current!;
      if (g.isHumanTurn) { const t = g.state.players.find((p) => p.id !== HUMAN_ID && p.hand.length > 0)!; await a.session.humanDraw(t.id, 0); }
      else { sched.advance(1001); await a.session.idle(); }
    }
    expect(a.session.current!.finished).toBe(false);
    await a.session.idle();
    const frozen = JSON.stringify(a.session.current!.state);
    const handBefore = a.session.current!.hand(HUMAN_ID).map((c) => c.id);
    a.session.dispose();
    a.repo.close(); // "browser closed"

    const db2 = await openDatabase(a.dbName); // "browser reopened"
    const repo2 = new Repo(db2, () => sched.now());
    const s2 = new OfflineSession({ repo: repo2, scheduler: sched, rng: seededRng(99), aiDelay: () => 1000, onUpdate: () => undefined });
    expect(await s2.resume()).toBe(true);
    expect(JSON.stringify(s2.current!.state)).toBe(frozen);
    expect(s2.current!.hand(HUMAN_ID).map((c) => c.id)).toEqual(handBefore);
    await playOut({ session: s2, scheduler: sched } as never);
    expect(s2.current!.finished).toBe(true);
    expect(await repo2.listGames()).toHaveLength(1);
    expect(await repo2.loadActive()).toBeNull();
  });

  it("returns false when there is nothing to resume, and abandon() records nothing", async () => {
    const ctx = await makeSession();
    expect(await ctx.session.resume()).toBe(false);
    await ctx.session.start(cfg(2, "easy"));
    await ctx.session.abandon();
    expect(await ctx.repo.loadActive()).toBeNull();
    expect((await ctx.repo.getStats()).offline.games).toBe(0);
    expect(await ctx.repo.queueAll()).toHaveLength(0);
  });
});

describe("persistence: stats, settings, queue, achievements", () => {
  it("statistics, game history, achievements and the sync queue persist across reopen", async () => {
    const ctx = await makeSession(uniqueDb(), 7);
    await ctx.session.start(cfg(2, "hard"));
    await playOut(ctx);
    const before = { stats: await ctx.repo.getStats(), q: await ctx.repo.queueAll(), g: await ctx.repo.listGames() };
    ctx.repo.close();
    const repo2 = new Repo(await openDatabase(ctx.dbName));
    expect(await repo2.getStats()).toEqual(before.stats);
    expect(await repo2.queueAll()).toEqual(before.q);
    expect(await repo2.listGames()).toEqual(before.g);
    expect((await repo2.getAchievements()).map((a) => a.id)).toContain("first_game");
    expect(before.q[0]!.status).toBe("pending");
  });

  it("recording the same finished game twice never double-counts (idempotent)", async () => {
    const ctx = await makeSession(uniqueDb(), 8);
    await ctx.session.start(cfg(2, "easy"));
    await playOut(ctx);
    const g = ctx.session.current!;
    const rec = g.toRecord(ctx.scheduler.now());
    await ctx.repo.finishOfflineGame(rec, g.storedEvents());
    await ctx.repo.finishOfflineGame(rec, g.storedEvents());
    expect((await ctx.repo.getStats()).offline.games).toBe(1);
    expect((await ctx.repo.queueAll()).filter((i) => i.type === "GAME_RESULT")).toHaveLength(1);
  });

  it("settings persist, and pending settings uploads are coalesced to the latest value", async () => {
    const ctx = await makeSession();
    await ctx.repo.saveSettings({ sound: false });
    await ctx.repo.saveSettings({ theme: "ember", aiPlayers: 3, debug: true });
    const s = await ctx.repo.getSettings();
    expect(s.values).toMatchObject({ sound: false, theme: "ember", aiPlayers: 3, debug: true });
    const pending = (await ctx.repo.queueAll()).filter((i) => i.type === "SETTINGS_UPDATE");
    expect(pending).toHaveLength(1);
    const payload = pending[0]!.payload as { settings: Record<string, unknown> };
    expect(payload.settings).toMatchObject({ sound: false, theme: "ember", aiPlayers: 3 });
    expect(payload.settings).not.toHaveProperty("debug"); // local-only, never uploaded
    ctx.repo.close();
    expect((await new Repo(await openDatabase(ctx.dbName)).getSettings()).values.theme).toBe("ember");
  });

  it("achievements unlock once", async () => {
    const ctx = await makeSession(uniqueDb(), 9);
    for (let i = 0; i < 2; i++) { await ctx.session.start(cfg(1, "easy")); await playOut(ctx); }
    const ids = (await ctx.repo.getAchievements()).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await ctx.repo.getStats()).offline.games).toBe(2);
  });
});

describe("hidden information inside the offline engine", () => {
  it("AI memory contains no card identity the AI was not entitled to see", () => {
    const g = OfflineGame.create(cfg(3, "hard"), seededRng(3), 1_000, "game-id-1234");
    const snap = g.toSnapshot();
    for (const mem of Object.values(snap.memories)) expect(Object.keys(mem.known)).toHaveLength(0);
    expect(g.state.players.length).toBe(4);
  });
  it("restoring from a snapshot does not count the closed time as play time", () => {
    const g = OfflineGame.create(cfg(2, "easy"), seededRng(4), 1_000, "game-id-5678");
    const snap = g.toSnapshot();
    const r = OfflineGame.restore(snap, seededRng(5), 1_000 + 9 * 3600_000);
    expect(r.toSnapshot().activeMs).toBe(0);
  });
});
