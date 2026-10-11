export type Suit = "hearts" | "diamonds" | "clubs" | "spades";
export declare const SUITS: readonly Suit[];
export declare const RANKS: readonly ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
export type NormalRank = (typeof RANKS)[number];
export interface Card {
    id: string;
    rank: string;
    suit?: Suit;
    isJoker: boolean;
}
export type AiLevel = "easy" | "normal" | "hard";
export type PlayerKind = "human" | "ai";
/** Authoritative per-player engine state. Never sent to other clients as-is. */
export interface EnginePlayer {
    id: string;
    name: string;
    kind: PlayerKind;
    aiLevel?: AiLevel;
    hand: Card[];
}
export type GamePhase = "playing" | "finished";
export interface GameState {
    players: EnginePlayer[];
    currentPlayerIndex: number;
    /** Increments every time the turn passes; used for duplicate-action protection. */
    turnId: number;
    /** Number of draws performed so far. */
    drawCount: number;
    phase: GamePhase;
    winnerId: string | null;
    /** Pairs removed from the game (each pair = 2 cards). Rank is not recorded publicly. */
    discardedPairs: number;
    eventSeq: number;
}
export type GameEventType = "game_started" | "initial_pairs" | "turn_changed" | "card_drawn" | "pair_formed" | "player_out" | "game_over";
/** Public event: contains NO hidden card identities. */
export interface GameEvent {
    seq: number;
    turnId: number;
    type: GameEventType;
    actorId?: string;
    targetId?: string;
    /** Index the actor picked in the target's hand (public – harmless). */
    cardIndex?: number;
    /** Hand size of actor / target *before* the draw (needed by AI memory). */
    actorCountBefore?: number;
    targetCountBefore?: number;
    pairFormed?: boolean;
    text: string;
}
export type EngineErrorCode = "GAME_NOT_ACTIVE" | "NOT_YOUR_TURN" | "STALE_TURN" | "UNKNOWN_PLAYER" | "INVALID_TARGET" | "TARGET_IS_SELF" | "TARGET_EMPTY" | "INVALID_CARD_INDEX";
export interface DrawResult {
    actorId: string;
    targetId: string;
    cardIndex: number;
    /** Private to the actor (and revealed to the AI actor itself). */
    card: Card;
    pairFormed: boolean;
    /** Private to the actor. */
    pairCards: [Card, Card] | null;
    targetOut: boolean;
    actorOut: boolean;
    gameOver: boolean;
}
export type EngineResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: EngineErrorCode;
    message: string;
};
export type Rng = () => number;
