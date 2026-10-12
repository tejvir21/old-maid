import { randomUUID } from "node:crypto";
import {
  ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, chatSchema, emoteSchema, playerNameSchema, randomInt, requestDrawSchema,
  secureRng, shuffleDeck, startGameSchema,
  type Ack, type AiLevel, type ErrorCode, type PlayerView, type PublicPlayerState, type Rng,
} from "@old-maid/shared";
import { GameSession, type SessionSeed } from "../game/GameSession.js";
import type { SettingsService } from "../services/settingsService.js";
import type { ActiveStateStore, Store } from "../store/types.js";
import type { Logger } from "../util/logger.js";
import type { Scheduler } from "../util/scheduler.js";
import { err } from "../util/errors.js";
import type { Emitter, Room, RoomPlayer, Timing } from "./roomTypes.js";
import { buildSlotTable, consumeSlot, resolveSlot, type SlotTable } from "./drawSlots.js";

export interface RoomManagerDeps {
  store: Store;
  active: ActiveStateStore;
  settings: SettingsService;
  log: Logger;
  emitter: Emitter;
  scheduler: Scheduler;
  rng?: Rng;
  codeGen?: () => string;
  /** Test hook: overrides timings derived from settings. */
  timing?: Partial<Timing>;
}

const AI_NAMES = ["Akira", "Ken", "Yuna", "Haru", "Sora", "Mika", "Rin", "Kaito", "Emi", "Daichi", "Nao", "Ayame"];

