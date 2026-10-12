import { randomUUID } from "node:crypto";
import mongoose, { Schema } from "mongoose";
import type { OfflineGamePayload, StatsSummary } from "@old-maid/shared";
import type {
  AdminRecord, AdminSessionRecord, AdminStore, AuditLogRecord, BanRecord, ChatRecord, GameEventRecord, GamePlayerRecord,
  GameRecord, ReportRecord, RoomRecord, SessionRecord, SettingsDoc, SettingsKey, Store, SyncGameOutcome, SyncSummary, UserRecord,
} from "./types.js";

/* ---------- Schemas (collections follow the spec's naming) ---------- */
const mixed = Schema.Types.Mixed;

const userSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    username: { type: String, required: true },
    email: { type: String, lowercase: true },
    passwordHash: String,
    status: { type: String, enum: ["guest", "active", "suspended", "banned"], default: "guest" },
    avatar: String,
    lastLoginAt: Date,
    settings: { type: mixed },
    profileUpdatedAt: Number,
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: String,
  },
  { timestamps: true, collection: "users" },
);
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
userSchema.index({ username: 1 });

const sessionSchema = new Schema(
  {
    _id: { type: String },
    userId: { type: String, index: true },
    lastSeenAt: Date,
    revoked: { type: Boolean, default: false },
    /**
     * Optional sliding expiry. `resolve()` only rejects when this is present and in the past,
     * so sessions written before it existed keep working (they are revoked explicitly instead).
     */
    expiresAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "sessions" },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: "date" } } });

const banSchema = new Schema(
  { userId: { type: String, index: true }, reason: String, createdBy: String, expiresAt: Date, active: { type: Boolean, default: true } },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "bans" },
);

const roomSchema = new Schema(
  {
    code: { type: String, required: true }, hostId: String, status: String, playerIds: [String], maxPlayers: Number,
    createdAtMs: Number, startedAt: Date, finishedAt: Date, expiresAt: Date,
  },
  { timestamps: true, collection: "rooms" },
);
roomSchema.index({ code: 1, createdAtMs: 1 }, { unique: true });
roomSchema.index({ status: 1 });
roomSchema.index({ expiresAt: 1 });

const gameSchema = new Schema(
  {
    _id: { type: String }, roomId: { type: String, index: true }, mode: String, status: String, playerIds: [String],
    winnerId: { type: String, index: true }, startedAt: Date, finishedAt: Date, durationSec: Number, drawCount: Number, endedByAdmin: mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "games" },
);
gameSchema.index({ createdAt: -1 });

const gamePlayerSchema = new Schema(
  { gameId: { type: String, index: true }, playerId: String, userId: String, name: String, isAi: Boolean, seat: Number, result: String },
  { collection: "gamePlayers" },
);
gamePlayerSchema.index({ gameId: 1, playerId: 1 }, { unique: true });
gamePlayerSchema.index({ userId: 1 });

const gameEventSchema = new Schema(
  { gameId: { type: String, index: true }, seq: Number, type: String, actorId: String, targetId: String, text: String, createdAt: Date },
  { collection: "gameEvents" },
);
gameEventSchema.index({ gameId: 1, seq: 1 }, { unique: true });

const chatSchema = new Schema(
  { _id: String, roomCode: { type: String, index: true }, gameId: String, playerId: String, name: String, text: String,
    status: { type: String, default: "visible" }, deletedBy: String, deletedAt: Date, createdAt: Date },
  { collection: "chatMessages" },
);

const syncSchema = new Schema(
  { userId: { type: String, required: true }, localId: { type: String, required: true }, type: String,
    status: String, reason: String, receivedAt: Date, processedAt: Date },
  { collection: "syncRecords" },
);
syncSchema.index({ userId: 1, localId: 1 }, { unique: true });

const offlineGameSchema = new Schema(
  { userId: { type: String, required: true }, localGameId: { type: String, required: true }, payload: mixed, receivedAt: Date },
  { collection: "offlineGames" },
);
offlineGameSchema.index({ userId: 1, localGameId: 1 }, { unique: true });

const statsSchema = new Schema(
  {
    _id: { type: String },
    online: { games: { type: Number, default: 0 }, wins: { type: Number, default: 0 }, losses: { type: Number, default: 0 } },
    offline: { games: { type: Number, default: 0 }, wins: { type: Number, default: 0 }, losses: { type: Number, default: 0 } },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: "statistics" },
);

const settingsSchema = new Schema(
  { _id: String, value: mixed, version: { type: Number, default: 0 }, updatedBy: String },
  { timestamps: { createdAt: false, updatedAt: true }, collection: "settings" },
);

/* ---------- Phase 4: admin, sessions, audit, reports ---------- */
const adminSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    email: { type: String, required: true, lowercase: true },
    username: { type: String, required: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["SUPER_ADMIN", "ADMIN", "MODERATOR", "SUPPORT"], required: true },
    permissions: { type: [String], default: [] },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    totpSecret: String,
    failedLogins: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
    createdBy: String,
    suspendedAt: Date,
  },
  { timestamps: true, collection: "admins" },
);
adminSchema.index({ email: 1 }, { unique: true });

