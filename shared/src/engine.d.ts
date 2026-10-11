import type { AiLevel, DrawResult, EnginePlayer, EngineResult, GameEvent, GameState, PlayerKind, Rng } from "./types.js";
export interface PlayerSeed {
    id: string;
    name: string;
    kind: PlayerKind;
    aiLevel?: AiLevel;
}
export interface StartResult {
    state: GameState;
    events: GameEvent[];
}
export declare function totalCards(state: GameState): number;
export declare function getJokerHolder(state: GameState): EnginePlayer | null;
/** The game ends exactly when the Joker is the only card left in play. */
export declare function isGameOver(state: GameState): boolean;
export declare function getWinner(state: GameState): EnginePlayer | null;
/** Clockwise next player (after `fromIndex`) who still has cards. -1 if none. */
export declare function nextPlayer(state: GameState, fromIndex: number): number;
export declare function getEligibleTargets(state: GameState, playerId: string): EnginePlayer[];
export declare function getCurrentPlayer(state: GameState): EnginePlayer;
/**
 * Creates a game: deck → shuffle → deal → discard initial pairs → first turn.
 * `firstPlayerIndex` defaults to a random seat.
 */
export declare function createGame(seeds: readonly PlayerSeed[], rng: Rng, firstPlayerIndex?: number): StartResult;
export interface DrawRequest {
    actorId: string;
    targetId: string;
    cardIndex: number;
    /** If supplied, must equal state.turnId (duplicate / stale-action guard). */
    turnId?: number;
}
export interface DrawOutcome {
    state: GameState;
    events: GameEvent[];
    result: DrawResult;
}
/** Pure: validates, performs one draw, removes pairs, checks the end, advances the turn. */
export declare function drawCard(prev: GameState, req: DrawRequest): EngineResult<DrawOutcome>;
/** Throws if any engine invariant is broken. Used by the server after every action and in tests. */
export declare function assertInvariants(state: GameState): void;
