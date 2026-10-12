import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OfflineGamePayload } from "@old-maid/shared";
import { MemoryStore } from "../src/store/memory.js";
import { MongoStore } from "../src/store/mongo.js";
import type { Store } from "../src/store/types.js";
import { SlidingWindowLimiter } from "../src/util/rateLimiter.js";
import { SettingsService } from "../src/services/settingsService.js";
import { silentLogger } from "../src/util/logger.js";

const mongoUri = process.env["MONGODB_TEST_URI"];

const game = (): OfflineGamePayload => ({
  localGameId: randomUUID(), startedAt: Date.now() - 100_000, finishedAt: Date.now() - 50_000, mode: "offline-ai",
  playerCount: 4, aiDifficulty: "easy", result: "loss", durationSeconds: 50, turnCount: 40,
});

/** The same behavioural contract must hold for every Store implementation. */
function contract(name: string, make: () => Promise<Store>, skip = false) {
  describe.skipIf(skip)(`Store contract: ${name}`, () => {
    let s: Store;
    beforeAll(async () => { s = await make(); });
    afterAll(async () => { await s.close(); });

    it("users: guest → upgrade → lookup by email/username (case-insensitive)", async () => {
      const g = await s.users.createGuest();
      expect(g.status).toBe("guest");
      const email = `u${randomUUID().slice(0, 8)}@example.com`;
      const up = await s.users.upgradeToAccount(g.id, { username: `Name${g.id.slice(0, 6)}`, email: email.toUpperCase(), passwordHash: "h" });
      expect(up?.status).toBe("active");
      expect((await s.users.findByEmail(email))?.id).toBe(g.id);
      expect((await s.users.findByUsername(up!.username.toUpperCase()))?.id).toBe(g.id);
      expect(await s.users.upgradeToAccount(g.id, { username: "x", email: "x@x.com", passwordHash: "h" })).toBeNull(); // only guests upgrade
      expect(await s.users.findById("does-not-exist")).toBeNull();
    });

    it("sessions: stored by hash, revocable", async () => {
      const u = await s.users.createGuest();
      const h = randomUUID();
      await s.sessions.create(u.id, h);
      expect((await s.sessions.resolve(h))?.userId).toBe(u.id);
      await s.sessions.revokeAllForUser(u.id);
      expect(await s.sessions.resolve(h)).toBeNull();
    });

    it("sessions: an unknown hash never resolves", async () => {
      expect(await s.sessions.resolve(randomUUID())).toBeNull();
    });

    it("sessions: revocation is scoped to the target user", async () => {
      const a = await s.users.createGuest();
      const c = await s.users.createGuest();
      const ha = randomUUID();
      const hc = randomUUID();
      await s.sessions.create(a.id, ha);
      await s.sessions.create(c.id, hc);
      await s.sessions.revokeAllForUser(a.id);
      expect(await s.sessions.resolve(ha)).toBeNull();
      expect((await s.sessions.resolve(hc))?.userId).toBe(c.id); // untouched
    });

    it("sessions: expired sessions are rejected and touch() slides the window", async () => {
      const u = await s.users.createGuest();
      const h = randomUUID();
      await s.sessions.create(u.id, h);
      // A tiny TTL expires almost immediately.
      await s.sessions.touch(h, 1);
      await new Promise((r) => setTimeout(r, 20));
      expect(await s.sessions.resolve(h)).toBeNull();
      // Refreshing slides the window forward, so an active user is never logged out.
      await s.sessions.touch(h, 60_000);
      expect((await s.sessions.resolve(h))?.userId).toBe(u.id);
    });

    it("bans: permanent, temporary, expired, lifted", async () => {
      const u = await s.users.createGuest();
      expect(await s.bans.isBanned(u.id)).toBe(false);
      await s.bans.create({ userId: u.id, reason: "r", createdBy: "a", expiresAt: new Date(Date.now() - 1000) });
      expect(await s.bans.isBanned(u.id)).toBe(false);
      await s.bans.create({ userId: u.id, reason: "r", createdBy: "a", expiresAt: null });
      expect(await s.bans.isBanned(u.id)).toBe(true);
      await s.bans.lift(u.id);
      expect(await s.bans.isBanned(u.id)).toBe(false);
    });

    it("sync: idempotent per (user, localId); stats move exactly once; users are isolated", async () => {
      const [a, b] = [await s.users.createGuest(), await s.users.createGuest()];
      const g = game();
      expect(await s.syncRecords.processGameResult(a.id, g)).toBe("applied");
      expect(await s.syncRecords.processGameResult(a.id, g)).toBe("duplicate");
      expect(await s.syncRecords.processGameResult(b.id, g)).toBe("applied");
      expect((await s.stats.get(a.id)).offline).toEqual({ games: 1, wins: 0, losses: 1 });
      expect((await s.stats.get(a.id)).online.games).toBe(0);
    });

    it("sync: concurrent identical submissions are applied once", async () => {
      const u = await s.users.createGuest();
      const g = game();
      const res = await Promise.all(Array.from({ length: 8 }, () => s.syncRecords.processGameResult(u.id, g)));
      expect(res.filter((r) => r === "applied")).toHaveLength(1);
      expect((await s.stats.get(u.id)).offline.games).toBe(1);
    });

    it("sync: rejected records are remembered and summarized", async () => {
      const u = await s.users.createGuest();
      await s.syncRecords.markRejected(u.id, randomUUID(), "GAME_RESULT", "bad");
      const sum = await s.syncRecords.summary(u.id);
      expect(sum.rejected).toBe(1);
      expect(sum.lastSyncAt).toBeInstanceOf(Date);
    });

    it("settings/profile sync is compare-and-set on the client timestamp", async () => {
      const u = await s.users.createGuest();
      expect((await s.users.applySettings(u.id, { sound: false }, 2000)).applied).toBe(true);
      expect((await s.users.applySettings(u.id, { sound: true }, 1000)).applied).toBe(false);
      expect((await s.users.applySettings(u.id, { theme: "ember" }, 3000)).applied).toBe(true);
      expect((await s.users.findById(u.id))!.settings).toMatchObject({ updatedAt: 3000, data: { sound: false, theme: "ember" } });
      expect((await s.users.applyProfile(u.id, { avatar: "a1" }, 10)).applied).toBe(true);
      expect((await s.users.applyProfile(u.id, { avatar: "a2" }, 5)).applied).toBe(false);
    });

    it("online stats + game lifecycle + public events persist", async () => {
      const u = await s.users.createGuest();
      await s.stats.recordOnline(u.id, true);
      await s.stats.recordOnline(u.id, false);
      expect((await s.stats.get(u.id)).online).toEqual({ games: 2, wins: 1, losses: 1 });
      const gameId = randomUUID();
      await s.rooms.upsert({ code: "ABCDE", hostId: u.id, status: "playing", playerIds: [u.id], maxPlayers: 7, createdAt: new Date() });
      await s.games.start({ gameId, roomCode: "ABCDE", mode: "online", status: "playing", playerIds: [u.id], startedAt: new Date() },
        [{ gameId, playerId: u.id, userId: u.id, name: "X", isAi: false, seat: 0 }]);
      await s.gameEvents.appendMany([{ gameId, seq: 1, type: "game_started", text: "go", createdAt: new Date() }]);
      await s.games.finish(gameId, { status: "finished", winnerId: u.id, finishedAt: new Date(), durationSec: 5 }, { [u.id]: "win" });
      await s.chat.append({ id: randomUUID(), roomCode: "ABCDE", playerId: u.id, name: "X", text: "hi", status: "visible", createdAt: new Date() });
    });

    it("settings documents are versioned", async () => {
      const key = "game" as const;
      const v1 = await s.settings.set(key, { a: 1 }, "admin1");
      const v2 = await s.settings.set(key, { a: 2 }, "admin2");
      expect(v2.version).toBe(v1.version + 1);
      expect((await s.settings.get(key))?.value).toEqual({ a: 2 });
    });

    it("ping works", async () => {
      expect((await s.ping()).ok).toBe(true);
    });
  });
}

