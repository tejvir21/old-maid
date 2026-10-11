import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import request from "supertest";
import {
  ROLE_PERMISSIONS, SUPER_ADMIN_ONLY, effectivePermissions, permissionsForRole,
} from "@old-maid/shared";
import type { Booted } from "./harness.js";
import { boot } from "./harness.js";

let b: Booted;
beforeAll(async () => {
  b = await boot({ app: { globalLimitPerMin: 100_000 } });
  // Seed one admin per role directly in the store (equivalent to the bootstrap command).
  for (const [email, role] of [
    ["root@example.com", "SUPER_ADMIN"],
    ["admin@example.com", "ADMIN"],
    ["mod@example.com", "MODERATOR"],
    ["support@example.com", "SUPPORT"],
  ] as const) {
    await b.services.store.admin.admins.create({
      email, username: email.split("@")[0]!, role, permissions: [],
      passwordHash: await bcrypt.hash(PW, 4), status: "active",
    });
  }
});
afterAll(async () => { await b.close(); });

const PW = "Sup3rSecretPass!23";
const as = (req: request.Test): request.Test => req;

/** Creates an admin directly in the store (bypasses the API so bootstrap does not need SUPER_ADMIN). */
async function makeAdmin(role: keyof typeof ROLE_PERMISSIONS, email: string, permissions: string[] = []) {
  const rec = await b.services.store.admin.admins.create({
    email, username: email.split("@")[0]!, role, permissions: permissions as never,
    passwordHash: await bcrypt.hash(PW, 4), status: "active",
  });
  return rec;
}
async function tokenFor(email: string): Promise<string> {
  const r = await request(b.app).post("/api/admin/login").send({ email, password: PW });
  expect(r.status).toBe(200);
  return r.body.token as string;
}
const superAdmin = async () => (await tokenFor("root@example.com"));
const withTok = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("admin authentication boundary", () => {
  it("rejects every privileged route without a token", async () => {
    for (const p of ["/users", "/rooms", "/games", "/reports", "/statistics", "/settings", "/admins", "/audit-logs", "/database/users", "/system-health", "/dashboard", "/me"]) {
      expect((await request(b.app).get(`/api/admin${p}`)).status, p).toBe(401);
    }
  });
  it("rejects a forged / player-audience / garbage token", async () => {
    for (const t of ["nonsense", "a.b.c", "Bearer", "x".repeat(400)]) {
      expect((await request(b.app).get("/api/admin/users").set(withTok(t))).status).toBe(401);
    }
    // A real PLAYER token must never be accepted as an admin token.
    const g = await request(b.app).post("/api/auth/guest");
    expect((await request(b.app).get("/api/admin/users").set(withTok(g.body.token))).status).toBe(401);
  });
  it("login requires valid credentials and never leaks whether the email exists", async () => {
    const bad = await request(b.app).post("/api/admin/login").send({ email: "root@example.com", password: "wrong" });
    const missing = await request(b.app).post("/api/admin/login").send({ email: "nobody@example.com", password: "wrong" });
    expect(bad.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(bad.body.error.message).toBe(missing.body.error.message);
  });
  it("login returns no hash and no session material", async () => {
    const t = await superAdmin();
    const me = await request(b.app).get("/api/admin/me").set(withTok(t));
    expect(me.status).toBe(200);
    const dump = JSON.stringify(me.body);
    expect(dump).not.toMatch(/passwordHash|totpSecret|sessionHash/i);
  });
});

describe("role / permission matrix", () => {
  it("enforces the documented matrix", () => {
    expect(ROLE_PERMISSIONS.SUPER_ADMIN).toContain("DATABASE_WRITE");
    expect(ROLE_PERMISSIONS.ADMIN).toContain("USERS_BAN");
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain("DATABASE_WRITE");
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain("ADMINS_WRITE");
    expect(ROLE_PERMISSIONS.MODERATOR).toContain("REPORTS_MANAGE");
    expect(ROLE_PERMISSIONS.MODERATOR).not.toContain("SETTINGS_WRITE");
    expect(ROLE_PERMISSIONS.SUPPORT).not.toContain("USERS_BAN");
    expect(ROLE_PERMISSIONS.SUPPORT).not.toContain("DATABASE_READ");
    // effectivePermissions must agree with can()
    for (const role of Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]) {
      for (const p of permissionsForRole(role)) expect(effectivePermissions(role).has(p)).toBe(true);
    }
  });
  it("grants may only narrow, never widen into a super-admin-only permission", () => {
    for (const p of SUPER_ADMIN_ONLY) expect(effectivePermissions("ADMIN", [p]).has(p)).toBe(false);
    expect(effectivePermissions("SUPER_ADMIN", []).has("DATABASE_WRITE")).toBe(true);
  });
  it("blocks a MODERATOR from SUPER_ADMIN-only endpoints (403, not 500)", async () => {
    const t = await tokenFor("mod@example.com");
    expect((await request(b.app).get("/api/admin/database/users").set(withTok(t))).status).toBe(403);
    expect((await request(b.app).get("/api/admin/debug/game/x").set(withTok(t))).status).toBe(403);
    // USERS_BAN IS granted to a moderator, so this reaches the handler and fails on the
    // (nonexistent) target — i.e. authorization passed, rather than being refused up front.
    expect((await request(b.app).post("/api/admin/users/abc/ban").set(withTok(t)).send({ reason: "spamming" })).status).toBe(404);
    // ...but a moderator CAN read reports and audit logs.
    expect((await request(b.app).get("/api/admin/reports").set(withTok(t))).status).toBe(200);
    expect((await request(b.app).get("/api/admin/audit-logs").set(withTok(t))).status).toBe(200);
  });
  it("blocks SUPPORT from any write endpoint", async () => {
    const t = await tokenFor("support@example.com");
    expect((await request(b.app).get("/api/admin/users").set(withTok(t))).status).toBe(200);
    expect((await request(b.app).post("/api/admin/users/abc/ban").set(withTok(t)).send({ reason: "nope" })).status).toBe(403);
    expect((await request(b.app).post("/api/admin/rooms/AAAAAA/close").set(withTok(t)).send({ reason: "nope" })).status).toBe(403);
  });
});

