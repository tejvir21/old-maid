import type { Socket } from "socket.io";
import type { ServerToClientEvents } from "@old-maid/shared";
import type { Emitter, EventArgs } from "../rooms/roomTypes.js";

interface RawEmit { emit(event: string, ...args: unknown[]): void; disconnect(close?: boolean): void }

/** Maps playerId → its single live socket. Implements the Emitter the room layer talks to. */
export class SocketRegistry implements Emitter {
  private sockets = new Map<string, Socket>();

  emit<K extends keyof ServerToClientEvents>(playerId: string, event: K, ...args: EventArgs<K>): void {
    const s = this.sockets.get(playerId);
    if (s) (s as unknown as RawEmit).emit(event, ...args);
  }

  /** Registers the socket; returns a previously registered one (the caller must kick it). */
  register(playerId: string, socket: Socket): Socket | undefined {
    const prev = this.sockets.get(playerId);
    this.sockets.set(playerId, socket);
    return prev;
  }

  /** True only if `socket` was the currently-registered one (i.e. this is a real disconnect, not a takeover). */
  unregister(playerId: string, socket: Socket): boolean {
    if (this.sockets.get(playerId) !== socket) return false;
    this.sockets.delete(playerId);
    return true;
  }

  isOnline(playerId: string): boolean {
    return this.sockets.has(playerId);
  }
  get size(): number {
    return this.sockets.size;
  }
  disconnectPlayer(playerId: string): void {
    (this.sockets.get(playerId) as unknown as RawEmit | undefined)?.disconnect(true);
  }
}
