import { useEffect, useState } from "react";
import type { GameSettings, SystemSettings } from "@old-maid/shared";
import { AdminLayout, Card, ConfirmAction, Loading, Notice } from "../AdminLayout";
import { useAdminApi } from "../context";
import type { SettingsResponse } from "../adminApi";

type Tab = "game" | "system" | "features" | "ai";

export function AdminSettings() {
  const api = useAdminApi();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [tab, setTab] = useState<Tab>("game");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const reload = (): void => {
    api.settings().then((s) => { setData(s); setDirty(false); }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(reload, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const canWrite = api.can("SETTINGS_WRITE");
  const mutate = (fn: (s: SettingsResponse["settings"]) => SettingsResponse["settings"]): void => {
    if (!data) return;
    setData({ ...data, settings: fn(data.settings) });
    setDirty(true);
  };

  const save = async (reason: string, key: Tab): Promise<void> => {
    if (!data) return;
    const map: Record<Tab, unknown> = {
      game: data.settings.game, system: data.settings.system, features: data.settings.features, ai: data.settings.ai,
    };
    await api.putSettings(key, map[key], reason);
    setOk("Settings saved and validated by the server.");
    reload();
  };

  return (
    <AdminLayout title="Settings">
      {error && <Notice>{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {!data && !error && <Loading />}

      {data && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {(["game", "system", "features", "ai"] as Tab[]).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)}
                className={`min-h-[44px] border px-4 text-xs uppercase tracking-[0.15em] ${tab === t ? "border-ember bg-blood/40 text-bone" : "border-bone/25 text-dim"}`}>
                {t === "features" ? "Feature flags" : t === "ai" ? "AI" : t}
              </button>
            ))}
          </div>

          {tab === "game" && <GameSettingsTab value={data.settings.game as unknown as GameSettings} canWrite={canWrite} mutate={mutate} />}
          {tab === "system" && <SystemTab value={data.settings.system as unknown as SystemSettings} canWrite={canWrite} mutate={mutate} />}
          {tab === "features" && <FeaturesTab value={data.settings.features} canWrite={canWrite} mutate={mutate} />}
          {tab === "ai" && <AiTab value={data.settings.ai as Record<string, unknown>} canWrite={canWrite} mutate={mutate} />}

          {canWrite && (
            <div className="sticky bottom-0 mt-4 border border-bone/20 bg-ink/95 p-3 backdrop-blur">
              <ConfirmAction label={dirty ? "Save changes" : "Save"} title="Save settings?"
                description="Values are validated by the server before they are applied. Runtime changes affect new games immediately; matches already in progress keep the settings they started with."
                confirmLabel="Save" disabled={!dirty}
                onConfirm={async (reason) => save(reason, tab)} />
            </div>
          )}
          {!canWrite && <p className="mt-4 text-xs text-dim">Your role can read settings but not change them.</p>}
        </>
      )}
    </AdminLayout>
  );
}

type Mutate = (fn: (s: SettingsResponse["settings"]) => SettingsResponse["settings"]) => void;

