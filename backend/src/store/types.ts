import type { AdminRole, AdminStatus, AuditAction, OfflineGamePayload, Permission, ReportCategory, ReportStatus, StatsSummary } from "@old-maid/shared";

export type UserStatus = "guest" | "active" | "suspended" | "banned";

export interface UserRecord {
  id: string;
  username: string;
  email?: string;
  passwordHash?: string;
  status: UserStatus;
  avatar?: string;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
  settings?: { data: Record<string, unknown>; updatedAt: number };
  profileUpdatedAt?: number;
  isDeleted?: boolean;
}

export interface SessionRecord {
  /** sha256 of the secret session id; the raw secret is never stored. */
  sessionHash: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  revoked: boolean;
  /** Optional sliding expiry. Absent means "until explicitly revoked". */
  expiresAt?: Date;
}

export interface BanRecord {
  id: string;
  userId: string;
  reason: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  active: boolean;
}

export type RoomStatus = "waiting" | "playing" | "finished" | "closed" | "expired";
export interface RoomRecord {
  code: string;
  hostId: string;
  status: RoomStatus;
  playerIds: string[];
  maxPlayers: number;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  expiresAt?: Date;
}

export type GameStatus = "playing" | "finished" | "abandoned";
export interface GamePlayerRecord {
  gameId: string;
  playerId: string;
  userId?: string;
  name: string;
  isAi: boolean;
  seat: number;
  result?: "win" | "loss" | "abandoned";
}
export interface GameRecord {
  gameId: string;
  roomCode: string;
  mode: "online";
  status: GameStatus;
  playerIds: string[];
  winnerId?: string | null;
  startedAt: Date;
  finishedAt?: Date;
  durationSec?: number;
  drawCount?: number;
  endedByAdmin?: { adminId: string; reason: string };
}
export interface GameEventRecord {
  gameId: string;
  seq: number;
  type: string;
  actorId?: string;
  targetId?: string;
  text: string;
  createdAt: Date;
}

export interface ChatRecord {
  id: string;
  roomCode: string;
  gameId?: string;
  playerId: string;
  name: string;
  text: string;
  status: "visible" | "deleted";
  deletedBy?: string;
  deletedAt?: Date;
  createdAt: Date;
}

export interface SyncSummary {
  processed: number;
  rejected: number;
  lastSyncAt: Date | null;
}

export type SettingsKey = "game" | "ai" | "system" | "features";
export interface SettingsDoc {
  key: SettingsKey;
  value: unknown;
  version: number;
  updatedAt: Date;
  updatedBy?: string;
}

export interface StoreHealth {
  ok: boolean;
  latencyMs: number;
  kind: "memory" | "mongo";
}

export type SyncGameOutcome = "applied" | "duplicate";

/* ------------------------------------------------------------------ Phase 4: admin */

export interface AdminRecord {
  id: string;
  email: string;
  username: string;
  /** bcrypt. Never leaves the server. */
  passwordHash: string;
  role: AdminRole;
  /** Narrowing grants on top of the role's default set. */
  permissions: Permission[];
  status: AdminStatus;
  /** Optional TOTP secret (base32). Enables 2FA when present. */
  totpSecret?: string;
  failedLogins: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  suspendedAt?: Date;
}

export interface AdminSessionRecord {
  /** sha256 of the bearer secret; the raw secret is never stored. */
  sessionHash: string;
  adminId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revoked: boolean;
  ip?: string;
  userAgent?: string;
}

