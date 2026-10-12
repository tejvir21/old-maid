import { Link } from "react-router-dom";
import { useNetStore, useSyncStore } from "../store/ui";
import { useServices } from "../app/context";

export function NetBadge() {
  const net = useNetStore();
  // "blocked" is a browser-side refusal (Brave Shields / an extension), NOT a dead server, and
  // is labelled differently so the user knows to allow the site rather than wait for a restart.
  const label = net.suspended
    ? "OFFLINE MODE"
    : net.state === "online"
      ? "ONLINE"
      : net.state === "offline"
        ? "OFFLINE"
        : net.state === "blocked"
          ? "REQUEST BLOCKED"
          : "SERVER UNREACHABLE";
  const up = net.state === "online" && !net.suspended;
  const tone = net.state === "blocked" ? "text-dim" : up ? "text-bone" : "text-ember";
  const title =
    net.state === "blocked"
      ? "Your browser is blocking requests to the game server. Allow this site in Brave Shields or your ad-blocker, then reload. Offline play is unaffected."
      : net.state === "unreachable"
        ? "Could not reach the game server. Retrying with backoff; offline play is unaffected."
        : undefined;
  return (
    <span
      role="status" title={title} aria-label={`Network: ${label}`}
      className={`inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.25em] ${tone}`}
    >
      <span aria-hidden>{up ? "●" : "○"}</span>
      {label}
    </span>
  );
}

export function SyncBadge() {
  const s = useSyncStore();
  const net = useNetStore();
  let text: string | null = null;
  if (s.state === "syncing") text = `SYNCING… ${s.done} / ${s.total} COMPLETE`;
  else if (s.failed > 0 && s.pending === 0) text = `${s.failed} item${s.failed === 1 ? "" : "s"} rejected by the server`;
  else if (s.pending > 0 && (net.state !== "online" || net.suspended)) text = `${s.pending} game${s.pending === 1 ? "" : "s"} waiting to sync`;
  else if (s.pending > 0 && s.state === "error") text = `${s.pending} item${s.pending === 1 ? "" : "s"} could not sync. Will retry automatically.`;
  else if (s.pending > 0) text = `${s.pending} waiting to sync`;
  else if (s.lastSyncAt) text = "✓ All data synchronized";
  if (!text) return null;
  return <span role="status" className="text-[11px] uppercase tracking-[0.2em] text-dim">{text}</span>;
}

export function StatusBar({ back }: { back?: boolean }) {
  const svc = useServices();
  const s = useSyncStore();
  return (
    <header className="relative z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
      {back ? <Link to="/" className="text-xs uppercase tracking-[0.3em] text-dim hover:text-bone">← Menu</Link> : <span />}
      <div className="flex flex-col items-end gap-0.5">
        <NetBadge />
        <SyncBadge />
        {s.state === "error" && s.pending > 0 && (
          <button type="button" className="text-[11px] uppercase tracking-[0.2em] text-ember underline" onClick={() => void svc.sync.run()}>Retry now</button>
        )}
      </div>
    </header>
  );
}
