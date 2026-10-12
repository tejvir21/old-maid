import { Crown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "zustand";
import type { AiLevel } from "@old-maid/shared";
import { useServices } from "../app/context";
import { Avatar } from "../components/Avatar";
import { ChatPanel } from "../components/ChatPanel";
import { GameTable } from "../components/GameTable";
import { DrawReveal, FlyingCard, GameOverOverlay } from "../components/Overlays";
import { Page, Segmented, Toggle } from "../components/Page";
import { NetBadge } from "../components/StatusBar";
import { onlineVm } from "../game/tableVm";
import { useReducedMotion } from "../hooks/useMotion";
import { cardAria } from "../components/Card";
import { playSound } from "../sound/sound";
import type { OnlineController } from "../store/onlineStore";

const CONN = { connected: "● Connected", connecting: "○ Connecting…", reconnecting: "○ Reconnecting…", disconnected: "× Disconnected" } as const;

export function OnlineRoom() {
  const svc = useServices();
  const nav = useNavigate();
  const ctl = svc.online;
  const view = useStore(ctl.store, (s) => s.view);
  useEffect(() => { if (!view) nav("/online", { replace: true }); }, [view, nav]);
  if (!view) return null;
  return view.status === "waiting" ? <Lobby ctl={ctl} /> : <OnlineGame ctl={ctl} />;
}

function Lobby({ ctl }: { ctl: OnlineController }) {
  const nav = useNavigate();
  const view = useStore(ctl.store, (s) => s.view)!;
  const conn = useStore(ctl.store, (s) => s.conn);
  const error = useStore(ctl.store, (s) => s.error);
  const notices = useStore(ctl.store, (s) => s.notices);
  const [fill, setFill] = useState(false);
  const [level, setLevel] = useState<AiLevel>("normal");
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const total = fill ? view.maxPlayers : view.players.length;
  const canStart = view.isHost && total >= view.minPlayers && conn === "connected";
  const invite = `Join my Old Maid game!\n\nRoom Code: ${view.roomCode}`;
  const copy = async (what: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500); } catch { setCopied("failed"); }
  };
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <Page title="Lobby" back={false}>
      <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-[0.25em]">
        <span className={conn === "connected" ? "" : "text-ember"} role="status">{CONN[conn]}</span>
        <NetBadge />
      </div>
      <section aria-label="Room code" className="my-4 border border-bone/15 bg-coal/70 p-5 text-center">
        <p className="text-[10px] uppercase tracking-[0.4em] text-dim">Room code</p>
        <p className="title-display my-2 text-6xl tracking-[0.3em] text-bone" aria-label={`Room code ${view.roomCode.split("").join(" ")}`}>{view.roomCode}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className="btn !min-h-[44px]" onClick={() => void copy("code", view.roomCode)}>{copied === "code" ? "Copied" : "Copy room code"}</button>
          <button type="button" className="btn !min-h-[44px]" onClick={() => void copy("msg", invite)}>{copied === "msg" ? "Copied" : "Copy invite message"}</button>
          {canShare && <button type="button" className="btn !min-h-[44px]" onClick={() => void navigator.share({ title: "Old Maid", text: invite }).catch(() => undefined)}>Share room</button>}
        </div>
        <p className="mt-3 text-xs text-dim">Share this code with your friends.</p>
      </section>

      <section aria-label="Players">
        <h2 className="mb-2 text-xs uppercase tracking-[0.3em] text-dim">Players</h2>
        <ul className="space-y-1">
          {view.players.map((p) => (
            <li key={p.id} className="flex items-center gap-3 border border-bone/10 bg-coal/50 px-3 py-2">
              <Avatar name={p.name} size={34} dim={!p.isConnected} />
              <span className="flex-1 truncate">{p.name}{p.id === view.you ? " (you)" : ""}</span>
              {p.isHost && <span className="flex items-center gap-1 text-[11px] uppercase tracking-[0.2em] text-ember"><Crown className="h-3.5 w-3.5" aria-hidden />Host</span>}
              <span className={`text-[11px] ${p.isConnected ? "text-dim" : "text-ember"}`} aria-label={p.isConnected ? "Connected" : "Disconnected"}>{p.isConnected ? "●" : "○ away"}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-dim" aria-live="polite">{view.players.length} / {view.maxPlayers} players{fill && view.isHost ? ` + ${view.maxPlayers - view.players.length} AI` : ""}</p>
      </section>

      {view.isHost ? (
        <section className="mt-4" aria-label="Host controls">
          <Toggle label="Fill remaining slots with AI" hint={`${view.players.length} friends + ${view.maxPlayers - view.players.length} AI = ${view.maxPlayers} players`} checked={fill} onChange={setFill} />
          {fill && <Segmented<AiLevel> label="AI difficulty" value={level} onChange={setLevel} options={[{ value: "easy", label: "Easy" }, { value: "normal", label: "Normal" }, { value: "hard", label: "Hard" }]} />}
          {total < view.minPlayers && <p className="mt-3 text-sm text-ember" role="status">At least {view.minPlayers} players are required.</p>}
          {error && <p role="alert" className="mt-3 text-sm text-ember">{error}</p>}
          <button type="button" className="btn btn-primary mt-4 w-full" disabled={!canStart || busy} onClick={() => { setBusy(true); void ctl.start(fill, level).finally(() => setBusy(false)); }}>Start game</button>
        </section>
      ) : (
        <p className="mt-6 text-center text-sm uppercase tracking-[0.3em] text-dim" role="status">Waiting for host…</p>
      )}

      <ChatPanel ctl={ctl} className="mt-6 h-56" />
      <ul className="mt-3 space-y-1 text-xs text-dim" aria-live="polite">{notices.slice(-3).map((n) => <li key={n.id}>{n.message}</li>)}</ul>
      <button type="button" className="btn mt-6 w-full" onClick={() => void ctl.leave().then(() => nav("/online"))}>Leave room</button>
    </Page>
  );
}

function useSecondsLeft(initial: number | null, key: unknown): number | null {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    setLeft(initial);
    if (initial === null) return;
    const t0 = Date.now();
    const iv = setInterval(() => setLeft(Math.max(0, initial - Math.floor((Date.now() - t0) / 1000))), 500);
    return () => clearInterval(iv);
  }, [initial, key]);
  return left;
}

