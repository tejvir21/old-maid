import { useCallback, useEffect, useState } from "react";
import { AdminLayout, Card, ConfirmAction, Loading, Notice, Pager, Table } from "../AdminLayout";
import { useAdminApi } from "../context";

export function AdminDatabase() {
  const api = useAdminApi();
  const [collections, setCollections] = useState<{ name: string; editableFields: string[]; protected: boolean }[]>([]);
  const [active, setActive] = useState<string>("users");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const limit = 25;

  useEffect(() => {
    api.collections().then((r) => setCollections(r.collections)).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);

  const load = useCallback(() => {
    api.collection(active, { q, limit, offset })
      .then((p) => { setRows(p.items); setTotal(p.total); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, active, q, offset]);

  useEffect(load, [load]);

  const meta = collections.find((c) => c.name === active);
  const editableFields = meta?.editableFields ?? [];
  const isProtected = meta?.protected ?? false;
  const canWrite = api.can("DATABASE_WRITE");
  const isSuper = api.isSuperAdmin;

  const columns = useMemoColumns(rows);

  return (
    <AdminLayout title="Database">
      {error && <Notice>{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Card>
        <div className="flex flex-wrap gap-2">
          {collections.map((c) => (
            <button key={c.name} type="button" onClick={() => { setActive(c.name); setOffset(0); }}
              className={`min-h-[40px] border px-3 text-xs ${active === c.name ? "border-ember bg-blood/40 text-bone" : "border-bone/25 text-dim"}`}>
              {c.name}{c.protected ? " 🔒" : ""}
            </button>
          ))}
        </div>
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); setOffset(0); load(); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${active}`}
            className="min-h-[44px] flex-1 border border-bone/25 bg-transparent px-3 text-sm" />
          <button className="min-h-[44px] border border-bone/30 px-4 text-xs uppercase tracking-[0.15em]" type="submit">Search</button>
        </form>
      </Card>

      <Card
        title={`${active} · ${total} record${total === 1 ? "" : "s"}`}
        actions={isProtected ? <span className="text-xs text-dim">Protected collection</span> : undefined}
      >
        {!collections.length && <Loading />}
        {collections.length > 0 && (
          <Table
            rows={rows}
            empty={`No records in ${active}.`}
            columns={columns.map((c) => ({
              key: c,
              header: c,
              render: (r) => <code className="break-all text-xs">{renderCell(r[c], c)}</code>,
            }))}
          />
        )}
        <Pager total={total} limit={limit} offset={offset} onChange={setOffset} />
      </Card>

      {rows.length > 0 && (
        <Card title="Record actions">
          <p className="mb-3 text-xs text-dim">
            {meta?.editableFields.length
              ? `Editable fields in ${active}: ${meta.editableFields.join(", ")}. Everything else is read-only by design.`
              : `No fields in ${active} may be edited through this console.`}
          </p>
          {meta?.protected && <Notice>This collection is protected: it can be read but never edited or deleted.</Notice>}
          {!meta?.protected && canWrite && rows.slice(0, 10).map((r) => {
            const id = String(r["id"] ?? "");
            return (
              <div key={id} className="flex flex-wrap items-center gap-2 border-b border-bone/5 py-2">
                <code className="text-xs">{id || "(no id)"}</code>
                {editableFields.map((f) => (
                  <EditableField key={f} name={f} record={r} collection={active} id={id}
                    onSaved={(msg) => { setOk(msg); load(); }} />
                ))}
                <ConfirmAction label="Soft delete" danger title={`Soft-delete ${id}?`}
                  description="The record is hidden from the application but retained in the database."
                  onConfirm={async (reason) => { await api.softDelete(active, id, reason); setOk("Record soft-deleted."); load(); }} />
                {isSuper && (
                  <ConfirmAction label="Purge" danger title={`Permanently delete ${id}?`}
                    description="This cannot be undone. Only SUPER_ADMINs can perform a permanent delete."
                    confirmLabel="Delete forever"
                    onConfirm={async (reason) => { await api.purge(active, id, reason); setOk("Record permanently deleted."); load(); }} />
                )}
              </div>
            );
          })}
        </Card>
      )}

      <Card title="Safety">
        <ul className="list-inside list-disc space-y-1 text-xs text-dim">
          <li>Collections are an explicit allow-list — there is no arbitrary collection or query access.</li>
          <li>Client-supplied MongoDB operators are rejected; only a fixed set of fields per collection can change.</li>
          <li>Password hashes, session material, tokens and live hidden card state are never returned.</li>
          <li>Permanent deletion is SUPER_ADMIN-only and impossible for audit logs and settings.</li>
        </ul>
      </Card>
    </AdminLayout>
  );
}

function EditableField({ name, record, collection, id, onSaved }: {
  name: string; record: Record<string, unknown>; collection: string; id: string; onSaved(msg: string): void;
}) {
  const api = useAdminApi();
  const [value, setValue] = useState(String(record[name] ?? ""));
  const current = String(record[name] ?? "");
  if (value === current) return null;
  return (
    <span className="flex items-center gap-1">
      <input value={value} onChange={(e) => setValue(e.target.value)}
        className="min-h-[36px] w-40 border border-bone/25 bg-transparent px-2 text-xs text-bone" aria-label={`New ${name}`} />
      <button type="button" className="min-h-[36px] border border-bone/30 px-2 text-xs"
        onClick={() => { api.editRecord(collection, id, { [name]: value }, `admin console edit: ${name}`).then(() => onSaved(`Updated ${name}.`)).catch((e: unknown) => onSaved(e instanceof Error ? e.message : String(e))); }}>
        Save {name}
      </button>
    </span>
  );
}

/** Only the first few columns are shown, so a wide document does not become unreadable. */
function useMemoColumns(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const r of rows.slice(0, 5)) for (const k of Object.keys(r)) keys.add(k);
  const ordered = ["id", "_id", "username", "email", "status", "code", "roomCode", "text", "name", "category", "action", "adminUsername", "reason", "createdAt"];
  const sorted = [...keys].sort((a, b) => {
    const ia = ordered.indexOf(a); const ib = ordered.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return sorted.slice(0, 7);
}

function renderCell(v: unknown, key: string): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 120);
  const s = String(v);
  if (/password|secret|token|hash/i.test(key)) return "[redacted]";
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}