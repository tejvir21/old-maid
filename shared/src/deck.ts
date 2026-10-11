import { RANKS, SUITS, type Card, type Rng } from "./types.js";
import { randomInt } from "./rng.js";

export const JOKER_ID = "joker";

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${rank}-${suit}`, rank, suit, isJoker: false });
    }
  }
  deck.push({ id: JOKER_ID, rank: "JOKER", isJoker: true });
  return deck;
}

/** Fisher–Yates. Returns a new array. */
export function shuffleDeck<T>(deck: readonly T[], rng: Rng): T[] {
  const out = [...deck];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/** Deal one by one around the table. Earlier players get the extra cards. */
export function dealCards(deck: readonly Card[], playerCount: number): Card[][] {
  if (!Number.isInteger(playerCount) || playerCount < 1) throw new RangeError("playerCount must be >= 1");
  const hands: Card[][] = Array.from({ length: playerCount }, () => []);
  deck.forEach((card, i) => {
    (hands[i % playerCount] as Card[]).push(card);
  });
  return hands;
}

export function cardLabel(card: Card): string {
  if (card.isJoker) return "Joker";
  const sym = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" }[card.suit as string] ?? "?";
  return `${card.rank}${sym}`;
}
