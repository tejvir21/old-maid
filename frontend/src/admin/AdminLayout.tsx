import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import type { Permission } from "@old-maid/shared";
import { useAdminApi, useAdminSession } from "./context";
import type { AdminProfile } from "./adminApi";

const NAV: { to: string; label: string; icon: string; need?: Permission; end?: boolean }[] = [
  { to: "/admin", label: "Dashboard", icon: "◧", end: true },
  { to: "/admin/users", label: "Users", icon: "👤", need: "USERS_READ" },
  { to: "/admin/rooms", label: "Rooms", icon: "⌂", need: "ROOMS_READ" },
  { to: "/admin/games", label: "Games", icon: "🂠", need: "GAMES_READ" },
  { to: "/admin/reports", label: "Reports", icon: "⚑", need: "REPORTS_READ" },
  { to: "/admin/statistics", label: "Statistics", icon: "◔", need: "SETTINGS_READ" },
  { to: "/admin/settings", label: "Settings", icon: "⚙", need: "SETTINGS_READ" },
  { to: "/admin/database", label: "Database", icon: "⛁", need: "DATABASE_READ" },
  { to: "/admin/audit-logs", label: "Audit log", icon: "☰", need: "AUDIT_READ" },
  { to: "/admin/admins", label: "Admins", icon: "★", need: "ADMINS_READ" },
  { to: "/admin/system-health", label: "System health", icon: "♥", need: "SETTINGS_READ" },
];

