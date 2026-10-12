import { AnimatePresence, motion } from "framer-motion";
import { Crown, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { tensionLine, type SeatVM, type TableVM } from "../game/tableVm";
import { Avatar } from "./Avatar";
import { CardBack, CardFace } from "./Card";
import { EventLog } from "./EventLog";
import { PlayerHand } from "./PlayerHand";

export interface GameTableProps {
  vm: TableVM;
  reduce: boolean;
  /** True while a draw request is in flight (offline: reveal playing; online: awaiting server). */
  busy: boolean;
  /** `choice` is an opaque server slot id online, or a positional index string offline. */
  onDraw(targetId: string, choice: string): void;
  header?: ReactNode;
  overlays?: ReactNode;
  banner?: ReactNode;
}

const eligible = (vm: TableVM, s: SeatVM) => !s.isYou && s.cardCount > 0;

function OpponentFan({ n }: { n: number }) {
  const shown = Math.min(n, 8);
  return (
    <div className="flex h-9 items-end justify-center" aria-hidden>
      {Array.from({ length: shown }, (_, i) => <CardBack key={i} size="xs" className={i > 0 ? "-ml-4" : ""} />)}
    </div>
  );
}

function Seat({ s, vm, onPick, compact }: { s: SeatVM; vm: TableVM; onPick(id: string): void; compact?: boolean }) {
  const canPick = vm.canAct && eligible(vm, s);
  const ring = s.isCurrent ? "pulse-ring ring-2 ring-ember" : "ring-1 ring-bone/15";
  const body = (
    <>
      <div className={`relative rounded-full ${ring}`}>
        <Avatar name={s.name} size={compact ? 40 : 52} dim={s.cardCount === 0 && !s.isYou} />
        {s.isHost && <Crown aria-label="Host" className="absolute -right-1 -top-2 h-4 w-4 text-ember" />}
        {!s.isConnected && <WifiOff aria-label="Disconnected" className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-ink p-0.5 text-ember" />}
        <AnimatePresence>
          {s.reaction && (
            <motion.span
              initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-ink/90 px-2 py-0.5 text-xs text-bone ring-1 ring-bone/20"
            >
              …
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <div className={compact ? "min-w-0 flex-1 text-left" : "text-center"}>
        <div className="truncate text-sm font-medium tracking-wide">{s.name}{s.isAi && vm.mode === "online" ? <span className="ml-1 text-[10px] text-dim">AI</span> : null}</div>
        <div className="text-xs text-dim" aria-label={`${s.cardCount} cards`}>{s.cardCount === 0 ? "out" : `${s.cardCount} card${s.cardCount === 1 ? "" : "s"}`}</div>
      </div>
      {!compact && <OpponentFan n={s.cardCount} />}
      {canPick && <span className="mt-1 border border-ember px-3 py-1 text-[11px] uppercase tracking-[0.3em] text-ember">Draw</span>}
    </>
  );
  const cls = compact
    ? "flex w-full items-center gap-3 border border-bone/10 bg-coal/70 px-3 py-2"
    : "flex w-36 flex-col items-center gap-1";
  if (!canPick) {
    return <div data-seat={s.id} className={cls} aria-label={`${s.name}, ${s.cardCount} cards${s.isCurrent ? ", current turn" : ""}`}>{body}</div>;
  }
  return (
    <button type="button" data-seat={s.id} onClick={() => onPick(s.id)} className={`${cls} transition hover:bg-blood/20`} aria-label={`Draw from ${s.name}, ${s.cardCount} cards`}>
      {body}
    </button>
  );
}

/**
 * Draw chooser.
 *
 * Online, `choices` are opaque server-issued slot ids: the React key is the slot id, never an
 * array index or card id, and the DOM exposes no identity at all. The order is re-randomised by
 * the server every turn and framer-motion's `layout` animates the reshuffle so a card visibly
 * moves. Offline, `choices` is positional (`"0"`, `"1"`, …) against the local engine only.
 */
function DrawPanel({ seat, choices, onClose, onDraw, busy, reduce }: {
  seat: SeatVM; choices: string[]; onClose(): void; onDraw(slot: string): void; busy: boolean; reduce: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => { refs.current[0]?.focus(); }, []);
  const n = choices.length;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    const i = refs.current.findIndex((r) => r === document.activeElement);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); refs.current[Math.min(n - 1, i + 1)]?.focus(); }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); refs.current[Math.max(0, i - 1)]?.focus(); }
  };
  return (
    <motion.div
      role="dialog" aria-modal="true" aria-label={`Choose one of ${seat.name}'s cards`}
      initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onKeyDown={onKey}
    >
      <div className="w-full max-w-xl border border-bone/15 bg-coal/95 p-5 shadow-glow">
        <div className="mb-1 flex items-center gap-3"><Avatar name={seat.name} size={36} /><h2 className="title-display text-xl">{seat.name}</h2></div>
        <p className="mb-4 text-xs uppercase tracking-[0.3em] text-dim">Choose one card. You won't know what it is until it's yours.</p>
        {n === 0 && (
          <p className="py-6 text-center text-sm text-dim">
            No cards available from {seat.name} right now.
          </p>
        )}
        <div className="flex flex-wrap justify-center gap-2">
          {choices.map((choice, i) => (
            <motion.button
              key={choice} ref={(el) => { refs.current[i] = el; }} type="button" disabled={busy}
              layout={!reduce}
              onClick={() => onDraw(choice)}
              initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduce ? 0 : i * 0.03 }}
              whileHover={reduce ? undefined : { y: -8 }}
              aria-label={`Card ${i + 1} of ${n}`}
              className="rounded-md hover:shadow-glow disabled:opacity-50"
            >
              <CardBack size="md" />
            </motion.button>
          ))}
        </div>
        <div className="mt-5 flex justify-center"><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
      </div>
    </motion.div>
  );
}

