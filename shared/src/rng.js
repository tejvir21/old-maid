/** Deterministic seedable RNG (mulberry32) – for tests and replays. */
export function seededRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Cryptographically strong RNG when available (server shuffles, room codes). */
export const secureRng = () => {
    const c = globalThis.crypto;
    if (c?.getRandomValues) {
        const buf = new Uint32Array(1);
        c.getRandomValues(buf);
        return (buf[0] ?? 0) / 4294967296;
    }
    return Math.random();
};
export function randomInt(rng, maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError("maxExclusive must be a positive integer");
    }
    return Math.min(maxExclusive - 1, Math.floor(rng() * maxExclusive));
}
