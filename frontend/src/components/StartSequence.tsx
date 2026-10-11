import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { CardBack } from "./Card";
import { playSound } from "../sound/sound";

const WORDS = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN"];

/** SEVEN PLAYERS · ONE JOKER → SHUFFLING… → dealing → pairs discarded → THE GAME BEGINS. Game logic has already run; this is presentation. */
export function StartSequence({ names, finalCounts, reduce, onDone }: { names: string[]; finalCounts: number[]; reduce: boolean; onDone(): void }) {
  const n = names.length;
  const dealt = names.map((_, i) => Math.floor(53 / n) + (i < 53 % n ? 1 : 0));
  const [stage, setStage] = useState<"intro" | "shuffle" | "deal" | "pairs" | "begin">("intro");
  const [counts, setCounts] = useState<number[]>(names.map(() => 0));

  useEffect(() => {
    const k = reduce ? 0.25 : 1;
    const t: ReturnType<typeof setTimeout>[] = [];
    t.push(setTimeout(() => { setStage("shuffle"); playSound("card-flip"); }, 2300 * k));
    t.push(setTimeout(() => setStage("deal"), 3800 * k));
    t.push(setTimeout(() => { setStage("pairs"); setCounts(finalCounts); playSound("pair"); }, 3800 * k + (reduce ? 200 : dealt[0]! * n * 22 + 700)));
    t.push(setTimeout(() => setStage("begin"), 3800 * k + (reduce ? 400 : dealt[0]! * n * 22 + 2100)));
    t.push(setTimeout(onDone, 3800 * k + (reduce ? 700 : dealt[0]! * n * 22 + 3300)));
    return () => t.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (stage !== "deal") return;
    if (reduce) { setCounts(dealt); return; }
    let given = 0;
    const total = 53;
    const iv = setInterval(() => {
      given += 1;
      setCounts(names.map((_, i) => Math.floor(given / n) + (i < given % n ? 1 : 0)));
      if (given % 3 === 0) playSound("card-draw");
      if (given >= total) clearInterval(iv);
    }, 22);
    return () => clearInterval(iv);
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div role="dialog" aria-modal="true" aria-live="polite" aria-label="Game starting" className="fixed inset-0 z-50 flex cursor-pointer flex-col items-center justify-center gap-6 bg-black p-6 text-center" onClick={onDone}>
      <AnimatePresence mode="wait">
        {stage === "intro" && (
          <motion.div key="i" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
            <p className="title-display text-4xl sm:text-6xl">{WORDS[n] ?? n} players</p>
            <p className="title-display text-4xl text-ember sm:text-6xl">One Joker</p>
            <p className="title-display text-2xl text-dim sm:text-3xl">Only one can win</p>
          </motion.div>
        )}
        {stage === "shuffle" && (
          <motion.div key="s" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-6">
            <div className="relative mx-auto h-28 w-24">
              {[0, 1, 2, 3].map((i) => (
                <motion.div key={i} className="absolute inset-0" animate={reduce ? undefined : { x: [0, i % 2 ? 26 : -26, 0], rotate: [0, i % 2 ? 9 : -9, 0] }} transition={{ repeat: Infinity, duration: 0.5, delay: i * 0.08 }}>
                  <CardBack size="md" />
                </motion.div>
              ))}
            </div>
            <p className="title-display text-3xl tracking-[0.4em]">Shuffling…</p>
          </motion.div>
        )}
        {(stage === "deal" || stage === "pairs") && (
          <motion.div key="d" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-5">
            <p className="text-xs uppercase tracking-[0.4em] text-dim">{stage === "deal" ? "Dealing" : "Matching pairs are discarded"}</p>
            <ul className="flex max-w-xl flex-wrap justify-center gap-4">
              {names.map((nm, i) => (
                <li key={nm + i} className="flex w-20 flex-col items-center gap-1">
                  <Avatar name={nm} size={44} />
                  <span className="truncate text-xs">{nm}</span>
                  <span className="text-lg tabular-nums">{counts[i]}</span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
        {stage === "begin" && (
          <motion.p key="b" initial={{ opacity: 0, letterSpacing: "0.1em" }} animate={{ opacity: 1, letterSpacing: "0.45em" }} transition={{ duration: reduce ? 0 : 0.9 }} className="title-display text-4xl text-ember sm:text-5xl">
            The game begins
          </motion.p>
        )}
      </AnimatePresence>
      <p className="absolute bottom-6 text-[10px] uppercase tracking-[0.3em] text-dim/60">Tap to skip</p>
    </div>
  );
}
