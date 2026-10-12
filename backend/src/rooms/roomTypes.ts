import type { AiLevel, ServerToClientEvents } from "@old-maid/shared";
import type { GameSession } from "../game/GameSession.js";
import type { SlotTable } from "./drawSlots.js";

export interface RoomPlayer {
  id: string;
  name: string;
  isAi: boolean;
  aiLevel?: AiLevel;
  connected: boolean;
  disconnectedAt: number | null;
  /** Reconnect window elapsed while still disconnected. */
  timedOut: boolean;
  /** Left a game in progress; a server AI plays the seat from now on. */
  left: boolean;
  joinedAt: number;
}

export type RoomStatus = "waiting" | "playing" | "finished";

export interface RoomResult {
  winnerId: string | null;
  abandoned: boolean;
}

export interface Room {
  code: string;
  hostId: string;
  status: RoomStatus;
  players: RoomPlayer[];
  maxPlayers: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Set when no human is connected; used for expiry. */
  idleSince: number | null;
  session: GameSession | null;
  result: RoomResult | null;
  pausedFor: string | null;
  locked: boolean;
  /**
   * Viewer-specific opaque slots for the player who may currently draw. Destroyed on every turn
   * change so it can never be replayed or reused across turns.
   */
  slots: SlotTable | null;
  /**
   * The presentation permutation last shown to this room's viewer, per target.
   * Used only to guarantee the next turn renders a DIFFERENT arrangement; it holds indices into
   * the server-side slot table and is never sent to any client.
   */
  lastSlotOrder: Map<string, readonly number[]> | null;
  timers: { turn: unknown; ai: unknown; reconnect: Map<string, unknown> };
}

export type EventArgs<K extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[K]>;

/** The room layer never touches sockets directly. */
export interface Emitter {
  emit<K extends keyof ServerToClientEvents>(playerId: string, event: K, ...args: EventArgs<K>): void;
}

export interface Timing {
  reconnectMs: number;
  turnMs: number;
  roomExpiryMs: number;
  aiDelayMinMs: number;
  aiDelayMaxMs: number;
}
