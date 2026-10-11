import { motion } from "framer-motion";
import type { CSSProperties } from "react";
import type { Card as CardT, Suit } from "@old-maid/shared";
import { useSettingsStore } from "../store/ui";

export const SUIT_GLYPH: Record<Suit, string> = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
const RANK_NAME: Record<string, string> = { A: "Ace", J: "Jack", Q: "Queen", K: "King" };

export function cardAria(c: CardT): string {
  if (c.isJoker) return "Joker";
  return `${RANK_NAME[c.rank] ?? c.rank} of ${c.suit}`;
}

export type CardSize = "xs" | "sm" | "md" | "lg";
const SIZE: Record<CardSize, string> = {
  xs: "w-7 h-10 rounded-[3px] text-[9px]",
  sm: "w-10 h-14 rounded-[4px] text-xs",
  md: "w-[3.9rem] h-[5.6rem] sm:w-20 sm:h-28 rounded-md text-base",
  lg: "w-28 h-40 sm:w-32 sm:h-44 rounded-lg text-xl",
};

const isRed = (s?: Suit) => s === "hearts" || s === "diamonds";

export function CardFace({ card, size = "md", className = "" }: { card: CardT; size?: CardSize; className?: string }) {
  const style = useSettingsStore((s) => s.values.cardStyle);
  const red = isRed(card.suit);
  const ink = card.isJoker ? "text-blood" : red ? "text-[#b3202c]" : "text-[#16161a]";
  return (
    <div
      data-face="front"
      data-card={card.id}
      className={`relative select-none bg-[#e6e0d3] ${ink} shadow-[0_6px_18px_rgba(0,0,0,0.55)] ring-1 ring-black/40 ${SIZE[size]} ${className}`}
      role="img"
      aria-label={cardAria(card)}
    >
      {card.isJoker ? (
        <div className="flex h-full flex-col items-center justify-between py-[8%]">
          <span className="font-display font-bold tracking-[0.2em] [font-size:0.7em]">JOKER</span>
          <span className="[font-size:2.2em] leading-none" aria-hidden>🃏</span>
          <span className="font-display font-bold tracking-[0.2em] [font-size:0.7em] rotate-180">JOKER</span>
        </div>
      ) : (
        <>
          <div className="absolute left-[8%] top-[5%] flex flex-col items-center leading-none font-bold">
            <span>{card.rank}</span>
            <span className="[font-size:0.85em]">{SUIT_GLYPH[card.suit as Suit]}</span>
          </div>
          <div className={`absolute inset-0 flex items-center justify-center leading-none ${style === "minimal" ? "[font-size:1.6em] opacity-80" : "[font-size:2.8em]"}`} aria-hidden>
            {SUIT_GLYPH[card.suit as Suit]}
          </div>
          <div className="absolute bottom-[5%] right-[8%] flex rotate-180 flex-col items-center leading-none font-bold">
            <span>{card.rank}</span>
            <span className="[font-size:0.85em]">{SUIT_GLYPH[card.suit as Suit]}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function CardBack({ size = "md", className = "", style }: { size?: CardSize; className?: string; style?: CSSProperties }) {
  return (
    <div
      data-face="back"
      className={`card-back select-none shadow-[0_6px_18px_rgba(0,0,0,0.55)] ${SIZE[size]} ${className}`}
      style={style}
      role="img"
      aria-label="Face-down card"
    />
  );
}

/** A card that physically flips from back to front (rotateY). */
export function FlipCard({ card, size = "lg", flipped, reduce, delay = 0 }: { card: CardT; size?: CardSize; flipped: boolean; reduce: boolean; delay?: number }) {
  return (
    <div className="[perspective:900px]">
      <motion.div
        className="relative [transform-style:preserve-3d]"
        initial={false}
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.7, delay, ease: "easeInOut" }}
      >
        <div className="[backface-visibility:hidden]"><CardBack size={size} /></div>
        <div className="absolute inset-0 [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <CardFace card={card} size={size} />
        </div>
      </motion.div>
    </div>
  );
}