export function sanitizeText(raw: string): string {
  // Plain text only: drop control chars, collapse whitespace. The client renders it as text (never HTML).
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, " ").replace(/\s+/g, " ").replace(/[<>]/g, "").trim();
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private playerRoom = new Map<string, string>();
  private readonly rng: Rng;

  constructor(private readonly d: RoomManagerDeps) {
    this.rng = d.rng ?? secureRng;
  }

  /* ------------------------------------------------------------ helpers */

  private get timing(): Timing {
    const g = this.d.settings.getGame();
    const ai = this.d.settings.getAi();
    return {
      reconnectMs: g.reconnectTimeoutSec * 1000,
      turnMs: g.turnTimeoutSec * 1000,
      roomExpiryMs: g.roomExpirationSec * 1000,
      aiDelayMinMs: ai.thinkingDelayMs,
      aiDelayMaxMs: ai.thinkingDelayMs + 700,
      ...this.d.timing,
    };
  }

  private now(): number {
    return this.d.scheduler.now();
  }

  private persist(label: string, p: Promise<unknown>): void {
    p.catch((e: unknown) => this.d.log.error("persistence failed", { label, error: e instanceof Error ? e.message : String(e) }));
  }

  private genCode(): string {
    if (this.d.codeGen) return this.d.codeGen();
    for (let attempt = 0; attempt < 50; attempt++) {
      let c = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) c += ROOM_CODE_ALPHABET[randomInt(secureRng, ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error("Could not allocate a room code");
  }

  roomOf(playerId: string): Room | null {
    const code = this.playerRoom.get(playerId);
    return code ? (this.rooms.get(code) ?? null) : null;
  }
  getRoom(code: string): Room | null {
    return this.rooms.get(code) ?? null;
  }
  private player(room: Room, id: string): RoomPlayer | undefined {
    return room.players.find((p) => p.id === id);
  }
  private humans(room: Room): RoomPlayer[] {
    return room.players.filter((p) => !p.isAi && !p.left);
  }
  private connectedHumans(room: Room): RoomPlayer[] {
    return this.humans(room).filter((p) => p.connected);
  }

  private emitRoom<K extends Parameters<Emitter["emit"]>[1]>(room: Room, event: K, ...args: Parameters<import("@old-maid/shared").ServerToClientEvents[K]>): void {
    for (const p of this.humans(room)) if (p.connected) this.d.emitter.emit(p.id, event, ...args);
  }

  private broadcastState(room: Room): void {
    for (const p of this.humans(room)) {
      if (p.connected) this.d.emitter.emit(p.id, "room_state", this.buildView(room, p.id));
    }
  }

  private secondsLeft(p: RoomPlayer): number {
    if (p.disconnectedAt === null) return 0;
    return Math.max(0, Math.ceil((this.timing.reconnectMs - (this.now() - p.disconnectedAt)) / 1000));
  }

  private clearTurnTimers(room: Room): void {
    if (room.timers.turn) this.d.scheduler.clearTimeout(room.timers.turn);
    if (room.timers.ai) this.d.scheduler.clearTimeout(room.timers.ai);
    room.timers.turn = null;
    room.timers.ai = null;
  }
  private clearAllTimers(room: Room): void {
    this.clearTurnTimers(room);
    for (const h of room.timers.reconnect.values()) this.d.scheduler.clearTimeout(h);
    room.timers.reconnect.clear();
  }

  private updateIdle(room: Room): void {
    if (this.connectedHumans(room).length === 0) room.idleSince ??= this.now();
    else room.idleSince = null;
  }

  private roomRecord(room: Room, status: string) {
    return {
      code: room.code, hostId: room.hostId,
      status: status as "waiting" | "playing" | "finished" | "closed" | "expired",
      playerIds: room.players.filter((p) => !p.isAi).map((p) => p.id),
      maxPlayers: room.maxPlayers, createdAt: new Date(room.createdAt),
      ...(room.startedAt ? { startedAt: new Date(room.startedAt) } : {}),
      ...(room.finishedAt ? { finishedAt: new Date(room.finishedAt) } : {}),
      expiresAt: new Date(this.now() + this.timing.roomExpiryMs),
    };
  }

  private saveSnapshot(room: Room): void {
    this.persist("active-snapshot", this.d.active.save({
      code: room.code, hostId: room.hostId, status: room.status, playerIds: room.players.map((p) => p.id),
      savedAt: this.now(), state: room.session ? structuredClone(room.session.state) : null,
    }));
  }

  /* ------------------------------------------------------------ views (the ONLY place client state is built) */

  buildView(room: Room, viewerId: string): PlayerView {
    const s = room.session;
    const players: PublicPlayerState[] = room.players.map((p) => ({
      id: p.id, name: p.name, cardCount: s ? s.cardCount(p.id) : 0, isConnected: p.isAi || p.left ? true : p.connected,
      isHost: p.id === room.hostId, isAi: p.isAi,
    }));
    const pausedPlayer = room.pausedFor ? this.player(room, room.pausedFor) : undefined;
    return {
      roomCode: room.code,
      status: room.status,
      you: viewerId,
      hostId: room.hostId,
      isHost: viewerId === room.hostId,
      players,
      maxPlayers: room.maxPlayers,
      minPlayers: this.d.settings.getGame().minPlayers,
      game: s
        ? {
            currentPlayerId: s.finished ? null : s.currentPlayerId,
            turnId: s.turnId,
            drawCount: s.state.drawCount,
            cardsRemaining: s.cardsRemaining,
            discardedPairs: s.state.discardedPairs,
            paused: pausedPlayer ? { playerId: pausedPlayer.id, secondsLeft: this.secondsLeft(pausedPlayer) } : null,
          }
        : null,
      // Only the viewer's own hand ever leaves the server.
      myHand: s && s.hasPlayer(viewerId) ? s.hand(viewerId) : [],
      result: room.result
        ? { winnerId: room.result.winnerId, finalCard: room.result.abandoned ? null : "joker", abandoned: room.result.abandoned }
        : null,
      events: s ? s.publicEvents.slice(-40) : [],
    };
  }

  viewFor(playerId: string): PlayerView | null {
    const room = this.roomOf(playerId);
    return room ? this.buildView(room, playerId) : null;
  }

  /* ------------------------------------------------------------ lobby */

  private validateName(raw: string): { ok: true; name: string } | { ok: false; error: Ack<never> } {
    const r = playerNameSchema.safeParse(raw);
    if (!r.success) return { ok: false, error: err("INVALID_NAME", r.error.issues[0]?.message ?? "Invalid name") as Ack<never> };
    return { ok: true, name: r.data };
  }

  createRoom(playerId: string, rawName: string): Ack<{ roomCode: string }> {
    const avail = this.d.settings.onlineAvailable();
    if (!avail.ok) return err(avail.code, avail.message);
    if (this.playerRoom.has(playerId)) return err("BAD_REQUEST", "You are already in a room. Leave it first.");
    const n = this.validateName(rawName);
    if (!n.ok) return n.error;

    const now = this.now();
    const room: Room = {
      code: this.genCode(), hostId: playerId, status: "waiting",
      players: [{ id: playerId, name: n.name, isAi: false, connected: true, disconnectedAt: null, timedOut: false, left: false, joinedAt: now }],
      maxPlayers: this.d.settings.getGame().maxPlayers, createdAt: now, startedAt: null, finishedAt: null, idleSince: null,
      session: null, result: null, pausedFor: null, locked: false, slots: null,
      timers: { turn: null, ai: null, reconnect: new Map() },
    };
    this.rooms.set(room.code, room);
    this.playerRoom.set(playerId, room.code);
    this.persist("room-create", this.d.store.rooms.upsert(this.roomRecord(room, "waiting")));
    this.d.log.info("room created", { room: room.code });
    this.broadcastState(room);
    return { ok: true, roomCode: room.code };
  }

  joinRoom(playerId: string, rawName: string, code: string): Ack<{ roomCode: string }> {
    const avail = this.d.settings.onlineAvailable();
    const room = this.rooms.get(code);
    const existing = this.playerRoom.get(playerId);
    if (existing && existing === code && room) {
      // Same player re-joining their own room == resume.
      this.onConnect(playerId);
      return { ok: true, roomCode: code };
    }
    if (!avail.ok) return err(avail.code, avail.message);
    if (existing) return err("BAD_REQUEST", "You are already in a room. Leave it first.");
    const n = this.validateName(rawName);
    if (!n.ok) return n.error;
    if (!room) return err("ROOM_NOT_FOUND", "That room does not exist.");
    if (room.locked) return err("ROOM_LOCKED", "That room is locked.");
    if (room.status !== "waiting") return err("GAME_ALREADY_STARTED", "That game has already started.");
    if (room.players.length >= room.maxPlayers) return err("ROOM_FULL", "That room is full.");
    if (room.players.some((p) => p.name.toLowerCase() === n.name.toLowerCase())) return err("NAME_TAKEN", "That name is already taken in this room.");

    room.players.push({ id: playerId, name: n.name, isAi: false, connected: true, disconnectedAt: null, timedOut: false, left: false, joinedAt: this.now() });
    this.playerRoom.set(playerId, code);
    room.idleSince = null;
    this.emitRoom(room, "player_joined", { playerId, name: n.name });
    this.persist("room-join", this.d.store.rooms.upsert(this.roomRecord(room, "waiting")));
    this.broadcastState(room);
    return { ok: true, roomCode: code };
  }

  private transferHost(room: Room, exceptId: string): void {
    const next = this.connectedHumans(room).filter((p) => p.id !== exceptId).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!next) return;
    room.hostId = next.id;
    this.emitRoom(room, "host_transferred", { playerId: next.id, name: next.name });
  }

  leaveRoom(playerId: string): Ack<object> {
    const room = this.roomOf(playerId);
    if (!room) return { ok: true };
    const p = this.player(room, playerId);
    if (!p) return { ok: true };

    const h = room.timers.reconnect.get(playerId);
    if (h) this.d.scheduler.clearTimeout(h);
    room.timers.reconnect.delete(playerId);
    this.playerRoom.delete(playerId);

    if (room.status === "playing" && room.session && !room.session.finished) {
      // Leaving a live game: a server AI takes over the seat (never leaves the table stuck).
      p.left = true; p.isAi = true; p.connected = false; p.aiLevel = this.d.settings.getGame().defaultAiDifficulty;
      room.session.takeOver(p.id, p.aiLevel);
      if (room.hostId === playerId) this.transferHost(room, playerId);
      this.emitRoom(room, "player_left", { playerId, name: p.name });
      if (this.humans(room).length === 0) {
        this.finishAbandoned(room);
        return { ok: true };
      }
      if (room.pausedFor === playerId) {
        room.pausedFor = null;
        this.emitRoom(room, "game_resumed");
      }
      this.updateIdle(room);
      this.broadcastState(room);
      this.scheduleTurn(room);
      return { ok: true };
    }

    room.players = room.players.filter((x) => x.id !== playerId);
    if (room.hostId === playerId) {
      this.transferHost(room, playerId);
      if (room.hostId === playerId) {
        const any = this.humans(room)[0];
        if (any) room.hostId = any.id;
      }
    }
    this.emitRoom(room, "player_left", { playerId, name: p.name });
    this.updateIdle(room);
    this.persist("room-leave", this.d.store.rooms.upsert(this.roomRecord(room, room.status)));
    this.broadcastState(room);
    return { ok: true };
  }

  /* ------------------------------------------------------------ connections */

  /** Called whenever an authenticated socket for this player is connected (first connect or reconnect). */
  onConnect(playerId: string): void {
    const room = this.roomOf(playerId);
    if (!room) return;
    const p = this.player(room, playerId);
    if (!p || p.left) return;
    const wasDown = !p.connected;
    p.connected = true; p.disconnectedAt = null; p.timedOut = false;
    const h = room.timers.reconnect.get(playerId);
    if (h) this.d.scheduler.clearTimeout(h);
    room.timers.reconnect.delete(playerId);
    room.idleSince = null;
    if (wasDown) {
      for (const o of this.connectedHumans(room)) if (o.id !== playerId) this.d.emitter.emit(o.id, "player_reconnected", { playerId, name: p.name });
    }
    if (room.pausedFor === playerId) {
      room.pausedFor = null;
      this.emitRoom(room, "game_resumed");
      this.broadcastState(room);
      // Re-mint so a reconnecting player never inherits (or an observer never sees) stale slots.
      this.refreshTurnSlots(room);
      this.scheduleTurn(room);
      return;
    }
    // Restore the player's private state; refresh everyone's connection flags.
    this.broadcastState(room);
  }

  onDisconnect(playerId: string): void {
    const room = this.roomOf(playerId);
    if (!room) return;
    const p = this.player(room, playerId);
    if (!p || p.left || !p.connected) return;
    p.connected = false; p.disconnectedAt = this.now(); p.timedOut = false;
    this.updateIdle(room);

    const timer = this.d.scheduler.setTimeout(() => this.onReconnectTimeout(room.code, playerId), this.timing.reconnectMs);
    room.timers.reconnect.set(playerId, timer);

    if (room.hostId === playerId) this.transferHost(room, playerId);
    this.emitRoom(room, "player_disconnected", { playerId, name: p.name, secondsLeft: this.secondsLeft(p) });

    if (room.status === "playing" && room.session && !room.session.finished && room.session.currentPlayerId === playerId) {
      this.pauseFor(room, p);
    } else {
      this.broadcastState(room);
    }
  }

  private onReconnectTimeout(code: string, playerId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const p = this.player(room, playerId);
    if (!p || p.connected) return;
    room.timers.reconnect.delete(playerId);
    p.timedOut = true;
    if (room.status === "waiting") {
      // Lobby: drop the absent player.
      this.playerRoom.delete(playerId);
      room.players = room.players.filter((x) => x.id !== playerId);
      this.emitRoom(room, "player_left", { playerId, name: p.name });
      this.updateIdle(room);
      this.broadcastState(room);
      return;
    }
    if (room.pausedFor === playerId) {
      this.emitRoom(room, "game_paused", { playerId, secondsLeft: 0 });
    }
    this.broadcastState(room);
  }

  /* ------------------------------------------------------------ game flow */

  startGame(playerId: string, raw: unknown): Ack<object> {
    const room = this.roomOf(playerId);
    if (!room) return err("NOT_IN_ROOM", "You are not in a room.");
    if (room.hostId !== playerId) return err("NOT_HOST", "Only the host can start the game.");
    if (room.status !== "waiting") return err("GAME_ALREADY_STARTED", "The game has already started.");
    const avail = this.d.settings.onlineAvailable();
    if (!avail.ok) return err(avail.code, avail.message);
    const parsed = startGameSchema.safeParse(raw ?? {});
    if (!parsed.success) return err("BAD_REQUEST", "Invalid start options.");

    const settings = this.d.settings.getGame();
    if (room.players.some((p) => !p.connected)) return err("PLAYER_DISCONNECTED", "A player is disconnected. Wait for them or let them time out.");

    const humans = [...room.players];
    const wantFill = parsed.data.fillWithAi === true;
    if (wantFill && (!settings.allowAiFill || !this.d.settings.getAi().enabled)) return err("FEATURE_DISABLED", "AI fill is disabled.");
    const fillCount = wantFill ? Math.max(0, room.maxPlayers - humans.length) : 0;
    if (humans.length + fillCount < settings.minPlayers) return err("NOT_ENOUGH_PLAYERS", `At least ${settings.minPlayers} players are required.`);

    const level: AiLevel = parsed.data.aiDifficulty ?? settings.defaultAiDifficulty;
    const used = new Set(humans.map((h) => h.name.toLowerCase()));
    const pool = AI_NAMES.filter((n) => !used.has(n.toLowerCase()));
    for (let i = 0; i < fillCount; i++) {
      const name = pool[i] ?? `Bot ${i + 1}`;
      room.players.push({ id: `ai-${randomUUID().slice(0, 8)}`, name, isAi: true, aiLevel: level, connected: true, disconnectedAt: null, timedOut: false, left: false, joinedAt: this.now() });
    }

    const seatOrder = shuffleDeck(room.players, this.rng);
    const seeds: SessionSeed[] = seatOrder.map((p) => ({ id: p.id, name: p.name, isAi: p.isAi, ...(p.aiLevel ? { aiLevel: p.aiLevel } : {}) }));
    const ai = this.d.settings.getAi();
    const session = new GameSession(seeds, this.rng, this.now(), ai.difficulty === level ? { aggressiveness: ai.aggressiveness, memory: ai.memory } : {});
    room.players = seatOrder;
    room.session = session;
    room.status = "playing";
    room.startedAt = this.now();
    room.result = null;
    room.pausedFor = null;

    this.persist("game-start", this.d.store.games.start(
      { gameId: session.gameId, roomCode: room.code, mode: "online", status: "playing", playerIds: room.players.map((p) => p.id), startedAt: new Date(room.startedAt) },
      room.players.map((p, seat) => ({ gameId: session.gameId, playerId: p.id, ...(p.isAi ? {} : { userId: p.id }), name: p.name, isAi: p.isAi, seat })),
    ));
    this.persist("room-start", this.d.store.rooms.upsert(this.roomRecord(room, "playing")));
    this.d.log.info("game started", { room: room.code, players: room.players.length, ai: fillCount });

    for (const p of this.humans(room)) if (p.connected) this.d.emitter.emit(p.id, "game_started", this.buildView(room, p.id));
    this.saveSnapshot(room);
    if (session.finished) this.finishGame(room);
    else {
      // The first player to act receives their opening slots.
      this.refreshTurnSlots(room);
      this.scheduleTurn(room);
    }
    return { ok: true };
  }

  requestDraw(playerId: string, raw: unknown): Ack<object> {
    const room = this.roomOf(playerId);
    if (!room) return err("NOT_IN_ROOM", "You are not in a room.");
    const parsed = requestDrawSchema.safeParse(raw);
    if (!parsed.success) return err("BAD_REQUEST", "Invalid draw request.");
    if (room.status !== "playing" || !room.session || room.session.finished) return err("BAD_REQUEST", "There is no game in progress.");
    if (room.pausedFor) return err("GAME_PAUSED", "The game is paused.");
    const p = this.player(room, playerId);
    if (!p || p.left || p.isAi) return err("NOT_IN_ROOM", "You are not a player in this game.");

    // Replay is rejected first: a repeated action must never produce a second effect,
    // regardless of whose turn it now is.
    if (room.session.isDuplicateAction(playerId, parsed.data.actionId)) {
      return err("DUPLICATE_ACTION", "That action was already processed.");
    }
    // A client working from an out-of-date view is told the turn moved on, which is the most
    // precise answer and leaks nothing about slot validity.
    if (parsed.data.turnId !== room.session.turnId) return err("STALE_TURN", "That action is out of date.");
    // Turn ownership is checked BEFORE the slot, so a player who is not on turn learns nothing
    // about whether any slot id is valid.
    if (room.session.currentPlayerId !== playerId) return err("NOT_YOUR_TURN", "It is not your turn.");

    // The client never names a card; it names an opaque slot minted for THIS player, THIS
    // target and THIS turn. Resolution happens here and stays here.
    const res = resolveSlot(room.slots, playerId, parsed.data.targetPlayerId, parsed.data.turnId, parsed.data.slotId);
    if (!res.ok) return err(res.reason, res.reason === "STALE_TURN"
      ? "That turn has moved on. Wait for your next turn."
      : "That card is no longer available.");

    const r = room.session.applyDraw({
      actorId: playerId, targetId: parsed.data.targetPlayerId, cardIndex: res.index,
      turnId: parsed.data.turnId, actionId: parsed.data.actionId,
    });
    if (!r.ok) return err(r.code, r.message);
    // A slot is single-use even if the turn somehow continues.
    consumeSlot(room.slots, parsed.data.targetPlayerId, parsed.data.slotId);
    this.afterDraw(room, r.outcome);
    return { ok: true };
  }

  /**
   * Mints fresh viewer-specific slots for `playerId` and sends them privately.
   *
   * Called every time a human becomes the current player, so the presentation order is
   * re-randomised each turn and an observer can never map a screen position to a card.
   */
  private issueDrawSlots(room: Room, playerId: string): void {
    const s = room.session;
    const p = this.player(room, playerId);
    if (!s || !p || p.isAi || p.left || s.finished || room.status !== "playing" || s.currentPlayerId !== playerId) return;
    if (!p.connected) return;
    const targets = this.eligibleTargets(room, playerId);
    if (targets.length === 0) return;
    const { table, payload } = buildSlotTable({
      roomCode: room.code,
      viewerId: playerId,
      turnId: s.turnId,
      targets: targets.map((t) => ({ playerId: t.id, cardCount: s.cardCount(t.id) })),
      rand: this.rng,
    });
    room.slots = table;
    this.d.emitter.emit(playerId, "draw_slots", payload);
  }

  /** Players this viewer may draw from right now (everyone except self who still holds cards). */
  private eligibleTargets(room: Room, playerId: string): RoomPlayer[] {
    const s = room.session;
    if (!s) return [];
    return room.players.filter((p) => p.id !== playerId && s.cardCount(p.id) > 0);
  }

  /** Invalidates slots and re-mints them for whoever is now on turn. */
  private refreshTurnSlots(room: Room): void {
    room.slots = null;
    const s = room.session;
    if (!s || s.finished) return;
    this.issueDrawSlots(room, s.currentPlayerId);
  }

  private afterDraw(room: Room, outcome: import("@old-maid/shared").DrawOutcome): void {
    const s = room.session as GameSession;
    const res = outcome.result;
    const actor = this.player(room, res.actorId);
    // Only the drawing human learns the card's identity.
    if (actor && !actor.isAi && actor.connected) {
      this.d.emitter.emit(actor.id, "card_drawn", { card: res.card, pairFormed: res.pairFormed, pairCards: res.pairCards, fromPlayerId: res.targetId });
    }
    const seq = outcome.events.find((e) => e.type === "card_drawn")?.seq ?? 0;
    // Public event carries NO card index and NO identity: an index would let an observer track
    // which physical card was removed from which hand.
    this.emitRoom(room, "draw_public", { actorId: res.actorId, targetId: res.targetId, pairFormed: res.pairFormed, seq });
    if (res.pairFormed) this.emitRoom(room, "pair_formed", { playerId: res.actorId });
    if (res.gameOver) {
      this.finishGame(room);
      return;
    }
    this.emitRoom(room, "turn_changed", { currentPlayerId: s.currentPlayerId, turnId: s.turnId });
    this.broadcastState(room);
    this.saveSnapshot(room);
    // Fresh, re-randomised slots for whoever is now on turn.
    this.refreshTurnSlots(room);
    this.scheduleTurn(room);
  }

  private scheduleTurn(room: Room): void {
    this.clearTurnTimers(room);
    const s = room.session;
    if (!s || room.status !== "playing" || s.finished || room.pausedFor) return;
    const cur = this.player(room, s.currentPlayerId);
    if (!cur) return;
    const turnId = s.turnId;
    if (s.isAiControlled(cur.id)) {
      const t = this.timing;
      const delay = t.aiDelayMinMs + Math.floor(this.rng() * (t.aiDelayMaxMs - t.aiDelayMinMs + 1));
      room.timers.ai = this.d.scheduler.setTimeout(() => this.runAi(room.code, cur.id, turnId), delay);
      return;
    }
    if (!cur.connected) {
      this.pauseFor(room, cur);
      return;
    }
    if (this.timing.turnMs > 0) {
      room.timers.turn = this.d.scheduler.setTimeout(() => this.runTurnTimeout(room.code, cur.id, turnId), this.timing.turnMs);
    }
  }

  private stillCurrent(room: Room | undefined, playerId: string, turnId: number): room is Room & { session: GameSession } {
    return !!room && room.status === "playing" && !!room.session && !room.session.finished && !room.pausedFor
      && room.session.turnId === turnId && room.session.currentPlayerId === playerId;
  }

  private runAi(code: string, playerId: string, turnId: number): void {
    const room = this.rooms.get(code);
    if (!this.stillCurrent(room, playerId, turnId)) return;
    room.timers.ai = null;
    try {
      const mv = room.session.aiMove(playerId);
      const r = room.session.applyDraw({ actorId: playerId, targetId: mv.targetId, cardIndex: mv.cardIndex, turnId, actionId: `ai-${turnId}` });
      if (!r.ok) throw new Error(`AI produced an illegal move: ${r.code}`);
      this.afterDraw(room, r.outcome);
    } catch (e) {
      this.d.log.error("AI turn failed", { room: code, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private runTurnTimeout(code: string, playerId: string, turnId: number): void {
    const room = this.rooms.get(code);
    if (!this.stillCurrent(room, playerId, turnId)) return;
    room.timers.turn = null;
    const p = this.player(room, playerId);
    try {
      const mv = room.session.randomMove(playerId);
      room.session.noteTimeoutAutoDraw(playerId);
      const r = room.session.applyDraw({ actorId: playerId, targetId: mv.targetId, cardIndex: mv.cardIndex, turnId, actionId: `timeout-${turnId}` });
      if (!r.ok) throw new Error(r.code);
      this.emitRoom(room, "server_notice", { message: `${p?.name ?? "A player"} ran out of time. A card was drawn for them.`, code: "TIMEOUT" });
      this.afterDraw(room, r.outcome);
    } catch (e) {
      this.d.log.error("turn timeout failed", { room: code, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private pauseFor(room: Room, p: RoomPlayer): void {
    this.clearTurnTimers(room);
    room.pausedFor = p.id;
    this.emitRoom(room, "game_paused", { playerId: p.id, secondsLeft: this.secondsLeft(p) });
    this.broadcastState(room);
  }

  private finishGame(room: Room): void {
    const s = room.session as GameSession;
    this.clearAllTimers(room);
    room.status = "finished";
    room.finishedAt = this.now();
    room.pausedFor = null;
    room.slots = null; // no slot may outlive the game
    const winnerId = s.winnerId;
    room.result = { winnerId, abandoned: false };
    const winner = winnerId ? this.player(room, winnerId) : undefined;
    this.d.log.info("game finished", { room: room.code, draws: s.state.drawCount });

    this.emitRoom(room, "game_over", { winnerId: winnerId ?? "", winnerName: winner?.name ?? "", finalCard: "joker" });
    this.broadcastState(room);

    const results: Record<string, "win" | "loss" | "abandoned"> = {};
    for (const p of room.players) results[p.id] = p.left ? "abandoned" : p.id === winnerId ? "win" : "loss";
    const duration = Math.round((room.finishedAt - (room.startedAt ?? room.finishedAt)) / 1000);
    this.persist("game-finish", this.d.store.games.finish(s.gameId, { status: "finished", winnerId, finishedAt: new Date(room.finishedAt), durationSec: duration, drawCount: s.state.drawCount }, results));
    this.persist("game-events", this.d.store.gameEvents.appendMany(s.allEvents.map((e) => ({ gameId: s.gameId, seq: e.seq, type: e.type.toUpperCase(), ...(e.actorId ? { actorId: e.actorId } : {}), ...(e.targetId ? { targetId: e.targetId } : {}), text: e.text, createdAt: new Date(room.finishedAt as number) }))));
    for (const p of room.players) {
      if (!p.isAi && !p.left) this.persist("stats", this.d.store.stats.recordOnline(p.id, p.id === winnerId));
    }
    this.persist("room-finish", this.d.store.rooms.upsert(this.roomRecord(room, "finished")));
    this.saveSnapshot(room);
  }

  private finishAbandoned(room: Room): void {
    this.clearAllTimers(room);
    const s = room.session;
    s?.abandon();
    room.status = "finished";
    room.finishedAt = this.now();
    room.pausedFor = null;
    room.slots = null;
    room.result = { winnerId: null, abandoned: true };
    this.emitRoom(room, "server_notice", { message: "The match was ended without a winner." });
    this.broadcastState(room);
    if (s) {
      const results: Record<string, "abandoned"> = {};
      for (const p of room.players) results[p.id] = "abandoned";
      this.persist("game-abandon", this.d.store.games.finish(s.gameId, { status: "abandoned", winnerId: null, finishedAt: new Date(room.finishedAt), durationSec: Math.round((room.finishedAt - (room.startedAt ?? room.finishedAt)) / 1000) }, results));
    }
    this.persist("room-finish", this.d.store.rooms.upsert(this.roomRecord(room, "finished")));
  }

  endMatch(playerId: string): Ack<object> {
    const room = this.roomOf(playerId);
    if (!room) return err("NOT_IN_ROOM", "You are not in a room.");
    if (room.hostId !== playerId) return err("NOT_HOST", "Only the host can end the match.");
    if (room.status !== "playing" || !room.pausedFor) return err("BAD_REQUEST", "You can only end the match while it is paused.");
    this.finishAbandoned(room);
    return { ok: true };
  }

  rematch(playerId: string): Ack<object> {
    const room = this.roomOf(playerId);
    if (!room) return err("NOT_IN_ROOM", "You are not in a room.");
    if (room.hostId !== playerId) return err("NOT_HOST", "Only the host can start a rematch.");
    if (room.status !== "finished") return err("BAD_REQUEST", "The game is not finished.");
    const avail = this.d.settings.onlineAvailable();
    if (!avail.ok) return err(avail.code, avail.message);

    for (const p of [...room.players]) {
      if (p.isAi || p.left || !p.connected) {
        room.players = room.players.filter((x) => x.id !== p.id);
        if (!p.isAi) this.playerRoom.delete(p.id);
      }
    }
    room.status = "waiting"; room.session = null; room.result = null; room.pausedFor = null; room.slots = null;
    room.startedAt = null; room.finishedAt = null;
    this.persist("room-rematch", this.d.store.rooms.upsert(this.roomRecord(room, "waiting")));
    this.broadcastState(room);
    return { ok: true };
  }

  /* ------------------------------------------------------------ chat / emotes */

  chat(playerId: string, raw: unknown): Ack<object> {
    const room = this.roomOf(playerId);
    if (!room) return err("NOT_IN_ROOM", "You are not in a room.");
    if (!this.d.settings.isEnabled("chat") || !this.d.settings.getGame().chatEnabled) return err("FEATURE_DISABLED", "Chat is disabled.");
    const parsed = chatSchema.safeParse(raw);
    if (!parsed.success) return err("BAD_REQUEST", "Messages must be 1–200 characters.");
    const text = sanitizeText(parsed.data.text);
    if (!text) return err("BAD_REQUEST", "Message is empty.");
    const p = this.player(room, playerId);
    if (!p) return err("NOT_IN_ROOM", "You are not in this room.");
    const msg = { id: randomUUID(), playerId, name: p.name, text, at: this.now() };
    this.emitRoom(room, "chat_message", msg);
    this.persist("chat", this.d.store.chat.append({ id: msg.id, roomCode: room.code, ...(room.session ? { gameId: room.session.gameId } : {}), playerId, name: p.name, text, status: "visible", createdAt: new Date(msg.at) }));
    return { ok: true };
  }

  emote(playerId: string, raw: unknown): Ack<object> {
    const room = this.roomOf(playerId);
    if (!room) return err("NOT_IN_ROOM", "You are not in a room.");
    if (!this.d.settings.isEnabled("emotes") || !this.d.settings.getGame().emotesEnabled) return err("FEATURE_DISABLED", "Emotes are disabled.");
    const parsed = emoteSchema.safeParse(raw);
    if (!parsed.success) return err("BAD_REQUEST", "Unknown emote.");
    this.emitRoom(room, "emote", { playerId, emote: parsed.data.emote });
    return { ok: true };
  }

  /* ------------------------------------------------------------ lifecycle / admin hooks */

  /** Expire idle/finished rooms. Call periodically. */
  sweep(): number {
    const now = this.now();
    let closed = 0;
    for (const room of [...this.rooms.values()]) {
      this.updateIdle(room);
      const idle = room.idleSince !== null && now - room.idleSince >= this.timing.roomExpiryMs;
      const stale = room.status === "finished" && room.finishedAt !== null && now - room.finishedAt >= this.timing.roomExpiryMs;
      if (idle || stale) {
        this.closeRoom(room.code, "expired");
        closed++;
      }
    }
    return closed;
  }

  closeRoom(code: string, reason: "expired" | "closed" = "closed", message = "This room has been closed."): boolean {
    const room = this.rooms.get(code);
    if (!room) return false;
    this.clearAllTimers(room);
    if (room.session && !room.session.finished) {
      room.session.abandon();
      this.persist("game-abandon", this.d.store.games.finish(room.session.gameId, { status: "abandoned", winnerId: null, finishedAt: new Date(this.now()) }, {}));
    }
    this.emitRoom(room, "server_notice", { message, code: "ROOM_CLOSED" });
    for (const p of room.players) this.playerRoom.delete(p.id);
    this.rooms.delete(code);
    this.persist("room-close", this.d.store.rooms.upsert(this.roomRecord(room, reason)));
    this.persist("active-remove", this.d.active.remove(code));
    this.d.log.info("room closed", { room: code, reason });
    return true;
  }

  stats(): { rooms: number; playing: number; players: number } {
    let playing = 0, players = 0;
    for (const r of this.rooms.values()) {
      if (r.status === "playing") playing++;
      players += this.connectedHumans(r).length;
    }
    return { rooms: this.rooms.size, playing, players };
  }

  /** Public (non-hidden) info for admin tooling. */
  listRooms(): { code: string; hostId: string; status: string; players: number; createdAt: number; locked: boolean }[] {
    return [...this.rooms.values()].map((r) => ({ code: r.code, hostId: r.hostId, status: r.status, players: r.players.length, createdAt: r.createdAt, locked: r.locked }));
  }

  /** Lock/unlock a lobby so no further players may join. */
  lockRoom(code: string, locked: boolean): boolean {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return false;
    room.locked = locked;
    this.broadcastState(room);
    return true;
  }

  /**
   * Public-only snapshot of a live room. Never includes any hand or the Joker's location —
   * an ordinary admin can see who is in a room and how many cards each holds, nothing more.
   */
  publicRoomSnapshot(code: string): {
    code: string; status: string; hostId: string; locked: boolean; createdAt: number;
    players: { id: string; name: string; cardCount: number; isAi: boolean; isConnected: boolean }[];
    currentPlayerId: string | null; drawCount: number; paused: boolean;
  } | null {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return null;
    const session = room.session;
    return {
      code: room.code, status: room.status, hostId: room.hostId, locked: room.locked, createdAt: room.createdAt,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, cardCount: session?.cardCount(p.id) ?? 0,
        isAi: p.isAi, isConnected: p.connected,
      })),
      currentPlayerId: session && !session.finished ? session.currentPlayerId : null,
      drawCount: session?.state.drawCount ?? 0,
      paused: Boolean(room.pausedFor),
    };
  }

  /** Administrative termination.
   *
   * Records the match as `abandoned` with the admin id and reason. It NEVER invents a winner:
   * an ended-by-admin match is a distinct outcome from a naturally completed one, and the
   * broadcast carries `winnerId: null`.
   */
  adminTerminateGame(gameId: string, admin: { adminId: string; reason: string }):
    { ok: true } | { ok: false; code: ErrorCode; message: string } {
    for (const room of this.rooms.values()) {
      if (room.session?.gameId !== gameId) continue;
      const session = room.session;
      session.abandon();
      this.clearAllTimers(room);
      room.status = "finished";
      room.finishedAt = this.now();
      room.pausedFor = null;
      // abandoned: true, winnerId null — never a fabricated winner.
      room.result = { winnerId: null, abandoned: true };
      this.emitRoom(room, "server_notice", { message: "An administrator ended this match.", code: "ROOM_CLOSED" });
      this.emitRoom(room, "game_over", { winnerId: "", winnerName: "", finalCard: "joker" });
      this.broadcastState(room);
      this.persist("game-admin-terminate", this.d.store.games.finish(
        gameId,
        { status: "abandoned", winnerId: null, finishedAt: new Date(room.finishedAt), endedByAdmin: admin },
        {},
      ));
      this.d.log.warn("game terminated by admin", { game: gameId, adminId: admin.adminId });
      return { ok: true };
    }
    return { ok: false, code: "NOT_FOUND", message: "No live game with that id." };
  }

  /** Pauses a live match (turn timers stop). Returns false when the game is not running. */
  adminPauseGame(gameId: string, reason: string): boolean {
    for (const room of this.rooms.values()) {
      const s = room.session;
      if (s?.gameId !== gameId || s.finished || room.status !== "playing" || room.pausedFor) continue;
      this.clearTurnTimers(room);
      // The current player is the one "held", so an existing client-side resume stays coherent.
      room.pausedFor = s.currentPlayerId;
      this.emitRoom(room, "game_paused", { playerId: s.currentPlayerId, secondsLeft: 0 });
      this.emitRoom(room, "server_notice", { message: `An administrator paused this game. ${reason}`.trim() });
      this.broadcastState(room);
      return true;
    }
    return false;
  }

  adminResumeGame(gameId: string): boolean {
    for (const room of this.rooms.values()) {
      const s = room.session;
      if (s?.gameId !== gameId || !room.pausedFor || s.finished) continue;
      room.pausedFor = null;
      this.scheduleTurn(room);
      this.emitRoom(room, "game_resumed");
      this.broadcastState(room);
      return true;
    }
    return false;
  }

  /**
   * Hidden live state (all hands + Joker location). SUPER_ADMIN + GAME_DEBUG_READ only,
   * and every read is written to the audit log by the route.
   */
  debugSnapshot(gameId: string): unknown | null {
    for (const room of this.rooms.values()) {
      if (room.session?.gameId !== gameId) continue;
      const s = room.session;
      return {
        gameId, roomCode: room.code, status: room.status,
        currentPlayerId: s.currentPlayerId, drawCount: s.state.drawCount,
        paused: Boolean(room.pausedFor), finished: s.finished,
        hands: s.state.players.map((p) => ({
          id: p.id, name: p.name, cards: p.hand.map((c) => ({ id: c.id, rank: c.rank, isJoker: c.isJoker })),
        })),
        discardedPairs: s.state.discardedPairs,
      };
    }
    return null;
  }

  /** Test/debug only – never exposed through any API. */
  _debugSession(code: string): GameSession | null {
    return this.rooms.get(code)?.session ?? null;
  }

  /** Test/debug only – the server-side slot table, for asserting the mapping is never sent out. */
  _debugSlots(code: string): SlotTable | null {
    return this.rooms.get(code)?.slots ?? null;
  }
}

export type { ErrorCode };
