import { z } from "zod";
import type { Card } from "./types.js";

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

export const createRoomSchema = z.object({ playerName: playerNameSchema });
export const joinRoomSchema = z.object({ roomCode: roomCodeSchema, playerName: playerNameSchema });
export const startGameSchema = z.object({ fillWithAi: z.boolean().optional(), aiDifficulty: z.enum(["easy", "normal", "hard"]).optional() });
export const requestDrawSchema = z.object({
  targetPlayerId: z.string().min(1).max(100),
  cardIndex: z.number().int().min(0).max(60),
  turnId: z.number().int().min(0),
  actionId: z.string().min(1).max(64),
});
export const chatSchema = z.object({ text: z.string().trim().min(1).max(200) });
export const EMOTES = ["😐", "😏", "😂", "😱", "🃏", "👀"] as const;
export const emoteSchema = z.object({ emote: z.enum(EMOTES) });

export type ErrorCode =
  | "ROOM_NOT_FOUND" | "ROOM_FULL" | "GAME_ALREADY_STARTED" | "INVALID_NAME" | "NAME_TAKEN"
  | "NOT_HOST" | "NOT_ENOUGH_PLAYERS" | "NOT_YOUR_TURN" | "INVALID_CARD" | "INVALID_TARGET"
  | "STALE_TURN" | "DUPLICATE_ACTION" | "GAME_PAUSED" | "RATE_LIMITED" | "MAINTENANCE"
  | "FEATURE_DISABLED" | "BANNED" | "BAD_REQUEST" | "NOT_IN_ROOM" | "INTERNAL"
  | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "PLAYER_DISCONNECTED" | "ROOM_LOCKED";

export interface ApiError { code: ErrorCode; message: string }
export type Ack<T> = ({ ok: true } & T) | { ok: false; error: ApiError };

export interface PublicPlayerState {
  id: string;
  name: string;
  cardCount: number;
  isConnected: boolean;
  isHost: boolean;
  isAi: boolean;
}

export interface PublicEvent { seq: number; text: string; type: string; actorId?: string; targetId?: string }

/** Everything a single client is allowed to know. Built per-viewer by the server. */
export interface PlayerView {
  roomCode: string;
  status: "waiting" | "playing" | "finished";
  you: string;
  hostId: string;
  players: PublicPlayerState[];
  maxPlayers: number;
  minPlayers: number;
  /** Only present while playing/finished. */
  game: null | {
    currentPlayerId: string | null;
    turnId: number;
    drawCount: number;
    cardsRemaining: number;
    discardedPairs: number;
    paused: null | { playerId: string; secondsLeft: number };
  };
  /** Only YOUR hand. */
  myHand: Card[];
  /** Only set when the game is over. */
  result: null | { winnerId: string | null; finalCard: "joker" | null; abandoned: boolean };
  /** Present on the requesting client only. */
  isHost: boolean;
  events: PublicEvent[];
}

export interface ChatMessagePayload { id: string; playerId: string; name: string; text: string; at: number }

/** Server → client events. */
export interface ServerToClientEvents {
  room_state: (view: PlayerView) => void;
  game_started: (view: PlayerView) => void;
  /** Sent ONLY to the drawing player: the identity of the card they drew. */
  card_drawn: (p: { card: Card; pairFormed: boolean; pairCards: [Card, Card] | null; fromPlayerId: string }) => void;
  /** Public: someone drew (no identities). */
  draw_public: (p: { actorId: string; targetId: string; cardIndex: number; pairFormed: boolean; seq: number }) => void;
  pair_formed: (p: { playerId: string }) => void;
  turn_changed: (p: { currentPlayerId: string; turnId: number }) => void;
  player_joined: (p: { playerId: string; name: string }) => void;
  player_left: (p: { playerId: string; name: string }) => void;
  player_disconnected: (p: { playerId: string; name: string; secondsLeft: number }) => void;
  player_reconnected: (p: { playerId: string; name: string }) => void;
  host_transferred: (p: { playerId: string; name: string }) => void;
  game_paused: (p: { playerId: string; secondsLeft: number }) => void;
  game_resumed: () => void;
  game_over: (p: { winnerId: string; winnerName: string; finalCard: "joker" }) => void;
  chat_message: (m: ChatMessagePayload) => void;
  emote: (p: { playerId: string; emote: string }) => void;
  server_notice: (p: { message: string; code?: "TAKEOVER" | "ROOM_CLOSED" | "TIMEOUT" }) => void;
}

export interface ClientToServerEvents {
  create_room: (p: unknown, ack: (r: Ack<{ roomCode: string; playerId: string }>) => void) => void;
  join_room: (p: unknown, ack: (r: Ack<{ roomCode: string; playerId: string }>) => void) => void;
  resume_session: (ack: (r: Ack<{ roomCode: string; playerId: string }>) => void) => void;
  leave_room: (ack?: (r: Ack<object>) => void) => void;
  start_game: (p: unknown, ack: (r: Ack<object>) => void) => void;
  request_draw: (p: unknown, ack: (r: Ack<object>) => void) => void;
  chat_message: (p: unknown, ack?: (r: Ack<object>) => void) => void;
  emote: (p: unknown, ack?: (r: Ack<object>) => void) => void;
  rematch: (ack: (r: Ack<object>) => void) => void;
  end_match: (ack: (r: Ack<object>) => void) => void;
}

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
export type OfflineGamePayload = z.infer<typeof offlineGameSchema>;
export const syncBatchSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(8).max(64),
    type: z.enum(["GAME_RESULT", "SETTINGS_UPDATE", "PROFILE_UPDATE"]),
    payload: z.unknown(),
  })).max(100),
});

export const settingsUpdateSchema = z.object({
  updatedAt: z.number().int().positive(),
  settings: z.object({
    sound: z.boolean().optional(),
    music: z.boolean().optional(),
    animations: z.boolean().optional(),
    theme: z.enum(["dark", "ember", "contrast"]).optional(),
    cardStyle: z.enum(["classic", "minimal"]).optional(),
    aiDifficulty: z.enum(["easy", "normal", "hard"]).optional(),
    aiPlayers: z.number().int().min(1).max(6).optional(),
    language: z.string().max(10).optional(),
  }).strict(),
});
export type SettingsUpdatePayload = z.infer<typeof settingsUpdateSchema>;

export const profileUpdateSchema = z.object({
  updatedAt: z.number().int().positive(),
  displayName: playerNameSchema.optional(),
  avatar: z.string().max(32).optional(),
});
export type ProfileUpdatePayload = z.infer<typeof profileUpdateSchema>;

export interface SyncItemResult {
  id: string;
  status: "synced" | "duplicate" | "rejected" | "stale" | "failed";
  reason?: string;
}

export interface StatsSummary {
  online: { games: number; wins: number; losses: number };
  offline: { games: number; wins: number; losses: number };
}
