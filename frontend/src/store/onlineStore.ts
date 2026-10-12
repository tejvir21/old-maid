import { createStore, type StoreApi } from "zustand/vanilla";
import type { Card, ChatMessagePayload, PlayerView } from "@old-maid/shared";
import { newId } from "../offline/ids";
import { OnlineClient, type ConnStatus, type OnlineClientOptions } from "../socket/onlineClient";

export interface RevealedCard { card: Card; pairFormed: boolean; pairCards: [Card, Card] | null; fromPlayerId: string; at: number }
/** Public draw notice. Carries NO card identity and NO hand index, by design. */
export interface PublicDraw { actorId: string; targetId: string; pairFormed: boolean; seq: number }

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
  /**
   * Opaque, server-issued slots for the current turn, valid only for `slotsTurnId`.
   * Never contains a card identity or a hand index.
   */
  drawSlots: { targetId: string; slots: string[] }[];
  slotsTurnId: number | null;
  /**
   * True when the server speaks a different wire protocol than this build.
   *
   * Frontend and backend deploy independently, so a browser can hold a build from a different
   * release. When that happens draws would fail with an opaque validation error and the UI
   * would have no slots to render, so we block play and ask the user to reload instead.
   */
  protocolSkewed: boolean;
}

const initial = (): OnlineState => ({
  conn: "disconnected", view: null, revealed: null, lastDraw: null, pendingDraw: false, gameOver: null,
  chat: [], emotes: [], notices: [], error: null, authFailed: false, pause: null,
  drawSlots: [], slotsTurnId: null, protocolSkewed: false,
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
  draw(targetId: string, choice: string): Promise<string | null>;
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
      cardDrawn: (p) => set({ revealed: { ...p, at: Date.now() }, pendingDraw: false, drawSlots: [], slotsTurnId: null }),
      drawPublic: (lastDraw) => set({ lastDraw }),
      // Slots are single-turn: they are dropped the instant the turn moves on.
      drawSlots: (p) => set({ drawSlots: p.targets.map((t) => ({ targetId: t.targetPlayerId, slots: t.slots })), slotsTurnId: p.turnId }),
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
    /**
     * Checks the server's protocol version before connecting.
     *
     * `checkProtocol` is optional so tests and the offline-only path can skip it; when absent
     * we simply connect. A skew is recorded in state and surfaced to the user, rather than
     * letting them discover it as an unexplained "Invalid draw request." mid-game.
     */
    connect: () => {
      const check = opts.checkProtocol?.() ?? Promise.resolve(false);
      void check.then((skewed) => {
        set({ protocolSkewed: skewed });
        if (skewed) {
          note("This app is out of date with the server. Reload the page to play online.", "PROTOCOL_SKEW");
          return;
        }
        client.connect();
      });
    },
    disconnect: () => { client.disconnect(); set({ ...initial() }); },
    async createRoom(name) { const r = await client.createRoom(name); return fail(r); },
    async joinRoom(code, name) { const r = await client.joinRoom(code, name); return fail(r); },
    async leave() { await client.leaveRoom(); set({ view: null, gameOver: null, revealed: null, lastDraw: null, pause: null, chat: [], drawSlots: [], slotsTurnId: null }); },
    async start(fill, level) { return fail(await client.startGame({ fillWithAi: fill, ...(level ? { aiDifficulty: level } : {}) })); },
    async draw(targetId, choice) {
      // Skew is checked first: it is the root cause and the most useful thing to report,
      // regardless of what view state happens to be present.
      if (get().protocolSkewed) return "Reload the page to play online.";
      const v = get().view;
      if (!v?.game) return "No game in progress.";
      if (v.game.turnId !== get().slotsTurnId) return "Wait for your cards.";
      set({ pendingDraw: true });
      // We send ONLY an opaque slot the server minted for this turn. The client never names a
      // card and never learns which hand index the slot resolved to.
      const r = await client.requestDraw({ targetPlayerId: targetId, slotId: choice, turnId: v.game.turnId, actionId: newId() });
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
