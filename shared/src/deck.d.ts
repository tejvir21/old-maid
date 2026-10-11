import { type Card, type Rng } from "./types.js";
export declare const JOKER_ID = "joker";
export declare function createDeck(): Card[];
/** Fisher–Yates. Returns a new array. */
export declare function shuffleDeck<T>(deck: readonly T[], rng: Rng): T[];
/** Deal one by one around the table. Earlier players get the extra cards. */
export declare function dealCards(deck: readonly Card[], playerCount: number): Card[][];
export declare function cardLabel(card: Card): string;