export interface AuditLogRecord {
  id: string;
  adminId: string;
  adminUsername: string;
  adminRole: AdminRole;
  action: AuditAction;
  resource: string;
  resourceId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

export interface ReportRecord {
  id: string;
  category: ReportCategory;
  status: ReportStatus;
  reporterId: string;
  targetUserId?: string;
  roomCode?: string;
  chatMessageId?: string;
  description: string;
  assignedTo?: string;
  resolution?: string;
  history: { at: Date; adminId: string; action: string; note?: string }[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Page<T> { items: T[]; total: number; limit: number; offset: number }

export interface AdminStatsSnapshot {
  users: number;
  guests: number;
  usersToday: number;
  activeSessions: number;
  rooms: number;
  activeGames: number;
  gamesToday: number;
  totalGames: number;
  pendingReports: number;
  openAdmins: number;
  syncRecords: number;
}

/** Admin-only read/write surface. Separate from the player Store contract on purpose. */
export interface AdminStore {
  admins: {
    create(a: Omit<AdminRecord, "id" | "createdAt" | "updatedAt" | "failedLogins">): Promise<AdminRecord>;
    findById(id: string): Promise<AdminRecord | null>;
    findByEmail(email: string): Promise<AdminRecord | null>;
    list(): Promise<AdminRecord[]>;
    update(id: string, patch: Partial<Omit<AdminRecord, "id" | "email" | "createdAt">>): Promise<AdminRecord | null>;
    recordFailedLogin(id: string, lockedUntil: Date | null): Promise<void>;
  };
  adminSessions: {
    create(rec: AdminSessionRecord): Promise<void>;
    resolve(sessionHash: string): Promise<AdminSessionRecord | null>;
    touch(sessionHash: string, at: Date): Promise<void>;
    revoke(id: string): Promise<void>;
    revokeAllForAdmin(adminId: string): Promise<void>;
    listActive(now: Date): Promise<AdminSessionRecord[]>;
  };
  audit: {
    append(e: Omit<AuditLogRecord, "id">): Promise<void>;
    list(filter: { q?: string; action?: string; adminId?: string; resource?: string; limit: number; offset: number }): Promise<Page<AuditLogRecord>>;
  };
  reports: {
    create(r: Omit<ReportRecord, "id" | "createdAt" | "updatedAt" | "status" | "history">): Promise<ReportRecord>;
    findById(id: string): Promise<ReportRecord | null>;
    list(filter: { q?: string; status?: string; category?: string; assignedTo?: string; limit: number; offset: number }): Promise<Page<ReportRecord>>;
    update(id: string, patch: Partial<ReportRecord>, historyEntry: ReportRecord["history"][number]): Promise<ReportRecord | null>;
    countByStatus(): Promise<Record<string, number>>;
  };
  /** Generic, allow-listed record inspection for the database console. */
  collection(name: string, filter: { q?: string; limit: number; offset: number }): Promise<Page<Record<string, unknown>>>;
  updateRecord(name: string, id: string, changes: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  softDelete(name: string, id: string): Promise<boolean>;
  /** Permanent removal. SUPER_ADMIN only; refuses protected collections. */
  purge(name: string, id: string): Promise<boolean>;
  stats(): Promise<AdminStatsSnapshot>;
}

/**
 * Persistence boundary. Active game state is NOT stored here per action – only lifecycle,
 * results and public events. A Redis adapter for live state can be added behind ActiveStateStore.
 */
export interface Store {
  readonly kind: "memory" | "mongo";
  users: {
    createGuest(): Promise<UserRecord>;
    findById(id: string): Promise<UserRecord | null>;
    findByEmail(email: string): Promise<UserRecord | null>;
    findByUsername(username: string): Promise<UserRecord | null>;
    upgradeToAccount(id: string, data: { username: string; email: string; passwordHash: string }): Promise<UserRecord | null>;
    createAccount(data: { username: string; email: string; passwordHash: string }): Promise<UserRecord>;
    touchLogin(id: string): Promise<void>;
    /** Applies only if `updatedAt` is newer than what the server holds. */
    applySettings(id: string, data: Record<string, unknown>, updatedAt: number): Promise<{ applied: boolean; current: { data: Record<string, unknown>; updatedAt: number } | null }>;
    applyProfile(id: string, data: { displayName?: string; avatar?: string }, updatedAt: number): Promise<{ applied: boolean }>;
  };
  sessions: {
    create(userId: string, sessionHash: string): Promise<void>;
    resolve(sessionHash: string): Promise<SessionRecord | null>;
    /** `ttlMs` extends the sliding expiry on each use; omit for "no expiry". */
    touch(sessionHash: string, ttlMs?: number): Promise<void>;
    revokeAllForUser(userId: string): Promise<void>;
  };
  bans: {
    isBanned(userId: string, at?: Date): Promise<boolean>;
    create(ban: Omit<BanRecord, "id" | "createdAt" | "active">): Promise<BanRecord>;
    lift(userId: string): Promise<void>;
  };
  rooms: { upsert(rec: RoomRecord): Promise<void> };
  games: {
    start(game: GameRecord, players: GamePlayerRecord[]): Promise<void>;
    finish(gameId: string, patch: Partial<GameRecord>, results: Record<string, "win" | "loss" | "abandoned">): Promise<void>;
  };
  gameEvents: { appendMany(events: GameEventRecord[]): Promise<void> };
  chat: { append(rec: ChatRecord): Promise<void> };
  syncRecords: {
    /** Idempotent: stores the offline game + bumps offline stats exactly once per (userId, localId). */
    processGameResult(userId: string, payload: OfflineGamePayload): Promise<SyncGameOutcome>;
    /** Idempotent claim for non-game sync items. */
    claim(userId: string, localId: string, type: string): Promise<SyncGameOutcome>;
    markRejected(userId: string, localId: string, type: string, reason: string): Promise<void>;
    summary(userId: string): Promise<SyncSummary>;
  };
  stats: {
    recordOnline(userId: string, win: boolean): Promise<void>;
    get(userId: string): Promise<StatsSummary>;
  };
  settings: {
    get(key: SettingsKey): Promise<SettingsDoc | null>;
    set(key: SettingsKey, value: unknown, updatedBy?: string): Promise<SettingsDoc>;
  };
  /** Players, rooms, games, chat and sync records need paginated admin inspection too. */
  adminQuery: {
    users(filter: { q?: string; status?: string; limit: number; offset: number }): Promise<Page<UserRecord>>;
    userGames(userId: string, limit: number): Promise<{ online: GameRecord[]; offline: number }>;
    rooms(filter: { q?: string; status?: string; limit: number; offset: number }): Promise<Page<RoomRecord>>;
    games(filter: { q?: string; status?: string; limit: number; offset: number }): Promise<Page<GameRecord>>;
    gameDetail(gameId: string): Promise<{ game: GameRecord; players: GamePlayerRecord[]; events: GameEventRecord[] } | null>;
    chat(filter: { q?: string; roomCode?: string; status?: string; limit: number; offset: number }): Promise<Page<ChatRecord>>;
    setChatStatus(id: string, status: ChatRecord["status"], deletedBy: string): Promise<boolean>;
    syncRecords(filter: { limit: number; offset: number }): Promise<Page<{ userId: string; localId: string; type: string; status: string; receivedAt: Date; reason?: string }>>;
    setUserStatus(id: string, status: UserStatus): Promise<boolean>;
  };
  /** Phase 4 surface. Separate contract so the player API can never reach it. */
  admin: AdminStore;
  ping(): Promise<StoreHealth>;
  close(): Promise<void>;
}

/** Serializable snapshot of a live room – the seam for a future Redis adapter. */
export interface ActiveRoomSnapshot {
  code: string;
  hostId: string;
  status: string;
  playerIds: string[];
  savedAt: number;
  state: unknown;
}
export interface ActiveStateStore {
  save(snapshot: ActiveRoomSnapshot): Promise<void>;
  remove(code: string): Promise<void>;
  list(): Promise<ActiveRoomSnapshot[]>;
}
