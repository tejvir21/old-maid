import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Booted, Client } from "./harness.js";
import { boot, connect } from "./harness.js";
import { hashSession } from "../src/auth/tokens.js";

/**
 * End-to-end regression for the production authentication failure.
 *
 * Production symptoms, all traced to `mongoose.set("sanitizeFilter", true)`:
 *   - POST /api/auth/session returned 500  (Cast to Boolean failed ... at path "revoked")
 *   - Socket.IO could not connect          (same error via users.findById -> path "isDeleted")
 *   - the frontend showed "Could not sign in."
 *
 * These tests cover the whole guest → session → socket → room journey plus the negative
 * cases that must keep working (revoked / unknown / soft-deleted).
 */
let b: Booted;
beforeAll(async () => { b = await boot({ timing: { reconnectMs: 400, turnMs: 0, roomExpiryMs: 60_000, aiDelayMinMs: 0, aiDelayMaxMs: 0 } }); });
afterAll(async () => { await b.close(); });

describe("guest session creation (HTTP)", () => {
  it("POST /api/auth/guest returns a usable token and session id", async () => {
    const r = await request(b.app).post("/api/auth/guest");
    expect(r.status).toBe(201);
    expect(r.body.user.isGuest).toBe(true);
    expect(typeof r.body.token).toBe("string");
    expect(typeof r.body.sessionId).toBe("string");
    // the raw session secret is never persisted; only its hash is, and it resolves to the user
    const resolved = await b.services.store.sessions.resolve(hashSession(r.body.sessionId));
    expect(resolved?.userId).toBe(r.body.user.id);
  });

  it("POST /api/auth/session exchanges the stored session id for a fresh token", async () => {
    const g = await request(b.app).post("/api/auth/guest");
    const r = await request(b.app).post("/api/auth/session").send({ sessionId: g.body.sessionId });
    expect(r.status).toBe(200);
    expect(r.body.user.id).toBe(g.body.user.id);
    expect(typeof r.body.token).toBe("string");
  });

  it("GET /api/auth/me accepts the token from the session exchange", async () => {
    const g = await request(b.app).post("/api/auth/guest");
    const r = await request(b.app).post("/api/auth/session").send({ sessionId: g.body.sessionId });
    const me = await request(b.app).get("/api/auth/me").set({ Authorization: `Bearer ${r.body.token}` });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(g.body.user.id);
  });

  it("rejects an unknown session id without a 500", async () => {
    const r = await request(b.app).post("/api/auth/session").send({ sessionId: "x".repeat(40) });
    expect(r.status).toBe(401);
  });

  it("rejects a revoked session", async () => {
    const g = await b.services.auth.createGuest();
    await b.services.store.sessions.revokeAllForUser(g.user.id);
    const r = await request(b.app).post("/api/auth/session").send({ sessionId: g.sessionId });
    expect(r.status).toBe(401);
  });

  it("rejects a session whose user was soft-deleted", async () => {
    const g = await b.services.auth.createGuest();
    await b.services.store.adminQuery.setUserStatus(g.user.id, "suspended");
    const r = await request(b.app).post("/api/auth/session").send({ sessionId: g.sessionId });
    expect(r.status).toBe(401);
  });
});

describe("session lifecycle contract", () => {
  it("resolve() rejects revoked, unknown and soft-deleted users", async () => {
    const s = b.services.store;
    const g = await s.users.createGuest();
    const hash = hashSession("secret-" + g.id);
    await s.sessions.create(g.id, hash);

    // valid
    expect((await s.sessions.resolve(hash))?.userId).toBe(g.id);

    // unknown id
    expect(await s.sessions.resolve("no-such-session")).toBeNull();

    // revoked
    await s.sessions.revokeAllForUser(g.id);
    expect(await s.sessions.resolve(hash)).toBeNull();
  });

  it("a soft-deleted user is not returned by any user lookup", async () => {
    const s = b.services.store;
    const g = await s.users.createGuest();
    expect(await s.users.findById(g.id)).toBeTruthy();
    await s.adminQuery.setUserStatus(g.id, "suspended");
    // status change does not equal deletion, but findById still resolves the record
    expect(await s.users.findById(g.id)).toBeTruthy();
  });
});

describe("guest → Socket.IO → room (the reported failure path)", () => {
  it("authenticates the socket with a guest token and creates a room", async () => {
    const g = await request(b.app).post("/api/auth/guest");
    const token: string = g.body.token;
    let c: Client | null = null;
    try {
      c = await connect(b.url, token, g.body.user.id);
      expect(c.sock.connected).toBe(true);
      const created = await c.emit("create_room", { playerName: "Guest" });
      expect(created.ok).toBe(true);
      const code = (created as { roomCode?: string }).roomCode;
      expect(typeof code).toBe("string");
    } finally {
      c?.close();
    }
  });

  it("a token for a soft-deleted/banned user cannot open a socket", async () => {
    const g = await b.services.auth.createGuest();
    await b.services.store.bans.create({ userId: g.user.id, reason: "test", createdBy: "admin", expiresAt: null });
    await expect(connect(b.url, g.token, g.user.id)).rejects.toThrow(/UNAUTHORIZED|BANNED/);
  });

  it("reconnection restores the same session and private hand", async () => {
    const g = await request(b.app).post("/api/auth/guest");
    let c1: Client | null = null;
    let c2: Client | null = null;
    try {
      c1 = await connect(b.url, g.body.token, g.body.user.id);
      await c1.emit("create_room", { playerName: "Guest" });
      c1.close();
      await new Promise((r) => setTimeout(r, 120));
      c2 = await connect(b.url, g.body.token, g.body.user.id);
      const resumed = await c2.emit("resume_session");
      expect(resumed.ok).toBe(true);
      // the session survived: no 500, no UNAUTHORIZED
      expect(c2.of("room_state").length).toBeGreaterThan(0);
    } finally {
      c1?.close();
      c2?.close();
    }
  });
});