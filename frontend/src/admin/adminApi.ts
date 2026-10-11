import type {
  AdminRole, AuditAction, Permission, ReportCategory, ReportStatus,
} from "@old-maid/shared";

/** Mirrors the backend GameRecord shape (kept local so the admin UI has no server dependency). */
export interface GameRecord {
  gameId: string; roomCode: string; mode: string; status: string;
  playerIds: string[]; winnerId?: string | null;
  startedAt: string; finishedAt?: string; durationSec?: number; drawCount?: number;
  endedByAdmin?: { adminId: string; reason: string };
}

export interface AdminProfile {
  id: string; email: string; username: string; role: AdminRole;
  permissions: Permission[]; status: "active" | "suspended";
  lastLoginAt?: string; createdAt: string; twoFactorEnabled: boolean;
}

export interface PageResult<T> { items: T[]; total: number; limit: number; offset: number }

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Admin API client. Holds a session token in sessionStorage (cleared when the tab closes) and
 * re-authorizes on 401 so a page left open overnight does not silently keep stale privileges.
 */
export class AdminApi {
  private token: string | null = null;
  private profile: AdminProfile | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly storage: Storage | null = safeStorage(),
  ) {
    this.token = this.storage?.getItem("om-admin-token") ?? null;
  }

  get authed(): boolean { return this.token !== null; }
  get current(): AdminProfile | null { return this.profile; }
  can(p: Permission): boolean { return this.profile?.permissions.includes(p) ?? false; }
  get isSuperAdmin(): boolean { return this.profile?.role === "SUPER_ADMIN"; }

  setProfile(p: AdminProfile | null): void {
    this.profile = p;
  }

  /** Establishes a session directly (used by restore/login flows and by tests). */
  establish(token: string, p: AdminProfile): void {
    this.persist(token);
    this.profile = p;
  }

  private persist(token: string | null): void {
    this.token = token;
    if (token) this.storage?.setItem("om-admin-token", token);
    else this.storage?.removeItem("om-admin-token");
  }

  async login(email: string, password: string, totp?: string): Promise<AdminProfile> {
    const r = await this.request<{ token: string; admin: AdminProfile }>("POST", "/login", {
      email, password, ...(totp ? { totp } : {}),
    }, false);
    this.persist(r.token);
    this.profile = r.admin;
    return r.admin;
  }

  async restore(): Promise<AdminProfile | null> {
    if (!this.token) return null;
    try {
      const r = await this.request<{ admin: AdminProfile; permissions: Permission[] }>("GET", "/me");
      this.profile = r.admin;
      return r.admin;
    } catch {
      this.logout();
      return null;
    }
  }

  logout(): void {
    if (this.token) void this.request("POST", "/logout", {}, false).catch(() => undefined);
    this.persist(null);
    this.profile = null;
  }

  async request<T>(method: string, path: string, body?: unknown, withAuth = true): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/admin${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(withAuth && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      // An expired/revoked session must drop privileges immediately, not on the next click.
      if (res.status === 401 && withAuth) this.logout();
      const e = (data["error"] ?? {}) as { code?: string; message?: string };
      throw new AdminApiError(res.status, e.code ?? "ERROR", e.message ?? "Request failed.");
    }
    return data as T;
  }

  /* ---------------- typed endpoints (all real, all backend-backed) ---------------- */

  dashboard = async (): Promise<DashboardData> => (await this.request<{ data: DashboardData }>("GET", "/dashboard")).data;
  users = (q: AdminListQuery) => this.request<PageResult<UserRow>>("GET", `/users${qs(q)}`);
  user = (id: string) => this.request<{ user: UserRow & { stats: StatsShape; onlineGames: GameRecord[]; offlineGames: number; banned: boolean } }>("GET", `/users/${id}`);
  banUser = (id: string, reason: string, expiresAt?: string) => this.request("POST", `/users/${id}/ban`, { reason, ...(expiresAt ? { expiresAt } : {}) });
  unbanUser = (id: string, reason: string) => this.request("POST", `/users/${id}/unban`, { reason });
  rooms = (q: AdminListQuery) => this.request<PageResult<RoomRow>>("GET", `/rooms${qs(q)}`);
  room = (code: string) => this.request<{ room: RoomRow | null; detail: RoomDetail | null }>("GET", `/rooms/${code}`);
  closeRoom = (code: string, reason: string) => this.request("POST", `/rooms/${code}/close`, { reason });
  lockRoom = (code: string, reason: string) => this.request("POST", `/rooms/${code}/lock`, { reason });
  unlockRoom = (code: string, reason: string) => this.request("POST", `/rooms/${code}/unlock`, { reason });
  games = (q: AdminListQuery) => this.request<PageResult<GameRecord>>("GET", `/games${qs(q)}`);
  game = (id: string) => this.request<{ game: GameRecord; players: GamePlayerRow[]; events: EventRow[] }>("GET", `/games/${id}`);
  terminateGame = (id: string, reason: string) => this.request<{ outcome: string }>("POST", `/games/${id}/terminate`, { reason });
  pauseGame = (id: string, reason: string) => this.request("POST", `/games/${id}/pause`, { reason });
  resumeGame = (id: string, reason: string) => this.request("POST", `/games/${id}/resume`, { reason });
  reports = (q: AdminListQuery) => this.request<PageResult<ReportRow>>("GET", `/reports${qs(q)}`);
  updateReport = (id: string, patch: Partial<Pick<ReportRow, "status" | "assignedTo" | "resolution">> & { reason?: string }) => this.request("PATCH", `/reports/${id}`, patch);
  chat = (q: AdminListQuery & { roomCode?: string }) => this.request<PageResult<ChatRow>>("GET", `/chat${qs(q)}`);
  deleteMessage = (id: string, reason: string) => this.request("POST", `/chat/${id}/delete`, { reason });
  settings = () => this.request<SettingsResponse>("GET", "/settings");
  putSettings = (key: "game" | "ai" | "system" | "features", value: unknown, reason: string) => this.request("PUT", `/settings/${key}`, { value, reason });
  setMaintenance = (enabled: boolean, message: string | undefined, reason: string) => this.request("POST", "/settings/maintenance", { enabled, ...(message ? { message } : {}), reason });
  statistics = () => this.request<{ data: StatsPage }>("GET", "/statistics");
  collections = () => this.request<{ collections: { name: string; editableFields: string[]; protected: boolean }[] }>("GET", "/database/collections");
  collection = (name: string, q: AdminListQuery) => this.request<PageResult<Record<string, unknown>>>("GET", `/database/${name}${qs(q)}`);
  editRecord = (name: string, id: string, changes: Record<string, unknown>, reason: string) => this.request("PATCH", `/database/${name}/${id}`, { changes, reason });
  softDelete = (name: string, id: string, reason: string) => this.request("DELETE", `/database/${name}/${id}`, { reason });
  purge = (name: string, id: string, reason: string) => this.request("DELETE", `/database/${name}/${id}/purge`, { reason });
  auditLogs = (q: AdminListQuery & { action?: string; adminId?: string; resource?: string }) => this.request<PageResult<AuditRow>>("GET", `/audit-logs${qs(q)}`);
  admins = () => this.request<{ items: AdminProfile[] }>("GET", "/admins");
  createAdmin = (input: { email: string; username: string; password: string; role: AdminRole; permissions?: Permission[] }) => this.request("POST", "/admins", input);
  updateAdmin = (id: string, patch: { role?: AdminRole; permissions?: Permission[]; status?: "active" | "suspended"; password?: string; reason: string }) => this.request("PATCH", `/admins/${id}`, patch);
  revokeAdminSessions = (id: string) => this.request("POST", `/admins/${id}/revoke-sessions`);
  systemHealth = () => this.request<{ data: HealthPage }>("GET", "/system-health");
}