function OnlineGame({ ctl }: { ctl: OnlineController }) {
  const nav = useNavigate();
  const reduce = useReducedMotion();
  const view = useStore(ctl.store, (s) => s.view)!;
  const conn = useStore(ctl.store, (s) => s.conn);
  const revealed = useStore(ctl.store, (s) => s.revealed);
  const lastDraw = useStore(ctl.store, (s) => s.lastDraw);
  const pending = useStore(ctl.store, (s) => s.pendingDraw);
  const error = useStore(ctl.store, (s) => s.error);
  const notices = useStore(ctl.store, (s) => s.notices);
  const drawSlots = useStore(ctl.store, (s) => s.drawSlots);
  const slotsTurnId = useStore(ctl.store, (s) => s.slotsTurnId);
  const [privateLog, setPrivateLog] = useState<{ id: number; text: string }[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const seq = useRef(0);

  // Private lines come ONLY from what the server told this player ("you drew …").
  useEffect(() => {
    if (!revealed) return;
    const from = view.players.find((p) => p.id === revealed.fromPlayerId)?.name ?? "someone";
    setPrivateLog((l) => [...l, { id: ++seq.current, text: `You drew ${cardAria(revealed.card)} from ${from}.` }, ...(revealed.pairFormed ? [{ id: ++seq.current, text: "Pair formed and discarded." }] : [])].slice(-20));
  }, [revealed?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const pausedSecs = useSecondsLeft(view.game?.paused?.secondsLeft ?? null, view.game?.paused?.playerId);
  const vm0 = useMemo(
    () => onlineVm(view, privateLog, pausedSecs, view.game && view.game.turnId === slotsTurnId ? drawSlots : []),
    [view, privateLog, pausedSecs, drawSlots, slotsTurnId],
  );
  const blocked = !!revealed || pending || conn !== "connected";
  const vm = { ...vm0, canAct: vm0.canAct && !blocked };
  useEffect(() => { if (vm.canAct) playSound("turn"); }, [vm.canAct]);

  const fly = useMemo(() => (lastDraw ? { fromId: lastDraw.targetId, toId: lastDraw.actorId, key: lastDraw.seq } : null), [lastDraw]);
  const reveal = revealed && { card: revealed.card, pairFormed: revealed.pairFormed, pairCards: revealed.pairCards, fromName: view.players.find((p) => p.id === revealed.fromPlayerId)?.name ?? "", key: revealed.at };
  const leave = async () => { await ctl.leave(); nav("/online"); };
  const showOver = vm.finished && !revealed;

  return (
    <GameTable
      vm={vm} reduce={reduce} busy={blocked}
      onDraw={(id, i) => void ctl.draw(id, i)}
      header={
        <>
          <NetBadge />
          <button type="button" className="btn !min-h-[40px] !px-3 !tracking-[0.15em]" onClick={() => setChatOpen((o) => !o)} aria-expanded={chatOpen}>Chat</button>
          {!vm.finished && <button type="button" className="btn !min-h-[40px] !px-3 !tracking-[0.15em]" onClick={() => { if (confirm("Leave this game? An AI will take your seat.")) void leave(); }}>Leave</button>}
        </>
      }
      banner={
        <div className="relative z-20 space-y-1 px-3">
          {conn !== "connected" && <p role="alert" className="border border-ember bg-blood/30 px-3 py-2 text-center text-xs uppercase tracking-[0.25em]">{conn === "reconnecting" ? "Connection lost — reconnecting…" : conn === "connecting" ? "Connecting…" : "Disconnected"}</p>}
          {vm.paused && (
            <div role="alert" className="border border-ember/60 bg-ink/90 px-3 py-2 text-center text-xs uppercase tracking-[0.25em]">
              <p>Waiting for {vm.paused.name} to reconnect… {vm.paused.secondsLeft > 0 ? <span className="tabular-nums text-ember">{vm.paused.secondsLeft}</span> : null}</p>
              {vm.paused.secondsLeft === 0 && <p className="mt-1 text-dim normal-case tracking-normal">The game stays paused until they return{view.isHost ? " or you end the match." : " or the host ends the match."}</p>}
              {view.isHost && vm.paused.secondsLeft === 0 && <button type="button" className="btn mt-2 !min-h-[40px]" onClick={() => { if (confirm("End the match with no winner?")) void ctl.endMatch(); }}>End match</button>}
            </div>
          )}
          {error && <p role="status" className="text-center text-xs text-ember">{error}</p>}
          {notices.slice(-1).map((n) => <p key={n.id} role="status" className="text-center text-xs text-dim">{n.message}</p>)}
        </div>
      }
      overlays={
        <>
          <FlyingCard fly={fly} reduce={reduce} />
          <DrawReveal reveal={reveal ?? null} reduce={reduce} onDone={() => ctl.clearReveal()} />
          {chatOpen && <div className="fixed bottom-24 right-3 z-30 w-72 max-w-[calc(100vw-1.5rem)] shadow-glow"><ChatPanel ctl={ctl} className="h-64" /></div>}
          {showOver && (
            <GameOverOverlay
              vm={vm} reduce={reduce}
              primary={view.isHost ? { label: "Play again", onClick: () => void ctl.rematch() } : { label: "Waiting for host…", onClick: () => undefined, disabled: true }}
              secondary={{ label: "Leave room", onClick: () => void leave() }}
              note={vm.abandoned ? "The host ended the match." : "Rematch returns everyone to the lobby."}
            />
          )}
        </>
      }
    />
  );
}
