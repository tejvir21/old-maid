import os from "node:os";
import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  ADMIN_COLLECTIONS, EDITABLE_FIELDS, adminCollectionSchema, adminListQuerySchema, adminLoginSchema,
  banUserSchema, createAdminSchema, createReportSchema, dbEditSchema, reasonSchema, updateAdminSchema, updateReportSchema,
  type Permission,
} from "@old-maid/shared";
import type { AdminAuthService, AdminPrincipal, RequestMeta } from "../auth/adminAuth.js";
import { toPublicAdmin } from "../auth/adminAuth.js";
import type { Services } from "../services/container.js";
import { AppError } from "../util/errors.js";
import { asyncHandler, requestMeta, requireAdmin, requirePermission, requireSuperAdmin } from "./adminAuth.js";
import { requireAuth } from "./middleware.js";

/** Fields stripped from every admin response, whatever the collection. */
const strip = <T extends Record<string, unknown>>(o: T): Omit<T, "passwordHash"> => {
  const { passwordHash: _drop, ...rest } = o;
  void _drop;
  return rest;
};

const userStatusPatchSchema = z.object({
  status: z.enum(["active", "suspended", "banned"]),
  reason: z.string().trim().min(3, "A reason is required").max(500),
});

export function adminRouter(s: Services, adminAuth: AdminAuthService): Router {
  const r = Router();
  const auth = requireAdmin(s, adminAuth);
  const meta = (req: Request): RequestMeta => requestMeta(req);
  const who = (req: Request): AdminPrincipal => {
    if (!req.admin) throw new AppError("UNAUTHORIZED", "Admin authentication required.", 401);
    return req.admin;
  };

  /* ---------------------------------------------------------- authentication */

  // Login is IP-throttled independently of the global limiter, so brute force is contained.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, res) => void res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later." } }),
  });

  r.post("/login", loginLimiter, asyncHandler(async (req, res) => {
    const input = adminLoginSchema.parse(req.body);
    const out = await adminAuth.login(input, requestMeta(req));
    res.json({ success: true, token: out.token, admin: out.admin });
  }));

  r.post("/logout", auth, asyncHandler(async (req, res) => {
    await adminAuth.logout(who(req), meta(req));
    res.json({ success: true });
  }));

  r.get("/me", auth, asyncHandler(async (req, res) => {
    const rec = await s.store.admin.admins.findById(who(req).adminId);
    if (!rec) throw new AppError("UNAUTHORIZED", "Admin authentication required.", 401);
    res.json({ success: true, admin: toPublicAdmin(rec), permissions: [...who(req).permissions].sort() });
  }));

  /* ---------------------------------------------------------- dashboard */

  r.get("/dashboard", auth, requirePermission("USERS_READ"), asyncHandler(async (_req, res) => {
    const [stats, live, health] = await Promise.all([s.store.admin.stats(), Promise.resolve(s.rooms.stats()), s.store.ping()]);
    const mem = process.memoryUsage();
    const reportCounts = await s.store.admin.reports.countByStatus();
    res.json({
      success: true,
      data: {
        users: stats.users,
        guests: stats.guests,
        usersToday: stats.usersToday,
        onlinePlayers: live.players,
        activeRooms: live.rooms,
        roomsPlaying: live.playing,
        activeGames: stats.activeGames,
        gamesToday: stats.gamesToday,
        totalGames: stats.totalGames,
        pendingReports: stats.pendingReports,
        reportCounts,
        syncRecords: stats.syncRecords,
        activeAdmins: stats.openAdmins,
        uptimeSec: Math.floor((Date.now() - s.startedAt) / 1000),
        health: {
          api: "ok",
          database: { kind: health.kind, ok: health.ok, latencyMs: health.latencyMs },
          socket: { connections: live.players, rooms: live.rooms },
          server: {
            nodeVersion: process.version,
            platform: process.platform,
            rssMb: Math.round(mem.rss / 1_048_576),
            heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
            cpus: os.cpus().length,
            loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
          },
        },
        instanceId: s.instanceId,
      },
    });
  }));

  /* ---------------------------------------------------------- users */

  r.get("/users", auth, requirePermission("USERS_READ"), asyncHandler(async (req, res) => {
    const q = adminListQuerySchema.parse(req.query);
    const page = await s.store.adminQuery.users(q);
    res.json({ success: true, items: page.items.map((u) => strip(u as unknown as Record<string, unknown>)), total: page.total, limit: page.limit, offset: page.offset });
  }));

  r.get("/users/:id", auth, requirePermission("USERS_READ"), asyncHandler(async (req, res) => {
    const u = await s.store.users.findById(req.params.id ?? "");
    if (!u) throw new AppError("NOT_FOUND", "User not found.", 404);
    const [stats, games, bans] = await Promise.all([
      s.store.stats.get(u.id),
      s.store.adminQuery.userGames(u.id, 25),
      s.store.bans.isBanned(u.id),
    ]);
    res.json({
      success: true,
      user: {
        ...strip(u as unknown as Record<string, unknown>),
        banned: bans,
        stats,
        onlineGames: games.online,
        offlineGames: games.offline,
      },
    });
  }));

  const banHandler = asyncHandler(async (req, res) => {
    const input = banUserSchema.parse(req.body);
    const target = await s.store.users.findById(req.params.id ?? "");
    if (!target) throw new AppError("NOT_FOUND", "User not found.", 404);
    await s.store.bans.create({
      userId: target.id, reason: input.reason, createdBy: who(req).adminId, expiresAt: input.expiresAt ?? null,
    });
    await s.store.adminQuery.setUserStatus(target.id, "banned");
    await s.store.sessions.revokeAllForUser(target.id);
    await adminAuth.audit(who(req), "USER_BAN", "user", target.id, { status: target.status }, { status: "banned" }, input.reason, meta(req));
    res.json({ success: true });
  });
  r.post("/users/:id/ban", auth, requirePermission("USERS_BAN"), banHandler);
  r.post("/users/:id/suspend", auth, requirePermission("USERS_BAN"), banHandler);

  r.post("/users/:id/unban", auth, requirePermission("USERS_BAN"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const target = await s.store.users.findById(req.params.id ?? "");
    if (!target) throw new AppError("NOT_FOUND", "User not found.", 404);
    await s.store.bans.lift(target.id);
    await s.store.adminQuery.setUserStatus(target.id, "active");
    await adminAuth.audit(who(req), "USER_UNBAN", "user", target.id, { status: target.status }, { status: "active" }, reason, meta(req));
    res.json({ success: true });
  }));

  r.post("/users/:id/restore", auth, requirePermission("USERS_BAN"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const target = await s.store.users.findById(req.params.id ?? "");
    if (!target) throw new AppError("NOT_FOUND", "User not found.", 404);
    await s.store.bans.lift(target.id);
    await s.store.adminQuery.setUserStatus(target.id, "active");
    await adminAuth.audit(who(req), "USER_RESTORE", "user", target.id, { status: target.status }, { status: "active" }, reason, meta(req));
    res.json({ success: true });
  }));

  r.patch("/users/:id", auth, requirePermission("USERS_WRITE"), asyncHandler(async (req, res) => {
    const { status, reason } = userStatusPatchSchema.parse(req.body);
    const target = await s.store.users.findById(req.params.id ?? "");
    if (!target) throw new AppError("NOT_FOUND", "User not found.", 404);
    await s.store.adminQuery.setUserStatus(target.id, status);
    // A status change must invalidate any live player session immediately.
    await s.store.sessions.revokeAllForUser(target.id);
    await adminAuth.audit(who(req), status === "banned" ? "USER_BAN" : "USER_SUSPEND", "user", target.id,
      { status: target.status }, { status }, reason, meta(req));
    res.json({ success: true });
  }));

  /* ---------------------------------------------------------- rooms */

  r.get("/rooms", auth, requirePermission("ROOMS_READ"), asyncHandler(async (req, res) => {
    const q = adminListQuerySchema.parse(req.query);
    const [page, live] = await Promise.all([s.store.adminQuery.rooms(q), Promise.resolve(s.rooms.listRooms())]);
    // Live rooms are the source of truth for "is it running right now".
    const liveByCode = new Map(live.map((l) => [l.code, l]));
    res.json({
      success: true,
      total: page.total + live.filter((l) => !page.items.some((p) => p.code === l.code)).length,
      limit: page.limit, offset: page.offset,
      items: [...page.items.map((p) => ({ ...p, live: liveByCode.get(p.code) ?? null })),
              ...live.filter((l) => !page.items.some((p) => p.code === l.code)).map((l) => ({ ...l, live: l }))]
        .slice(page.offset, page.offset + page.limit),
    });
  }));

  r.get("/rooms/:code", auth, requirePermission("ROOMS_READ"), asyncHandler(async (req, res) => {
    const code = (req.params.code ?? "").toUpperCase();
    const live = s.rooms.listRooms().find((l) => l.code === code) ?? null;
    const detail = s.rooms.publicRoomSnapshot(code);
    // Only public metadata — never another player's hand or the Joker's location.
    res.json({ success: true, room: live, detail });
  }));

  r.post("/rooms/:code/close", auth, requirePermission("ROOMS_WRITE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const code = (req.params.code ?? "").toUpperCase();
    const ok = s.rooms.closeRoom(code, "closed", "An administrator closed this room.");
    if (!ok) throw new AppError("NOT_FOUND", "Room not found or already closed.", 404);
    await adminAuth.audit(who(req), "ROOM_CLOSE", "room", code, undefined, undefined, reason, meta(req));
    res.json({ success: true });
  }));

  r.post("/rooms/:code/expire", auth, requirePermission("ROOMS_WRITE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const code = (req.params.code ?? "").toUpperCase();
    const ok = s.rooms.closeRoom(code, "expired", "This room has expired.");
    if (!ok) throw new AppError("NOT_FOUND", "Room not found or already closed.", 404);
    await adminAuth.audit(who(req), "ROOM_EXPIRE", "room", code, undefined, undefined, reason, meta(req));
    res.json({ success: true });
  }));

  r.post("/rooms/:code/lock", auth, requirePermission("ROOMS_WRITE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const ok = s.rooms.lockRoom((req.params.code ?? "").toUpperCase(), true);
    if (!ok) throw new AppError("NOT_FOUND", "Room not found.", 404);
    await adminAuth.audit(who(req), "ROOM_LOCK", "room", (req.params.code ?? "").toUpperCase(), undefined, { locked: true }, reason, meta(req));
    res.json({ success: true });
  }));

  r.post("/rooms/:code/unlock", auth, requirePermission("ROOMS_WRITE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const ok = s.rooms.lockRoom((req.params.code ?? "").toUpperCase(), false);
    if (!ok) throw new AppError("NOT_FOUND", "Room not found.", 404);
    await adminAuth.audit(who(req), "ROOM_UNLOCK", "room", (req.params.code ?? "").toUpperCase(), { locked: true }, { locked: false }, reason, meta(req));
    res.json({ success: true });
  }));

  /* ---------------------------------------------------------- games */

  r.get("/games", auth, requirePermission("GAMES_READ"), asyncHandler(async (req, res) => {
    const q = adminListQuerySchema.parse(req.query);
    const page = await s.store.adminQuery.games(q);
    res.json({ success: true, ...page });
  }));

  r.get("/games/:id", auth, requirePermission("GAMES_READ"), asyncHandler(async (req, res) => {
    const detail = await s.store.adminQuery.gameDetail(req.params.id ?? "");
    if (!detail) throw new AppError("NOT_FOUND", "Game not found.", 404);
    res.json({ success: true, ...detail });
  }));

  r.post("/games/:id/terminate", auth, requirePermission("GAMES_MANAGE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const gameId = req.params.id ?? "";
    // Administrative termination. No winner is ever invented: the game is recorded as
    // "abandoned" with the admin id + reason, which is distinct from a completed match.
    const out = await s.rooms.adminTerminateGame(gameId, { adminId: who(req).adminId, reason });
    if (!out.ok) throw new AppError(out.code, out.message, out.code === "NOT_FOUND" ? 404 : 409);
    await adminAuth.audit(who(req), "GAME_TERMINATE", "game", gameId, { status: "playing" }, { status: "abandoned", endedByAdmin: { adminId: who(req).adminId } }, reason, meta(req));
    res.json({ success: true, outcome: "abandoned" });
  }));

  r.post("/games/:id/pause", auth, requirePermission("GAMES_MANAGE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const ok = s.rooms.adminPauseGame(req.params.id ?? "", reason);
    if (!ok) throw new AppError("NOT_FOUND", "Game not found or already finished.", 404);
    await adminAuth.audit(who(req), "GAME_PAUSE", "game", req.params.id ?? "", undefined, { paused: true }, reason, meta(req));
    res.json({ success: true });
  }));

  r.post("/games/:id/resume", auth, requirePermission("GAMES_MANAGE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const ok = s.rooms.adminResumeGame(req.params.id ?? "");
    if (!ok) throw new AppError("NOT_FOUND", "Game not found or not paused.", 404);
    await adminAuth.audit(who(req), "GAME_RESUME", "game", req.params.id ?? "", { paused: true }, { paused: false }, reason, meta(req));
    res.json({ success: true });
  }));

  /* ---------------------------------------------------------- reports */

  r.get("/reports", auth, requirePermission("REPORTS_READ"), asyncHandler(async (req, res) => {
    const q = adminListQuerySchema.parse(req.query);
    res.json({ success: true, ...(await s.store.admin.reports.list(q)) });
  }));

  r.patch("/reports/:id", auth, requirePermission("REPORTS_MANAGE"), asyncHandler(async (req, res) => {
    const input = updateReportSchema.parse(req.body);
    const cur = await s.store.admin.reports.findById(req.params.id ?? "");
    if (!cur) throw new AppError("NOT_FOUND", "Report not found.", 404);
    const patch: Record<string, unknown> = {};
    if (input.status) patch.status = input.status;
    if (input.assignedTo !== undefined) patch.assignedTo = input.assignedTo ?? undefined;
    if (input.resolution) patch.resolution = input.resolution;
    const next = await s.store.admin.reports.update(cur.id, patch, {
      at: new Date(), adminId: who(req).adminId,
      action: input.status ? `STATUS:${input.status}` : input.assignedTo !== undefined ? "ASSIGNED" : "NOTE",
      ...(input.reason ? { note: input.reason } : {}),
    });
    await adminAuth.audit(who(req), "REPORT_STATUS", "report", cur.id, { status: cur.status, assignedTo: cur.assignedTo }, { status: next?.status, assignedTo: next?.assignedTo }, input.reason, meta(req));
    res.json({ success: true, report: next });
  }));

  /* ---------------------------------------------------------- chat moderation */

  r.get("/chat", auth, requirePermission("REPORTS_READ"), asyncHandler(async (req, res) => {
    const q = adminListQuerySchema.extend({ roomCode: z.string().trim().max(16).optional() }).parse(req.query);
    res.json({ success: true, ...(await s.store.adminQuery.chat(q)) });
  }));

  r.post("/chat/:id/delete", auth, requirePermission("REPORTS_MANAGE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const ok = await s.store.adminQuery.setChatStatus(req.params.id ?? "", "deleted", who(req).adminId);
    if (!ok) throw new AppError("NOT_FOUND", "Message not found.", 404);
    await adminAuth.audit(who(req), "REPORT_DELETE_MESSAGE", "chatMessage", req.params.id ?? "", { status: "visible" }, { status: "deleted" }, reason, meta(req));
    res.json({ success: true });
  }));

  r.post("/chat/:id/restore", auth, requirePermission("REPORTS_MANAGE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const ok = await s.store.adminQuery.setChatStatus(req.params.id ?? "", "visible", who(req).adminId);
    if (!ok) throw new AppError("NOT_FOUND", "Message not found.", 404);
    await adminAuth.audit(who(req), "REPORT_DELETE_MESSAGE", "chatMessage", req.params.id ?? "", { status: "deleted" }, { status: "visible" }, reason, meta(req));
    res.json({ success: true });
  }));

  /* ---------------------------------------------------------- statistics */

  r.get("/statistics", auth, requirePermission("SETTINGS_READ"), asyncHandler(async (_req, res) => {
    const [db, live, reports] = await Promise.all([s.store.admin.stats(), Promise.resolve(s.rooms.stats()), s.store.admin.reports.countByStatus()]);
    const dayAgo = Date.now() - 86_400_000;
    const recent = await s.store.adminQuery.games({ limit: 100, offset: 0 });
    const finishedToday = recent.items.filter((g) => g.status === "finished" && g.startedAt.getTime() >= dayAgo).length;
    res.json({
      success: true,
      data: {
        users: db.users, guests: db.guests, usersToday: db.usersToday,
        games: { total: db.totalGames, active: db.activeGames, today: db.gamesToday, finishedToday },
        rooms: { total: db.rooms, live: live.rooms, playing: live.playing },
        reports, syncRecords: db.syncRecords,
        onlinePlayers: live.players,
      },
    });
  }));

  /* ---------------------------------------------------------- settings + flags */

  r.get("/settings", auth, requirePermission("SETTINGS_READ"), asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      settings: {
        game: s.settings.getGame(), ai: s.settings.getAi(), system: s.settings.getSystem(), features: s.settings.getFlags(),
      },
      onlineAvailable: s.settings.onlineAvailable(),
    });
  }));

  const putSettings = (key: "game" | "ai" | "system" | "features") => asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const body = (req.body as Record<string, unknown>) ?? {};
    const value = (body.value ?? body.settings ?? body) as unknown;
    const before = key === "game" ? s.settings.getGame() : key === "ai" ? s.settings.getAi() : key === "system" ? s.settings.getSystem() : s.settings.getFlags();
    const next = key === "game" ? await s.settings.updateGame(value, who(req).adminId)
      : key === "ai" ? await s.settings.updateAi(value, who(req).adminId)
      : key === "system" ? await s.settings.updateSystem(value, who(req).adminId)
      : await s.settings.updateFlags(value as never, who(req).adminId);
    await adminAuth.audit(who(req), key === "features" ? "FEATURE_FLAG_UPDATE" : "SETTINGS_UPDATE", "settings", key, before, next, reason, meta(req));
    res.json({ success: true, value: next });
  });
  r.put("/settings/game", auth, requirePermission("SETTINGS_WRITE"), putSettings("game"));
  r.put("/settings/ai", auth, requirePermission("SETTINGS_WRITE"), putSettings("ai"));
  r.put("/settings/system", auth, requirePermission("SETTINGS_WRITE"), putSettings("system"));
  r.put("/settings/features", auth, requirePermission("SETTINGS_WRITE"), putSettings("features"));

  r.post("/settings/maintenance", auth, requirePermission("SETTINGS_WRITE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const { enabled, message } = z.object({ enabled: z.boolean(), message: z.string().max(300).optional() }).parse(req.body);
    const before = s.settings.getSystem();
    const next = await s.settings.updateSystem({
      ...before, maintenanceMode: enabled,
      ...(message !== undefined ? { maintenanceMessage: message } : {}),
    }, who(req).adminId);
    await adminAuth.audit(who(req), "MAINTENANCE_MODE", "settings", "system", { maintenanceMode: before.maintenanceMode }, { maintenanceMode: next.maintenanceMode }, reason, meta(req));
    res.json({ success: true, value: next });
  }));

  /* ---------------------------------------------------------- database console */

  r.get("/database/collections", auth, requirePermission("DATABASE_READ"), asyncHandler(async (_req, res) => {
    res.json({ success: true, collections: ADMIN_COLLECTIONS.map((name) => ({ name, editableFields: EDITABLE_FIELDS[name] ?? [], protected: name === "auditLogs" || name === "settings" })) });
  }));

  r.get("/database/:collection", auth, requirePermission("DATABASE_READ"), asyncHandler(async (req, res) => {
    const name = adminCollectionSchema.parse(req.params.collection);
    const q = adminListQuerySchema.parse(req.query);
    const page = await s.store.admin.collection(name, { ...(q.q ? { q: q.q } : {}), limit: q.limit, offset: q.offset });
    // Defence in depth: strip secrets even if a future query ever selects them.
    res.json({ success: true, collection: name, items: page.items.map((d) => strip(d)), total: page.total, limit: page.limit, offset: page.offset });
  }));

  r.patch("/database/:collection/:id", auth, requirePermission("DATABASE_WRITE"), asyncHandler(async (req, res) => {
    const input = dbEditSchema.parse({ collection: req.params.collection, id: req.params.id, changes: (req.body as Record<string, unknown>).changes, reason: (req.body as Record<string, unknown>).reason });
    const allowed = EDITABLE_FIELDS[input.collection] ?? [];
    for (const k of Object.keys(input.changes)) {
      if (!allowed.includes(k)) throw new AppError("FORBIDDEN", `Field '${k}' is not editable in ${input.collection}.`, 403);
      if (/^\$/.test(k)) throw new AppError("BAD_REQUEST", "Update operators are not accepted.", 400);
    }
    const after = await s.store.admin.updateRecord(input.collection, input.id, input.changes);
    if (!after) throw new AppError("NOT_FOUND", "Record not found.", 404);
    await adminAuth.audit(who(req), "DB_EDIT", input.collection, input.id, undefined, strip(after), input.reason, meta(req));
    res.json({ success: true, record: strip(after) });
  }));

  r.delete("/database/:collection/:id", auth, requirePermission("DATABASE_WRITE"), asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body ?? {});
    const name = adminCollectionSchema.parse(req.params.collection);
    const ok = await s.store.admin.softDelete(name, req.params.id ?? "");
    if (!ok) throw new AppError("NOT_FOUND", "Record not found.", 404);
    await adminAuth.audit(who(req), "DB_SOFT_DELETE", name, req.params.id ?? "", undefined, { isDeleted: true }, reason, meta(req));
    res.json({ success: true, mode: "soft" });
  }));

  // Permanent deletion is SUPER_ADMIN only and refuses protected collections.
  r.delete("/database/:collection/:id/purge", auth, requireSuperAdmin, asyncHandler(async (req, res) => {
    const { reason } = reasonSchema.parse(req.body ?? {});
    const name = adminCollectionSchema.parse(req.params.collection);
    const ok = await s.store.admin.purge(name, req.params.id ?? "");
    if (!ok) throw new AppError("FORBIDDEN", "Record cannot be permanently deleted (missing or protected collection).", 403);
    await adminAuth.audit(who(req), "DB_DELETE", name, req.params.id ?? "", undefined, { purged: true }, reason, meta(req));
    res.json({ success: true, mode: "permanent" });
  }));

  /* ---------------------------------------------------------- audit logs */

  r.get("/audit-logs", auth, requirePermission("AUDIT_READ"), asyncHandler(async (req, res) => {
    const q = adminListQuerySchema.extend({ action: z.string().max(64).optional(), adminId: z.string().max(64).optional(), resource: z.string().max(64).optional() }).parse(req.query);
    res.json({ success: true, ...(await s.store.admin.audit.list(q)) });
  }));

  /* ---------------------------------------------------------- admin accounts */

  r.get("/admins", auth, requirePermission("ADMINS_READ"), asyncHandler(async (_req, res) => {
    const list = await s.store.admin.admins.list();
    res.json({ success: true, items: list.map((a) => toPublicAdmin(a)) });
  }));

  r.post("/admins", auth, requirePermission("ADMINS_WRITE"), asyncHandler(async (req, res) => {
    const rec = await adminAuth.createAdmin(who(req), createAdminSchema.parse(req.body), meta(req));
    res.json({ success: true, admin: toPublicAdmin(rec) });
  }));

  r.patch("/admins/:id", auth, requirePermission("ADMINS_WRITE"), asyncHandler(async (req, res) => {
    const next = await adminAuth.updateAdmin(who(req), req.params.id ?? "", updateAdminSchema.parse(req.body), meta(req));
    res.json({ success: true, admin: toPublicAdmin(next) });
  }));

  r.post("/admins/:id/revoke-sessions", auth, requirePermission("ADMINS_WRITE"), asyncHandler(async (req, res) => {
    await adminAuth.revokeSessions(who(req), req.params.id ?? "", meta(req));
    res.json({ success: true });
  }));

  /* ---------------------------------------------------------- system health */

  r.get("/system-health", auth, requirePermission("SETTINGS_READ"), asyncHandler(async (_req, res) => {
    const [db, live] = await Promise.all([s.store.ping(), Promise.resolve(s.rooms.stats())]);
    res.json({
      success: true,
      data: {
        api: { status: "ok", uptimeSec: Math.floor((Date.now() - s.startedAt) / 1000), instanceId: s.instanceId },
        database: { kind: db.kind, ok: db.ok, latencyMs: db.latencyMs },
        socket: { ok: true, rooms: live.rooms, playingRooms: live.playing, connectedPlayers: live.players },
        settings: { game: s.settings.getGame(), system: s.settings.getSystem(), features: s.settings.getFlags() },
        memory: process.memoryUsage(),
        node: process.version,
      },
    });
  }));

  /* ---------------------------------------------------------- diagnostics (SUPER_ADMIN) */

  // Hidden live-game state is SUPER_ADMIN only and every access is audited.
  r.get("/debug/game/:id", auth, requireSuperAdmin, asyncHandler(async (req, res) => {
    const snap = s.rooms.debugSnapshot(req.params.id ?? "");
    if (!snap) throw new AppError("NOT_FOUND", "Game not found.", 404);
    await adminAuth.audit(who(req), "DEBUG_STATE_READ", "game", req.params.id ?? "", undefined, undefined, "hidden state inspected", meta(req));
    res.json({ success: true, snapshot: snap });
  }));

  return r;
}

/* ---------------------------------------------------------- player-facing report submission */

export function reportRouter(s: Services): Router {
  const r = Router();
  const playerAuth = requireAuth(s);
  r.post("/", playerAuth, asyncHandler(async (req, res) => {
    const userId = (req.auth as { userId: string }).userId;
    const input = createReportSchema.parse(req.body);
    const rec = await s.store.admin.reports.create({
      category: input.category, reporterId: userId, description: input.description,
      ...(input.targetUserId ? { targetUserId: input.targetUserId } : {}),
      ...(input.roomCode ? { roomCode: input.roomCode.toUpperCase() } : {}),
      ...(input.chatMessageId ? { chatMessageId: input.chatMessageId } : {}),
    });
    res.json({ success: true, id: rec.id });
  }));
  return r;
}

export type { Permission };