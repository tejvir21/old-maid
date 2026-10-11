import { useEffect, useState } from "react";
import { useServices } from "../app/context";
import { Page, Segmented, Toggle } from "../components/Page";
import { useInstall } from "../hooks/useInstall";
import { useSettingsStore } from "../store/ui";

export function Settings() {
  const svc = useServices();
  const { values, update } = useSettingsStore();
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const install = useInstall();
  useEffect(() => { void svc.repo.getProfile().then((p) => setName(p.displayName)); }, [svc]);
  const set = (patch: Partial<typeof values>) => void update(svc.repo, patch);

  const saveName = async () => {
    const n = name.trim();
    if (n.length < 2 || n.length > 16) return;
    await svc.repo.patchProfile({ displayName: n }, { sync: true });
    setSaved(true);
    void svc.sync.run();
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <Page title="Settings">
      <p className="mb-4 text-xs text-dim">Saved on this device and synced to your account when online (newest change wins).</p>
      <div className="border-b border-bone/10 py-3">
        <label htmlFor="name" className="mb-2 block text-sm uppercase tracking-[0.2em]">Your name</label>
        <div className="flex gap-2">
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={16} minLength={2} className="min-h-[48px] flex-1 border border-bone/30 bg-ink px-3 text-bone" />
          <button type="button" className="btn" onClick={() => void saveName()} disabled={name.trim().length < 2}>{saved ? "Saved" : "Save"}</button>
        </div>
      </div>
      <Toggle label="Sound effects" checked={values.sound} onChange={(v) => set({ sound: v })} />
      <Toggle label="Ambient music" hint="A low generated drone — no audio files." checked={values.music} onChange={(v) => set({ music: v })} />
      <Toggle label="Animations" hint="Turn off for a calmer, faster interface. Your system's reduced-motion setting is always respected." checked={values.animations} onChange={(v) => set({ animations: v })} />
      <Segmented label="Theme" value={values.theme} onChange={(v) => set({ theme: v })} options={[{ value: "dark", label: "Dark" }, { value: "ember", label: "Ember" }, { value: "contrast", label: "High contrast" }]} />
      <Segmented label="Card style" value={values.cardStyle} onChange={(v) => set({ cardStyle: v })} options={[{ value: "classic", label: "Classic" }, { value: "minimal", label: "Minimal" }]} />
      <Segmented label="Default AI difficulty" value={values.aiDifficulty} onChange={(v) => set({ aiDifficulty: v })} options={[{ value: "easy", label: "Easy" }, { value: "normal", label: "Normal" }, { value: "hard", label: "Hard" }]} />
      <Segmented label="Default AI opponents" value={values.aiPlayers} onChange={(v) => set({ aiPlayers: v })} options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))} />
      <Toggle label="Debug mode" hint="Offline games only: reveals every AI hand. Never available online." checked={values.debug} onChange={(v) => set({ debug: v })} />
      {install.canInstall && <button type="button" className="btn mt-6" onClick={() => void install.install()}>Install app</button>}
      {install.installed && <p className="mt-6 text-xs uppercase tracking-[0.2em] text-dim">✓ Installed</p>}
    </Page>
  );
}
