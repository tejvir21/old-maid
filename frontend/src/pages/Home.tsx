import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useServices } from "../app/context";
import { StatusBar } from "../components/StatusBar";
import { useInstall } from "../hooks/useInstall";
import { useNetStore } from "../store/ui";

export function Home() {
  const svc = useServices();
  const nav = useNavigate();
  const net = useNetStore();
  const [saved, setSaved] = useState(false);
  const [maint, setMaint] = useState<string | null>(null);
  const install = useInstall();

  useEffect(() => { void svc.hasActiveOffline().then(setSaved); }, [svc]);
  useEffect(() => {
    // Best-effort: only asked while online and not mid-offline-game.
    if (net.state !== "online" || net.suspended) { setMaint(null); return; }
    void svc.api.config().then((c) => setMaint(c.maintenance.enabled ? c.maintenance.message : null)).catch(() => undefined);
  }, [svc, net.state, net.suspended]);

  const offline = net.state !== "online";
  return (
    <div className="room flex min-h-full flex-col">
      <StatusBar />
      <main className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
        <div>
          <h1 className="title-display text-6xl text-bone sm:text-7xl" style={{ textShadow: "0 0 40px rgb(var(--c-blood) / 0.8)" }}>Old Maid</h1>
          <p className="mt-4 text-xs uppercase tracking-[0.35em] text-dim">A game of memory, deception and chance.</p>
        </div>
        {maint && <p role="alert" className="border border-ember/60 bg-blood/20 px-4 py-2 text-xs uppercase tracking-[0.2em]">{maint}</p>}
        <nav aria-label="Main menu" className="flex w-full flex-col gap-3">
          {saved && <button type="button" className="btn btn-primary" onClick={() => void svc.resumeOffline().then((ok) => ok && nav("/offline/play"))}>Continue game</button>}
          <button type="button" className="btn btn-primary" onClick={() => nav("/online")} disabled={offline && !svc.net.snapshot.suspended && net.state === "offline"} aria-describedby={offline ? "online-hint" : undefined}>Play online</button>
          {offline && <p id="online-hint" className="-mt-1 text-[11px] uppercase tracking-[0.2em] text-dim">Online play needs a connection.</p>}
          <button type="button" className="btn" onClick={() => nav("/offline")}>Play offline</button>
          <Link to="/rules" className="btn">How to play</Link>
          <div className="grid grid-cols-2 gap-3">
            <Link to="/settings" className="btn">Settings</Link>
            <Link to="/stats" className="btn">Stats</Link>
          </div>
          {install.canInstall && <button type="button" className="btn" onClick={() => void install.install()}>Install app</button>}
        </nav>
      </main>
    </div>
  );
}
