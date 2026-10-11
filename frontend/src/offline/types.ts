import type { AiLevel, OfflineGamePayload } from "@old-maid/shared";

export type Theme = "dark" | "ember" | "contrast";
export type CardStyle = "classic" | "minimal";

/** Keys in this object (except `debug`) are exactly what the server's settings schema accepts. */
export interface Settings {
  sound: boolean;
  music: boolean;
  animations: boolean;
  theme: Theme;
  cardStyle: CardStyle;
  aiDifficulty: AiLevel;
  aiPlayers: number;
  language: string;
  /** Local-only (never synced): shows every hand in OFFLINE games. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sound: true, music: false, animations: true, theme: "dark", cardStyle: "classic",
  aiDifficulty: "normal", aiPlayers: 6, language: "en", debug: false,
};

export const SYNCED_SETTING_KEYS = ["sound", "music", "animations", "theme", "cardStyle", "aiDifficulty", "aiPlayers", "language"] as const;

export interface StoredSettings { key: "local"; values: Settings; updatedAt: number }

export interface Profile {
  key: "me";
  localPlayerId: string;
  displayName: string;
  avatar: string;
  updatedAt: number;
  lastSyncAt?: number;
  auth?: { userId: string; sessionId: string };
}

export type SyncStatus = "pending" | "synced" | "failed";

export interface OfflineGameRecord {
  localGameId: string;
  startedAt: number;
  finishedAt: number;
  mode: "offline-ai";
  playerId: string;
  playerCount: number;
  aiDifficulty: AiLevel;
  result: "win" | "loss";
  durationSeconds: number;
  turnCount: number;
  syncStatus: SyncStatus;
}

export interface StoredEvent { localGameId: string; seq: number; text: string; type: string }

export type QueueType = "GAME_RESULT" | "SETTINGS_UPDATE" | "PROFILE_UPDATE";
export type QueueStatus = "pending" | "syncing" | "synced" | "failed";
export interface SyncQueueItem {
  id: string;
  type: QueueType;
  payload: unknown;
  createdAt: number;
  attempts: number;
  status: QueueStatus;
  nextAttemptAt: number;
  lastError?: string;
}

export interface StatsDoc {
  key: "offline" | "online";
  games: number;
  wins: number;
  losses: number;
  updatedAt: number;
  byDifficulty?: Record<AiLevel, { games: number; wins: number }>;
}

export interface AchievementDoc { id: string; unlockedAt: number }

export interface ActiveGameDoc { key: "current"; localGameId: string; savedAt: number; snapshot: unknown }

export const toGamePayload = (r: OfflineGameRecord): OfflineGamePayload => ({
  localGameId: r.localGameId, startedAt: r.startedAt, finishedAt: r.finishedAt, mode: "offline-ai",
  playerCount: r.playerCount, aiDifficulty: r.aiDifficulty, result: r.result,
  durationSeconds: r.durationSeconds, turnCount: r.turnCount,
});

export const ACHIEVEMENTS: { id: string; title: string; hint: string }[] = [
  { id: "first_game", title: "First Hand", hint: "Finish an offline game." },
  { id: "first_win", title: "Holder", hint: "Win by holding the Joker." },
  { id: "hard_win", title: "Cold Nerve", hint: "Win against Hard AI." },
  { id: "full_table", title: "Full Table", hint: "Win a 7-player game." },
  { id: "ten_games", title: "Regular", hint: "Play 10 offline games." },
];
