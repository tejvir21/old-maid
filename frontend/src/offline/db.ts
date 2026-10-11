import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  ACHIEVEMENTS, DEFAULT_SETTINGS, SYNCED_SETTING_KEYS, toGamePayload,
  type AchievementDoc, type ActiveGameDoc, type OfflineGameRecord, type Profile, type QueueStatus, type QueueType,
  type Settings, type StatsDoc, type StoredEvent, type StoredSettings, type SyncQueueItem,
} from "./types";
import { newId } from "./ids";

interface Schema extends DBSchema {
  profile: { key: string; value: Profile };
  settings: { key: string; value: StoredSettings };
  activeGame: { key: string; value: ActiveGameDoc };
  offlineGames: { key: string; value: OfflineGameRecord; indexes: { bySync: string; byFinished: number } };
  gameEvents: { key: [string, number]; value: StoredEvent };
  statistics: { key: string; value: StatsDoc };
  achievements: { key: string; value: AchievementDoc };
  syncQueue: { key: string; value: SyncQueueItem; indexes: { byStatus: string } };
}
export type Db = IDBPDatabase<Schema>;

export async function openDatabase(name = "old-maid"): Promise<Db> {
  return openDB<Schema>(name, 1, {
    upgrade(db) {
      db.createObjectStore("profile", { keyPath: "key" });
      db.createObjectStore("settings", { keyPath: "key" });
      db.createObjectStore("activeGame", { keyPath: "key" });
      const g = db.createObjectStore("offlineGames", { keyPath: "localGameId" });
      g.createIndex("bySync", "syncStatus");
      g.createIndex("byFinished", "finishedAt");
      db.createObjectStore("gameEvents", { keyPath: ["localGameId", "seq"] });
      db.createObjectStore("statistics", { keyPath: "key" });
      db.createObjectStore("achievements", { keyPath: "id" });
      const q = db.createObjectStore("syncQueue", { keyPath: "id" });
      q.createIndex("byStatus", "status");
    },
  });
}

const emptyStats = (key: "offline" | "online"): StatsDoc => ({
  key, games: 0, wins: 0, losses: 0, updatedAt: 0,
  byDifficulty: { easy: { games: 0, wins: 0 }, normal: { games: 0, wins: 0 }, hard: { games: 0, wins: 0 } },
});

/** The only methods we need from an object store; satisfied structurally by idb's transaction stores. */
interface QStore {
  getAll(): Promise<SyncQueueItem[]>;
  delete(id: string): Promise<void>;
  put(v: SyncQueueItem): Promise<unknown>;
}

export interface FinishResult { newAchievements: string[] }
export interface QueueCounts { pending: number; syncing: number; failed: number; synced: number }

/** All persistence for the offline-first client. Every multi-store write is a single IndexedDB transaction. */
export class Repo {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  close(): void {
    this.db.close();
  }

  /** Replaces any still-pending item of the same type so only the latest value is ever uploaded. */
  private async queueCoalesced(store: QStore, type: QueueType, payload: unknown): Promise<void> {
    for (const it of await store.getAll()) if (it.type === type && it.status === "pending") await store.delete(it.id);
    await store.put({ id: newId(), type, payload, createdAt: this.now(), attempts: 0, status: "pending", nextAttemptAt: 0 });
  }

  /* ---------------- profile ---------------- */
  async getProfile(): Promise<Profile> {
    const existing = await this.db.get("profile", "me");
    if (existing) return existing;
    const p: Profile = { key: "me", localPlayerId: newId(), displayName: "Player", avatar: "a1", updatedAt: 0 };
    await this.db.put("profile", p);
    return p;
  }
  async patchProfile(patch: Partial<Omit<Profile, "key" | "localPlayerId">>, opts: { sync?: boolean } = {}): Promise<Profile> {
    const tx = this.db.transaction(["profile", "syncQueue"], "readwrite");
    const cur = (await tx.objectStore("profile").get("me")) ?? { key: "me" as const, localPlayerId: newId(), displayName: "Player", avatar: "a1", updatedAt: 0 };
    const next: Profile = { ...cur, ...patch, key: "me" };
    if (opts.sync) {
      next.updatedAt = this.now();
      await this.queueCoalesced(tx.objectStore("syncQueue"), "PROFILE_UPDATE", {
        updatedAt: next.updatedAt, displayName: next.displayName, avatar: next.avatar,
      });
    }
    await tx.objectStore("profile").put(next);
    await tx.done;
    return next;
  }

