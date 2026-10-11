import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { io as ioClient, type Socket } from "socket.io-client";
import type { Express } from "express";
import { createApp, type AppOptions } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { createServices, type Services } from "../src/services/container.js";
import { attachSocketGateway, type GatewayDeps } from "../src/socket/socket.js";
import { MemoryStore } from "../src/store/memory.js";
import type { Timing } from "../src/rooms/roomTypes.js";
import { silentLogger } from "../src/util/logger.js";

export const SECRET = "test-secret-test-secret-test-secret-123456";

export interface Booted {
  services: Services;
  app: Express;
  server: Server;
  url: string;
  store: MemoryStore;
  close(): Promise<void>;
}

export async function boot(opts: { timing?: Partial<Timing>; app?: AppOptions; rateLimits?: GatewayDeps["rateLimits"] } = {}): Promise<Booted> {
  const env = loadEnv({ NODE_ENV: "test", JWT_ACCESS_SECRET: SECRET, CLIENT_URL: "http://localhost:5173" } as NodeJS.ProcessEnv);
  const store = new MemoryStore();
  const services = await createServices(env, silentLogger, {
    store,
    timing: { reconnectMs: 400, turnMs: 0, roomExpiryMs: 60_000, aiDelayMinMs: 0, aiDelayMaxMs: 0, ...opts.timing },
  });
  const app = createApp(services, { authLimitPerMin: 1000, ...opts.app });
  const server = createServer(app);
  const gateway = attachSocketGateway(server, {
    rooms: services.rooms, registry: services.registry, store, log: silentLogger, jwtSecret: SECRET,
    allowedOrigins: env.allowedOrigins, ...(opts.rateLimits ? { rateLimits: opts.rateLimits } : {}),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    services, app, server, url, store,
    async close() {
      await gateway.close().catch(() => undefined);
      server.close();
    },
  };
}

export interface Msg { event: string; payload: unknown }
export interface Client {
  sock: Socket;
  userId: string;
  token: string;
  msgs: Msg[];
  emit<T = { ok: boolean; error?: { code: string }; roomCode?: string }>(event: string, payload?: unknown): Promise<T>;
  wait(event: string, pred?: (p: any) => boolean, timeoutMs?: number): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  of(event: string): unknown[];
  close(): void;
}

export async function newUser(b: Booted): Promise<{ token: string; userId: string }> {
  const g = await b.services.auth.createGuest();
  return { token: g.token, userId: g.user.id };
}

export function connect(url: string, token: string, userId = ""): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock = ioClient(url, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
    const msgs: Msg[] = [];
    sock.onAny((event: string, payload: unknown) => msgs.push({ event, payload }));
    const client: Client = {
      sock, userId, token, msgs,
      emit: (event, payload) =>
        new Promise((res) => {
          if (payload === undefined) sock.emit(event, (r: never) => res(r));
          else sock.emit(event, payload, (r: never) => res(r));
        }),
      wait: (event, pred = () => true, timeoutMs = 4000) =>
        new Promise((res, rej) => {
          const t0 = Date.now();
          const tick = () => {
            const m = client.msgs.find((x) => x.event === event && pred(x.payload));
            if (m) return res(m.payload);
            if (Date.now() - t0 > timeoutMs) return rej(new Error(`timeout waiting for ${event}`));
            setTimeout(tick, 5);
          };
          tick();
        }),
      of: (event) => client.msgs.filter((m) => m.event === event).map((m) => m.payload),
      close: () => void sock.close(),
    };
    sock.on("connect", () => resolve(client));
    sock.on("connect_error", (e) => {
      sock.close();
      reject(e);
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function forgedToken(opts: { secret?: string; audience?: string; sub?: string; expiresIn?: number }): string {
  return jwt.sign({}, opts.secret ?? SECRET, {
    subject: opts.sub ?? randomUUID(), audience: opts.audience ?? "old-maid:player", issuer: "old-maid", expiresIn: opts.expiresIn ?? 3600,
  });
}
