import { z } from "zod";
export declare const gameSettingsSchema: z.ZodEffects<z.ZodObject<{
    minPlayers: z.ZodNumber;
    maxPlayers: z.ZodNumber;
    allowAiFill: z.ZodBoolean;
    defaultAiDifficulty: z.ZodEnum<["easy", "normal", "hard"]>;
    turnTimeoutSec: z.ZodNumber;
    reconnectTimeoutSec: z.ZodNumber;
    roomExpirationSec: z.ZodNumber;
    chatEnabled: z.ZodBoolean;
    emotesEnabled: z.ZodBoolean;
    spectatorsEnabled: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    minPlayers: number;
    maxPlayers: number;
    allowAiFill: boolean;
    defaultAiDifficulty: "easy" | "normal" | "hard";
    turnTimeoutSec: number;
    reconnectTimeoutSec: number;
    roomExpirationSec: number;
    chatEnabled: boolean;
    emotesEnabled: boolean;
    spectatorsEnabled: boolean;
}, {
    minPlayers: number;
    maxPlayers: number;
    allowAiFill: boolean;
    defaultAiDifficulty: "easy" | "normal" | "hard";
    turnTimeoutSec: number;
    reconnectTimeoutSec: number;
    roomExpirationSec: number;
    chatEnabled: boolean;
    emotesEnabled: boolean;
    spectatorsEnabled: boolean;
}>, {
    minPlayers: number;
    maxPlayers: number;
    allowAiFill: boolean;
    defaultAiDifficulty: "easy" | "normal" | "hard";
    turnTimeoutSec: number;
    reconnectTimeoutSec: number;
    roomExpirationSec: number;
    chatEnabled: boolean;
    emotesEnabled: boolean;
    spectatorsEnabled: boolean;
}, {
    minPlayers: number;
    maxPlayers: number;
    allowAiFill: boolean;
    defaultAiDifficulty: "easy" | "normal" | "hard";
    turnTimeoutSec: number;
    reconnectTimeoutSec: number;
    roomExpirationSec: number;
    chatEnabled: boolean;
    emotesEnabled: boolean;
    spectatorsEnabled: boolean;
}>;
export type GameSettings = z.infer<typeof gameSettingsSchema>;
export declare const DEFAULT_GAME_SETTINGS: GameSettings;
export declare const aiSettingsSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    difficulty: z.ZodEnum<["easy", "normal", "hard"]>;
    thinkingDelayMs: z.ZodNumber;
    aggressiveness: z.ZodNumber;
    memory: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    aggressiveness: number;
    memory: number;
    enabled: boolean;
    difficulty: "easy" | "normal" | "hard";
    thinkingDelayMs: number;
}, {
    aggressiveness: number;
    memory: number;
    enabled: boolean;
    difficulty: "easy" | "normal" | "hard";
    thinkingDelayMs: number;
}>;
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export declare const DEFAULT_AI_SETTINGS: AiSettings;
export declare const FEATURE_FLAGS: readonly ["onlineMultiplayer", "offlineMode", "chat", "emotes", "spectators", "achievements", "statistics", "replays"];
export type FeatureFlagName = (typeof FEATURE_FLAGS)[number];
export declare const featureFlagsSchema: z.ZodRecord<z.ZodEnum<["onlineMultiplayer", "offlineMode", "chat", "emotes", "spectators", "achievements", "statistics", "replays"]>, z.ZodBoolean>;
export declare const DEFAULT_FEATURE_FLAGS: Record<FeatureFlagName, boolean>;
/** Canonical card rules cannot be changed – requests for an invalid deck are rejected. */
export declare const cardSettingsSchema: z.ZodObject<{
    jokerCount: z.ZodLiteral<1>;
    deckType: z.ZodLiteral<"standard52">;
}, "strip", z.ZodTypeAny, {
    jokerCount: 1;
    deckType: "standard52";
}, {
    jokerCount: 1;
    deckType: "standard52";
}>;
export declare const systemSettingsSchema: z.ZodObject<{
    applicationName: z.ZodString;
    maintenanceMode: z.ZodBoolean;
    maintenanceMessage: z.ZodString;
    allowExistingGamesInMaintenance: z.ZodBoolean;
    allowNewGames: z.ZodBoolean;
    allowRegistrations: z.ZodBoolean;
    sessionTimeoutMin: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    applicationName: string;
    maintenanceMode: boolean;
    maintenanceMessage: string;
    allowExistingGamesInMaintenance: boolean;
    allowNewGames: boolean;
    allowRegistrations: boolean;
    sessionTimeoutMin: number;
}, {
    applicationName: string;
    maintenanceMode: boolean;
    maintenanceMessage: string;
    allowExistingGamesInMaintenance: boolean;
    allowNewGames: boolean;
    allowRegistrations: boolean;
    sessionTimeoutMin: number;
}>;
export type SystemSettings = z.infer<typeof systemSettingsSchema>;
export declare const DEFAULT_SYSTEM_SETTINGS: SystemSettings;
