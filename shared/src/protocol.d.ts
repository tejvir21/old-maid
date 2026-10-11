import { z } from "zod";
import type { Card } from "./types.js";
/** Room codes: unambiguous alphabet, case-insensitive on input. */
export declare const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export declare const ROOM_CODE_LENGTH = 5;
export declare const playerNameSchema: z.ZodString;
export declare const roomCodeSchema: z.ZodEffects<z.ZodString, string, string>;
export declare const createRoomSchema: z.ZodObject<{
    playerName: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    playerName: string;
    sessionId?: string | undefined;
}, {
    playerName: string;
    sessionId?: string | undefined;
}>;
export declare const joinRoomSchema: z.ZodObject<{
    roomCode: z.ZodEffects<z.ZodString, string, string>;
    playerName: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    playerName: string;
    roomCode: string;
    sessionId?: string | undefined;
}, {
    playerName: string;
    roomCode: string;
    sessionId?: string | undefined;
}>;
export declare const resumeSchema: z.ZodObject<{
    sessionId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    sessionId: string;
}, {
    sessionId: string;
}>;
export declare const startGameSchema: z.ZodObject<{
    fillWithAi: z.ZodOptional<z.ZodBoolean>;
    aiDifficulty: z.ZodOptional<z.ZodEnum<["easy", "normal", "hard"]>>;
}, "strip", z.ZodTypeAny, {
    fillWithAi?: boolean | undefined;
    aiDifficulty?: "easy" | "normal" | "hard" | undefined;
}, {
    fillWithAi?: boolean | undefined;
    aiDifficulty?: "easy" | "normal" | "hard" | undefined;
}>;
export declare const requestDrawSchema: z.ZodObject<{
    targetPlayerId: z.ZodString;
    cardIndex: z.ZodNumber;
    turnId: z.ZodNumber;
    actionId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    turnId: number;
    cardIndex: number;
    targetPlayerId: string;
    actionId: string;
}, {
    turnId: number;
    cardIndex: number;
    targetPlayerId: string;
    actionId: string;
}>;
export declare const chatSchema: z.ZodObject<{
    text: z.ZodString;
}, "strip", z.ZodTypeAny, {
    text: string;
}, {
    text: string;
}>;
export declare const EMOTES: readonly ["😐", "😏", "😂", "😱", "🃏", "👀"];
export declare const emoteSchema: z.ZodObject<{
    emote: z.ZodEnum<["😐", "😏", "😂", "😱", "🃏", "👀"]>;
}, "strip", z.ZodTypeAny, {
    emote: "😐" | "😏" | "😂" | "😱" | "🃏" | "👀";
}, {
    emote: "😐" | "😏" | "😂" | "😱" | "🃏" | "👀";
}>;
export type ErrorCode = "ROOM_NOT_FOUND" | "ROOM_FULL" | "GAME_ALREADY_STARTED" | "INVALID_NAME" | "NAME_TAKEN" | "NOT_HOST" | "NOT_ENOUGH_PLAYERS" | "NOT_YOUR_TURN" | "INVALID_CARD" | "INVALID_TARGET" | "STALE_TURN" | "DUPLICATE_ACTION" | "GAME_PAUSED" | "RATE_LIMITED" | "MAINTENANCE" | "FEATURE_DISABLED" | "BANNED" | "BAD_REQUEST" | "NOT_IN_ROOM" | "INTERNAL";
export interface ApiError {
    code: ErrorCode;
    message: string;
}
export type Ack<T> = ({
    ok: true;
} & T) | {
    ok: false;
    error: ApiError;
};
export interface PublicPlayerState {
    id: string;
    name: string;
    cardCount: number;
    isConnected: boolean;
    isHost: boolean;
    isAi: boolean;
}
export interface PublicEvent {
    seq: number;
    text: string;
    type: string;
    actorId?: string;
    targetId?: string;
}
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
        paused: null | {
            playerId: string;
            secondsLeft: number;
        };
    };
    /** Only YOUR hand. */
    myHand: Card[];
    /** Only set when the game is over. */
    result: null | {
        winnerId: string;
        finalCard: "joker";
    };
    events: PublicEvent[];
}
export interface ChatMessagePayload {
    id: string;
    playerId: string;
    name: string;
    text: string;
    at: number;
}
/** Server → client events. */
export interface ServerToClientEvents {
    room_state: (view: PlayerView) => void;
    game_started: (view: PlayerView) => void;
    /** Sent ONLY to the drawing player: the identity of the card they drew. */
    card_drawn: (p: {
        card: Card;
        pairFormed: boolean;
        pairCards: [Card, Card] | null;
        fromPlayerId: string;
    }) => void;
    /** Public: someone drew (no identities). */
    draw_public: (p: {
        actorId: string;
        targetId: string;
        cardIndex: number;
        pairFormed: boolean;
        seq: number;
    }) => void;
    pair_formed: (p: {
        playerId: string;
    }) => void;
    turn_changed: (p: {
        currentPlayerId: string;
        turnId: number;
    }) => void;
    player_joined: (p: {
        playerId: string;
        name: string;
    }) => void;
    player_left: (p: {
        playerId: string;
        name: string;
    }) => void;
    player_disconnected: (p: {
        playerId: string;
        name: string;
        secondsLeft: number;
    }) => void;
    player_reconnected: (p: {
        playerId: string;
        name: string;
    }) => void;
    host_transferred: (p: {
        playerId: string;
        name: string;
    }) => void;
    game_paused: (p: {
        playerId: string;
        secondsLeft: number;
    }) => void;
    game_resumed: () => void;
    game_over: (p: {
        winnerId: string;
        winnerName: string;
        finalCard: "joker";
    }) => void;
    chat_message: (m: ChatMessagePayload) => void;
    emote: (p: {
        playerId: string;
        emote: string;
    }) => void;
    server_notice: (p: {
        message: string;
    }) => void;
}
export interface ClientToServerEvents {
    create_room: (p: unknown, ack: (r: Ack<{
        roomCode: string;
        playerId: string;
        sessionId: string;
    }>) => void) => void;
    join_room: (p: unknown, ack: (r: Ack<{
        roomCode: string;
        playerId: string;
        sessionId: string;
    }>) => void) => void;
    resume_session: (p: unknown, ack: (r: Ack<{
        roomCode: string;
        playerId: string;
    }>) => void) => void;
    leave_room: (ack?: (r: Ack<object>) => void) => void;
    start_game: (p: unknown, ack: (r: Ack<object>) => void) => void;
    request_draw: (p: unknown, ack: (r: Ack<object>) => void) => void;
    chat_message: (p: unknown, ack?: (r: Ack<object>) => void) => void;
    emote: (p: unknown, ack?: (r: Ack<object>) => void) => void;
    rematch: (ack: (r: Ack<object>) => void) => void;
}
/** Offline-sync payloads (HTTP). */
export declare const offlineGameSchema: z.ZodObject<{
    localGameId: z.ZodString;
    startedAt: z.ZodNumber;
    finishedAt: z.ZodNumber;
    mode: z.ZodLiteral<"offline-ai">;
    playerCount: z.ZodNumber;
    aiDifficulty: z.ZodEnum<["easy", "normal", "hard"]>;
    result: z.ZodEnum<["win", "loss"]>;
    durationSeconds: z.ZodNumber;
    turnCount: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    aiDifficulty: "easy" | "normal" | "hard";
    localGameId: string;
    startedAt: number;
    finishedAt: number;
    mode: "offline-ai";
    playerCount: number;
    result: "win" | "loss";
    durationSeconds: number;
    turnCount: number;
}, {
    aiDifficulty: "easy" | "normal" | "hard";
    localGameId: string;
    startedAt: number;
    finishedAt: number;
    mode: "offline-ai";
    playerCount: number;
    result: "win" | "loss";
    durationSeconds: number;
    turnCount: number;
}>;
export type OfflineGamePayload = z.infer<typeof offlineGameSchema>;
export declare const syncBatchSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        type: z.ZodEnum<["GAME_RESULT", "SETTINGS_UPDATE", "PROFILE_UPDATE"]>;
        payload: z.ZodUnknown;
    }, "strip", z.ZodTypeAny, {
        type: "GAME_RESULT" | "SETTINGS_UPDATE" | "PROFILE_UPDATE";
        id: string;
        payload?: unknown;
    }, {
        type: "GAME_RESULT" | "SETTINGS_UPDATE" | "PROFILE_UPDATE";
        id: string;
        payload?: unknown;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    items: {
        type: "GAME_RESULT" | "SETTINGS_UPDATE" | "PROFILE_UPDATE";
        id: string;
        payload?: unknown;
    }[];
}, {
    items: {
        type: "GAME_RESULT" | "SETTINGS_UPDATE" | "PROFILE_UPDATE";
        id: string;
        payload?: unknown;
    }[];
}>;
