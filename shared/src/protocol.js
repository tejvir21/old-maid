import { z } from "zod";
/** Room codes: unambiguous alphabet, case-insensitive on input. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 5;
export const playerNameSchema = z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(16, "Name must be at most 16 characters")
    .regex(/^[\p{L}\p{N} _.-]+$/u, "Name contains invalid characters");
export const roomCodeSchema = z
    .string()
    .trim()
    .toUpperCase()
    .length(ROOM_CODE_LENGTH)
    .refine((c) => [...c].every((ch) => ROOM_CODE_ALPHABET.includes(ch)), "Invalid room code");
export const createRoomSchema = z.object({
    playerName: playerNameSchema,
    sessionId: z.string().min(8).max(100).optional(),
});
export const joinRoomSchema = z.object({
    roomCode: roomCodeSchema,
    playerName: playerNameSchema,
    sessionId: z.string().min(8).max(100).optional(),
});
export const resumeSchema = z.object({ sessionId: z.string().min(8).max(100) });
export const startGameSchema = z.object({ fillWithAi: z.boolean().optional(), aiDifficulty: z.enum(["easy", "normal", "hard"]).optional() });
export const requestDrawSchema = z.object({
    targetPlayerId: z.string().min(1).max(100),
    cardIndex: z.number().int().min(0).max(60),
    turnId: z.number().int().min(0),
    actionId: z.string().min(1).max(64),
});
export const chatSchema = z.object({ text: z.string().trim().min(1).max(200) });
export const EMOTES = ["😐", "😏", "😂", "😱", "🃏", "👀"];
export const emoteSchema = z.object({ emote: z.enum(EMOTES) });
/** Offline-sync payloads (HTTP). */
export const offlineGameSchema = z.object({
    localGameId: z.string().min(8).max(64),
    startedAt: z.number().int().positive(),
    finishedAt: z.number().int().positive(),
    mode: z.literal("offline-ai"),
    playerCount: z.number().int().min(2).max(7),
    aiDifficulty: z.enum(["easy", "normal", "hard"]),
    result: z.enum(["win", "loss"]),
    durationSeconds: z.number().int().min(0).max(86400),
    turnCount: z.number().int().min(0).max(5000),
});
export const syncBatchSchema = z.object({
    items: z.array(z.object({
        id: z.string().min(8).max(64),
        type: z.enum(["GAME_RESULT", "SETTINGS_UPDATE", "PROFILE_UPDATE"]),
        payload: z.unknown(),
    })).max(100),
});
