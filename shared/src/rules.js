/**
 * Splits a hand into rank pairs and leftovers. The Joker never pairs.
 * Three of a rank => one pair + one leftover; four => two pairs.
 */
export function findPairs(hand) {
    const byRank = new Map();
    const order = [];
    for (const card of hand) {
        if (card.isJoker)
            continue;
        let bucket = byRank.get(card.rank);
        if (!bucket) {
            bucket = [];
            byRank.set(card.rank, bucket);
            order.push(card.rank);
        }
        bucket.push(card);
    }
    const pairs = [];
    const leftovers = [];
    for (const rank of order) {
        const bucket = byRank.get(rank);
        while (bucket.length >= 2) {
            const a = bucket.shift();
            const b = bucket.shift();
            pairs.push([a, b]);
        }
        leftovers.push(...bucket);
    }
    // keep original hand order for the remaining cards
    const leftoverIds = new Set(leftovers.map((c) => c.id));
    const keptInOrder = hand.filter((c) => c.isJoker || leftoverIds.has(c.id));
    return { pairs, remaining: keptInOrder };
}
export function removePairs(hand) {
    return findPairs(hand).remaining;
}