/* ---------------- shapes ---------------- */

export interface AdminListQuery {
  q?: string; status?: string; limit?: number; offset?: number;
  roomCode?: string; action?: string; adminId?: string; resource?: string;
}
const qs = (q: AdminListQuery): string => {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.status) p.set("status", q.status);
  if (q.roomCode) p.set("roomCode", q.roomCode);
  if (q.action) p.set("action", q.action);
  if (q.adminId) p.set("adminId", q.adminId);
  if (q.resource) p.set("resource", q.resource);
  p.set("limit", String(q.limit ?? 25));
  p.set("offset", String(q.offset ?? 0));
  return `?${p.toString()}`;
};

export interface StatsShape { online: { games: number; wins: number; losses: number }; offline: { games: number; wins: number; losses: number } }

export interface UserRow {
  id: string; username: string; email?: string; status: string; createdAt: string; lastLoginAt?: string;
}

export interface RoomRow { code: string; hostId: string; status: string; players?: number | string[]; createdAt: string; locked?: boolean; live?: unknown }
export interface RoomDetail {
  code: string; status: string; hostId: string; locked: boolean;
  players: { id: string; name: string; cardCount: number; isAi: boolean; isConnected: boolean }[];
  currentPlayerId: string | null; drawCount: number; paused: boolean;
}
export interface GamePlayerRow { playerId: string; name: string; isAi: boolean; seat: number; result?: string }
export interface EventRow { seq: number; type: string; text: string; createdAt: string; actorId?: string }
export interface ReportRow {
  id: string; category: ReportCategory; status: ReportStatus; reporterId: string; description: string;
  targetUserId?: string; roomCode?: string; assignedTo?: string; resolution?: string;
  createdAt: string; history: { at: string; adminId: string; action: string; note?: string }[];
}
export interface ChatRow { id: string; roomCode: string; playerId: string; name: string; text: string; status: string; createdAt: string }
export interface AuditRow {
  id: string; adminId: string; adminUsername: string; adminRole: AdminRole; action: AuditAction;
  resource: string; resourceId: string; before?: unknown; after?: unknown; reason?: string;
  ip?: string; userAgent?: string; createdAt: string;
}