const adminSessionSchema = new Schema(
  { _id: { type: String }, adminId: { type: String, index: true }, lastSeenAt: Date, expiresAt: { type: Date, index: true },
    revoked: { type: Boolean, default: false }, ip: String, userAgent: String },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "adminSessions" },
);

const auditLogSchema = new Schema(
  { adminId: { type: String, index: true }, adminUsername: String, adminRole: String, action: { type: String, index: true },
    resource: String, resourceId: String, before: mixed, after: mixed, reason: String, ip: String, userAgent: String },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "auditLogs" },
);
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ adminId: 1, createdAt: -1 });

const reportSchema = new Schema(
  { category: { type: String, required: true }, status: { type: String, default: "OPEN", index: true }, reporterId: String,
    targetUserId: String, roomCode: String, chatMessageId: String, description: String, assignedTo: String,
    resolution: String, history: [mixed] },
  { timestamps: true, collection: "reports" },
);
reportSchema.index({ createdAt: -1 });

type Rec = Record<string, unknown>;
/** Minimal hand-written surface of the mongoose model API we use (avoids mongoose's very heavy generic types). */
interface FindOneChain { sort(s: Record<string, 1 | -1>): FindOneChain; lean(): Promise<Rec | null> }
interface FindChain { sort(s: Record<string, 1 | -1>): FindChain; skip(n: number): FindChain; limit(n: number): FindChain; lean(): Promise<Rec[]> }
interface LooseModel {
  findOne(filter: Rec): FindOneChain;
  find(filter: Rec): FindChain;
  create(doc: Rec): Promise<{ toObject(): Rec }>;
  updateOne(filter: Rec, update: Rec, opts?: Rec): Promise<{ modifiedCount: number }>;
  updateMany(filter: Rec, update: Rec): Promise<unknown>;
  findOneAndUpdate(filter: Rec, update: Rec, opts?: Rec): { lean(): Promise<Rec | null> };
  countDocuments(filter: Rec): Promise<number>;
  insertMany(docs: Rec[], opts?: Rec): Promise<unknown>;
  deleteOne(filter: Rec): Promise<{ deletedCount: number }>;
  init(): Promise<unknown>;
}

function model(name: string, schema: Schema): LooseModel {
  const m = mongoose.models[name] ?? mongoose.model(name, schema);
  return m as unknown as LooseModel;
}

const User = model("User", userSchema);
const Session = model("Session", sessionSchema);
const Ban = model("Ban", banSchema);
const RoomM = model("Room", roomSchema);
const GameM = model("Game", gameSchema);
const GamePlayerM = model("GamePlayer", gamePlayerSchema);
const GameEventM = model("GameEvent", gameEventSchema);
const ChatM = model("ChatMessage", chatSchema);
const SyncM = model("SyncRecord", syncSchema);
const OfflineGameM = model("OfflineGame", offlineGameSchema);
const StatsM = model("Statistics", statsSchema);
const SettingsM = model("Setting", settingsSchema);
const AdminM = model("Admin", adminSchema);
const AdminSessionM = model("AdminSession", adminSessionSchema);
const AuditM = model("AuditLog", auditLogSchema);
const ReportM = model("Report", reportSchema);

/** Collection name → model, for the database console allow-list. */
const CONSOLE_MODELS: Record<string, LooseModel> = {
  users: User, rooms: RoomM, games: GameM, gamePlayers: GamePlayerM, gameEvents: GameEventM,
  chatMessages: ChatM, syncRecords: SyncM, settings: SettingsM, reports: ReportM, auditLogs: AuditM,
};
/** Never removable, even by a SUPER_ADMIN. */
const PROTECTED_COLLECTIONS = new Set(["auditLogs", "settings"]);

const isDup = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: number }).code === 11000;

function toUser(d: Rec | null): UserRecord | null {
  if (!d) return null;
  return {
    id: String(d["_id"]), username: String(d["username"]), status: d["status"] as UserRecord["status"],
    createdAt: d["createdAt"] as Date, updatedAt: d["updatedAt"] as Date,
    ...(d["email"] ? { email: String(d["email"]) } : {}),
    ...(d["passwordHash"] ? { passwordHash: String(d["passwordHash"]) } : {}),
    ...(d["avatar"] ? { avatar: String(d["avatar"]) } : {}),
    ...(d["lastLoginAt"] ? { lastLoginAt: d["lastLoginAt"] as Date } : {}),
    ...(d["settings"] ? { settings: d["settings"] as UserRecord["settings"] } : {}),
    ...(d["profileUpdatedAt"] ? { profileUpdatedAt: Number(d["profileUpdatedAt"]) } : {}),
  } as UserRecord;
}

const zeroStats = (): StatsSummary => ({ online: { games: 0, wins: 0, losses: 0 }, offline: { games: 0, wins: 0, losses: 0 } });

/** Escapes a user-supplied search term before it is embedded in a RegExp (no injection). */
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Runtime guard for identifiers that reach a query from OUTSIDE the store (route params,
 * request bodies). `sanitizeFilter` used to cover this globally, but it also corrupted the
 * store's own legitimate operator filters, so it was removed (see `connect()`).
 *
 * It deliberately inspects a single value, never a whole filter: the store's internal filters
 * legitimately contain operator documents such as `{ revoked: { $ne: true } }`.
 */
