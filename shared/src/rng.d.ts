import type { Rng } from "./types.js";
/** Deterministic seedable RNG (mulberry32) – for tests and replays. */
export declare function seededRng(seed: number): Rng;
/** Cryptographically strong RNG when available (server shuffles, room codes). */
export declare const secureRng: Rng;
export declare function randomInt(rng: Rng, maxExclusive: number): number;