contract("MemoryStore", async () => new MemoryStore());
// Runs only when MONGODB_TEST_URI points at a disposable MongoDB (e.g. a local container or an Atlas test DB).
contract("MongoStore", async () => { const m = new MongoStore(mongoUri as string); await m.connect(); return m; }, !mongoUri);

describe("SettingsService validation", () => {
  it("rejects dangerous/invalid admin updates and keeps the old value", async () => {
    const store = new MemoryStore();
    const svc = new SettingsService(store, silentLogger);
    await svc.load();
    await expect(svc.updateGame({ ...svc.getGame(), maxPlayers: 9 })).rejects.toThrow();
    await expect(svc.updateGame({ ...svc.getGame(), minPlayers: 6, maxPlayers: 3 })).rejects.toThrow();
    await expect(svc.updateAi({ ...svc.getAi(), aggressiveness: 4 })).rejects.toThrow();
    expect(svc.getGame().maxPlayers).toBe(7);
    const updated = await svc.updateGame({ ...svc.getGame(), turnTimeoutSec: 90 }, "admin");
    expect(updated.turnTimeoutSec).toBe(90);
    // survives a "restart"
    const svc2 = new SettingsService(store, silentLogger);
    await svc2.load();
    expect(svc2.getGame().turnTimeoutSec).toBe(90);
  });
  it("falls back to defaults if stored settings are corrupt", async () => {
    const store = new MemoryStore();
    await store.settings.set("game", { minPlayers: "lots" });
    const svc = new SettingsService(store, silentLogger);
    await svc.load();
    expect(svc.getGame().maxPlayers).toBe(7);
  });
});

describe("SlidingWindowLimiter", () => {
  it("allows up to max per window, then recovers", () => {
    let t = 0;
    const l = new SlidingWindowLimiter(3, 1000, () => t);
    expect([l.allow("a"), l.allow("a"), l.allow("a"), l.allow("a")]).toEqual([true, true, true, false]);
    expect(l.allow("b")).toBe(true);
    t = 1001;
    expect(l.allow("a")).toBe(true);
  });
});
