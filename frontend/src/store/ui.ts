import { create } from "zustand";
import type { Card } from "@old-maid/shared";
import type { AiStepResult, HumanDrawResult, OfflineGame } from "../game/offlineGame";
import type { SessionUpdate } from "../game/offlineSession";
import type { NetSnapshot } from "../net/network";
import type { Repo } from "../offline/db";
import { DEFAULT_SETTINGS, type OfflineGameRecord, type Settings } from "../offline/types";
import type { SyncStatus } from "../sync/syncEngine";

export const useNetStore = create<NetSnapshot>(() => ({ state: "online", suspended: false }));

export const useSyncStore = create<SyncStatus>(() => ({
  state: "idle", pending: 0, syncing: 0, failed: 0, done: 0, total: 0, lastSyncAt: null, lastError: null,
}));

interface SettingsState {
  values: Settings;
  ready: boolean;
  init(repo: Repo): Promise<void>;
  update(repo: Repo, patch: Partial<Settings>): Promise<void>;
}
export const useSettingsStore = create<SettingsState>((set) => ({
  values: DEFAULT_SETTINGS,
  ready: false,
  async init(repo) {
    const s = await repo.getSettings();
    set({ values: s.values, ready: true });
  },
  async update(repo, patch) {
    set((st) => ({ values: { ...st.values, ...patch } })); // optimistic: UI never waits on disk
    const s = await repo.saveSettings(patch);
    set({ values: s.values });
  },
}));

export interface RevealState {
  card: Card;
  pairFormed: boolean;
  pairCards: [Card, Card] | null;
  fromName: string;
  key: number;
}
export interface FlyState { fromId: string; toId: string; key: number }

interface OfflineUi {
  game: OfflineGame | null;
  /** Bumped on every update – OfflineGame is mutable, so components key off this. */
  version: number;
  thinking: boolean;
  reveal: RevealState | null;
  fly: FlyState | null;
  /** Seat showing a "pause" tell (deliberately unreliable). */
  reactionId: string | null;
  finished: { record: OfflineGameRecord; newAchievements: string[] } | null;
  apply(u: SessionUpdate): void;
  clearReveal(): void;
  reset(): void;
}

let key = 0;
export const useOfflineUi = create<OfflineUi>((set, get) => ({
  game: null, version: 0, thinking: false, reveal: null, fly: null, reactionId: null, finished: null,
  apply(u) {
    const g = u.game;
    const patch: Partial<OfflineUi> = { game: g, thinking: u.thinking, version: get().version + 1 };
    const hd: HumanDrawResult | undefined = u.humanDraw;
    if (hd && g) {
      patch.reveal = { card: hd.card, pairFormed: hd.pairFormed, pairCards: hd.pairCards, fromName: g.name(hd.targetId), key: ++key };
      patch.fly = { fromId: hd.targetId, toId: "human", key };
    }
    const ai: AiStepResult | undefined = u.aiStep;
    if (ai) {
      patch.fly = { fromId: ai.targetId, toId: ai.actorId, key: ++key };
      patch.reactionId = ai.reaction ? ai.actorId : null;
    }
    if (u.finished) patch.finished = u.finished;
    if (!g) { patch.finished = null; patch.reveal = null; patch.fly = null; patch.reactionId = null; }
    set(patch as OfflineUi);
  },
  clearReveal: () => set({ reveal: null }),
  reset: () => set({ game: null, reveal: null, fly: null, reactionId: null, finished: null, thinking: false }),
}));
