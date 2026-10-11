import { createStore, type StoreApi } from "zustand/vanilla";
import type { Card, ChatMessagePayload, PlayerView } from "@old-maid/shared";
import { newId } from "../offline/ids";
import { OnlineClient, type ConnStatus, type OnlineClientOptions } from "../socket/onlineClient";

export interface RevealedCard { card: Card; pairFormed: boolean; pairCards: [Card, Card] | null; fromPlayerId: string; at: number }
export interface PublicDraw { actorId: string; targetId: string; cardIndex: number; pairFormed: boolean; seq: number }

export interface OnlineState {
  conn: ConnStatus;
  /** The ONLY game data the browser ever has: what the server's buildView() chose to send. */
  view: PlayerView | null;
  revealed: RevealedCard | null;
  lastDraw: PublicDraw | null;
  pendingDraw: boolean;
  gameOver: { winnerId: string; winnerName: string } | null;
  chat: ChatMessagePayload[];
  emotes: { playerId: string; emote: string; at: number }[];
  notices: { id: string; message: string; code?: string }[];
  error: string | null;
  authFailed: boolean;
  /** Last pause message seen (game_paused events carry a fresh countdown). */
  pause: { playerId: string; secondsLeft: number; receivedAt: number } | null;
}

const initial = (): OnlineState => ({
  conn: "disconnected", view: null, revealed: null, lastDraw: null, pendingDraw: false, gameOver: null,
  chat: [], emotes: [], notices: [], error: null, authFailed: false, pause: null,
});

export type OnlineStore = StoreApi<OnlineState>;

export interface OnlineController {
  store: OnlineStore;
  client: OnlineClient;
  connect(): void;
  disconnect(): void;
  createRoom(name: string): Promise<string | null>;
  joinRoom(code: string, name: string): Promise<string | null>;
  leave(): Promise<void>;
  start(fillWithAi: boolean, level?: "easy" | "normal" | "hard"): Promise<string | null>;
  draw(targetId: string, cardIndex: number): Promise<string | null>;
  sendChat(text: string): Promise<void>;
  emote(e: string): Promise<void>;
  rematch(): Promise<string | null>;
  endMatch(): Promise<string | null>;
  clearReveal(): void;
  dismissNotice(id: string): void;
}

export function createOnlineController(opts: Omit<OnlineClientOptions, "handlers">): OnlineController {
  const store = createStore<OnlineState>(() => initial());
  const set = store.setState;
  const get = store.getState;
  const note = (message: string, code?: string) =>
    set((s) => ({ notices: [...s.notices.slice(-4), { id: newId(), message, ...(code ? { code } : {}) }] }));

  const client = new OnlineClient({
    ...opts,
    handlers: {
      status: (conn) => set({ conn }),
      view: (view, cause) => set((s) => {
        const fresh = cause === "game_started" || view.status === "waiting";
        const winnerId = view.result?.winnerId ?? null;
        return {
          view,
          pendingDraw: false,
          ...(fresh ? { revealed: null, lastDraw: null } : {}),
          // the result is part of every later view, so a reconnect restores the final screen too
          gameOver: winnerId
            ? { winnerId, winnerName: view.players.find((p) => p.id === winnerId)?.name ?? "" }
            : fresh ? null : s.gameOver,
        };
      }),
      cardDrawn: (p) => set({ revealed: { ...p, at: Date.now() }, pendingDraw: false }),
      drawPublic: (lastDraw) => set({ lastDraw }),
      pairFormed: () => undefined,
      gameOver: (p) => set({ gameOver: { winnerId: p.winnerId, winnerName: p.winnerName } }),
      paused: (p) => set({ pause: { ...p, receivedAt: Date.now() } }),
      resumed: () => set({ pause: null }),
      chat: (m) => set((s) => ({ chat: [...s.chat.slice(-99), m] })),
      emote: (e) => set((s) => ({ emotes: [...s.emotes.slice(-9), { ...e, at: Date.now() }] })),
      notice: (p) => note(p.message, p.code),
      presence: (p) => {
        const text = { joined: `${p.name} joined.`, left: `${p.name} left.`, disconnected: `${p.name} disconnected.`, reconnected: `${p.name} reconnected.`, host: `${p.name} is now the host.` }[p.kind];
        note(text);
      },
      authFailed: (reason) => set({ authFailed: true, error: reason === "BANNED" ? "This account is not allowed to play online." : "Could not sign in." }),
    },
  });

  const fail = (r: { ok: boolean; error?: { message: string } }): string | null => {
    if (r.ok) { set({ error: null }); return null; }
    const m = r.error?.message ?? "Something went wrong.";
    set({ error: m });
    return m;
  };

  return {
    store, client,
    connect: () => client.connect(),
    disconnect: () => { client.disconnect(); set({ ...initial() }); },
    async createRoom(name) { const r = await client.createRoom(name); return fail(r); },
    async joinRoom(code, name) { const r = await client.joinRoom(code, name); return fail(r); },
    async leave() { await client.leaveRoom(); set({ view: null, gameOver: null, revealed: null, lastDraw: null, pause: null, chat: [] }); },
    async start(fill, level) { return fail(await client.startGame({ fillWithAi: fill, ...(level ? { aiDifficulty: level } : {}) })); },
    async draw(targetId, cardIndex) {
      const v = get().view;
      if (!v?.game) return "No game in progress.";
      set({ pendingDraw: true });
      // The server decides everything; we only name a target and a position, tagged for duplicate protection.
      const r = await client.requestDraw({ targetPlayerId: targetId, cardIndex, turnId: v.game.turnId, actionId: newId() });
      if (!r.ok) set({ pendingDraw: false });
      return fail(r);
    },
    async sendChat(text) { await client.chat(text); },
    async emote(e) { await client.emote(e); },
    async rematch() { return fail(await client.rematch()); },
    async endMatch() { return fail(await client.endMatch()); },
    clearReveal: () => set({ revealed: null }),
    dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  };
}
