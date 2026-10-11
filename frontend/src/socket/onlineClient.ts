import { io, type Socket } from "socket.io-client";
import type { Ack, Card, ChatMessagePayload, PlayerView } from "@old-maid/shared";

export type ConnStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface OnlineHandlers {
  status(s: ConnStatus): void;
  view(v: PlayerView, cause: "room_state" | "game_started"): void;
  cardDrawn(p: { card: Card; pairFormed: boolean; pairCards: [Card, Card] | null; fromPlayerId: string }): void;
  drawPublic(p: { actorId: string; targetId: string; cardIndex: number; pairFormed: boolean; seq: number }): void;
  pairFormed(p: { playerId: string }): void;
  gameOver(p: { winnerId: string; winnerName: string; finalCard: "joker" }): void;
  paused(p: { playerId: string; secondsLeft: number }): void;
  resumed(): void;
  chat(m: ChatMessagePayload): void;
  emote(p: { playerId: string; emote: string }): void;
  notice(p: { message: string; code?: string }): void;
  presence(p: { kind: "joined" | "left" | "disconnected" | "reconnected" | "host"; playerId: string; name: string }): void;
  authFailed(reason: string): void;
}

export interface OnlineClientOptions {
  url: string;
  /** `force` = the previous token was rejected; fetch a fresh one. */
  getToken(force: boolean): Promise<string>;
  handlers: OnlineHandlers;
  ioImpl?: typeof io;
  transports?: string[];
}

type AckFn<T> = (r: Ack<T>) => void;
interface RawSocket {
  on(e: string, cb: (...a: never[]) => void): unknown;
  emit(e: string, ...a: unknown[]): unknown;
  io: { on(e: string, cb: (...a: never[]) => void): unknown };
}

/**
 * Transport only. It sends *requests* and relays what the server decides. It holds no game rules
 * and never computes a card, a winner, a turn or another player's hand.
 */
export class OnlineClient {
  private socket: Socket | null = null;
  private forceToken = false;
  private authRetries = 0;
  private kicked = false;
  private status: ConnStatus = "disconnected";

  constructor(private readonly o: OnlineClientOptions) {}

  get connected(): boolean { return this.status === "connected"; }
  get currentStatus(): ConnStatus { return this.status; }

  private setStatus(s: ConnStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.o.handlers.status(s);
  }

  connect(): void {
    if (this.socket) {
      if (!this.socket.connected) this.socket.connect();
      return;
    }
    this.kicked = false;
    const h = this.o.handlers;
    const factory = this.o.ioImpl ?? io;
    const socket = factory(this.o.url, {
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      ...(this.o.transports ? { transports: this.o.transports } : {}),
      auth: (cb: (d: object) => void) => {
        const force = this.forceToken;
        this.forceToken = false;
        this.o.getToken(force).then((token) => cb({ token })).catch(() => cb({ token: "" }));
      },
    });
    this.socket = socket;
    const raw = socket as unknown as RawSocket;
    this.setStatus("connecting");

    raw.on("connect", () => { this.authRetries = 0; this.setStatus("connected"); });
    raw.on("connect_error", ((err: Error) => {
      const msg = err.message;
      if (msg === "UNAUTHORIZED" && this.authRetries < 2) {
        this.authRetries++;
        this.forceToken = true; // token rejected → mint a new one and try again
        setTimeout(() => socket.connect(), 50);
        return;
      }
      if (msg === "UNAUTHORIZED" || msg === "BANNED") {
        this.setStatus("disconnected");
        h.authFailed(msg);
        return;
      }
      this.setStatus(this.status === "connected" ? "reconnecting" : "connecting");
    }) as never);
    raw.on("disconnect", ((reason: string) => {
      if (reason === "io client disconnect" || this.kicked) { this.setStatus("disconnected"); return; }
      this.setStatus("reconnecting"); // transport loss: socket.io retries automatically
    }) as never);
    raw.io.on("reconnect_attempt", (() => { if (!this.kicked) this.setStatus("reconnecting"); }) as never);

    raw.on("room_state", ((v: PlayerView) => h.view(v, "room_state")) as never);
    raw.on("game_started", ((v: PlayerView) => h.view(v, "game_started")) as never);
    raw.on("card_drawn", ((p: never) => h.cardDrawn(p)) as never);
    raw.on("draw_public", ((p: never) => h.drawPublic(p)) as never);
    raw.on("pair_formed", ((p: never) => h.pairFormed(p)) as never);
    raw.on("game_over", ((p: never) => h.gameOver(p)) as never);
    raw.on("game_paused", ((p: never) => h.paused(p)) as never);
    raw.on("game_resumed", (() => h.resumed()) as never);
    raw.on("chat_message", ((m: ChatMessagePayload) => h.chat(m)) as never);
    raw.on("emote", ((p: never) => h.emote(p)) as never);
    raw.on("server_notice", ((p: { message: string; code?: string }) => {
      if (p.code === "TAKEOVER") { this.kicked = true; socket.disconnect(); }
      h.notice(p);
    }) as never);
    for (const [ev, kind] of [["player_joined", "joined"], ["player_left", "left"], ["player_disconnected", "disconnected"], ["player_reconnected", "reconnected"], ["host_transferred", "host"]] as const) {
      raw.on(ev, ((p: { playerId: string; name: string }) => h.presence({ kind, playerId: p.playerId, name: p.name })) as never);
    }
    socket.connect();
  }

  disconnect(): void {
    this.kicked = false;
    this.socket?.disconnect();
    this.socket?.removeAllListeners();
    this.socket = null;
    this.setStatus("disconnected");
  }

  private request<T>(event: string, payload?: unknown, timeoutMs = 8000): Promise<Ack<T>> {
    return new Promise((resolve) => {
      const s = this.socket as unknown as RawSocket | null;
      if (!s || !this.connected) {
        resolve({ ok: false, error: { code: "INTERNAL", message: "Not connected to the server." } });
        return;
      }
      const t = setTimeout(() => resolve({ ok: false, error: { code: "INTERNAL", message: "The server did not respond." } }), timeoutMs);
      const ack: AckFn<T> = (r) => { clearTimeout(t); resolve(r); };
      if (payload === undefined) s.emit(event, ack);
      else s.emit(event, payload, ack);
    });
  }

  createRoom(playerName: string) { return this.request<{ roomCode: string; playerId: string }>("create_room", { playerName }); }
  joinRoom(roomCode: string, playerName: string) { return this.request<{ roomCode: string; playerId: string }>("join_room", { roomCode, playerName }); }
  resume() { return this.request<{ roomCode: string; playerId: string }>("resume_session"); }
  leaveRoom() { return this.request<object>("leave_room"); }
  startGame(opts: { fillWithAi?: boolean; aiDifficulty?: "easy" | "normal" | "hard" }) { return this.request<object>("start_game", opts); }
  requestDraw(p: { targetPlayerId: string; cardIndex: number; turnId: number; actionId: string }) { return this.request<object>("request_draw", p); }
  chat(text: string) { return this.request<object>("chat_message", { text }); }
  emote(emote: string) { return this.request<object>("emote", { emote }); }
  rematch() { return this.request<object>("rematch"); }
  endMatch() { return this.request<object>("end_match"); }
}
