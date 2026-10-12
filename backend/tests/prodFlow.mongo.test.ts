import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { createServices, type Services } from "../src/services/container.js";
import { attachSocketGateway } from "../src/socket/socket.js";
import { MongoStore } from "../src/store/mongo.js";
import { silentLogger } from "../src/util/logger.js";

/**
 * The exact production journey, running against a REAL MongoDB:
 *   POST /api/auth/guest  ->  POST /api/auth/session  ->  Socket.IO  ->  create_room
 *
 * This is the sequence that returned HTTP 500 / failed to connect in production because of
 * `Cast to Boolean failed for value "{ '$ne': true }"`. Skipped unless MONGODB_TEST_URI is set.
 */
const uri = process.env["MONGODB_TEST_URI"];
const SECRET = "test-secret-test-secret-test-secret-123456";

describe.skipIf(!uri)("production guest -> socket -> room flow (real MongoDB)", () => {
  let services: Services;
  let app: Express;
  let server: Server;
  let base: string;
  let closeGateway: () => Promise<void>;

  beforeAll(async () => {
    const env = loadEnv({ NODE_ENV: "test", JWT_ACCESS_SECRET: SECRET, CLIENT_URL: "http://localhost:5173" } as NodeJS.ProcessEnv);
    const store = new MongoStore(uri as string);
    await store.connect();
    services = await createServices(env, silentLogger, {
      store,
      timing: { reconnectMs: 400, turnMs: 0, roomExpiryMs: 60_000, aiDelayMinMs: 0, aiDelayMaxMs: 0 },
    });
    app = createApp(services, { globalLimitPerMin: 100_000, authLimitPerMin: 1000 });
    server = createServer(app);
    const gw = attachSocketGateway(server, {
      rooms: services.rooms, registry: services.registry, store: services.store as never,
      log: silentLogger, jwtSecret: SECRET, allowedOrigins: env.allowedOrigins,
    });
    closeGateway = gw.close;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await closeGateway?.();
    await new Promise<void>((r) => server.close(() => r()));
    await services?.store.close();
  }, 30_000);

  const connect = (token: string): Promise<Socket> =>
    new Promise((res, rej) => {
      const s = ioClient(base, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
      s.on("connect", () => res(s));
      s.on("connect_error", (e) => { s.close(); rej(e); });
    });

  it("health reports a connected database", async () => {
    const r = await fetch(`${base}/health`);
    const body = await r.json() as { status: string; database: string };
    expect(r.status).toBe(200);
    expect(body.database).toBe("connected");
  });

  it("runs the whole flow: guest -> session -> me -> socket -> room", async () => {
    // 1. frontend asks for a guest session
    const guestRes = await fetch(`${base}/api/auth/guest`, { method: "POST" });
    expect(guestRes.status).toBe(201);
    const guest = await guestRes.json() as { token: string; sessionId: string; user: { id: string; isGuest: boolean } };
    expect(guest.user.isGuest).toBe(true);
    expect(typeof guest.sessionId).toBe("string");

    // 2/3. the stored session secret is exchanged for a token (this returned 500 in production)
    const sessRes = await fetch(`${base}/api/auth/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: guest.sessionId }),
    });
    expect(sessRes.status).toBe(200);
    const sess = await sessRes.json() as { token: string; user: { id: string } };
    expect(sess.user.id).toBe(guest.user.id);

    // 4/5. the token authenticates an HTTP request
    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${sess.token}` } });
    expect(me.status).toBe(200);

    // 6. Socket.IO accepts the same credentials (the handshake calls users.findById)
    const sock = await connect(sess.token);
    try {
      expect(sock.connected).toBe(true);

      // 7. room creation succeeds
      const acked = await new Promise<{ ok: boolean; roomCode?: string; error?: { code: string } }>((res) => {
        sock.emit("create_room", { playerName: "MongoGuest" }, res);
      });
      expect(acked.ok).toBe(true);
      expect(typeof acked.roomCode).toBe("string");

      // 8. reconnect with the same session restores the room
      sock.disconnect();
      await new Promise((r) => setTimeout(r, 150));
      const again = await connect(sess.token);
      try {
        const resumed = await new Promise<{ ok: boolean; roomCode?: string }>((res) => {
          again.emit("resume_session", res);
        });
        expect(resumed.ok).toBe(true);
        expect(resumed.roomCode).toBe(acked.roomCode);
      } finally {
        again.disconnect();
      }
    } finally {
      sock.disconnect();
    }
  }, 60_000);

  it("a soft-deleted user cannot authenticate over HTTP or open a socket", async () => {
    const g = await fetch(`${base}/api/auth/guest`, { method: "POST" });
    const guest = await g.json() as { token: string; user: { id: string } };
    await services.store.admin.softDelete("users", guest.user.id);

    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${guest.token}` } });
    expect(me.status).toBe(401);

    await expect(connect(guest.token)).rejects.toThrow(/UNAUTHORIZED/);
  }, 30_000);

  it("an unknown session id is rejected with 401, never a 500", async () => {
    const r = await fetch(`${base}/api/auth/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: randomUUID() }),
    });
    expect(r.status).toBe(401);
  }, 30_000);

  it("a revoked session stops working immediately", async () => {
    const g = await fetch(`${base}/api/auth/guest`, { method: "POST" });
    const guest = await g.json() as { sessionId: string; user: { id: string } };
    await services.store.sessions.revokeAllForUser(guest.user.id);
    const r = await fetch(`${base}/api/auth/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: guest.sessionId }),
    });
    expect(r.status).toBe(401);
  }, 30_000);
});