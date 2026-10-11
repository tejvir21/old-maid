import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OfflineGamePayload } from "@old-maid/shared";
import { loadEnv, EnvError } from "../src/config/env.js";
import { createLogger, redact } from "../src/util/logger.js";
import { boot, forgedToken, newUser, type Booted } from "./harness.js";

let b: Booted;
beforeAll(async () => { b = await boot(); });
afterAll(async () => b.close());

const game = (over: Partial<OfflineGamePayload> = {}): OfflineGamePayload => {
  const now = Date.now();
  return { localGameId: randomUUID(), startedAt: now - 120_000, finishedAt: now - 60_000, mode: "offline-ai", playerCount: 7, aiDifficulty: "normal", result: "win", durationSeconds: 60, turnCount: 80, ...over };
};
const item = (g: OfflineGamePayload) => ({ id: g.localGameId, type: "GAME_RESULT", payload: g });
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("health, config, errors", () => {
  it("GET /health reports ok + database state", async () => {
    const r = await request(b.app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", database: "memory" });
  });
  it("reports degraded (503) when the database is down", async () => {
    const orig = b.services.store.ping;
    b.services.store.ping = async () => ({ ok: false, latencyMs: 1, kind: "mongo" });
    const r = await request(b.app).get("/health");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ status: "degraded", database: "disconnected" });
    b.services.store.ping = orig;
  });
  it("GET /api/config exposes only public settings", async () => {
    const r = await request(b.app).get("/api/config");
    expect(r.body.features.onlineMultiplayer).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/secret|mongo|password/i);
  });
  it("uses consistent error bodies and never leaks stack traces", async () => {
    const nf = await request(b.app).get("/nope");
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Not found." } });
    const bad = await request(b.app).post("/api/auth/session").set("Content-Type", "application/json").send("{oops");
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/stack|at .*\.ts/);
    const orig = b.services.store.ping;
    b.services.store.ping = async () => { throw new Error("secret mongodb://user:pw@host exploded"); };
    const boom = await request(b.app).get("/health");
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.body)).not.toMatch(/mongodb|exploded|pw@/);
    b.services.store.ping = orig;
  });
  it("only allow-listed origins receive CORS headers", async () => {
    const ok = await request(b.app).get("/health").set("Origin", "http://localhost:5173");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const bad = await request(b.app).get("/health").set("Origin", "https://evil.example");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    expect(ok.headers["x-powered-by"]).toBeUndefined();
    expect(ok.headers["x-content-type-options"]).toBe("nosniff"); // helmet
  });
  it("the admin API exists but rejects anonymous access without leaking data", async () => {
    // Phase 4 added a real admin surface. The invariant is no longer "404" (no surface at
    // all) but "exists, and never serves data to an unauthenticated caller".
    const adminPaths: [string, string][] = [
      ["/api/admin/users", "get"],
      ["/api/admin/rooms", "get"],
      ["/api/admin/games", "get"],
      ["/api/admin/reports", "get"],
      ["/api/admin/statistics", "get"],
      ["/api/admin/settings", "get"],
      ["/api/admin/database/users", "get"],
      ["/api/admin/audit-logs", "get"],
      ["/api/admin/admins", "get"],
      ["/api/admin/system-health", "get"],
      ["/api/admin/dashboard", "get"],
      ["/api/admin/debug/game/anything", "get"],
    ];
    for (const [p, method] of adminPaths) {
      const r = await (method === "get" ? request(b.app).get(p) : request(b.app).post(p));
      expect([401, 403], `${method.toUpperCase()} ${p}`).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toMatch(/"(passwordHash|token|sessionHash|myHand|hands)"/);
    }
    // Player-only surfaces stay unreachable and never expose admin data.
    for (const p of ["/admin", "/api/database"]) {
      expect((await request(b.app).get(p)).status).toBe(404);
    }
  });
});

