import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "zustand";
import { useServices } from "../app/context";
import { Page } from "../components/Page";
import { useNetStore } from "../store/ui";

const CONN_TEXT = { connected: "● Connected", connecting: "○ Connecting…", reconnecting: "○ Reconnecting…", disconnected: "× Disconnected" } as const;

export function OnlineMenu() {
  const svc = useServices();
  const nav = useNavigate();
  const ctl = svc.online;
  const conn = useStore(ctl.store, (s) => s.conn);
  const view = useStore(ctl.store, (s) => s.view);
  const error = useStore(ctl.store, (s) => s.error);
  const authFailed = useStore(ctl.store, (s) => s.authFailed);
  const net = useNetStore();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void svc.repo.getProfile().then((p) => setName(p.displayName === "Player" ? "" : p.displayName)); }, [svc]);
  useEffect(() => { if (net.state !== "offline") ctl.connect(); }, [ctl, net.state]);
  // Already in a room (e.g. the page was reloaded mid-game)? The server restores it on connect.
  useEffect(() => { if (view) nav("/online/room", { replace: true }); }, [view, nav]);

  const offline = net.state === "offline";
  const ready = conn === "connected" && name.trim().length >= 2 && (mode === "create" || code.trim().length === 5);
  const submit = async () => {
    setBusy(true);
    await svc.repo.patchProfile({ displayName: name.trim() }, { sync: true });
    const err = mode === "create" ? await ctl.createRoom(name.trim()) : await ctl.joinRoom(code.trim().toUpperCase(), name.trim());
    setBusy(false);
    if (!err) nav("/online/room");
  };

  return (
    <Page title="Play online">
      {offline ? (
        <div role="alert" className="border border-ember/50 bg-blood/20 p-4 text-sm">
          <p className="uppercase tracking-[0.2em]">You're offline</p>
          <p className="mt-2 text-dim">Online play needs a connection. You can still play against AI — your results sync later.</p>
          <button type="button" className="btn btn-primary mt-4" onClick={() => nav("/offline")}>Play offline</button>
        </div>
      ) : (
        <>
          <p role="status" className={`mb-4 text-xs uppercase tracking-[0.25em] ${conn === "connected" ? "text-bone" : "text-ember"}`}>{CONN_TEXT[conn]}</p>
          {authFailed && <p role="alert" className="mb-4 border border-ember/50 p-3 text-sm">{error}</p>}
          <div className="mb-4 flex gap-2" role="tablist" aria-label="Room action">
            {(["create", "join"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`btn flex-1 ${mode === m ? "btn-primary" : ""}`}>{m === "create" ? "Create room" : "Join room"}</button>
            ))}
          </div>
          {mode === "join" && (
            <div className="mb-3">
              <label htmlFor="code" className="mb-2 block text-sm uppercase tracking-[0.2em]">Room code</label>
              <input id="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5))} placeholder="A7K9P" autoCapitalize="characters" autoComplete="off" inputMode="text" className="min-h-[52px] w-full border border-bone/30 bg-ink px-3 text-center text-2xl tracking-[0.5em] text-bone" />
            </div>
          )}
          <label htmlFor="oname" className="mb-2 block text-sm uppercase tracking-[0.2em]">Your name</label>
          <input id="oname" value={name} onChange={(e) => setName(e.target.value)} maxLength={16} placeholder="Ryuji" className="min-h-[48px] w-full border border-bone/30 bg-ink px-3 text-bone" />
          {error && !authFailed && <p role="alert" className="mt-3 text-sm text-ember">{error}</p>}
          <button type="button" className="btn btn-primary mt-5 w-full" disabled={!ready || busy} onClick={() => void submit()}>{mode === "create" ? "Create room" : "Join room"}</button>
          <p className="mt-6 text-xs text-dim">No account needed. The server deals and judges every move — you only ever see your own cards.</p>
        </>
      )}
    </Page>
  );
}
