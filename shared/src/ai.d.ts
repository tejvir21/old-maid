import type { AiLevel, Card, GameEvent, GameState, Rng } from "./types.js";
/** Tunable AI parameters (also editable by admins). All values 0..1 except delay. */
export interface AiConfig {
    level: AiLevel;
    aggressiveness: number;
    memory: number;
    /** Min/max "thinking" delay in ms. */
    delayMinMs: number;
    delayMaxMs: number;
}
export declare const AI_PRESETS: Record<AiLevel, AiConfig>;
export declare function aiConfigFor(level: AiLevel, overrides?: Partial<AiConfig>): AiConfig;
export declare function aiDelay(config: AiConfig, rng: Rng): number;
/** What the AI remembers about another player's hand. Built ONLY from information it legitimately saw. */
export interface KnownCard {
    cardId: string;
    rank: string;
    isJoker: boolean;
    /** Position in the owner's hand, or null if it has become uncertain. */
    index: number | null;
}
export interface AiMemory {
    known: Record<string, KnownCard[]>;
}
export declare function newMemory(): AiMemory;
/**
 * Update memory after a public draw event.
 * `ownCard` is supplied ONLY when the AI itself was the actor (the card it drew)
 * or the target (the card that was taken from it) – both legitimately known to it.
 */
export declare function observeDraw(memory: AiMemory, selfId: string, ev: GameEvent, ownCard?: Card): AiMemory;
export interface AiView {
    selfId: string;
    hand: readonly Card[];
    players: readonly {
        id: string;
        cardCount: number;
    }[];
}
export declare function viewFor(state: GameState, selfId: string): AiView;
export interface AiMove {
    targetId: string;
    cardIndex: number;
}
/**
 * Chooses a draw. Win condition: hold the Joker when the last pair disappears.
 *  - Non-holders hunt the Joker and avoid helping the game end by pairing.
 *  - The holder looks for pairs (to end the game) and otherwise plays randomly.
 */
export declare function chooseMove(view: AiView, memory: AiMemory, config: AiConfig, rng: Rng): AiMove;