describe("authentication", () => {
  it("guest → refresh by session secret → me", async () => {
    const g = await request(b.app).post("/api/auth/guest");
    expect(g.status).toBe(201);
    expect(g.body.user.isGuest).toBe(true);
    const me = await request(b.app).get("/api/auth/me").set(auth(g.body.token));
    expect(me.body.user.id).toBe(g.body.user.id);
    const rf = await request(b.app).post("/api/auth/session").send({ sessionId: g.body.sessionId });
    expect(rf.status).toBe(200);
    expect(rf.body.user.id).toBe(g.body.user.id);
    expect((await request(b.app).post("/api/auth/session").send({ sessionId: "x".repeat(30) })).status).toBe(401);
    // the raw session secret is never stored
    expect(JSON.stringify([...b.store.data.sessions.keys()])).not.toContain(g.body.sessionId);
  });
  it("register upgrades the guest (keeping its id + stats), login works, hashes never leak", async () => {
    const g = await request(b.app).post("/api/auth/guest");
    await b.store.stats.recordOnline(g.body.user.id, true);
    const reg = await request(b.app).post("/api/auth/register").set(auth(g.body.token)).send({ username: "Ryuji Test", email: "Ryuji@Example.com", password: "correct horse battery" });
    expect(reg.status).toBe(201);
    expect(reg.body.user.id).toBe(g.body.user.id);
    expect(reg.body.user.isGuest).toBe(false);
    expect(JSON.stringify(reg.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect((await b.store.stats.get(reg.body.user.id)).online.wins).toBe(1);
    expect((await request(b.app).post("/api/auth/register").send({ username: "Other Name", email: "ryuji@example.com", password: "another long pass" })).status).toBe(409);
    expect((await request(b.app).post("/api/auth/register").send({ username: "Weak", email: "w@example.com", password: "short" })).status).toBe(400);
    const ok = await request(b.app).post("/api/auth/login").send({ email: "ryuji@example.com", password: "correct horse battery" });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toMatch(/passwordHash/);
    const bad = await request(b.app).post("/api/auth/login").send({ email: "ryuji@example.com", password: "wrong password" });
    const none = await request(b.app).post("/api/auth/login").send({ email: "nobody@example.com", password: "wrong password" });
    expect(bad.status).toBe(401);
    expect(none.body).toEqual(bad.body); // no user enumeration
  });
  it("logout-all revokes sessions", async () => {
    const g = await request(b.app).post("/api/auth/guest");
    expect((await request(b.app).post("/api/auth/logout-all").set(auth(g.body.token))).status).toBe(200);
    expect((await request(b.app).post("/api/auth/session").send({ sessionId: g.body.sessionId })).status).toBe(401);
  });
  it("rate-limits the auth endpoints per IP", async () => {
    const b2 = await boot({ app: { authLimitPerMin: 4 } });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await request(b2.app).post("/api/auth/guest")).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    await b2.close();
  });
  it("banned players are refused over HTTP", async () => {
    const u = await newUser(b);
    await b.store.bans.create({ userId: u.userId, reason: "x", createdBy: "a", expiresAt: new Date(Date.now() + 60_000) });
    expect((await request(b.app).get("/api/stats/me").set(auth(u.token))).status).toBe(403);
    await b.store.bans.lift(u.userId);
    expect((await request(b.app).get("/api/stats/me").set(auth(u.token))).status).toBe(200);
  });
});

describe("offline sync API", () => {
  it("requires a valid player token (none, garbage, wrong secret, wrong audience, unknown user)", async () => {
    const body = { items: [] };
    expect((await request(b.app).post("/api/sync").send(body)).status).toBe(401);
    expect((await request(b.app).post("/api/sync").set(auth("garbage")).send(body)).status).toBe(401);
    expect((await request(b.app).post("/api/sync").set(auth(forgedToken({ secret: "z".repeat(40) }))).send(body)).status).toBe(401);
    expect((await request(b.app).post("/api/sync").set(auth(forgedToken({ audience: "old-maid:admin" }))).send(body)).status).toBe(401);
    expect((await request(b.app).post("/api/sync").set(auth(forgedToken({}))).send(body)).status).toBe(401);
    expect((await request(b.app).get("/api/sync/status")).status).toBe(401);
  });

  it("accepts a legitimately short 2-player game (few draws, ~2s)", async () => {
    const u = await newUser(b);
    const g = game({ playerCount: 2, durationSeconds: 2, turnCount: 4, startedAt: Date.now() - 60_000, finishedAt: Date.now() - 55_000 });
    const r = await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [item(g)] });
    expect(r.body.results[0].status).toBe("synced");
  });

  it("applies a game exactly once (localGameId idempotency) and keeps offline stats separate", async () => {
    const u = await newUser(b);
    const g = game();
    const first = await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [item(g)] });
    expect(first.body.results).toEqual([{ id: g.localGameId, status: "synced" }]);
    const again = await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [item(g), item(g)] });
    expect(again.body.results.map((r: { status: string }) => r.status)).toEqual(["duplicate", "duplicate"]);
    const st = await request(b.app).get("/api/stats/me").set(auth(u.token));
    expect(st.body.stats.offline).toEqual({ games: 1, wins: 1, losses: 0 });
    expect(st.body.stats.online).toEqual({ games: 0, wins: 0, losses: 0 });
    expect(st.body.sync.processed).toBe(1);
  });

  it("scopes idempotency per user (same id from two users counts for both)", async () => {
    const [u1, u2] = [await newUser(b), await newUser(b)];
    const g = game({ result: "loss" });
    for (const u of [u1, u2]) expect((await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [item(g)] })).body.results[0].status).toBe("synced");
  });

  it("never trusts browser-supplied totals; unknown fields are dropped", async () => {
    const u = await newUser(b);
    const g = { ...game(), wins: 10000, totalWins: 10000, games: 99999 };
    await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [item(g as OfflineGamePayload)] });
    const st = (await b.store.stats.get(u.userId)).offline;
    expect(st).toEqual({ games: 1, wins: 1, losses: 0 });
  });

  it("rejects implausible / malformed records without counting them", async () => {
    const u = await newUser(b);
    const now = Date.now();
    const bad = [
      game({ finishedAt: now - 200_000, startedAt: now - 100_000 }),
      game({ finishedAt: now + 3_600_000, startedAt: now + 3_000_000 }),
      game({ durationSeconds: 99999 }),
      game({ durationSeconds: 1 }), // 80 draws in 1s
      game({ durationSeconds: 0, turnCount: 4 }),
      game({ turnCount: 0 }),
      game({ startedAt: now - 800 * 24 * 3600_000, finishedAt: now - 799 * 24 * 3600_000 }),
      { ...game(), result: "draw" } as unknown as OfflineGamePayload,
      { ...game(), playerCount: 12 } as OfflineGamePayload,
    ];
    const r = await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: bad.map(item) });
    expect(r.status).toBe(200);
    expect(r.body.results.every((x: { status: string }) => x.status === "rejected")).toBe(true);
    const g = game();
    const mismatch = await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [{ id: randomUUID(), type: "GAME_RESULT", payload: g }] });
    expect(mismatch.body.results[0].status).toBe("rejected");
    expect((await b.store.stats.get(u.userId)).offline.games).toBe(0);
    expect((await b.store.syncRecords.summary(u.userId)).rejected).toBeGreaterThan(0);
  });

  it("is retry-safe: a transient failure keeps the item retryable and it is counted once", async () => {
    const u = await newUser(b);
    const g = game();
    const orig = b.services.store.syncRecords.processGameResult;
    let calls = 0;
    b.services.store.syncRecords.processGameResult = async (...a) => { if (calls++ === 0) throw new Error("db blip"); return orig(...a); };
    const r1 = await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [item(g)] });
    expect(r1.body.results[0]).toMatchObject({ status: "failed" });
    const r2 = await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [item(g)] });
    expect(r2.body.results[0].status).toBe("synced");
    const r3 = await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [item(g)] });
    expect(r3.body.results[0].status).toBe("duplicate");
    expect((await b.store.stats.get(u.userId)).offline.games).toBe(1);
    b.services.store.syncRecords.processGameResult = orig;
  });

  it("one bad item does not block the rest of the batch", async () => {
    const u = await newUser(b);
    const good = game(); const bad = game({ turnCount: 0 });
    const r = await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [item(bad), item(good)] });
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(["rejected", "synced"]);
  });

  it("settings sync uses timestamps: newer wins, older is reported stale, replays are harmless", async () => {
    const u = await newUser(b);
    const up = (updatedAt: number, settings: object) => ({ id: randomUUID(), type: "SETTINGS_UPDATE", payload: { updatedAt, settings } });
    const t = Date.now();
    expect((await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [up(t, { sound: false, theme: "dark" })] })).body.results[0].status).toBe("synced");
    expect((await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [up(t - 5000, { sound: true })] })).body.results[0].status).toBe("stale");
    expect((await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [up(t, { sound: true })] })).body.results[0].status).toBe("stale");
    expect((await b.store.users.findById(u.userId))!.settings!.data).toMatchObject({ sound: false, theme: "dark" });
    const evil = await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [up(t + 10, { isAdmin: true })] });
    expect(evil.body.results[0].status).toBe("rejected"); // strict schema: no arbitrary keys
  });

  it("validates the batch envelope (size cap, shape)", async () => {
    const u = await newUser(b);
    const many = Array.from({ length: 101 }, () => item(game()));
    expect((await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: many })).status).toBe(400);
    expect((await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: "x" })).status).toBe(400);
    expect((await request(b.app).post("/api/sync").set(auth(u.token)).send({ items: [{ id: "short", type: "GAME_RESULT", payload: {} }] })).status).toBe(400);
  });
});