function InfoPanel({ vm, total }: { vm: TableVM; total: number }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border border-bone/10 bg-ink/70 px-3 py-2 text-[10px] uppercase tracking-[0.2em] sm:text-xs" aria-label="Game information">
      <dt className="text-dim">Round</dt><dd>{vm.round}</dd>
      <dt className="text-dim">Players</dt><dd>{vm.playersWithCards} / {total}</dd>
      <dt className="text-dim">Cards left</dt><dd>{vm.cardsRemaining}</dd>
      <dt className="text-dim">Turn</dt><dd className="truncate">{vm.currentName || "—"}</dd>
    </dl>
  );
}

export function GameTable({ vm, reduce, busy, onDraw, header, overlays, banner }: GameTableProps) {
  const [target, setTarget] = useState<string | null>(null);
  const others = useMemo(() => vm.seats.filter((s) => !s.isYou), [vm.seats]);
  const you = vm.seats.find((s) => s.isYou);
  const targetSeat = others.find((s) => s.id === target) ?? null;
  useEffect(() => { if (!vm.canAct || (targetSeat && targetSeat.cardCount === 0)) setTarget(null); }, [vm.canAct, targetSeat]);

  /**
   * Choices offered for `targetSeat`.
   *
   * Online: the server's opaque slots for this turn. Offline: positional, because the whole game
   * is local to this device and there is nothing to protect.
   */
  const choicesFor = (seat: SeatVM): string[] => {
    if (vm.mode === "online") return vm.drawSlots.find((t) => t.targetId === seat.id)?.slots ?? [];
    return Array.from({ length: seat.cardCount }, (_, i) => String(i));
  };

  const n = others.length;
  const pos = (i: number) => {
    const a = ((90 + ((i + 1) * 360) / (n + 1)) * Math.PI) / 180;
    return { left: `${50 + 41 * Math.cos(a)}%`, top: `${48 + 38 * Math.sin(a)}%` };
  };
  const line = vm.finished ? "" : vm.paused ? `Waiting for ${vm.paused.name}…` : tensionLine(vm.round, vm.cardsRemaining);

  return (
    <div className={`room flex min-h-full flex-col ${reduce ? "no-motion" : ""}`}>
      <div className="relative z-10 flex items-start justify-between gap-3 p-3">
        <InfoPanel vm={vm} total={vm.seats.length} />
        <div className="flex flex-col items-end gap-2">{header}</div>
      </div>
      {banner}

      {/* Desktop / tablet: players around the table */}
      <main className="relative z-10 hidden flex-1 md:block" aria-label="Table">
        <div className="relative mx-auto h-full min-h-[26rem] w-full max-w-5xl">
          <div className="felt absolute left-[14%] right-[14%] top-[16%] bottom-[14%] rounded-[50%]" />
          <div className="absolute left-1/2 top-[46%] w-64 -translate-x-1/2 -translate-y-1/2 text-center">
            <p className="title-display text-2xl text-bone/90" aria-live="polite">{line}</p>
            {vm.currentId && !vm.paused && (
              <p className="mt-3 text-xs uppercase tracking-[0.3em] text-dim">{vm.canAct ? "Pick a player" : `${vm.currentName} is choosing`}</p>
            )}
          </div>
          {others.map((s, i) => (
            <div key={s.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={pos(i)}>
              <Seat s={s} vm={vm} onPick={setTarget} />
              {s.debugHand && <DebugHand cards={s.debugHand} />}
            </div>
          ))}
        </div>
      </main>

      {/* Mobile: vertical layout, opponents collapse to rows */}
      <main className="relative z-10 flex flex-1 flex-col gap-2 px-3 md:hidden" aria-label="Table">
        <p className="title-display py-2 text-center text-lg text-bone/90" aria-live="polite">{line}</p>
        <ul className="space-y-2">
          {others.map((s) => (
            <li key={s.id}>
              <Seat s={s} vm={vm} onPick={setTarget} compact />
              {s.debugHand && <DebugHand cards={s.debugHand} />}
            </li>
          ))}
        </ul>
      </main>

      <footer className="relative z-10 mt-auto bg-gradient-to-t from-ink via-ink/90 to-transparent pb-3 pt-2">
        <div className="mx-auto grid max-w-5xl gap-2 px-3 md:grid-cols-[1fr_16rem]">
          <div>
            <div className="mb-1 flex items-center justify-center gap-2 text-sm uppercase tracking-[0.3em]">
              {vm.finished ? null : vm.canAct ? (
                <span className="pulse-ring rounded-full px-3 py-1 text-ember" role="status"><span aria-hidden>● </span>Your turn</span>
              ) : (
                <span className="text-dim" role="status">Current turn: <span className="text-bone">{vm.currentName || "—"}</span></span>
              )}
            </div>
            <PlayerHand cards={vm.myHand} youId={vm.youId} reduce={reduce} />
            {you && <p className="text-center text-[11px] uppercase tracking-[0.3em] text-dim">{you.name} · {you.cardCount} card{you.cardCount === 1 ? "" : "s"}</p>}
          </div>
          <EventLog lines={vm.log} className="hidden h-36 border border-bone/10 bg-ink/70 p-2 md:flex" />
        </div>
        <EventLog lines={vm.log.slice(-4)} className="mx-3 mt-2 h-20 border border-bone/10 bg-ink/70 p-2 md:hidden" />
      </footer>

      <AnimatePresence>
        {targetSeat && vm.canAct && (
          <DrawPanel
            seat={targetSeat} choices={choicesFor(targetSeat)} busy={busy} reduce={reduce}
            onClose={() => setTarget(null)}
            onDraw={(choice) => { setTarget(null); onDraw(targetSeat.id, choice); }}
          />
        )}
      </AnimatePresence>
      {overlays}
    </div>
  );
}

/** Offline debug mode only – the online UI has no code path that can produce this. */
function DebugHand({ cards }: { cards: import("@old-maid/shared").Card[] }) {
  return (
    <div className="mt-1 flex max-w-[11rem] flex-wrap justify-center gap-0.5 border border-dashed border-ember/60 p-1" aria-label="Debug: this player's hand">
      {cards.map((c) => <CardFace key={c.id} card={c} size="xs" />)}
    </div>
  );
}