function GameSettingsTab({ value, canWrite, mutate }: { value: GameSettings; canWrite: boolean; mutate: Mutate }) {
  const set = <K extends keyof GameSettings>(k: K, v: GameSettings[K]): void =>
    mutate((s) => ({ ...s, game: { ...(s.game as unknown as GameSettings), [k]: v } }));
  return (
    <Card title="Game rules">
      <div className="grid gap-3 sm:grid-cols-2">
        <Num label="Minimum players" value={value.minPlayers} min={2} max={7} disabled={!canWrite} onChange={(v) => set("minPlayers", v)} />
        <Num label="Maximum players" value={value.maxPlayers} min={2} max={7} disabled={!canWrite} onChange={(v) => set("maxPlayers", v)} />
        <Num label="Turn timeout (s)" value={value.turnTimeoutSec} min={10} max={600} disabled={!canWrite} onChange={(v) => set("turnTimeoutSec", v)} />
        <Num label="Reconnect timeout (s)" value={value.reconnectTimeoutSec} min={10} max={600} disabled={!canWrite} onChange={(v) => set("reconnectTimeoutSec", v)} />
        <Num label="Room expiration (s)" value={value.roomExpirationSec} min={60} max={86400} disabled={!canWrite} onChange={(v) => set("roomExpirationSec", v)} />
        <label className="block text-xs uppercase tracking-[0.15em] text-dim">
          Default AI difficulty
          <select disabled={!canWrite} value={value.defaultAiDifficulty} onChange={(e) => set("defaultAiDifficulty", e.target.value as GameSettings["defaultAiDifficulty"])}
            className="mt-1 min-h-[44px] w-full border border-bone/25 bg-transparent px-2 text-sm normal-case tracking-normal text-bone disabled:opacity-50">
            {["easy", "normal", "hard"].map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <Bool label="AI fill allowed" value={value.allowAiFill} disabled={!canWrite} onChange={(v) => set("allowAiFill", v)} />
        <Bool label="Chat enabled" value={value.chatEnabled} disabled={!canWrite} onChange={(v) => set("chatEnabled", v)} />
        <Bool label="Emotes enabled" value={value.emotesEnabled} disabled={!canWrite} onChange={(v) => set("emotesEnabled", v)} />
        <Bool label="Spectators enabled" value={value.spectatorsEnabled} disabled={!canWrite} onChange={(v) => set("spectatorsEnabled", v)} />
      </div>
      <p className="mt-4 text-xs text-dim">
        The deck is always 52 cards plus exactly one Joker, and the Joker holder wins. These values cannot change that rule.
      </p>
    </Card>
  );
}

function SystemTab({ value, canWrite, mutate }: { value: SystemSettings; canWrite: boolean; mutate: Mutate }) {
  const set = <K extends keyof SystemSettings>(k: K, v: SystemSettings[K]): void =>
    mutate((s) => ({ ...s, system: { ...(s.system as unknown as SystemSettings), [k]: v } }));
  return (
    <Card title="System">
      <label className="mb-3 block text-xs uppercase tracking-[0.15em] text-dim">
        Application name
        <input disabled={!canWrite} value={value.applicationName} maxLength={60}
          onChange={(e) => set("applicationName", e.target.value)}
          className="mt-1 min-h-[44px] w-full border border-bone/25 bg-transparent px-2 text-sm normal-case tracking-normal text-bone disabled:opacity-50" />
      </label>
      <label className="mb-3 block text-xs uppercase tracking-[0.15em] text-dim">
        Maintenance message
        <textarea disabled={!canWrite} value={value.maintenanceMessage} rows={2} maxLength={300}
          onChange={(e) => set("maintenanceMessage", e.target.value)}
          className="mt-1 w-full border border-bone/25 bg-transparent p-2 text-sm normal-case tracking-normal text-bone disabled:opacity-50" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Bool label="Maintenance mode" value={value.maintenanceMode} disabled={!canWrite} onChange={(v) => set("maintenanceMode", v)} />
        <Bool label="Allow new games" value={value.allowNewGames} disabled={!canWrite} onChange={(v) => set("allowNewGames", v)} />
        <Bool label="Allow registrations" value={value.allowRegistrations} disabled={!canWrite} onChange={(v) => set("allowRegistrations", v)} />
        <Bool label="Keep running games in maintenance" value={value.allowExistingGamesInMaintenance} disabled={!canWrite} onChange={(v) => set("allowExistingGamesInMaintenance", v)} />
        <Num label="Session timeout (min)" value={value.sessionTimeoutMin} min={5} max={43200} disabled={!canWrite} onChange={(v) => set("sessionTimeoutMin", v)} />
      </div>
      <p className="mt-4 text-xs text-dim">Maintenance mode stops new online games. Offline AI play is unaffected.</p>
    </Card>
  );
}

function FeaturesTab({ value, canWrite, mutate }: { value: Record<string, boolean>; canWrite: boolean; mutate: Mutate }) {
  return (
    <Card title="Feature flags">
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(value).map(([k, v]) => (
          <Bool key={k} label={k.replace(/([A-Z])/g, " $1")} value={v} disabled={!canWrite}
            onChange={(nv) => mutate((s) => ({ ...s, features: { ...s.features, [k]: nv } }))} />
        ))}
      </div>
      <p className="mt-4 text-xs text-dim">Flags are enforced server-side; the client mirrors them but cannot override them.</p>
    </Card>
  );
}

function AiTab({ value, canWrite, mutate }: { value: Record<string, unknown>; canWrite: boolean; mutate: Mutate }) {
  const set = (k: string, v: unknown): void => mutate((s) => ({ ...s, ai: { ...s.ai, [k]: v } }));
  return (
    <Card title="AI tuning">
      <div className="grid gap-3 sm:grid-cols-2">
        <Bool label="AI enabled" value={Boolean(value["enabled"])} disabled={!canWrite} onChange={(v) => set("enabled", v)} />
        <Num label="Thinking delay (ms)" value={Number(value["thinkingDelayMs"] ?? 0)} min={0} max={5000} disabled={!canWrite} onChange={(v) => set("thinkingDelayMs", v)} />
        <Num label="Aggressiveness (0–1)" value={Number(value["aggressiveness"] ?? 0)} min={0} max={1} step={0.05} disabled={!canWrite} onChange={(v) => set("aggressiveness", v)} />
        <Num label="Memory (0–1)" value={Number(value["memory"] ?? 0)} min={0} max={1} step={0.05} disabled={!canWrite} onChange={(v) => set("memory", v)} />
      </div>
    </Card>
  );
}

function Num({ label, value, min, max, step, disabled, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onChange(v: number): void;
}) {
  return (
    <label className="block text-xs uppercase tracking-[0.15em] text-dim">
      {label}
      <input type="number" value={value} min={min} max={max} step={step ?? 1} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 min-h-[44px] w-full border border-bone/25 bg-transparent px-2 text-sm normal-case tracking-normal text-bone disabled:opacity-50" />
    </label>
  );
}
function Bool({ label, value, disabled, onChange }: { label: string; value: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex min-h-[44px] items-center justify-between gap-3 border border-bone/15 px-3 text-xs uppercase tracking-[0.15em] text-dim">
      {label}
      <input type="checkbox" role="switch" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-10 cursor-pointer appearance-none rounded-full border border-bone/40 bg-ink transition checked:border-ember checked:bg-blood disabled:opacity-50" />
    </label>
  );
}