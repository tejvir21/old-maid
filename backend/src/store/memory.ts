import { randomUUID } from "node:crypto";
import type { OfflineGamePayload, StatsSummary } from "@old-maid/shared";
import type {
  ActiveRoomSnapshot, ActiveStateStore, AdminRecord, AdminSessionRecord, AdminStore, AuditLogRecord, BanRecord,
  ChatRecord, GameEventRecord, GamePlayerRecord, GameRecord, ReportRecord, RoomRecord, SessionRecord,
  SettingsDoc, SettingsKey, Store, SyncGameOutcome, SyncSummary, UserRecord,
} from "./types.js";

const emptyStats = (): StatsSummary => ({
  online: { games: 0, wins: 0, losses: 0 },
  offline: { games: 0, wins: 0, losses: 0 },
});

/** Reference implementation + test double. Also used for dev without MongoDB. */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  readonly data = {
    users: new Map<string, UserRecord>(),
    sessions: new Map<string, SessionRecord>(),
    bans: [] as BanRecord[],
    rooms: new Map<string, RoomRecord>(),
    games: new Map<string, GameRecord>(),
    gamePlayers: [] as GamePlayerRecord[],
    gameEvents: [] as GameEventRecord[],
    chat: [] as ChatRecord[],
    syncRecords: new Map<string, { userId: string; localId: string; type: string; status: "processed" | "rejected"; reason?: string; receivedAt: Date }>(),
    offlineGames: new Map<string, OfflineGamePayload & { userId: string }>(),
    stats: new Map<string, StatsSummary>(),
    settings: new Map<SettingsKey, SettingsDoc>(),
    // Phase 4
    admins: new Map<string, AdminRecord>(),
    adminSessions: new Map<string, AdminSessionRecord>(),
    auditLogs: [] as AuditLogRecord[],
    reports: new Map<string, ReportRecord>(),
  };

  users: Store["users"] = {
    createGuest: async () => {
      const id = randomUUID();
      const now = new Date();
      const u: UserRecord = { id, username: `Guest-${id.slice(0, 4).toUpperCase()}`, status: "guest", createdAt: now, updatedAt: now };
      this.data.users.set(id, u);
      return { ...u };
    },
    findById: async (id) => {
      const u = this.data.users.get(id);
      return u && !u.isDeleted ? { ...u } : null;
    },
    findByEmail: async (email) =>
      [...this.data.users.values()].find((u) => u.email === email.toLowerCase() && !u.isDeleted) ?? null,
    findByUsername: async (username) =>
      [...this.data.users.values()].find((u) => u.username.toLowerCase() === username.toLowerCase() && !u.isDeleted) ?? null,
    upgradeToAccount: async (id, d) => {
      const u = this.data.users.get(id);
      if (!u || u.status !== "guest") return null;
      Object.assign(u, { username: d.username, email: d.email.toLowerCase(), passwordHash: d.passwordHash, status: "active", updatedAt: new Date() });
      return { ...u };
    },
    createAccount: async (d) => {
      const id = randomUUID();
      const now = new Date();
      const u: UserRecord = { id, username: d.username, email: d.email.toLowerCase(), passwordHash: d.passwordHash, status: "active", createdAt: now, updatedAt: now };
      this.data.users.set(id, u);
      return { ...u };
    },
    touchLogin: async (id) => {
      const u = this.data.users.get(id);
      if (u) u.lastLoginAt = new Date();
    },
    applySettings: async (id, data, updatedAt) => {
      const u = this.data.users.get(id);
      if (!u) return { applied: false, current: null };
      if (u.settings && u.settings.updatedAt >= updatedAt) return { applied: false, current: u.settings };
      u.settings = { data: { ...(u.settings?.data ?? {}), ...data }, updatedAt };
      return { applied: true, current: u.settings };
    },
    applyProfile: async (id, d, updatedAt) => {
      const u = this.data.users.get(id);
      if (!u || (u.profileUpdatedAt ?? 0) >= updatedAt) return { applied: false };
      if (d.displayName) u.username = d.displayName;
      if (d.avatar) u.avatar = d.avatar;
      u.profileUpdatedAt = updatedAt;
      return { applied: true };
    },
  };

  sessions: Store["sessions"] = {
    create: async (userId, sessionHash) => {
      const now = new Date();
      this.data.sessions.set(sessionHash, { sessionHash, userId, createdAt: now, lastSeenAt: now, revoked: false });
    },
    resolve: async (h) => {
      const s = this.data.sessions.get(h);
      if (!s || s.revoked) return null;
      // Expiry is enforced only when present, matching the MongoStore semantics.
      if (s.expiresAt && s.expiresAt.getTime() <= Date.now()) return null;
      return { ...s };
    },
    touch: async (h, ttlMs) => {
      const s = this.data.sessions.get(h);
      if (!s) return;
      s.lastSeenAt = new Date();
      if (ttlMs && ttlMs > 0) s.expiresAt = new Date(Date.now() + ttlMs);
    },
    revokeAllForUser: async (userId) => {
      for (const s of this.data.sessions.values()) if (s.userId === userId) s.revoked = true;
    },
  };

  bans: Store["bans"] = {
    isBanned: async (userId, at = new Date()) =>
      this.data.bans.some((b) => b.userId === userId && b.active && (!b.expiresAt || b.expiresAt > at)),
    create: async (b) => {
      const rec: BanRecord = { ...b, id: randomUUID(), createdAt: new Date(), active: true };
      this.data.bans.push(rec);
      return rec;
    },
    lift: async (userId) => {
      for (const b of this.data.bans) if (b.userId === userId) b.active = false;
    },
  };

  rooms: Store["rooms"] = { upsert: async (rec) => void this.data.rooms.set(rec.code + ":" + rec.createdAt.getTime(), { ...rec }) };

  games: Store["games"] = {
    start: async (game, players) => {
      this.data.games.set(game.gameId, { ...game });
      this.data.gamePlayers.push(...players.map((p) => ({ ...p })));
    },
    finish: async (gameId, patch, results) => {
      const g = this.data.games.get(gameId);
      if (g) Object.assign(g, patch);
      for (const p of this.data.gamePlayers) if (p.gameId === gameId && results[p.playerId]) p.result = results[p.playerId];
    },
  };

  gameEvents: Store["gameEvents"] = { appendMany: async (evs) => void this.data.gameEvents.push(...evs) };
  chat: Store["chat"] = { append: async (rec) => void this.data.chat.push(rec) };

  stats: Store["stats"] = {
    recordOnline: async (userId, win) => {
      const s = this.data.stats.get(userId) ?? emptyStats();
      s.online.games++;
      if (win) s.online.wins++;
      else s.online.losses++;
      this.data.stats.set(userId, s);
    },
    get: async (userId) => structuredClone(this.data.stats.get(userId) ?? emptyStats()),
  };

  syncRecords: Store["syncRecords"] = {
    processGameResult: async (userId, p): Promise<SyncGameOutcome> => {
      const key = `${userId}:${p.localGameId}`;
      if (this.data.syncRecords.has(key)) return "duplicate";
      this.data.syncRecords.set(key, { userId, localId: p.localGameId, type: "GAME_RESULT", status: "processed", receivedAt: new Date() });
      this.data.offlineGames.set(key, { ...p, userId });
      const s = this.data.stats.get(userId) ?? emptyStats();
      s.offline.games++;
      if (p.result === "win") s.offline.wins++;
      else s.offline.losses++;
      this.data.stats.set(userId, s);
      return "applied";
    },
    claim: async (userId, localId, type): Promise<SyncGameOutcome> => {
      const key = `${userId}:${localId}`;
      if (this.data.syncRecords.has(key)) return "duplicate";
      this.data.syncRecords.set(key, { userId, localId, type, status: "processed", receivedAt: new Date() });
      return "applied";
    },
    markRejected: async (userId, localId, type, reason) => {
      const key = `${userId}:${localId}`;
      if (!this.data.syncRecords.has(key)) {
        this.data.syncRecords.set(key, { userId, localId, type, status: "rejected", reason, receivedAt: new Date() });
      }
    },
    summary: async (userId): Promise<SyncSummary> => {
      let processed = 0, rejected = 0;
      let last: Date | null = null;
      for (const r of this.data.syncRecords.values()) {
        if (r.userId !== userId) continue;
        if (r.status === "processed") processed++;
        else rejected++;
        if (!last || r.receivedAt > last) last = r.receivedAt;
      }
      return { processed, rejected, lastSyncAt: last };
    },
  };

  settings: Store["settings"] = {
    get: async (key) => this.data.settings.get(key) ?? null,
    set: async (key, value, updatedBy) => {
      const prev = this.data.settings.get(key);
      const doc: SettingsDoc = { key, value, version: (prev?.version ?? 0) + 1, updatedAt: new Date(), ...(updatedBy ? { updatedBy } : {}) };
      this.data.settings.set(key, doc);
      return doc;
    },
  };

  adminQuery: Store["adminQuery"] = {
    users: async ({ q, status, limit, offset }) => {
      const needle = q?.toLowerCase();
      const all = [...this.data.users.values()].filter((u) => {
        if (u.isDeleted) return false;
        if (status && u.status !== status) return false;
        if (!needle) return true;
        return u.username.toLowerCase().includes(needle) || (u.email ?? "").toLowerCase().includes(needle) || u.id.includes(needle);
      });
      all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return { items: all.slice(offset, offset + limit).map((u) => ({ ...u })), total: all.length, limit, offset };
    },
    userGames: async (userId, limit) => ({
      online: [...this.data.games.values()]
        .filter((g) => g.playerIds.includes(userId))
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, limit)
        .map((g) => ({ ...g })),
      offline: [...this.data.offlineGames.values()].filter((o) => o.userId === userId).length,
    }),
    rooms: async ({ q, status, limit, offset }) => {
      const needle = q?.toLowerCase();
      const all = [...this.data.rooms.values()].filter((r) => {
        if (status && r.status !== status) return false;
        if (!needle) return true;
        return r.code.toLowerCase().includes(needle) || r.hostId.includes(needle);
      });
      all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return { items: all.slice(offset, offset + limit).map((r) => ({ ...r })), total: all.length, limit, offset };
    },
    games: async ({ q, status, limit, offset }) => {
      const needle = q?.toLowerCase();
      const all = [...this.data.games.values()].filter((g) => {
        if (status && g.status !== status) return false;
        if (!needle) return true;
        return g.gameId.toLowerCase().includes(needle) || g.roomCode.toLowerCase().includes(needle);
      });
      all.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return { items: all.slice(offset, offset + limit).map((g) => ({ ...g })), total: all.length, limit, offset };
    },
    gameDetail: async (gameId) => {
      const g = this.data.games.get(gameId);
      if (!g) return null;
      return {
        game: { ...g },
        players: this.data.gamePlayers.filter((p) => p.gameId === gameId).map((p) => ({ ...p })),
        events: this.data.gameEvents.filter((e) => e.gameId === gameId).sort((a, b) => a.seq - b.seq).map((e) => ({ ...e })),
      };
    },
    chat: async ({ q, roomCode, status, limit, offset }) => {
      const needle = q?.toLowerCase();
      const all = this.data.chat.filter((c) => {
        if (status && c.status !== status) return false;
        if (roomCode && c.roomCode !== roomCode) return false;
        if (!needle) return true;
        return c.text.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle);
      });
      all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return { items: all.slice(offset, offset + limit).map((c) => ({ ...c })), total: all.length, limit, offset };
    },
    setChatStatus: async (id, status, deletedBy) => {
      const c = this.data.chat.find((x) => x.id === id);
      if (!c) return false;
      c.status = status;
      if (status === "deleted") { c.deletedBy = deletedBy; c.deletedAt = new Date(); }
      return true;
    },
    syncRecords: async ({ limit, offset }) => {
      const all = [...this.data.syncRecords.values()].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
      return {
        items: all.slice(offset, offset + limit).map((r) => ({ ...r })),
        total: all.length, limit, offset,
      };
    },
    setUserStatus: async (id, status) => {
      const u = this.data.users.get(id);
      if (!u) return false;
      u.status = status;
      u.updatedAt = new Date();
      return true;
    },
  };

  admin: AdminStore = {
    admins: {
      create: async (a) => {
        const now = new Date();
        const rec: AdminRecord = { ...a, id: randomUUID(), createdAt: now, updatedAt: now, failedLogins: 0 };
        this.data.admins.set(rec.id, rec);
        return { ...rec };
      },
      findById: async (id) => {
        const a = this.data.admins.get(id);
        return a ? { ...a } : null;
      },
      findByEmail: async (email) => {
        const a = [...this.data.admins.values()].find((x) => x.email === email.toLowerCase());
        return a ? { ...a } : null;
      },
      list: async () => [...this.data.admins.values()].map((a) => ({ ...a })),
      update: async (id, patch) => {
        const a = this.data.admins.get(id);
        if (!a) return null;
        Object.assign(a, patch, { updatedAt: new Date() });
        return { ...a };
      },
      recordFailedLogin: async (id, lockedUntil) => {
        const a = this.data.admins.get(id);
        if (!a) return;
        a.failedLogins += 1;
        a.lockedUntil = lockedUntil;
      },
    },
    adminSessions: {
      create: async (rec) => void this.data.adminSessions.set(rec.sessionHash, { ...rec }),
      resolve: async (h) => {
        const s = this.data.adminSessions.get(h);
        return s && !s.revoked && s.expiresAt > new Date() ? { ...s } : null;
      },
      touch: async (h, at) => {
        const s = this.data.adminSessions.get(h);
        if (s) s.lastSeenAt = at;
      },
      revoke: async (h) => {
        const s = this.data.adminSessions.get(h);
        if (s) s.revoked = true;
      },
      revokeAllForAdmin: async (adminId) => {
        for (const s of this.data.adminSessions.values()) if (s.adminId === adminId) s.revoked = true;
      },
      listActive: async (now) =>
        [...this.data.adminSessions.values()].filter((s) => !s.revoked && s.expiresAt > now).map((s) => ({ ...s })),
    },
    audit: {
      append: async (e) => void this.data.auditLogs.push({ ...e, id: randomUUID() }),
      list: async ({ q, action, adminId, resource, limit, offset }) => {
        const needle = q?.toLowerCase();
        const all = this.data.auditLogs.filter((e) => {
          if (action && e.action !== action) return false;
          if (adminId && e.adminId !== adminId) return false;
          if (resource && e.resource !== resource) return false;
          if (!needle) return true;
          return (e.reason ?? "").toLowerCase().includes(needle) || e.resourceId.toLowerCase().includes(needle) || e.adminUsername.toLowerCase().includes(needle);
        });
        all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return { items: all.slice(offset, offset + limit).map((e) => ({ ...e })), total: all.length, limit, offset };
      },
    },
    reports: {
      create: async (r) => {
        const now = new Date();
        const rec: ReportRecord = { ...r, id: randomUUID(), status: "OPEN", history: [], createdAt: now, updatedAt: now };
        this.data.reports.set(rec.id, rec);
        return { ...rec };
      },
      findById: async (id) => {
        const r = this.data.reports.get(id);
        return r ? structuredClone(r) : null;
      },
      list: async ({ q, status, category, assignedTo, limit, offset }) => {
        const needle = q?.toLowerCase();
        const all = [...this.data.reports.values()].filter((r) => {
          if (status && r.status !== status) return false;
          if (category && r.category !== category) return false;
          if (assignedTo && r.assignedTo !== assignedTo) return false;
          if (!needle) return true;
          return r.description.toLowerCase().includes(needle) || r.id.includes(needle);
        });
        all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return { items: structuredClone(all.slice(offset, offset + limit)), total: all.length, limit, offset };
      },
      update: async (id, patch, historyEntry) => {
        const r = this.data.reports.get(id);
        if (!r) return null;
        Object.assign(r, patch, { updatedAt: new Date() });
        r.history.push(historyEntry);
        return structuredClone(r);
      },
      countByStatus: async () => {
        const c: Record<string, number> = {};
        for (const r of this.data.reports.values()) c[r.status] = (c[r.status] ?? 0) + 1;
        return c;
      },
    },
    collection: async (name, { q, limit, offset }) => {
      const rows = this.collectionRows(name);
      const needle = q?.toLowerCase();
      const all = needle ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle)) : rows;
      return { items: structuredClone(all.slice(offset, offset + limit)), total: all.length, limit, offset };
    },
    updateRecord: async (name, id, changes) => {
      const rec = this.findRecord(name, id);
      if (!rec) return null;
      Object.assign(rec, changes);
      return structuredClone(rec);
    },
    softDelete: async (name, id) => {
      const rec = this.findRecord(name, id) as Record<string, unknown> | null;
      if (!rec) return false;
      if ("isDeleted" in rec || name === "users") { rec["isDeleted"] = true; rec["deletedAt"] = new Date().toISOString(); }
      else rec["status"] = "deleted";
      return true;
    },
    purge: async (name, id) => {
      if (name === "auditLogs" || name === "settings") return false; // protected collections
      const rows = this.collectionRef(name);
      if (!rows) return false;
      const i = rows.findIndex((r) => String((r as { id?: string }).id ?? (r as { _id?: string })._id) === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    stats: async () => {
      const dayAgo = new Date(Date.now() - 86_400_000);
      const users = [...this.data.users.values()].filter((u) => !u.isDeleted);
      return {
        users: users.length,
        guests: users.filter((u) => u.status === "guest").length,
        usersToday: users.filter((u) => u.createdAt >= dayAgo).length,
        activeSessions: this.data.sessions.size,
        rooms: this.data.rooms.size,
        activeGames: [...this.data.games.values()].filter((g) => g.status === "playing").length,
        gamesToday: [...this.data.games.values()].filter((g) => g.startedAt >= dayAgo).length,
        totalGames: this.data.games.size,
        pendingReports: [...this.data.reports.values()].filter((r) => r.status === "OPEN" || r.status === "INVESTIGATE").length,
        openAdmins: [...this.data.admins.values()].filter((a) => a.status === "active").length,
        syncRecords: this.data.syncRecords.size,
      };
    },
  };

  private collectionRows(name: string): Record<string, unknown>[] {
    const rows: unknown[] = ((): unknown[] => {
      switch (name) {
        case "users": return [...this.data.users.values()].filter((u) => !u.isDeleted);
        case "rooms": return [...this.data.rooms.values()];
        case "games": return [...this.data.games.values()];
        case "gamePlayers": return [...this.data.gamePlayers];
        case "gameEvents": return [...this.data.gameEvents];
        case "chatMessages": return [...this.data.chat];
        case "syncRecords": return [...this.data.syncRecords.values()];
        case "settings": return [...this.data.settings.values()];
        case "reports": return [...this.data.reports.values()];
        case "auditLogs": return [...this.data.auditLogs];
        default: return [];
      }
    })();
    return rows as Record<string, unknown>[];
  }
  private collectionRef(name: string): Record<string, unknown>[] | null {
    const rows: unknown[] | null = ((): unknown[] | null => {
      switch (name) {
        case "users": return [...this.data.users.values()];
        case "rooms": return [...this.data.rooms.values()];
        case "games": return [...this.data.games.values()];
        case "gamePlayers": return [...this.data.gamePlayers];
        case "gameEvents": return [...this.data.gameEvents];
        case "chatMessages": return [...this.data.chat];
        case "syncRecords": return [...this.data.syncRecords.values()].map((r) => ({ ...r, id: `${r.userId}:${r.localId}` }));
        case "reports": return [...this.data.reports.values()];
        default: return null;
      }
    })();
    return rows === null ? null : (rows as Record<string, unknown>[]);
  }
  private findRecord(name: string, id: string): Record<string, unknown> | null {
    return this.collectionRows(name).find((r) => String((r as { id?: string }).id ?? (r as { _id?: string })._id ?? (r as { code?: string }).code ?? "") === id) ?? null;
  }

  async ping() {
    return { ok: true, latencyMs: 0, kind: "memory" as const };
  }
  async close() {}
}

/** In-process live-state snapshots; replace with a Redis implementation for horizontal scaling. */
export class MemoryActiveStateStore implements ActiveStateStore {
  private snaps = new Map<string, ActiveRoomSnapshot>();
  async save(s: ActiveRoomSnapshot) {
    this.snaps.set(s.code, s);
  }
  async remove(code: string) {
    this.snaps.delete(code);
  }
  async list() {
    return [...this.snaps.values()];
  }
}
