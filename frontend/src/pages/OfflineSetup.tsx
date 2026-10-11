import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useServices } from "../app/context";
import { Page, Segmented } from "../components/Page";
import { useOfflineUi, useSettingsStore } from "../store/ui";
import type { AiLevel } from "@old-maid/shared";

export function OfflineSetup() {
  const svc = useServices();
  const nav = useNavigate();
  const { values, update } = useSettingsStore();
  const [name, setName] = useState("Player");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void svc.repo.getProfile().then((p) => setName(p.displayName));
    void svc.hasActiveOffline().then(setSaved);
  }, [svc]);

  const start = async () => {
    setBusy(true);
    useOfflineUi.getState().reset();
    const profile = await svc.repo.getProfile();
    await svc.startOffline({ humanName: name.trim() || "Player", aiCount: values.aiPlayers, level: values.aiDifficulty, localPlayerId: profile.localPlayerId }, { hold: true });
    nav("/offline/play", { state: { intro: true } });
  };

  return (
    <Page title="Play offline">
      <p className="mb-4 text-sm text-dim">Works with no connection. Your result is saved on this device and synced later.</p>
      {saved && (
        <div className="mb-4 flex items-center justify-between gap-3 border border-ember/50 bg-blood/20 p-3">
          <span className="text-xs uppercase tracking-[0.2em]">A game is in progress</span>
          <button type="button" className="btn btn-primary !min-h-[40px]" onClick={() => void svc.resumeOffline().then((ok) => ok && nav("/offline/play"))}>Continue</button>
        </div>
      )}
      <div className="border-b border-bone/10 py-3">
        <label htmlFor="pname" className="mb-2 block text-sm uppercase tracking-[0.2em]">Your name</label>
        <input id="pname" value={name} onChange={(e) => setName(e.target.value)} maxLength={16} className="min-h-[48px] w-full border border-bone/30 bg-ink px-3 text-bone" />
      </div>
      <Segmented label="AI opponents" value={values.aiPlayers} onChange={(v) => void update(svc.repo, { aiPlayers: v })} options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))} />
      <Segmented<AiLevel> label="Difficulty" value={values.aiDifficulty} onChange={(v) => void update(svc.repo, { aiDifficulty: v })} options={[{ value: "easy", label: "Easy" }, { value: "normal", label: "Normal" }, { value: "hard", label: "Hard" }]} />
      <p className="mt-3 text-xs text-dim">{values.aiPlayers + 1} players · one Joker · only one can win. {saved && "Starting a new game discards the one in progress."}</p>
      <button type="button" className="btn btn-primary mt-6 w-full" onClick={() => void start()} disabled={busy || name.trim().length < 2}>Start game</button>
    </Page>
  );
}