export function AdminLayout({ title, children }: { title: string; children: ReactNode }) {
  const api = useAdminApi();
  const { profile, logout } = useAdminSession();
  const nav = useNavigate();

  return (
    <div className="room flex min-h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-bone/10 p-4 md:flex">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-[0.3em] text-dim">Old Maid</p>
          <p className="title-display text-xl">Admin</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.filter((n) => !n.need || api.can(n.need)).map((n) => (
            <NavLink
              key={n.to} to={n.to} end={n.end}
              className={({ isActive }) =>
                `flex min-h-[44px] items-center gap-3 border-l-2 px-3 text-sm transition ${
                  isActive ? "border-ember bg-blood/30 text-bone" : "border-transparent text-dim hover:border-bone/40 hover:text-bone"
                }`
              }
            >
              <span aria-hidden>{n.icon}</span>{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 border-t border-bone/10 pt-4 text-xs text-dim">
          <p className="font-semibold text-bone">{profile?.username}</p>
          <p>{profile?.role}</p>
          <button
            type="button"
            className="mt-2 min-h-[36px] w-full border border-bone/25 text-xs uppercase tracking-[0.2em] hover:border-ember"
            onClick={() => { logout(); nav("/admin/login", { replace: true }); }}
          >Sign out</button>
        </div>
      </aside>

      {/* Narrow screens: a scrollable nav strip instead of the sidebar. */}
      <div className="w-full md:hidden">
        <AdminMobileNav profile={profile} onSignOut={() => { logout(); nav("/admin/login", { replace: true }); }} />
      </div>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6">
        <h1 className="title-display mb-4 text-2xl sm:text-3xl">{title}</h1>
        {children}
      </main>
    </div>
  );
}

function AdminMobileNav({ profile, onSignOut }: { profile: AdminProfile | null; onSignOut(): void }) {
  const api = useAdminApi();
  return (
    <div className="border-b border-bone/10 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.2em] text-dim">{profile?.role} · {profile?.username}</span>
        <button type="button" className="min-h-[36px] border border-bone/25 px-3 text-xs" onClick={onSignOut}>Sign out</button>
      </div>
      <nav className="mt-2 flex gap-2 overflow-x-auto pb-2">
        {NAV.filter((n) => !n.need || api.can(n.need)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}
            className={({ isActive }) => `min-h-[36px] shrink-0 border px-3 text-xs ${isActive ? "border-ember text-bone" : "border-bone/20 text-dim"}`}>
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/* ---------------- shared widgets ---------------- */

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mb-4 border border-bone/15 bg-ink/40">
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-bone/10 px-4 py-2">
          {title && <h2 className="text-sm uppercase tracking-[0.2em]">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A metric tile. `null` renders "unavailable" so a missing number is never shown as 0. */
export function Stat({ label, value, hint }: { label: string; value: number | string | null; hint?: string }) {
  return (
    <div className="border border-bone/15 p-3">
      <p className="text-xs uppercase tracking-[0.15em] text-dim">{label}</p>
      <p className="title-display mt-1 text-2xl">
        {value === null ? <span className="text-dim">n/a</span> : value}
      </p>
      {hint && <p className="mt-1 text-xs text-dim">{hint}</p>}
    </div>
  );
}

export function Table<T>({ rows, columns, empty = "Nothing here." }: {
  rows: T[]; empty?: string;
  columns: { key: string; header: string; render(r: T): ReactNode }[];
}) {
  if (rows.length === 0) return <p className="p-4 text-sm text-dim">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-bone/15 text-xs uppercase tracking-[0.15em] text-dim">
            {columns.map((c) => <th key={c.key} className="px-3 py-2 font-normal">{c.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-bone/5 align-top hover:bg-bone/5">
              {columns.map((c) => <td key={c.key} className="px-3 py-2">{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ total, limit, offset, onChange }: {
  total: number; limit: number; offset: number; onChange(offset: number): void;
}) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between gap-3 border-t border-bone/10 px-3 py-2 text-xs text-dim">
      <span>{total === 0 ? "No records" : `${offset + 1}–${Math.min(offset + limit, total)} of ${total}`} · page {page}/{pages}</span>
      <span className="flex gap-2">
        <button type="button" disabled={offset === 0} className="min-h-[36px] border border-bone/20 px-3 disabled:opacity-30" onClick={() => onChange(Math.max(0, offset - limit))}>Prev</button>
        <button type="button" disabled={offset + limit >= total} className="min-h-[36px] border border-bone/20 px-3 disabled:opacity-30" onClick={() => onChange(offset + limit)}>Next</button>
      </span>
    </div>
  );
}

/**
 * Confirmation modal for consequential actions. A reason is required and is sent to the
 * server, which records it in the audit log.
 */
export function ConfirmAction({ label, title, description, confirmLabel = "Confirm", danger, onConfirm, disabled }: {
  label: string; title: string; description: string; confirmLabel?: string; danger?: boolean;
  onConfirm(reason: string): Promise<void> | void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}
        className={`min-h-[36px] border px-3 text-xs uppercase tracking-[0.15em] disabled:opacity-30 ${danger ? "border-blood text-blood hover:bg-blood/20" : "border-bone/30 hover:border-bone"}`}>
        {label}
      </button>
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-md border border-bone/25 bg-ink p-5">
        <h3 className="title-display text-xl">{title}</h3>
        <p className="mt-2 text-sm text-dim">{description}</p>
        <label className="mt-4 block text-xs uppercase tracking-[0.15em] text-dim">
          Reason (recorded in the audit log)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
            className="mt-1 w-full border border-bone/25 bg-transparent p-2 text-sm normal-case tracking-normal text-bone" />
        </label>
        {err && <p className="mt-2 text-sm text-blood">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="min-h-[44px] border border-bone/30 px-4 text-xs uppercase" onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
          <button type="button" disabled={busy || reason.trim().length < 3}
            className={`min-h-[44px] border px-4 text-xs uppercase disabled:opacity-40 ${danger ? "border-blood bg-blood/30" : "border-ember bg-blood/40"}`}
            onClick={async () => {
              setBusy(true); setErr(null);
              try { await onConfirm(reason.trim()); setOpen(false); setReason(""); }
              catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
              finally { setBusy(false); }
            }}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Notice({ kind = "error", children }: { kind?: "error" | "ok"; children: ReactNode }) {
  return <p className={`mb-3 border px-3 py-2 text-sm ${kind === "error" ? "border-blood/50 text-blood" : "border-emerald/50 text-emerald"}`}>{children}</p>;
}

export function Loading() {
  return <p className="p-4 text-sm text-dim">Loading…</p>;
}