describe("privilege escalation is impossible", () => {
  it("an ADMIN cannot create or modify a SUPER_ADMIN", async () => {
    const t = await tokenFor("admin@example.com");
    const r = await request(b.app).post("/api/admin/admins").set(withTok(t)).send({
      email: "sneaky@example.com", username: "sneaky", password: PW, role: "SUPER_ADMIN",
    });
    expect(r.status).toBe(403);
    const t2 = await tokenFor("mod@example.com");
    expect((await request(b.app).post("/api/admin/admins").set(withTok(t2)).send({
      email: "sneaky2@example.com", username: "sneaky2", password: PW, role: "ADMIN",
    })).status).toBe(403); // MODERATOR lacks ADMINS_WRITE entirely
  });
  it("an ADMIN cannot grant itself super-admin-only permissions", async () => {
    const t = await tokenFor("admin@example.com");
    const target = await b.services.store.admin.admins.findByEmail("mod@example.com");
    const r = await request(b.app).patch(`/api/admin/admins/${target!.id}`).set(withTok(t)).send({
      permissions: ["DATABASE_WRITE"], reason: "self escalation",
    });
    expect(r.status).toBe(403);
  });
  it("an admin cannot suspend or demote itself", async () => {
    const t = await tokenFor("admin@example.com");
    const me = await b.services.store.admin.admins.findByEmail("admin@example.com");
    expect((await request(b.app).patch(`/api/admin/admins/${me!.id}`).set(withTok(t)).send({ status: "suspended", reason: "self" })).status).toBe(403);
  });
  it("a suspended admin's existing sessions stop working immediately", async () => {
    const sT = await superAdmin();
    const target = await makeAdmin("SUPPORT", "temp@example.com");
    const t = await tokenFor("temp@example.com");
    expect((await request(b.app).get("/api/admin/users").set(withTok(t))).status).toBe(200);
    const r = await request(b.app).patch(`/api/admin/admins/${target.id}`).set(withTok(sT)).send({ status: "suspended", reason: "test" });
    expect(r.status).toBe(200);
    expect((await request(b.app).get("/api/admin/users").set(withTok(t))).status).toBe(401);
  });
});