export interface DashboardData {
  users: number; guests: number; usersToday: number; onlinePlayers: number;
  activeRooms: number; roomsPlaying: number; activeGames: number;
  gamesToday: number; totalGames: number; pendingReports: number;
  reportCounts: Record<string, number>; syncRecords: number; activeAdmins: number; uptimeSec: number;
  health: {
    api: string;
    database: { kind: string; ok: boolean; latencyMs: number };
    socket: { connections: number; rooms: number };
    server: { nodeVersion: string; platform: string; rssMb: number; heapUsedMb: number; cpus: number; loadAvg: number[] };
  };
  instanceId: string;
}

export interface StatsPage {
  users: number; guests: number; usersToday: number;
  games: { total: number; active: number; today: number; finishedToday: number };
  rooms: { total: number; live: number; playing: number };
  reports: Record<string, number>; syncRecords: number; onlinePlayers: number;
}

export interface HealthPage {
  api: { status: string; uptimeSec: number; instanceId: string };
  database: { kind: string; ok: boolean; latencyMs: number };
  socket: { ok: boolean; rooms: number; playingRooms: number; connectedPlayers: number };
  settings: { game: Record<string, unknown>; system: Record<string, unknown>; features: Record<string, boolean> };
  memory: Record<string, number>; node: string;
}

export interface SettingsResponse {
  settings: {
    game: Record<string, unknown>; ai: Record<string, unknown>;
    system: Record<string, unknown>; features: Record<string, boolean>;
  };
  onlineAvailable: { ok: true } | { ok: false; code: string; message: string };
}

function safeStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null; // private mode / blocked storage
  }
}