export function assertNoOperatorInjection(value: unknown, label: string): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) assertNoOperatorInjection(v, label);
    return;
  }
  if (typeof value === "object") {
    throw new Error(`Refusing to build a query for ${label}: object values are not allowed`);
  }
}

/** Fields the database console may search on per collection (never secrets). */
const SEARCHABLE_FIELDS: Record<string, string[]> = {
  users: ["username", "email", "_id"], rooms: ["code", "hostId"], games: ["_id", "roomId"],
  gamePlayers: ["name", "playerId"], gameEvents: ["text"], chatMessages: ["text", "name", "roomCode"],
  syncRecords: ["userId", "localId"], settings: ["_id"], reports: ["description", "_id"], auditLogs: ["reason", "resourceId", "adminUsername"],
};

/** Converts a lean mongoose doc into a plain object with a stable `id` and no prototype. */
function normalizeDoc(d: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === "_id") out["id"] = String(v);
    else if (k === "__v") continue;
    else out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

function toAdmin(d: Rec | null): AdminRecord | null {
  if (!d) return null;
  return {
    id: String(d["_id"]), email: String(d["email"]), username: String(d["username"]), passwordHash: String(d["passwordHash"]),
    role: d["role"] as AdminRecord["role"], permissions: (d["permissions"] as AdminRecord["permissions"]) ?? [],
    status: (d["status"] as AdminRecord["status"]) ?? "active",
    failedLogins: Number(d["failedLogins"] ?? 0),
    createdAt: d["createdAt"] as Date, updatedAt: d["updatedAt"] as Date,
    ...(d["totpSecret"] ? { totpSecret: String(d["totpSecret"]) } : {}),
    ...(d["lockedUntil"] ? { lockedUntil: d["lockedUntil"] as Date } : {}),
    ...(d["lastLoginAt"] ? { lastLoginAt: d["lastLoginAt"] as Date } : {}),
    ...(d["createdBy"] ? { createdBy: String(d["createdBy"]) } : {}),
    ...(d["suspendedAt"] ? { suspendedAt: d["suspendedAt"] as Date } : {}),
  };
}

function fromAudit(d: Rec): AuditLogRecord {
  return {
    id: String(d["_id"]), adminId: String(d["adminId"]), adminUsername: String(d["adminUsername"] ?? ""),
    adminRole: d["adminRole"] as AuditLogRecord["adminRole"], action: d["action"] as AuditLogRecord["action"],
    resource: String(d["resource"]), resourceId: String(d["resourceId"]), createdAt: d["createdAt"] as Date,
    ...(d["before"] !== undefined ? { before: d["before"] } : {}),
    ...(d["after"] !== undefined ? { after: d["after"] } : {}),
    ...(d["reason"] ? { reason: String(d["reason"]) } : {}),
    ...(d["ip"] ? { ip: String(d["ip"]) } : {}),
    ...(d["userAgent"] ? { userAgent: String(d["userAgent"]) } : {}),
  };
}

function fromReport(d: Rec | null): ReportRecord | null {
  if (!d) return null;
  return {
    id: String(d["_id"]), category: d["category"] as ReportRecord["category"], status: d["status"] as ReportRecord["status"],
    reporterId: String(d["reporterId"]), description: String(d["description"]),
    history: (d["history"] as ReportRecord["history"]) ?? [], createdAt: d["createdAt"] as Date, updatedAt: d["updatedAt"] as Date,
    ...(d["targetUserId"] ? { targetUserId: String(d["targetUserId"]) } : {}),
    ...(d["roomCode"] ? { roomCode: String(d["roomCode"]) } : {}),
    ...(d["chatMessageId"] ? { chatMessageId: String(d["chatMessageId"]) } : {}),
    ...(d["assignedTo"] ? { assignedTo: String(d["assignedTo"]) } : {}),
    ...(d["resolution"] ? { resolution: String(d["resolution"]) } : {}),
  };
}

function fromGame(d: Rec): GameRecord {
  return {
    gameId: String(d["_id"]), roomCode: String(d["roomId"] ?? ""), mode: "online",
    status: d["status"] as GameRecord["status"], playerIds: (d["playerIds"] as string[]) ?? [],
    startedAt: d["startedAt"] as Date,
    ...(d["winnerId"] !== undefined ? { winnerId: d["winnerId"] as string | null } : {}),
    ...(d["finishedAt"] ? { finishedAt: d["finishedAt"] as Date } : {}),
    ...(d["durationSec"] ? { durationSec: Number(d["durationSec"]) } : {}),
    ...(d["drawCount"] !== undefined ? { drawCount: Number(d["drawCount"]) } : {}),
    ...(d["endedByAdmin"] ? { endedByAdmin: d["endedByAdmin"] as GameRecord["endedByAdmin"] } : {}),
  };
}

