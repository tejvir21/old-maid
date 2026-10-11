import { useCallback, useEffect, useState } from "react";
import { AdminLayout, Card, ConfirmAction, Loading, Notice, Pager, Table } from "../AdminLayout";
import { useAdminApi } from "../context";
import type { UserRow } from "../adminApi";

export function AdminUsers() {
  const api = useAdminApi();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<UserRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const limit = 25;

  const load = useCallback(() => {
    api.users({ q, status, limit, offset })
      .then((p) => { setRows(p.items); setTotal(p.total); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, q, status, offset]);

  useEffect(load, [load]);

  const canBan = api.can("USERS_BAN");

  return (
    <AdminLayout title="Users">
      {error && <Notice>{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Card>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => { e.preventDefault(); setOffset(0); load(); }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username, email or id"
            className="min-h-[44px] flex-1 border border-bone/25 bg-transparent px-3 text-sm" />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
            className="min-h-[44px] border border-bone/25 bg-transparent px-3 text-sm">
            <option value="">All statuses</option>
            {["guest", "active", "suspended", "banned"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="min-h-[44px] border border-bone/30 px-4 text-xs uppercase tracking-[0.15em]" type="submit">Search</button>
        </form>
      </Card>

      <Card title={`${total} user${total === 1 ? "" : "s"}`}>
        <Table
          rows={rows}
          empty="No users match this filter."
          columns={[
            { key: "username", header: "User", render: (u) => <><span className="block text-bone">{u.username}</span><span className="block text-xs text-dim">{u.email ?? "guest (no email)"}</span></> },
            { key: "status", header: "Status", render: (u) => <span className={u.status === "banned" || u.status === "suspended" ? "text-blood" : ""}>{u.status}</span> },
            { key: "created", header: "Registered", render: (u) => fmt(u.createdAt) },
            { key: "login", header: "Last login", render: (u) => (u.lastLoginAt ? fmt(u.lastLoginAt) : <span className="text-dim">never</span>) },
            {
              key: "actions", header: "", render: (u) => (
                <span className="flex gap-2">
                  <button className="min-h-[36px] border border-bone/25 px-2 text-xs" onClick={() => setSelected(u)}>Details</button>
                  {canBan && (u.status === "banned" || u.status === "suspended" ? (
                    <ConfirmAction label="Unban" title="Unban this user?" confirmLabel="Unban"
                      description={`${u.username} will regain access to their account and can play again.`}
                      onConfirm={async (reason) => { await api.unbanUser(u.id, reason); setOk(`${u.username} unbanned.`); load(); }} />
                  ) : (
                    <ConfirmAction label="Ban" title="Ban this user?" danger confirmLabel="Ban user"
                      description={`${u.username} will be signed out and blocked from playing. Existing sessions are revoked.`}
                      onConfirm={async (reason) => { await api.banUser(u.id, reason); setOk(`${u.username} banned.`); load(); }} />
                  ))}
                </span>
              ),
            },
          ]}
        />
        <Pager total={total} limit={limit} offset={offset} onChange={setOffset} />
      </Card>

      {selected && <UserDetail user={selected} onClose={() => setSelected(null)} />}
    </AdminLayout>
  );
}

function UserDetail({ user, onClose }: { user: UserRow; onClose(): void }) {
  const api = useAdminApi();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.user>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.user(user.id).then(setData).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, user.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="User details">
      <div className="my-8 w-full max-w-2xl border border-bone/25 bg-ink p-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="title-display text-2xl">{user.username}</h2>
            <p className="text-xs text-dim">{user.email ?? "guest"} · {user.id}</p>
          </div>
          <button type="button" onClick={onClose} className="min-h-[36px] border border-bone/25 px-3 text-xs">Close</button>
        </div>

        {error && <Notice>{error}</Notice>}
        {!data && !error && <Loading />}

        {data && (
          <div className="mt-4 space-y-4">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><dt className="text-xs uppercase text-dim">Status</dt><dd>{data.user.status}{data.user.banned ? " (banned)" : ""}</dd></div>
              <div><dt className="text-xs uppercase text-dim">Registered</dt><dd>{fmt(data.user.createdAt)}</dd></div>
              <div><dt className="text-xs uppercase text-dim">Last login</dt><dd>{data.user.lastLoginAt ? fmt(data.user.lastLoginAt) : "never"}</dd></div>
              <div><dt className="text-xs uppercase text-dim">Offline games</dt><dd>{data.user.offlineGames}</dd></div>
            </dl>

            <div className="grid gap-3 sm:grid-cols-2">
              {(["online", "offline"] as const).map((k) => (
                <div key={k} className="border border-bone/15 p-3">
                  <p className="text-xs uppercase tracking-[0.15em] text-dim">{k} (verified by the server)</p>
                  <p className="mt-1 text-sm">
                    {data.user.stats[k].games} games · {data.user.stats[k].wins}W / {data.user.stats[k].losses}L
                  </p>
                </div>
              ))}
            </div>

            <div>
              <p className="mb-1 text-xs uppercase tracking-[0.15em] text-dim">Online game history</p>
              <Table
                rows={data.user.onlineGames}
                empty="No online games recorded."
                columns={[
                  { key: "id", header: "Game", render: (g) => <code className="text-xs">{g.gameId.slice(0, 8)}</code> },
                  { key: "status", header: "Status", render: (g) => g.status },
                  { key: "started", header: "Started", render: (g) => fmt(g.startedAt) },
                ]}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const fmt = (v: string): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
};