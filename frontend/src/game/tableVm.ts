import type { Card, PlayerView } from "@old-maid/shared";
import { HUMAN_ID, type OfflineGame } from "./offlineGame";

export interface SeatVM {
  id: string;
  name: string;
  cardCount: number;
  isYou: boolean;
  isCurrent: boolean;
  isConnected: boolean;
  isHost: boolean;
  isAi: boolean;
  reaction: boolean;
  /** Offline debug mode only. */
  debugHand?: Card[];
}

export interface TableVM {
  mode: "offline" | "online";
  youId: string;
  /** You first, then clockwise turn order. */
  seats: SeatVM[];
  myHand: Card[];
  currentId: string | null;
  currentName: string;
  canAct: boolean;
  cardsRemaining: number;
  round: number;
  playersWithCards: number;
  log: { id: number; text: string; kind: "public" | "private" | "system" }[];
  paused: { name: string; secondsLeft: number } | null;
  finished: boolean;
  abandoned: boolean;
  winnerId: string | null;
  winnerName: string;
  youWon: boolean;
}

const rotateToYou = <T extends { id: string }>(seats: T[], youId: string): T[] => {
  const i = seats.findIndex((s) => s.id === youId);
  return i <= 0 ? seats : [...seats.slice(i), ...seats.slice(0, i)];
};

export function offlineVm(game: OfflineGame, reactionId: string | null, debug: boolean): TableVM {
  const cur = game.finished ? null : game.currentPlayerId;
  const seats: SeatVM[] = game.state.players.map((p) => ({
    id: p.id, name: p.name, cardCount: p.hand.length, isYou: p.id === HUMAN_ID, isCurrent: p.id === cur,
    isConnected: true, isHost: false, isAi: p.kind === "ai", reaction: p.id === reactionId,
    ...(debug && p.id !== HUMAN_ID ? { debugHand: p.hand.map((c) => ({ ...c })) } : {}),
  }));
  const withCards = seats.filter((s) => s.cardCount > 0).length;
  return {
    mode: "offline", youId: HUMAN_ID, seats: rotateToYou(seats, HUMAN_ID), myHand: game.hand(HUMAN_ID),
    currentId: cur, currentName: cur ? game.name(cur) : "", canAct: game.isHumanTurn,
    cardsRemaining: game.cardsRemaining, round: Math.floor(game.state.drawCount / Math.max(1, withCards)) + 1,
    playersWithCards: withCards, log: [...game.log], paused: null, finished: game.finished, abandoned: false,
    winnerId: game.winnerId, winnerName: game.winnerId ? game.name(game.winnerId) : "", youWon: game.humanWon,
  };
}

/** Built ONLY from the server's per-viewer PlayerView – there is nothing else in the browser to leak. */
export function onlineVm(view: PlayerView, privateLog: { id: number; text: string }[], pauseSecondsLeft: number | null): TableVM {
  const g = view.game;
  const cur = view.status === "playing" ? (g?.currentPlayerId ?? null) : null;
  const seats: SeatVM[] = view.players.map((p) => ({
    id: p.id, name: p.name, cardCount: p.cardCount, isYou: p.id === view.you, isCurrent: p.id === cur,
    isConnected: p.isConnected, isHost: p.isHost, isAi: p.isAi, reaction: false,
  }));
  const name = (id: string | null) => view.players.find((p) => p.id === id)?.name ?? "";
  const paused = g?.paused ? { name: name(g.paused.playerId), secondsLeft: pauseSecondsLeft ?? g.paused.secondsLeft } : null;
  const withCards = seats.filter((s) => s.cardCount > 0).length;
  const winnerId = view.result?.winnerId ?? null;
  const pub = view.events.map((e) => ({ id: e.seq, text: e.text, kind: "public" as const }));
  const priv = privateLog.map((l) => ({ id: 1_000_000 + l.id, text: l.text, kind: "private" as const }));
  return {
    mode: "online", youId: view.you, seats: rotateToYou(seats, view.you), myHand: view.myHand,
    currentId: cur, currentName: name(cur), canAct: !!cur && cur === view.you && !paused,
    cardsRemaining: g?.cardsRemaining ?? 0, round: Math.floor((g?.drawCount ?? 0) / Math.max(1, withCards)) + 1,
    playersWithCards: withCards, log: [...pub, ...priv].slice(-60), paused,
    finished: view.status === "finished", abandoned: !!view.result?.abandoned,
    winnerId, winnerName: name(winnerId), youWon: winnerId !== null && winnerId === view.you,
  };
}

export const TENSION_LINES = [
  "Choose carefully.", "You don't know what you're taking.", "Someone is hiding the Joker.",
  "The circle gets smaller.", "Whoever holds it wins.",
];
export const tensionLine = (round: number, cardsRemaining: number): string =>
  cardsRemaining <= 3 ? "One card remains. Whoever holds it wins." : TENSION_LINES[round % TENSION_LINES.length] ?? "";
