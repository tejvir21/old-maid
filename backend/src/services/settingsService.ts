import {
  DEFAULT_AI_SETTINGS, DEFAULT_FEATURE_FLAGS, DEFAULT_GAME_SETTINGS, DEFAULT_SYSTEM_SETTINGS,
  aiSettingsSchema, featureFlagsSchema, gameSettingsSchema, systemSettingsSchema,
  type AiSettings, type FeatureFlagName, type GameSettings, type SystemSettings,
} from "@old-maid/shared";
import type { SettingsKey, Store } from "../store/types.js";
import type { Logger } from "../util/logger.js";

/** Server-side source of truth for game/AI/system settings and feature flags (cached, validated). */
export class SettingsService {
  private game: GameSettings = { ...DEFAULT_GAME_SETTINGS };
  private ai: AiSettings = { ...DEFAULT_AI_SETTINGS };
  private system: SystemSettings = { ...DEFAULT_SYSTEM_SETTINGS };
  private flags: Record<FeatureFlagName, boolean> = { ...DEFAULT_FEATURE_FLAGS };

  constructor(private readonly store: Store, private readonly log: Logger) {}

  async load(): Promise<void> {
    const [g, a, s, f] = await Promise.all(
      (["game", "ai", "system", "features"] as SettingsKey[]).map((k) => this.store.settings.get(k)),
    );
    const apply = <T>(raw: unknown, parse: (v: unknown) => { success: boolean; data?: T }, fallback: T, name: string): T => {
      if (raw === undefined || raw === null) return fallback;
      const r = parse(raw);
      if (!r.success) {
        this.log.warn("stored settings invalid, using defaults", { name });
        return fallback;
      }
      return r.data as T;
    };
    this.game = apply(g?.value, (v) => gameSettingsSchema.safeParse(v), this.game, "game");
    this.ai = apply(a?.value, (v) => aiSettingsSchema.safeParse(v), this.ai, "ai");
    this.system = apply(s?.value, (v) => systemSettingsSchema.safeParse(v), this.system, "system");
    const stored = apply<Partial<Record<FeatureFlagName, boolean>>>(f?.value, (v) => featureFlagsSchema.safeParse(v) as { success: boolean; data?: Partial<Record<FeatureFlagName, boolean>> }, {}, "features");
    this.flags = { ...DEFAULT_FEATURE_FLAGS, ...stored };
  }

  getGame(): GameSettings { return this.game; }
  getAi(): AiSettings { return this.ai; }
  getSystem(): SystemSettings { return this.system; }
  getFlags(): Record<FeatureFlagName, boolean> { return this.flags; }
  isEnabled(flag: FeatureFlagName): boolean { return this.flags[flag]; }

  /** Used by the admin API (validated here, never trusted from callers). */
  async updateGame(value: unknown, by?: string): Promise<GameSettings> {
    const v = gameSettingsSchema.parse(value);
    await this.store.settings.set("game", v, by);
    this.game = v;
    return v;
  }
  async updateAi(value: unknown, by?: string): Promise<AiSettings> {
    const v = aiSettingsSchema.parse(value);
    await this.store.settings.set("ai", v, by);
    this.ai = v;
    return v;
  }
  async updateSystem(value: unknown, by?: string): Promise<SystemSettings> {
    const v = systemSettingsSchema.parse(value);
    await this.store.settings.set("system", v, by);
    this.system = v;
    return v;
  }
  async updateFlags(value: unknown, by?: string): Promise<Record<FeatureFlagName, boolean>> {
    const v = { ...this.flags, ...featureFlagsSchema.parse(value) } as Record<FeatureFlagName, boolean>;
    await this.store.settings.set("features", v, by);
    this.flags = v;
    return v;
  }

  /** True when new online rooms/games may be created right now. */
  onlineAvailable(): { ok: true } | { ok: false; code: "MAINTENANCE" | "FEATURE_DISABLED"; message: string } {
    if (!this.flags.onlineMultiplayer) return { ok: false, code: "FEATURE_DISABLED", message: "Online multiplayer is currently disabled." };
    if (this.system.maintenanceMode && !this.system.allowNewGames) return { ok: false, code: "MAINTENANCE", message: this.system.maintenanceMessage };
    if (!this.system.allowNewGames) return { ok: false, code: "MAINTENANCE", message: "New games are currently disabled." };
    return { ok: true };
  }
}