describe("environment validation + logging", () => {
  it("rejects bad/unsafe configuration", () => {
    expect(() => loadEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(EnvError);
    expect(() => loadEnv({ NODE_ENV: "production", CLIENT_URL: "https://x.app", MONGODB_URI: "mongodb://h/db", JWT_ACCESS_SECRET: "short" } as NodeJS.ProcessEnv)).toThrow(/32/);
    expect(() => loadEnv({ NODE_ENV: "production", ALLOWED_ORIGINS: "*", MONGODB_URI: "mongodb://h/db", JWT_ACCESS_SECRET: "s".repeat(40) } as NodeJS.ProcessEnv)).toThrow(/\*/);
    expect(() => loadEnv({ PORT: "abc" } as NodeJS.ProcessEnv)).toThrow(EnvError);
    const ok = loadEnv({ NODE_ENV: "production", CLIENT_URL: "https://x.app/", MONGODB_URI: "mongodb://h/db", JWT_ACCESS_SECRET: "s".repeat(40), PORT: "10000" } as NodeJS.ProcessEnv);
    expect(ok.allowedOrigins).toEqual(["https://x.app"]);
    expect(ok.port).toBe(10000);
  });
  it("redacts secrets and private game data from logs", () => {
    const lines: string[] = [];
    const log = createLogger("debug", (l) => lines.push(l));
    log.info("x", { password: "hunter2", token: "abc", hand: [{ id: "joker" }], nested: { authorization: "Bearer z", ok: 1 } });
    expect(lines[0]).not.toMatch(/hunter2|abc|joker|Bearer/);
    expect(lines[0]).toContain('"ok":1');
    expect(redact({ MONGODB_URI: "mongodb://u:p@h" })).toEqual({ MONGODB_URI: "[redacted]" });
  });
});
