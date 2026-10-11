import { z } from "zod";
export const gameSettingsSchema = z.object({
    minPlayers: z.number().int().min(2).max(7),
    maxPlayers: z.number().int().min(2).max(7),
    allowAiFill: z.boolean(),
    defaultAiDifficulty: z.enum(["easy", "normal", "hard"]),
    turnTimeoutSec: z.number().int().min(10).max(600),
    reconnectTimeoutSec: z.number().int().min(10).max(600),
    roomExpirationSec: z.number().int().min(60).max(86400),
    chatEnabled: z.boolean(),
    emotesEnabled: z.boolean(),
    spectatorsEnabled: z.boolean(),
}).refine((s) => s.minPlayers <= s.maxPlayers, { message: "minPlayers must be <= maxPlayers" });
export const DEFAULT_GAME_SETTINGS = {
    minPlayers: 2,
    maxPlayers: 7,
    allowAiFill: true,
    defaultAiDifficulty: "normal",
    turnTimeoutSec: 60,
    reconnectTimeoutSec: 60,
    roomExpirationSec: 600,
    chatEnabled: true,
    emotesEnabled: true,
    spectatorsEnabled: false,
};
export const aiSettingsSchema = z.object({
    enabled: z.boolean(),
    difficulty: z.enum(["easy", "normal", "hard"]),
    thinkingDelayMs: z.number().int().min(0).max(5000),
    aggressiveness: z.number().min(0).max(1),
    memory: z.number().min(0).max(1),
});
export const DEFAULT_AI_SETTINGS = {
    enabled: true, difficulty: "normal", thinkingDelayMs: 800, aggressiveness: 0.5, memory: 0.6,
};
export const FEATURE_FLAGS = [
    "onlineMultiplayer", "offlineMode", "chat", "emotes", "spectators", "achievements", "statistics", "replays",
];
export const featureFlagsSchema = z.record(z.enum(FEATURE_FLAGS), z.boolean());
export const DEFAULT_FEATURE_FLAGS = {
    onlineMultiplayer: true, offlineMode: true, chat: true, emotes: true,
    spectators: false, achievements: true, statistics: true, replays: false,
};
/** Canonical card rules cannot be changed – requests for an invalid deck are rejected. */
export const cardSettingsSchema = z.object({
    jokerCount: z.literal(1),
    deckType: z.literal("standard52"),
});
export const systemSettingsSchema = z.object({
    applicationName: z.string().min(1).max(60),
    maintenanceMode: z.boolean(),
    maintenanceMessage: z.string().max(300),
    allowExistingGamesInMaintenance: z.boolean(),
    allowNewGames: z.boolean(),
    allowRegistrations: z.boolean(),
    sessionTimeoutMin: z.number().int().min(5).max(43200),
});
export const DEFAULT_SYSTEM_SETTINGS = {
    applicationName: "Old Maid", maintenanceMode: false,
    maintenanceMessage: "The game is temporarily unavailable. Please try again later.",
    allowExistingGamesInMaintenance: true, allowNewGames: true, allowRegistrations: true, sessionTimeoutMin: 1440,
};
