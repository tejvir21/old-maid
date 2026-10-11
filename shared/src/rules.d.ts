import type { Card } from "./types.js";
export interface PairResult {
    pairs: [Card, Card][];
    remaining: Card[];
}
/**
 * Splits a hand into rank pairs and leftovers. The Joker never pairs.
 * Three of a rank => one pair + one leftover; four => two pairs.
 */
export declare function findPairs(hand: readonly Card[]): PairResult;
export declare function removePairs(hand: readonly Card[]): Card[];
