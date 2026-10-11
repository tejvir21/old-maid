import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  createRoomSchema, joinRoomSchema,
  type Ack, type ClientToServerEvents, type ServerToClientEvents,
} from "@old-maid/shared";
import { verifyPlayerToken } from "../auth/tokens.js";
import type { RoomManager } from "../rooms/roomManager.js";
import type { Store } from "../store/types.js";
import type { Logger } from "../util/logger.js";
import { err } from "../util/errors.js";
import { SlidingWindowLimiter } from "../util/rateLimiter.js";
import type { SocketRegistry } from "./registry.js";

export interface GatewayDeps {
  rooms: RoomManager;
  registry: SocketRegistry;
  store: Store;
  log: Logger;
  jwtSecret: string;
  allowedOrigins: string[];
  now?: () => number;
  /** Override per-player socket rate limits (tests / tuning). */
  rateLimits?: Partial<Record<"general" | "room" | "draw" | "chat" | "emote", { max: number; windowMs: number }>>;
}

type RawSocket = { on(event: string, cb: (...args: unknown[]) => void): void };

export function attachSocketGateway(httpServer: HttpServer, deps: GatewayDeps) {
  const { rooms, registry, store, log } = deps;
  const now = deps.now ?? Date.now;
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    // Never "*": only the configured front-end origins may open a socket.
    cors: { origin: deps.allowedOrigins, credentials: true },
    maxHttpBufferSize: 8 * 1024,
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });

  const L = { general: { max: 60, windowMs: 10_000 }, room: { max: 8, windowMs: 60_000 }, draw: { max: 12, windowMs: 5_000 },
    chat: { max: 6, windowMs: 10_000 }, emote: { max: 8, windowMs: 10_000 }, ...deps.rateLimits };
  const limiters = {
    general: new SlidingWindowLimiter(L.general.max, L.general.windowMs, now),
    room: new SlidingWindowLimiter(L.room.max, L.room.windowMs, now),
    draw: new SlidingWindowLimiter(L.draw.max, L.draw.windowMs, now),
    chat: new SlidingWindowLimiter(L.chat.max, L.chat.windowMs, now),
    emote: new SlidingWindowLimiter(L.emote.max, L.emote.windowMs, now),
  } as const;
  type LimiterName = keyof typeof limiters;

  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      if (typeof token !== "string") return next(new Error("UNAUTHORIZED"));
      const claims = verifyPlayerToken(deps.jwtSecret, token);
      if (!claims) return next(new Error("UNAUTHORIZED"));
      const user = await store.users.findById(claims.userId);
      if (!user) return next(new Error("UNAUTHORIZED"));
      if (user.status === "banned" || user.status === "suspended" || (await store.bans.isBanned(user.id))) return next(new Error("BANNED"));
      socket.data.userId = user.id;
      next();
    } catch (e) {
      log.error("socket auth failed", { error: e instanceof Error ? e.message : String(e) });
      next(new Error("INTERNAL"));
    }
  });

  io.on("connection", (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
    const playerId = socket.data.userId as string;
    const prev = registry.register(playerId, socket as unknown as Socket);
    if (prev) {
      (prev as unknown as { emit(e: string, ...a: unknown[]): void }).emit("server_notice", { message: "You signed in from another tab or device.", code: "TAKEOVER" });
      prev.disconnect(true);
    }
    log.info("socket connected", { player: playerId });
    rooms.onConnect(playerId);

    const raw = socket as unknown as RawSocket;
    const reply = (ack: unknown, r: Ack<object>) => {
      if (typeof ack === "function") (ack as (r: Ack<object>) => void)(r);
    };
    const on = (event: string, limiter: LimiterName | null, fn: (payload: unknown) => Ack<object>) => {
      raw.on(event, (...args: unknown[]) => {
        const ack = args[args.length - 1];
        const payload = typeof args[0] === "function" ? undefined : args[0];
        try {
          if (!limiters.general.allow(playerId) || (limiter && !limiters[limiter].allow(playerId))) {
            return reply(ack, err("RATE_LIMITED", "You are doing that too fast."));
          }
          reply(ack, fn(payload));
        } catch (e) {
          log.error("socket handler error", { event, error: e instanceof Error ? e.message : String(e) });
          reply(ack, err("INTERNAL", "Something went wrong."));
        }
      });
    };

    on("create_room", "room", (p) => {
      const parsed = createRoomSchema.safeParse(p);
      if (!parsed.success) return err("INVALID_NAME", parsed.error.issues[0]?.message ?? "Invalid request");
      const r = rooms.createRoom(playerId, parsed.data.playerName);
      return r.ok ? { ok: true, roomCode: r.roomCode, playerId } : r;
    });
    on("join_room", "room", (p) => {
      const parsed = joinRoomSchema.safeParse(p);
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        return field === "roomCode" ? err("ROOM_NOT_FOUND", "That room code is not valid.") : err("INVALID_NAME", parsed.error.issues[0]?.message ?? "Invalid name");
      }
      const r = rooms.joinRoom(playerId, parsed.data.playerName, parsed.data.roomCode);
      return r.ok ? { ok: true, roomCode: r.roomCode, playerId } : r;
    });
    on("resume_session", null, () => {
      const room = rooms.roomOf(playerId);
      if (!room) return err("NOT_IN_ROOM", "You are not in a room.");
      rooms.onConnect(playerId);
      return { ok: true, roomCode: room.code, playerId };
    });
    on("leave_room", null, () => rooms.leaveRoom(playerId));
    on("start_game", "room", (p) => rooms.startGame(playerId, p));
    on("request_draw", "draw", (p) => rooms.requestDraw(playerId, p));
    on("chat_message", "chat", (p) => rooms.chat(playerId, p));
    on("emote", "emote", (p) => rooms.emote(playerId, p));
    on("rematch", "room", () => rooms.rematch(playerId));
    on("end_match", "room", () => rooms.endMatch(playerId));

    socket.on("disconnect", () => {
      if (registry.unregister(playerId, socket as unknown as Socket)) {
        log.info("socket disconnected", { player: playerId });
        rooms.onDisconnect(playerId);
      }
    });
  });

  return {
    io,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}