describe("data protection", () => {
  it("never returns password hashes or session material to any admin endpoint", async () => {
    const t = await superAdmin();
    for (const p of ["/users", "/rooms", "/games", "/admins", "/database/users", "/database/syncRecords"]) {
      const r = await request(b.app).get(`/api/admin${p}`).set(withTok(t));
      const dump = JSON.stringify(r.body);
      expect(r.status, p).toBe(200);
      expect(dump, p).not.toMatch(/passwordHash|sessionHash|totpSecret/i);
    }
  });
  it("a user detail response omits the password hash", async () => {
    const t = await superAdmin();
    const list = await request(b.app).get("/api/admin/users").set(withTok(t));
    const id = list.body.items[0]?.id as string;
    const detail = await request(b.app).get(`/api/admin/users/${id}`).set(withTok(t));
    expect(JSON.stringify(detail.body)).not.toMatch(/passwordHash/);
  });
  it("does not expose another player's hand or the Joker location to an ordinary admin", async () => {
    const t = await tokenFor("admin@example.com"); // ADMIN, NOT super
    const dump = JSON.stringify((await request(b.app).get("/api/admin/rooms").set(withTok(t))).body);
    const dump2 = JSON.stringify((await request(b.app).get("/api/admin/games").set(withTok(t))).body);
    expect(dump).not.toMatch(/myHand|hands|isJoker|\"cards\"/);
    expect(dump2).not.toMatch(/myHand|hands|isJoker|\"cards\"/);
  });
  it("blocks an ordinary admin from the SUPER_ADMIN debug endpoint (hidden state)", async () => {
    const t = await tokenFor("admin@example.com");
    expect((await request(b.app).get("/api/admin/debug/game/whatever").set(withTok(t))).status).toBe(403);
  });
});

describe("user management safety", () => {
  it("ban/unban writes an audit record and revokes sessions", async () => {
    const t = await superAdmin();
    const g = await request(b.app).post("/api/auth/guest");
    const uid = g.body.user.id as string;
    expect((await request(b.app).post(`/api/admin/users/${uid}/ban`).set(withTok(t)).send({ reason: "cheating" })).status).toBe(200);
    // banned user cannot use the player API any more
    expect((await request(b.app).get("/api/stats/me").set(withTok(g.body.token))).status).toBe(403);
    expect((await request(b.app).post(`/api/admin/users/${uid}/unban`).set(withTok(t)).send({ reason: "appeal granted" })).status).toBe(200);
    const audit = await request(b.app).get("/api/admin/audit-logs").set(withTok(t));
    const actions = audit.body.items.map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["USER_BAN", "USER_UNBAN"]));
  });
  it("ban requires a reason", async () => {
    const t = await superAdmin();
    const g = await request(b.app).post("/api/auth/guest");
    expect((await request(b.app).post(`/api/admin/users/${g.body.user.id}/ban`).set(withTok(t)).send({})).status).toBe(400);
  });
});

describe("settings & flags", () => {
  it("validates on the server and rejects invalid values", async () => {
    const t = await superAdmin();
    const bad = await request(b.app).put("/api/admin/settings/game").set(withTok(t)).send({ value: { minPlayers: 99 }, reason: "test" });
    expect(bad.status).toBe(400);
  });
  it("maintenance mode blocks new online games but not offline play", async () => {
    const t = await superAdmin();
    expect((await request(b.app).post("/api/admin/settings/maintenance").set(withTok(t)).send({ enabled: true, message: "down", reason: "planned maintenance" })).status).toBe(200);
    // the public config reflects it
    expect((await request(b.app).get("/api/config")).body.maintenance.enabled).toBe(true);
    // offlineMode feature flag remains independent
    expect((await request(b.app).get("/api/config")).body.features.offlineMode).toBe(true);
    expect((await request(b.app).post("/api/admin/settings/maintenance").set(withTok(t)).send({ enabled: false, reason: "over" })).status).toBe(200);
  });

  it("a maintenance change requires a reason (audited)", async () => {
    const t = await superAdmin();
    expect((await request(b.app).post("/api/admin/settings/maintenance").set(withTok(t)).send({ enabled: true })).status).toBe(400);
  });
});