function fromRoom(d: Rec): RoomRecord {
  return {
    code: String(d["code"]), hostId: String(d["hostId"] ?? ""), status: d["status"] as RoomRecord["status"],
    playerIds: (d["playerIds"] as string[]) ?? [], maxPlayers: Number(d["maxPlayers"] ?? 7),
    createdAt: (d["createdAtMs"] ? new Date(Number(d["createdAtMs"])) : d["createdAt"]) as Date,
    ...(d["startedAt"] ? { startedAt: d["startedAt"] as Date } : {}),
    ...(d["finishedAt"] ? { finishedAt: d["finishedAt"] as Date } : {}),
    ...(d["expiresAt"] ? { expiresAt: d["expiresAt"] as Date } : {}),
  };
}

export class MongoStore implements Store {
  readonly kind = "mongo" as const;
  constructor(private readonly uri: string) {}

  async connect(): Promise<void> {
    mongoose.set("strictQuery", true);
    // NOTE: `sanitizeFilter` is deliberately NOT enabled globally.
    //
    // `sanitizeFilter` rewrites ANY filter value that contains a `$` key into `{ $eq: <value> }`.
    // This codebase legitimately queries with operators (`revoked: { $ne: true }`,
    // `expiresAt: { $gt: now }`, `$or`, `$in`, `$exists`, ...), so enabling it turned each of
    // those into `{ revoked: { $eq: { $ne: true } } }`, which then failed to cast an object
    // onto the Boolean path:
    //
    //   Cast to Boolean failed for value "{ '$ne': true }" (type Object) at path "revoked"
    //
    // That broke every player lookup (Session.resolve, User.findById) and, through it, guest
    // session creation, HTTP auth and the Socket.IO handshake.
    //
    // Operator-injection protection is provided where it actually matters: every route input is
    // parsed by a Zod schema (ids/emails are validated as primitives, so an object can never
    // reach a filter), and free-text search terms are escaped with `escRe()` before being
    // embedded in a RegExp. `assertNoOperatorInjection()` guards the dynamic paths below.
    await mongoose.connect(this.uri, { serverSelectionTimeoutMS: 8000 });
    await Promise.all([User, Session, Ban, RoomM, GameM, GamePlayerM, GameEventM, ChatM, SyncM, OfflineGameM, StatsM, SettingsM, AdminM, AdminSessionM, AuditM, ReportM].map((m) => m.init()));
  }

  users: Store["users"] = {
    createGuest: async () => {
      const id = randomUUID();
      const d = await User.create({ _id: id, username: `Guest-${id.slice(0, 4).toUpperCase()}`, status: "guest" });
      return toUser(d.toObject()) as UserRecord;
    },
    findById: async (id) => {
      assertNoOperatorInjection(id, "users.findById._id");
      return toUser(await User.findOne({ _id: id, isDeleted: { $ne: true } }).lean());
    },
    findByEmail: async (email) => {
      assertNoOperatorInjection(email, "users.findByEmail.email");
      return toUser(await User.findOne({ email: email.toLowerCase(), isDeleted: { $ne: true } }).lean());
    },
    findByUsername: async (username) => {
      assertNoOperatorInjection(username, "users.findByUsername.username");
      return toUser(await User.findOne({ username: new RegExp(`^${escRe(username)}$`, "i"), isDeleted: { $ne: true } }).lean());
    },
    upgradeToAccount: async (id, d) => {
      assertNoOperatorInjection(id, "users.upgradeToAccount._id");
      return toUser(await User.findOneAndUpdate({ _id: id, status: "guest" }, { $set: { username: d.username, email: d.email.toLowerCase(), passwordHash: d.passwordHash, status: "active" } }, { new: true }).lean());
    },
    createAccount: async (d) => {
      const doc = await User.create({ _id: randomUUID(), username: d.username, email: d.email.toLowerCase(), passwordHash: d.passwordHash, status: "active" });
      return toUser(doc.toObject()) as UserRecord;
    },
    touchLogin: async (id) => void (await User.updateOne({ _id: id }, { $set: { lastLoginAt: new Date() } })),
    applySettings: async (id, data, updatedAt) => {
      const set: Record<string, unknown> = { "settings.updatedAt": updatedAt };
      for (const [k, v] of Object.entries(data)) set[`settings.data.${k}`] = v;
      // Only applies when our stored version is older (compare-and-set).
      const res = await User.updateOne({ _id: id, $or: [{ "settings.updatedAt": { $lt: updatedAt } }, { settings: { $exists: false } }] }, { $set: set });
      if (res.modifiedCount > 0) return { applied: true, current: { data, updatedAt } };
      const cur = await User.findOne({ _id: id }).lean();
      return { applied: false, current: (cur?.["settings"] as { data: Record<string, unknown>; updatedAt: number } | undefined) ?? null };
    },
    applyProfile: async (id, d, updatedAt) => {
      const set: Record<string, unknown> = { profileUpdatedAt: updatedAt };
      if (d.displayName) set["username"] = d.displayName;
      if (d.avatar) set["avatar"] = d.avatar;
      const res = await User.updateOne({ _id: id, $or: [{ profileUpdatedAt: { $lt: updatedAt } }, { profileUpdatedAt: { $exists: false } }] }, { $set: set });
      return { applied: res.modifiedCount > 0 };
    },
  };