  /* ---------------- settings ---------------- */
  async getSettings(): Promise<{ values: Settings; updatedAt: number }> {
    const s = await this.db.get("settings", "local");
    return s ? { values: { ...DEFAULT_SETTINGS, ...s.values }, updatedAt: s.updatedAt } : { values: { ...DEFAULT_SETTINGS }, updatedAt: 0 };
  }
  async saveSettings(patch: Partial<Settings>): Promise<{ values: Settings; updatedAt: number }> {
    const tx = this.db.transaction(["settings", "syncQueue"], "readwrite");
    const cur = await tx.objectStore("settings").get("local");
    const values: Settings = { ...DEFAULT_SETTINGS, ...(cur?.values ?? {}), ...patch };
    const updatedAt = this.now();
    await tx.objectStore("settings").put({ key: "local", values, updatedAt });
    const synced = Object.fromEntries(SYNCED_SETTING_KEYS.map((k) => [k, values[k]]));
    await this.queueCoalesced(tx.objectStore("syncQueue"), "SETTINGS_UPDATE", { updatedAt, settings: synced });
    await tx.done;
    return { values, updatedAt };
  }

  /* ---------------- active game (survives close/reopen) ---------------- */
  async saveActive(localGameId: string, snapshot: unknown): Promise<void> {
    await this.db.put("activeGame", { key: "current", localGameId, savedAt: this.now(), snapshot });
  }
  async loadActive<T>(): Promise<{ localGameId: string; snapshot: T; savedAt: number } | null> {
    const d = await this.db.get("activeGame", "current");
    return d ? { localGameId: d.localGameId, snapshot: d.snapshot as T, savedAt: d.savedAt } : null;
  }
  async clearActive(): Promise<void> {
    await this.db.delete("activeGame", "current");
  }

  /**
   * ATOMIC: result + public events + statistics + achievements + sync-queue item + active-game removal.
   * A crash can never leave a finished game without its queue entry, or count it twice.
   */
  async finishOfflineGame(record: OfflineGameRecord, events: StoredEvent[]): Promise<FinishResult> {
    const tx = this.db.transaction(["offlineGames", "gameEvents", "statistics", "achievements", "syncQueue", "activeGame"], "readwrite");
    const games = tx.objectStore("offlineGames");
    if (await games.get(record.localGameId)) {
      await tx.objectStore("activeGame").delete("current");
      await tx.done;
      return { newAchievements: [] }; // already recorded (idempotent)
    }
    await games.put(record);
    for (const e of events) await tx.objectStore("gameEvents").put(e);

    const stats = (await tx.objectStore("statistics").get("offline")) ?? emptyStats("offline");
    stats.games += 1;
    if (record.result === "win") stats.wins += 1;
    else stats.losses += 1;
    const bd = stats.byDifficulty ?? emptyStats("offline").byDifficulty!;
    bd[record.aiDifficulty].games += 1;
    if (record.result === "win") bd[record.aiDifficulty].wins += 1;
    stats.byDifficulty = bd;
    stats.updatedAt = this.now();
    await tx.objectStore("statistics").put(stats);

    const unlocked = new Set((await tx.objectStore("achievements").getAll()).map((a) => a.id));
    const earn: string[] = [];
    const grant = (id: string, cond: boolean) => { if (cond && !unlocked.has(id)) earn.push(id); };
    grant("first_game", true);
    grant("first_win", record.result === "win");
    grant("hard_win", record.result === "win" && record.aiDifficulty === "hard");
    grant("full_table", record.result === "win" && record.playerCount === 7);
    grant("ten_games", stats.games >= 10);
    for (const id of earn) await tx.objectStore("achievements").put({ id, unlockedAt: this.now() });

    await tx.objectStore("syncQueue").put({
      id: record.localGameId, type: "GAME_RESULT", payload: toGamePayload(record),
      createdAt: this.now(), attempts: 0, status: "pending", nextAttemptAt: 0,
    });
    await tx.objectStore("activeGame").delete("current");
    await tx.done;
    return { newAchievements: earn };
  }