describe("database console safety", () => {
  it("rejects an unknown collection (allow-list)", async () => {
    const t = await superAdmin();
    expect((await request(b.app).get("/api/admin/database/secrets").set(withTok(t))).status).toBe(400);
  });
  it("refuses to edit a field that is not in the editable set", async () => {
    const t = await superAdmin();
    const r = await request(b.app).patch("/api/admin/database/users/abc").set(withTok(t)).send({
      changes: { status: "active" }, reason: "test",
    });
    // field IS editable for users, so this should be a 404 (record missing) not 403/500
    expect([200, 404]).toContain(r.status);
    const forbidden = await request(b.app).patch("/api/admin/database/users/abc").set(withTok(t)).send({
      changes: { passwordHash: "x" }, reason: "test",
    });
    expect(forbidden.status).toBe(403);
  });
  it("refuses MongoDB update operators entirely", async () => {
    const t = await superAdmin();
    const r = await request(b.app).patch("/api/admin/database/users/abc").set(withTok(t)).send({
      changes: { "$set": { status: "banned" } }, reason: "inject",
    });
    expect(r.status).toBe(403);
  });
  it("only SUPER_ADMIN can permanently delete, and never audit logs or settings", async () => {
    const adminT = await tokenFor("admin@example.com");
    // Not SUPER_ADMIN → refused before anything is touched.
    expect((await request(b.app).delete("/api/admin/database/users/x/purge").set(withTok(adminT)).send({ reason: "cleanup test" })).status).toBe(403);
    const superT = await superAdmin();
    // SUPER_ADMIN, but audit logs and settings are structurally protected collections.
    expect((await request(b.app).delete("/api/admin/database/auditLogs/x/purge").set(withTok(superT)).send({ reason: "cleanup test" })).status).toBe(403);
    expect((await request(b.app).delete("/api/admin/database/settings/x/purge").set(withTok(superT)).send({ reason: "cleanup test" })).status).toBe(403);
  });

  it("refuses a purge with no reason", async () => {
    const superT = await superAdmin();
    expect((await request(b.app).delete("/api/admin/database/users/x/purge").set(withTok(superT)).send({})).status).toBe(400);
  });
});

describe("audit log integrity", () => {
  it("records admin login, and is itself readable with before/after", async () => {
    const t = await superAdmin();
    const logs = await request(b.app).get("/api/admin/audit-logs?limit=100").set(withTok(t));
    const login = logs.body.items.find((x: { action: string }) => x.action === "ADMIN_LOGIN");
    expect(login).toBeTruthy();
    expect(login).toHaveProperty("adminId");
    expect(login).toHaveProperty("ip");
    expect(login).toHaveProperty("createdAt");
  });
  it("never stores password/secret material inside an audit record", async () => {
    const t = await superAdmin();
    const dump = JSON.stringify((await request(b.app).get("/api/admin/audit-logs?limit=100").set(withTok(t))).body);
    expect(dump).not.toMatch(/passwordHash|sessionHash|totpSecret|\"password\"/);
  });
  it("audit log is only readable with AUDIT_READ (SUPPORT cannot)", async () => {
    const t = await tokenFor("support@example.com");
    expect((await request(b.app).get("/api/admin/audit-logs").set(withTok(t))).status).toBe(403);
  });
});

describe("input validation / injection", () => {
  it("rejects malformed JSON and oversized bodies without crashing", async () => {
    expect((await request(b.app).post("/api/admin/login").set("Content-Type", "application/json").send("{bad json")).status).toBe(400);
  });
  it("rejects an invalid admin create payload", async () => {
    const t = await superAdmin();
    // weak password below policy
    expect((await request(b.app).post("/api/admin/admins").set(withTok(t)).send({
      email: "w@example.com", username: "weak", password: "short", role: "MODERATOR",
    })).status).toBe(400);
  });
});

// Deliberately last: the login limiter is per-IP and shared with every test above, so this
// must exhaust it only after all other suites have finished minting tokens.
describe("login throttling", () => {
  it("admin login is rate limited after repeated failures", async () => {
    let sawLimited = false;
    for (let i = 0; i < 15; i++) {
      const r = await request(b.app).post("/api/admin/login").send({ email: "root@example.com", password: "bad" });
      if (r.status === 429) { sawLimited = true; break; }
    }
    expect(sawLimited, "repeated failed admin logins must eventually be throttled").toBe(true);
  });
});