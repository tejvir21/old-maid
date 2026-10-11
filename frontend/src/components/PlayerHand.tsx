import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import type { Card } from "@old-maid/shared";
import { CardFace } from "./Card";
import { cardAria } from "./Card";

export function PlayerHand({ cards, youId, reduce }: { cards: Card[]; youId: string; reduce: boolean }) {
  const [lifted, setLifted] = useState<string | null>(null);
  return (
    <section aria-label="Your hand" data-seat={youId} className="w-full">
      <h2 className="mb-1 text-center text-[10px] uppercase tracking-[0.35em] text-dim">Your hand</h2>
      <div className="flex min-h-[6.2rem] items-end justify-center overflow-x-auto px-6 pb-2 pt-4 sm:min-h-[8rem]">
        <AnimatePresence initial={false}>
          {cards.map((c, i) => (
            <motion.button
              key={c.id}
              type="button"
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: lifted === c.id ? -18 : 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -40, scale: 0.9 }}
              transition={{ duration: reduce ? 0 : 0.28 }}
              whileHover={reduce ? undefined : { y: -14, zIndex: 20 }}
              onClick={() => setLifted((p) => (p === c.id ? null : c.id))}
              aria-pressed={lifted === c.id}
              aria-label={`${cardAria(c)}, card ${i + 1} of ${cards.length}`}
              className={`relative shrink-0 rounded-md transition-shadow hover:shadow-glow focus-visible:shadow-glow ${i > 0 ? "-ml-6 sm:-ml-7" : ""} ${lifted === c.id ? "ring-2 ring-ember" : ""}`}
              style={{ zIndex: lifted === c.id ? 30 : i }}
            >
              <CardFace card={c} size="md" />
            </motion.button>
          ))}
        </AnimatePresence>
        {cards.length === 0 && <p className="py-8 text-xs uppercase tracking-[0.3em] text-dim">No cards left</p>}
      </div>
    </section>
  );
}
