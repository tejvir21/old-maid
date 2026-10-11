import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { Card } from "@old-maid/shared";
import type { FlyState, RevealState } from "../store/ui";
import { playSound } from "../sound/sound";
import { cardAria, CardBack, CardFace, FlipCard, SUIT_GLYPH } from "./Card";
import type { TableVM } from "../game/tableVm";

/** The card you just took: it travels to your hand, flips, and any pair is discarded. */
export function DrawReveal({ reveal, reduce, onDone }: { reveal: RevealState | null; reduce: boolean; onDone(): void }) {
  const [flipped, setFlipped] = useState(false);
  const [paired, setPaired] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  const joker = reveal?.card.isJoker ?? false;

  useEffect(() => {
    if (!reveal) return;
    setFlipped(false);
    setPaired(false);
    playSound("card-draw");
    const t: ReturnType<typeof setTimeout>[] = [];
    const k = reduce ? 0.35 : 1;
    t.push(setTimeout(() => { setFlipped(true); playSound(reveal.card.isJoker ? "joker-reveal" : "card-flip"); }, 450 * k));
    if (reveal.pairFormed) t.push(setTimeout(() => { setPaired(true); playSound("pair"); }, 1500 * k));
    t.push(setTimeout(() => done.current(), (joker ? 3200 : reveal.pairFormed ? 2600 : 1900) * k));
    return () => t.forEach(clearTimeout);
  }, [reveal?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AnimatePresence>
      {reveal && (
        <motion.div
          key={reveal.key} role="dialog" aria-modal="true" aria-live="assertive"
          aria-label={`You drew ${cardAria(reveal.card)}${reveal.pairFormed ? ", forming a pair" : ""}`}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onDone}
          className={`fixed inset-0 z-50 flex cursor-pointer flex-col items-center justify-center gap-5 backdrop-blur-sm ${joker ? "bg-black/90" : "bg-black/75"}`}
        >
          {joker && flipped && (
            <motion.p initial={reduce ? false : { opacity: 0, scale: 0.8, letterSpacing: "0.1em" }} animate={{ opacity: 1, scale: 1, letterSpacing: "0.5em" }} transition={{ duration: reduce ? 0 : 1.1 }} className="title-display text-4xl text-ember sm:text-6xl">
              The Joker
            </motion.p>
          )}
          <div className="relative flex items-center gap-4">
            <motion.div
              animate={paired ? { x: 70, opacity: 0.0, scale: 0.8 } : { x: 0, opacity: 1, scale: 1 }}
              transition={{ duration: reduce ? 0 : 0.6 }}
              className="z-10"
            >
              <FlipCard card={reveal.card} flipped={flipped} reduce={reduce} />
            </motion.div>
            {reveal.pairFormed && reveal.pairCards && (
              <motion.div animate={paired ? { x: -70, opacity: 0, scale: 0.8 } : { opacity: 1, x: 0 }} transition={{ duration: reduce ? 0 : 0.6 }}>
                <CardFace card={otherOf(reveal.pairCards, reveal.card)} size="lg" />
              </motion.div>
            )}
          </div>
          <p className="text-center text-sm uppercase tracking-[0.3em] text-bone">
            {flipped ? <>You drew <span className="text-ember">{cardAria(reveal.card)}</span> from {reveal.fromName}</> : <>Taking a card from {reveal.fromName}…</>}
          </p>
          {flipped && reveal.pairFormed && <p className="text-xs uppercase tracking-[0.35em] text-dim">{paired ? "Pair discarded." : "A pair."}</p>}
          {flipped && joker && <p className="text-xs uppercase tracking-[0.35em] text-dim">Keep it. Whoever holds it at the end wins.</p>}
          <p className="text-[10px] uppercase tracking-[0.3em] text-dim/70">Tap to continue</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
const otherOf = (pair: [Card, Card], drawn: Card): Card => (pair[0].id === drawn.id ? pair[1] : pair[0]);

/** A card back that visibly travels from the seat it was taken from to the seat that took it. */
export function FlyingCard({ fly, reduce }: { fly: FlyState | null; reduce: boolean }) {
  const [path, setPath] = useState<{ key: number; from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  useEffect(() => {
    if (!fly || reduce) { setPath(null); return; }
    const centre = (id: string) => {
      const el = document.querySelector(`[data-seat="${CSS.escape(id)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const from = centre(fly.fromId), to = centre(fly.toId);
    if (!from || !to) { setPath(null); return; }
    setPath({ key: fly.key, from, to });
    const t = setTimeout(() => setPath(null), 800);
    return () => clearTimeout(t);
  }, [fly?.key, reduce]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AnimatePresence>
      {path && (
        <motion.div
          key={path.key} aria-hidden className="pointer-events-none fixed left-0 top-0 z-30"
          initial={{ x: path.from.x - 14, y: path.from.y - 20, rotate: -8, opacity: 1 }}
          animate={{ x: path.to.x - 14, y: path.to.y - 20, rotate: 6, opacity: 0.9 }}
          exit={{ opacity: 0 }} transition={{ duration: 0.6, ease: "easeInOut" }}
        >
          <CardBack size="sm" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export interface GameOverProps {
  vm: TableVM;
  reduce: boolean;
  primary: { label: string; onClick(): void; disabled?: boolean };
  secondary: { label: string; onClick(): void };
  note?: string;
}

/** ONE CARD REMAINS → THE FINAL CARD → THE JOKER WAS HELD BY → verdict. The holder wins; everyone else loses. */
export function GameOverOverlay({ vm, reduce, primary, secondary, note }: GameOverProps) {
  const [stage, setStage] = useState(reduce ? 3 : 0);
  useEffect(() => {
    if (reduce) { setStage(3); return; }
    const ts = [setTimeout(() => { setStage(1); playSound("joker-reveal"); }, 1100), setTimeout(() => setStage(2), 2900), setTimeout(() => { setStage(3); playSound(vm.youWon ? "victory" : "game-over"); }, 4300)];
    return () => ts.forEach(clearTimeout);
  }, [reduce, vm.youWon]);

  const joker: Card = { id: "joker", rank: "JOKER", isJoker: true };
  return (
    <motion.div
      role="dialog" aria-modal="true" aria-label="Game over" aria-live="polite"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduce ? 0 : 1.2 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 overflow-y-auto bg-black/95 p-6 text-center"
    >
      {!vm.abandoned && stage === 0 && <p className="title-display text-3xl text-bone/80">One card remains.</p>}
      {!vm.abandoned && stage >= 1 && (
        <>
          <p className="text-xs uppercase tracking-[0.45em] text-dim">The final card</p>
          <FlipCard card={joker} flipped={stage >= 1} reduce={reduce} />
          <p className="title-display text-3xl text-ember">The Joker</p>
        </>
      )}
      {!vm.abandoned && stage >= 2 && (
        <motion.div initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <p className="text-xs uppercase tracking-[0.45em] text-dim">The Joker was held by</p>
          <p className="title-display mt-2 text-5xl text-bone sm:text-6xl">{vm.winnerName}</p>
        </motion.div>
      )}
      {vm.abandoned && (
        <div>
          <p className="title-display text-4xl text-bone">The match was ended</p>
          <p className="mt-3 text-sm uppercase tracking-[0.3em] text-dim">No winner was declared.</p>
        </div>
      )}
      {stage >= 3 && (
        <motion.div initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduce ? 0 : 0.9 }} className="flex flex-col items-center gap-4">
          {!vm.abandoned && (
            <>
              <p className={`title-display text-5xl sm:text-6xl ${vm.youWon ? "text-bone" : "text-blood"}`}>{vm.youWon ? "Game cleared" : "Game over"}</p>
              <p className="text-sm uppercase tracking-[0.3em]">{vm.youWon ? "You won." : "You lost."}</p>
              <p className="text-xs uppercase tracking-[0.3em] text-dim">
                {vm.youWon ? "You held the Joker until the end." : "The Joker was not yours."}
              </p>
              <p className="text-[11px] uppercase tracking-[0.4em] text-ember">The Joker has chosen its holder.</p>
              <ul className="mt-1 grid w-full max-w-xs gap-1 text-left text-xs" aria-label="Results">
                {vm.seats.map((s) => (
                  <li key={s.id} className="flex justify-between border-b border-bone/10 py-1">
                    <span>{s.name}{s.isYou ? " (you)" : ""}</span>
                    <span className={s.id === vm.winnerId ? "text-ember" : "text-dim"}>{s.id === vm.winnerId ? "WINNER" : "LOSER"}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {note && <p className="max-w-xs text-xs text-dim">{note}</p>}
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            <button type="button" className="btn btn-primary" onClick={primary.onClick} disabled={primary.disabled} autoFocus>{primary.label}</button>
            <button type="button" className="btn" onClick={secondary.onClick}>{secondary.label}</button>
          </div>
        </motion.div>
      )}
      {stage < 3 && !vm.abandoned && (
        <button type="button" className="mt-4 text-[11px] uppercase tracking-[0.3em] text-dim underline" onClick={() => setStage(3)}>Skip</button>
      )}
    </motion.div>
  );
}

export { SUIT_GLYPH };