  async listGames(limit = 20): Promise<OfflineGameRecord[]> {
    const all = await this.db.getAllFromIndex("offlineGames", "byFinished");
    return all.reverse().slice(0, limit);
  }
  async getGame(id: string): Promise<OfflineGameRecord | undefined> {
    return this.db.get("offlineGames", id);
  }
  async getGameEvents(id: string): Promise<StoredEvent[]> {
    return (await this.db.getAll("gameEvents")).filter((e) => e.localGameId === id).sort((a, b) => a.seq - b.seq);
  }

  /* ---------------- statistics ---------------- */
  async getStats(): Promise<{ offline: StatsDoc; online: StatsDoc }> {
    return {
      offline: (await this.db.get("statistics", "offline")) ?? emptyStats("offline"),
      online: (await this.db.get("statistics", "online")) ?? emptyStats("online"),
    };
  }
  /** Cache of the server's VERIFIED online stats (display only – never uploaded). */
  async cacheOnlineStats(s: { games: number; wins: number; losses: number }): Promise<void> {
    await this.db.put("statistics", { ...emptyStats("online"), ...s, key: "online", updatedAt: this.now() });
  }
  async getAchievements(): Promise<AchievementDoc[]> {
    return this.db.getAll("achievements");
  }
  achievementTitle(id: string): string {
    return ACHIEVEMENTS.find((a) => a.id === id)?.title ?? id;
  }

  /* ---------------- sync queue ---------------- */
  async queueAll(): Promise<SyncQueueItem[]> {
    return (await this.db.getAll("syncQueue")).sort((a, b) => a.createdAt - b.createdAt);
  }
  async queueDue(now: number, limit = 25): Promise<SyncQueueItem[]> {
    return (await this.db.getAllFromIndex("syncQueue", "byStatus", "pending"))
      .filter((i) => i.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }
  async queueCounts(): Promise<QueueCounts> {
    const c: QueueCounts = { pending: 0, syncing: 0, failed: 0, synced: 0 };
    for (const i of await this.db.getAll("syncQueue")) c[i.status as QueueStatus]++;
    return c;
  }
  async markSyncing(ids: string[]): Promise<void> {
    const tx = this.db.transaction("syncQueue", "readwrite");
    for (const id of ids) {
      const it = await tx.store.get(id);
      if (it && it.status === "pending") await tx.store.put({ ...it, status: "syncing" });
    }
    await tx.done;
  }
  /** Items left "syncing" by a crash/close go back to pending. Safe: the server is idempotent. */
  async resetStuckSyncing(): Promise<number> {
    const tx = this.db.transaction("syncQueue", "readwrite");
    let n = 0;
    for (const it of await tx.store.index("byStatus").getAll("syncing")) {
      await tx.store.put({ ...it, status: "pending", nextAttemptAt: 0 });
      n++;
    }
    await tx.done;
    return n;
  }
  async pruneSynced(olderThanMs = 3_600_000): Promise<void> {
    const tx = this.db.transaction("syncQueue", "readwrite");
    for (const it of await tx.store.index("byStatus").getAll("synced")) {
      if (this.now() - it.createdAt > olderThanMs) await tx.store.delete(it.id);
    }
    await tx.done;
  }

  /** Record the server's verdict for one queue item (and mirror it onto the game record). */
  async resolveItem(id: string, outcome: { kind: "synced" } | { kind: "failed"; reason: string } | { kind: "retry"; reason: string; nextAttemptAt: number }): Promise<void> {
    const tx = this.db.transaction(["syncQueue", "offlineGames"], "readwrite");
    const it = await tx.objectStore("syncQueue").get(id);
    if (!it) { await tx.done; return; }
    if (outcome.kind === "synced") it.status = "synced";
    else if (outcome.kind === "failed") { it.status = "failed"; it.lastError = outcome.reason; }
    else { it.status = "pending"; it.attempts += 1; it.nextAttemptAt = outcome.nextAttemptAt; it.lastError = outcome.reason; }
    await tx.objectStore("syncQueue").put(it);
    if (it.type === "GAME_RESULT") {
      const g = await tx.objectStore("offlineGames").get(id);
      if (g && outcome.kind !== "retry") await tx.objectStore("offlineGames").put({ ...g, syncStatus: outcome.kind === "synced" ? "synced" : "failed" });
    }
    await tx.done;
  }
}
