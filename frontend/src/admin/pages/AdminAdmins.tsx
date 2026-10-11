import { useEffect, useState } from "react";
import type { AdminRole, Permission } from "@old-maid/shared";
import { ADMIN_ROLES, PERMISSIONS, ROLE_PERMISSIONS } from "@old-maid/shared";
import { AdminLayout, Card, ConfirmAction, Loading, Notice, Table } from "../AdminLayout";
import { useAdminApi, useAdminSession } from "../context";
import type { AdminProfile } from "../adminApi";

export function AdminAdmins() {
  const api = useAdminApi();
  const { profile: me } = useAdminSession();
  const [items, setItems] = useState<AdminProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = (): void => {
    api.admins().then((r) => setItems(r.items)).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const canWrite = api.can("ADMINS_WRITE");

  return (
    <AdminLayout title="Administrators">
      {error && <Notice>{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {!items.length && !error && <Loading />}

      <Card
        title={`${items.length} admin account${items.length === 1 ? "" : "s"}`}
        actions={canWrite ? <button type="button" className="min-h-[36px] border border-ember px-3 text-xs uppercase" onClick={() => setCreating(true)}>New admin</button> : undefined}
      >
        <Table
          rows={items}
          empty="No administrators."
          columns={[
            { key: "user", header: "Admin", render: (a) => <><span className="block text-bone">{a.username}{a.id === me?.id ? " (you)" : ""}</span><span className="block text-xs text-dim">{a.email}</span></> },
            { key: "role", header: "Role", render: (a) => a.role },
            { key: "status", header: "Status", render: (a) => <span className={a.status === "suspended" ? "text-blood" : ""}>{a.status}</span> },
            { key: "perms", header: "Permissions", render: (a) => <span className="text-xs text-dim">{a.permissions.length} effective</span> },
            { key: "login", header: "Last login", render: (a) => (a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : "never") },
            {
              key: "actions", header: "", render: (a) => (
                <span className="flex flex-wrap gap-2">
                  {canWrite && <button className="min-h-[36px] border border-bone/25 px-2 text-xs" onClick={() => setCreating(false)} hidden={false} style={{ display: "none" }} />}
                  {canWrite && a.role !== "SUPER_ADMIN" && a.id !== me?.id && (
                    <>
                      {ADMIN_ROLES.filter((r) => r !== a.role).map((r) => (
                        <ConfirmAction key={r} label={r.replace("_", " ")} title={`Change ${a.username} to ${r}?`}
                          description="The role change and your reason are recorded in the audit log. Existing sessions are kept unless the role loses access."
                          onConfirm={async (reason) => { await api.updateAdmin(a.id, { role: r, reason }); setOk(`${a.username} is now ${r}.`); load(); }} />
                      ))}
                      <ConfirmAction label={a.status === "active" ? "Suspend" : "Restore"} danger={a.status === "active"}
                        title={`${a.status === "active" ? "Suspend" : "Restore"} ${a.username}?`}
                        description={a.status === "active" ? "All their sessions are revoked immediately and they cannot sign in." : "They will be able to sign in again."}
                        onConfirm={async (reason) => {
                          await api.updateAdmin(a.id, { status: a.status === "active" ? "suspended" : "active", reason });
                          setOk(`${a.username} ${a.status === "active" ? "suspended" : "restored"}.`); load();
                        }} />
                      <ConfirmAction label="Revoke sessions" title={`Revoke all sessions for ${a.username}?`}
                        description="They are signed out everywhere but keep their account and permissions."
                        onConfirm={async () => { await api.revokeAdminSessions(a.id); setOk("Sessions revoked."); }} />
                    </>
                  )}
                  {!canWrite && <span className="text-xs text-dim">read only</span>}
                </span>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Role / permission matrix">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-bone/15 text-dim">
                <th className="px-2 py-1 font-normal">Permission</th>
                {ADMIN_ROLES.map((r) => <th key={r} className="px-2 py-1 font-normal">{r.replace("_", " ")}</th>)}
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map((p) => (
                <tr key={p} className="border-b border-bone/5">
                  <td className="px-2 py-1">{p}</td>
                  {ADMIN_ROLES.map((r) => (
                    <td key={r} className="px-2 py-1">{ROLE_PERMISSIONS[r].includes(p) ? "✓" : <span className="text-dim">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {creating && canWrite && <CreateAdmin onClose={() => setCreating(false)} onCreated={(m) => { setOk(m); setCreating(false); load(); }} />}
    </AdminLayout>
  );
}

function CreateAdmin({ onClose, onCreated }: { onClose(): void; onCreated(msg: string): void }) {
  const api = useAdminApi();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminRole>("SUPPORT");
  const [grants, setGrants] = useState<Permission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSuper = api.isSuperAdmin;
  const selectable = ROLE_PERMISSIONS[role];
  const narrowed = isSuper ? PERMISSIONS : selectable.filter((p) => !["ADMINS_WRITE", "DATABASE_READ", "DATABASE_WRITE", "GAME_DEBUG_READ", "GAME_DEBUG_WRITE"].includes(p));

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.createAdmin({ email, username, password, role, permissions: grants });
      onCreated(`Admin ${username} created.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Create admin">
      <form onSubmit={(e) => void submit(e)} className="max-h-[90vh] w-full max-w-lg overflow-y-auto border border-bone/25 bg-ink p-5">
        <h2 className="title-display text-xl">New administrator</h2>
        {error && <div className="mt-3"><Notice>{error}</Notice></div>}

        <label className="mb-3 block text-xs uppercase tracking-[0.15em] text-dim">
          Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            className="mt-1 min-h-[44px] w-full border border-bone/25 bg-transparent px-2 text-sm normal-case tracking-normal text-bone" />
        </label>
        <label className="mb-3 block text-xs uppercase tracking-[0.15em] text-dim">
          Username<input required value={username} onChange={(e) => setUsername(e.target.value)}
            className="mt-1 min-h-[44px] w-full border border-bone/25 bg-transparent px-2 text-sm normal-case tracking-normal text-bone" />
        </label>
        <label className="mb-3 block text-xs uppercase tracking-[0.15em] text-dim">
          Password (12+ chars, upper, lower, digit)
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
            className="mt-1 min-h-[44px] w-full border border-bone/25 bg-transparent px-2 text-sm normal-case tracking-normal text-bone" />
        </label>
        <label className="mb-3 block text-xs uppercase tracking-[0.15em] text-dim">
          Role
          <select value={role} onChange={(e) => { setRole(e.target.value as AdminRole); setGrants([]); }}
            className="mt-1 min-h-[44px] w-full border border-bone/25 bg-transparent px-2 text-sm normal-case tracking-normal text-bone">
            {ADMIN_ROLES.filter((r) => r !== "SUPER_ADMIN" || isSuper).map((r) => <option key={r} value={r}>{r.replace("_", " ")}</option>)}
          </select>
        </label>

        <fieldset className="mb-3">
          <legend className="mb-1 text-xs uppercase tracking-[0.15em] text-dim">
            Extra permissions (grants only add what the role already allows)
          </legend>
          <div className="grid grid-cols-2 gap-1">
            {narrowed.map((p) => (
              <label key={p} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={grants.includes(p)}
                  disabled={selectable.includes(p)}
                  onChange={(e) => setGrants((g) => (e.target.checked ? [...g, p] : g.filter((x) => x !== p)))} />
                <span className={selectable.includes(p) ? "text-dim" : ""}>{p}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex justify-end gap-2">
          <button type="button" className="min-h-[44px] border border-bone/30 px-4 text-xs uppercase" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}
            className="min-h-[44px] border border-ember bg-blood/40 px-4 text-xs uppercase disabled:opacity-50">
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}