  sessions: Store["sessions"] = {
    create: async (userId, hash) => void (await Session.create({ _id: hash, userId, lastSeenAt: new Date(), revoked: false })),
    resolve: async (hash) => {
      assertNoOperatorInjection(hash, "sessions.resolve._id");
      // `revoked: { $ne: true }` is intentional and NOT a bug: it matches `false`, `null` and
      // documents written before the field existed. Replacing it with `revoked: false` would
      // silently lock out every legacy session that lacks the field.
      // Expiry is optional and only enforced when present, so pre-existing sessions keep working.
      const d = await Session.findOne({ _id: hash, revoked: { $ne: true } }).lean();
      if (!d) return null;
      const expiresAt = d["expiresAt"] ? (d["expiresAt"] as Date) : null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) return null; // expired
      return {
        sessionHash: String(d["_id"]), userId: String(d["userId"]), createdAt: d["createdAt"] as Date,
        lastSeenAt: d["lastSeenAt"] as Date, revoked: false, ...(expiresAt ? { expiresAt } : {}),
      } satisfies SessionRecord;
    },
    touch: async (hash, ttlMs) => {
      assertNoOperatorInjection(hash, "sessions.touch._id");
      const at = new Date();
      void (await Session.updateOne(
        { _id: hash },
        ttlMs && ttlMs > 0 ? { $set: { lastSeenAt: at, expiresAt: new Date(at.getTime() + ttlMs) } } : { $set: { lastSeenAt: at } },
      ));
    },
    revokeAllForUser: async (userId) => {
      assertNoOperatorInjection(userId, "sessions.revokeAllForUser.userId");
      void (await Session.updateMany({ userId }, { $set: { revoked: true } }));
    },
  };

  bans: Store["bans"] = {
    isBanned: async (userId, at = new Date()) =>
      (await Ban.countDocuments({ userId, active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: at } }] })) > 0,
    create: async (b) => {
      const d = await Ban.create({ ...b, active: true });
      const o = d.toObject();
      return { id: String(o["_id"]), userId: b.userId, reason: b.reason, createdBy: b.createdBy, expiresAt: b.expiresAt, active: true, createdAt: o["createdAt"] as Date } satisfies BanRecord;
    },
    lift: async (userId) => void (await Ban.updateMany({ userId }, { $set: { active: false } })),
  };

  rooms: Store["rooms"] = {
    upsert: async (r: RoomRecord) => {
      const { createdAt, ...rest } = r;
      await RoomM.updateOne({ code: r.code, createdAtMs: createdAt.getTime() }, { $set: { ...rest, createdAtMs: createdAt.getTime() } }, { upsert: true });
    },
  };

  games: Store["games"] = {
    start: async (g: GameRecord, players: GamePlayerRecord[]) => {
      await GameM.create({ _id: g.gameId, roomId: g.roomCode, mode: g.mode, status: g.status, playerIds: g.playerIds, startedAt: g.startedAt });
      if (players.length) await GamePlayerM.insertMany(players.map((p) => ({ ...p })));
    },
    finish: async (gameId, patch, results) => {
      const { gameId: _g, roomCode: _r, ...rest } = patch;
      void _g; void _r;
      await GameM.updateOne({ _id: gameId }, { $set: rest });
      await Promise.all(Object.entries(results).map(([playerId, result]) => GamePlayerM.updateOne({ gameId, playerId }, { $set: { result } })));
    },
  };

  gameEvents: Store["gameEvents"] = {
    appendMany: async (evs: GameEventRecord[]) => {
      if (evs.length) await GameEventM.insertMany(evs.map((e) => ({ ...e })), { ordered: false }).catch((e: unknown) => { if (!isDup(e) && !(e as { writeErrors?: unknown }).writeErrors) throw e; });
    },
  };

  chat: Store["chat"] = { append: async (r: ChatRecord) => void (await ChatM.create({ _id: r.id, ...r })) };

  stats: Store["stats"] = {
    recordOnline: async (userId, win) => {
      await StatsM.updateOne({ _id: userId }, { $inc: { "online.games": 1, [win ? "online.wins" : "online.losses"]: 1 } }, { upsert: true });
    },
    get: async (userId) => {
      const d = await StatsM.findOne({ _id: userId }).lean();
      if (!d) return zeroStats();
      const z = zeroStats();
      return { online: { ...z.online, ...(d["online"] as object) }, offline: { ...z.offline, ...(d["offline"] as object) } };
    },
  };

  syncRecords: Store["syncRecords"] = {
    processGameResult: async (userId, p: OfflineGamePayload): Promise<SyncGameOutcome> => {
      // The unique (userId, localId) index is the idempotency guard. Insert first, then count:
      // a crash in between can only UNDER-count, never double-count (offlineGames allows reconciliation).
      try {
        await SyncM.create({ userId, localId: p.localGameId, type: "GAME_RESULT", status: "processed", receivedAt: new Date(), processedAt: new Date() });
      } catch (e) {
        if (isDup(e)) return "duplicate";
        throw e;
      }
      await OfflineGameM.updateOne({ userId, localGameId: p.localGameId }, { $setOnInsert: { payload: p, receivedAt: new Date() } }, { upsert: true });
      await StatsM.updateOne({ _id: userId }, { $inc: { "offline.games": 1, [p.result === "win" ? "offline.wins" : "offline.losses"]: 1 } }, { upsert: true });
      return "applied";
    },
    claim: async (userId, localId, type): Promise<SyncGameOutcome> => {
      try {
        await SyncM.create({ userId, localId, type, status: "processed", receivedAt: new Date(), processedAt: new Date() });
        return "applied";
      } catch (e) {
        if (isDup(e)) return "duplicate";
        throw e;
      }
    },
    markRejected: async (userId, localId, type, reason) => {
      await SyncM.updateOne({ userId, localId }, { $setOnInsert: { type, status: "rejected", reason, receivedAt: new Date() } }, { upsert: true });
    },
    summary: async (userId): Promise<SyncSummary> => {
      const [processed, rejected, last] = await Promise.all([
        SyncM.countDocuments({ userId, status: "processed" }),
        SyncM.countDocuments({ userId, status: "rejected" }),
        SyncM.findOne({ userId }).sort({ receivedAt: -1 }).lean(),
      ]);
      return { processed, rejected, lastSyncAt: (last?.["receivedAt"] as Date | undefined) ?? null };
    },
  };

  settings: Store["settings"] = {
    get: async (key) => {
      const d = await SettingsM.findOne({ _id: key }).lean();
      return d ? ({ key, value: d["value"], version: Number(d["version"] ?? 0), updatedAt: d["updatedAt"] as Date, ...(d["updatedBy"] ? { updatedBy: String(d["updatedBy"]) } : {}) } as SettingsDoc) : null;
    },
    set: async (key: SettingsKey, value, updatedBy) => {
      const d = await SettingsM.findOneAndUpdate({ _id: key }, { $set: { value, ...(updatedBy ? { updatedBy } : {}) }, $inc: { version: 1 } }, { upsert: true, new: true }).lean();
      return { key, value, version: Number(d?.["version"] ?? 1), updatedAt: (d?.["updatedAt"] as Date) ?? new Date(), ...(updatedBy ? { updatedBy } : {}) };
    },
  };

  adminQuery: Store["adminQuery"] = {
    users: async ({ q, status, limit, offset }) => {
      const filter: Rec = { isDeleted: { $ne: true } };
      if (status) filter["status"] = status;
      if (q) filter["$or"] = [{ username: new RegExp(escRe(q), "i") }, { email: new RegExp(escRe(q), "i") }, { _id: new RegExp(escRe(q), "i") }];
      const [rows, total] = await Promise.all([
        User.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
        User.countDocuments(filter),
      ]);
      return { items: rows.map((r) => toUser(r)).filter((u): u is UserRecord => u !== null), total, limit, offset };
    },
    userGames: async (userId, limit) => ({
      online: (await GameM.find({ playerIds: userId }).sort({ startedAt: -1 }).limit(limit).lean()).map(fromGame),
      offline: await OfflineGameM.countDocuments({ userId }),
    }),
    rooms: async ({ q, status, limit, offset }) => {
      const filter: Rec = {};
      if (status) filter["status"] = status;
      if (q) filter["$or"] = [{ code: new RegExp(escRe(q), "i") }, { hostId: new RegExp(escRe(q), "i") }];
      const [rows, total] = await Promise.all([
        RoomM.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
        RoomM.countDocuments(filter),
      ]);
      return { items: rows.map(fromRoom), total, limit, offset };
    },
    games: async ({ q, status, limit, offset }) => {
      const filter: Rec = {};
      if (status) filter["status"] = status;
      if (q) filter["$or"] = [{ _id: new RegExp(escRe(q), "i") }, { roomId: new RegExp(escRe(q), "i") }];
      const [rows, total] = await Promise.all([
        GameM.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
        GameM.countDocuments(filter),
      ]);
      return { items: rows.map(fromGame), total, limit, offset };
    },
    gameDetail: async (gameId) => {
      const g = await GameM.findOne({ _id: gameId }).lean();
      if (!g) return null;
      const [players, events] = await Promise.all([
        GamePlayerM.find({ gameId }).lean(),
        GameEventM.find({ gameId }).sort({ seq: 1 }).lean(),
      ]);
      return {
        game: fromGame(g),
        players: players.map((p) => ({
          gameId, playerId: String(p["playerId"]), name: String(p["name"]), isAi: Boolean(p["isAi"]), seat: Number(p["seat"] ?? 0),
          ...(p["userId"] ? { userId: String(p["userId"]) } : {}),
          ...(p["result"] ? { result: p["result"] as "win" | "loss" | "abandoned" } : {}),
        })),
        events: events.map((e) => ({
          gameId, seq: Number(e["seq"]), type: String(e["type"]), text: String(e["text"]), createdAt: e["createdAt"] as Date,
          ...(e["actorId"] ? { actorId: String(e["actorId"]) } : {}),
          ...(e["targetId"] ? { targetId: String(e["targetId"]) } : {}),
        })),
      };
    },
    chat: async ({ q, roomCode, status, limit, offset }) => {
      const filter: Rec = {};
      if (status) filter["status"] = status;
      if (roomCode) filter["roomCode"] = roomCode;
      if (q) filter["$or"] = [{ text: new RegExp(escRe(q), "i") }, { name: new RegExp(escRe(q), "i") }];
      const [rows, total] = await Promise.all([
        ChatM.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
        ChatM.countDocuments(filter),
      ]);
      return {
        items: rows.map((c) => ({
          id: String(c["_id"]), roomCode: String(c["roomCode"]), playerId: String(c["playerId"]), name: String(c["name"]),
          text: String(c["text"]), status: c["status"] as "visible" | "deleted", createdAt: c["createdAt"] as Date,
          ...(c["gameId"] ? { gameId: String(c["gameId"]) } : {}),
          ...(c["deletedBy"] ? { deletedBy: String(c["deletedBy"]) } : {}),
          ...(c["deletedAt"] ? { deletedAt: c["deletedAt"] as Date } : {}),
        })),
        total, limit, offset,
      };
    },
    setChatStatus: async (id, status, deletedBy) => {
      const res = await ChatM.updateOne(
        { _id: id },
        status === "deleted" ? { $set: { status, deletedBy, deletedAt: new Date() } } : { $set: { status } },
      );
      return res.modifiedCount > 0;
    },
    syncRecords: async ({ limit, offset }) => {
      const [rows, total] = await Promise.all([
        SyncM.find({}).sort({ receivedAt: -1 }).skip(offset).limit(limit).lean(),
        SyncM.countDocuments({}),
      ]);
      return {
        items: rows.map((r) => ({
          userId: String(r["userId"]), localId: String(r["localId"]), type: String(r["type"]),
          status: String(r["status"] ?? "processed"), receivedAt: r["receivedAt"] as Date,
          ...(r["reason"] ? { reason: String(r["reason"]) } : {}),
        })),
        total, limit, offset,
      };
    },
    setUserStatus: async (id, status) => {
      const res = await User.updateOne({ _id: id }, { $set: { status } });
      return res.modifiedCount > 0;
    },
  };

  admin: AdminStore = {
    admins: {
      create: async (a) => toAdmin(await AdminM.create({ ...a }).then((d) => d.toObject())) as AdminRecord,
      findById: async (id) => toAdmin(await AdminM.findOne({ _id: id }).lean()),
      findByEmail: async (email) => toAdmin(await AdminM.findOne({ email: email.toLowerCase() }).lean()),
      list: async () => (await AdminM.find({}).lean()).map(toAdmin).filter((a): a is AdminRecord => a !== null),
      update: async (id, patch) => toAdmin(await AdminM.findOneAndUpdate({ _id: id }, { $set: patch }, { new: true }).lean()),
      recordFailedLogin: async (id, lockedUntil) => {
        await AdminM.updateOne({ _id: id }, { $inc: { failedLogins: 1 }, ...(lockedUntil ? { $set: { lockedUntil } } : {}) });
      },
    },
    adminSessions: {
      create: async (rec) => void (await AdminSessionM.create({
        _id: rec.sessionHash, adminId: rec.adminId, expiresAt: rec.expiresAt, lastSeenAt: rec.lastSeenAt,
        ...(rec.ip ? { ip: rec.ip } : {}), ...(rec.userAgent ? { userAgent: rec.userAgent } : {}), revoked: false,
      })),
      resolve: async (h) => {
        assertNoOperatorInjection(h, "adminSessions.resolve._id");
        const d = await AdminSessionM.findOne({ _id: h, revoked: { $ne: true }, expiresAt: { $gt: new Date() } }).lean();
        if (!d) return null;
        return {
          sessionHash: String(d["_id"]), adminId: String(d["adminId"]), createdAt: d["createdAt"] as Date,
          lastSeenAt: d["lastSeenAt"] as Date, expiresAt: d["expiresAt"] as Date, revoked: false,
          ...(d["ip"] ? { ip: String(d["ip"]) } : {}), ...(d["userAgent"] ? { userAgent: String(d["userAgent"]) } : {}),
        } satisfies AdminSessionRecord;
      },
      touch: async (h, at) => { assertNoOperatorInjection(h, "adminSessions.touch._id"); void (await AdminSessionM.updateOne({ _id: h }, { $set: { lastSeenAt: at } })); },
      revoke: async (h) => { assertNoOperatorInjection(h, "adminSessions.revoke._id"); void (await AdminSessionM.updateOne({ _id: h }, { $set: { revoked: true } })); },
      revokeAllForAdmin: async (adminId) => { assertNoOperatorInjection(adminId, "adminSessions.revokeAllForAdmin.adminId"); void (await AdminSessionM.updateMany({ adminId }, { $set: { revoked: true } })); },
      listActive: async (now) => (await AdminSessionM.find({ revoked: { $ne: true }, expiresAt: { $gt: now } }).lean()).map((d) => ({
        sessionHash: String(d["_id"]), adminId: String(d["adminId"]), createdAt: d["createdAt"] as Date,
        lastSeenAt: d["lastSeenAt"] as Date, expiresAt: d["expiresAt"] as Date, revoked: false,
      } satisfies AdminSessionRecord)),
    },
    audit: {
      append: async (e) => void (await AuditM.create({ ...e })),
      list: async ({ q, action, adminId, resource, limit, offset }) => {
        const filter: Rec = {};
        if (action) filter["action"] = action;
        if (adminId) filter["adminId"] = adminId;
        if (resource) filter["resource"] = resource;
        if (q) filter["$or"] = [{ reason: new RegExp(escRe(q), "i") }, { resourceId: new RegExp(escRe(q), "i") }, { adminUsername: new RegExp(escRe(q), "i") }];
        const [rows, total] = await Promise.all([
          AuditM.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
          AuditM.countDocuments(filter),
        ]);
        return { items: rows.map(fromAudit), total, limit, offset };
      },
    },
    reports: {
      create: async (r) => fromReport(await ReportM.create({ ...r, status: "OPEN", history: [] }).then((d) => d.toObject())) as ReportRecord,
      findById: async (id) => { assertNoOperatorInjection(id, "reports.findById._id"); return fromReport(await ReportM.findOne({ _id: id }).lean()); },
      list: async ({ q, status, category, assignedTo, limit, offset }) => {
        const filter: Rec = {};
        if (status) filter["status"] = status;
        if (category) filter["category"] = category;
        if (assignedTo) filter["assignedTo"] = assignedTo;
        if (q) filter["$or"] = [{ description: new RegExp(escRe(q), "i") }, { _id: new RegExp(escRe(q), "i") }];
        const [rows, total] = await Promise.all([
          ReportM.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
          ReportM.countDocuments(filter),
        ]);
        return { items: rows.map(fromReport).filter((r): r is ReportRecord => r !== null), total, limit, offset };
      },
      update: async (id, patch, historyEntry) => {
        assertNoOperatorInjection(id, "reports.update._id");
        return fromReport(await ReportM.findOneAndUpdate({ _id: id }, { $set: patch, $push: { history: historyEntry } }, { new: true }).lean());
      },
      countByStatus: async () => {
        const rows = await ReportM.find({ status: { $in: ["OPEN", "INVESTIGATE", "RESOLVE", "DISMISS"] } }).lean();
        const c: Record<string, number> = {};
        for (const r of rows) { const s = String(r["status"]); c[s] = (c[s] ?? 0) + 1; }
        return c;
      },
    },
    collection: async (name, { q, limit, offset }) => {
      const m = CONSOLE_MODELS[name];
      if (!m) return { items: [], total: 0, limit, offset };
      const searchable = SEARCHABLE_FIELDS[name] ?? [];
      const filter: Rec = q && searchable.length
        ? { $or: searchable.map((k) => ({ [k]: new RegExp(escRe(q), "i") })) }
        : {};
      const [rows, total] = await Promise.all([
        m.find(filter).skip(offset).limit(limit).lean(),
        m.countDocuments(filter),
      ]);
      return { items: rows.map(normalizeDoc), total, limit, offset };
    },
    updateRecord: async (name, id, changes) => {
      assertNoOperatorInjection(id, `db.updateRecord.${name}._id`);
      const m = CONSOLE_MODELS[name];
      if (!m) return null;
      const d = await m.findOneAndUpdate({ _id: id } as Rec, { $set: changes }, { new: true }).lean();
      return d ? normalizeDoc(d) : null;
    },
    softDelete: async (name, id) => {
      assertNoOperatorInjection(id, `db.softDelete.${name}._id`);
      const m = CONSOLE_MODELS[name];
      if (!m) return false;
      const res = name === "users"
        ? await m.updateOne({ _id: id } as Rec, { $set: { isDeleted: true, deletedAt: new Date() } })
        : await m.updateOne({ _id: id } as Rec, { $set: { status: "deleted" } });
      return res.modifiedCount > 0;
    },
    purge: async (name, id) => {
      if (PROTECTED_COLLECTIONS.has(name)) return false;
      assertNoOperatorInjection(id, `db.purge.${name}._id`);
      const m = CONSOLE_MODELS[name];
      if (!m) return false;
      const res = await m.deleteOne({ _id: id } as Rec);
      return res.deletedCount > 0;
    },
    stats: async () => {
      const dayAgo = new Date(Date.now() - 86_400_000);
      const [users, guests, usersToday, activeSessions, rooms, activeGames, gamesToday, totalGames, pendingReports, openAdmins, syncRecords] =
        await Promise.all([
          User.countDocuments({ isDeleted: { $ne: true } }),
          User.countDocuments({ status: "guest", isDeleted: { $ne: true } }),
          User.countDocuments({ createdAt: { $gte: dayAgo } }),
          Session.countDocuments({ revoked: { $ne: true } }),
          RoomM.countDocuments({}),
          GameM.countDocuments({ status: "playing" }),
          GameM.countDocuments({ startedAt: { $gte: dayAgo } }),
          GameM.countDocuments({}),
          ReportM.countDocuments({ status: { $in: ["OPEN", "INVESTIGATE"] } }),
          AdminM.countDocuments({ status: "active" }),
          SyncM.countDocuments({}),
        ]);
      return { users, guests, usersToday, activeSessions, rooms, activeGames, gamesToday, totalGames, pendingReports, openAdmins, syncRecords };
    },
  };

  async ping() {
    const t = Date.now();
    try {
      await mongoose.connection.db?.admin().ping();
      return { ok: mongoose.connection.readyState === 1, latencyMs: Date.now() - t, kind: "mongo" as const };
    } catch {
      return { ok: false, latencyMs: Date.now() - t, kind: "mongo" as const };
    }
  }

  async close() {
    await mongoose.disconnect();
  }
}
