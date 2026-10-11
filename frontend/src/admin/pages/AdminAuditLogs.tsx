import { useCallback, useEffect, useState } from "react";
import { AdminLayout, Card, Loading, Notice, Pager, Table } from "../AdminLayout";
import { useAdminApi } from "../context";
import type { AuditRow } from "../adminApi";

export function AdminAuditLogs() {
  const api = useAdminApi();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const limit = 25;

  const load = useCallback(() => {
    api.auditLogs({ q, action, limit, offset })
      .then((p) => { setRows(p.items); setTotal(p.total); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, q, action, offset]);

  useEffect(load, [load]);

  return (
    <AdminLayout title="Audit log">
      {error && <Notice>{error}</Notice>}

      <Card>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setOffset(0); load(); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search admin, resource id or reason"
            className="min-h-[44px] flex-1 border border-bone/25 bg-transparent px-3 text-sm" />
          <input value={action} onChange={(e) => setAction(e.target.value.toUpperCase())} placeholder="Action (e.g. USER_BAN)"
            className="min-h-[44px] w-52 border border-bone/25 bg-transparent px-3 text-sm" />
          <button className="min-h-[44px] border border-bone/30 px-4 text-xs uppercase tracking-[0.15em]" type="submit">Search</button>
        </form>
      </Card>

      <Card title={`${total} entr${total === 1 ? "y" : "ies"}`}>
        <Table
          rows={rows}
          empty="No audit records match this filter."
          columns={[
            { key: "when", header: "When", render: (r) => <span className="whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</span> },
            { key: "admin", header: "Admin", render: (r) => <><span className="block text-bone">{r.adminUsername}</span><span className="block text-xs text-dim">{r.adminRole}</span></> },
            { key: "action", header: "Action", render: (r) => <code className="text-xs">{r.action}</code> },
            { key: "resource", header: "Resource", render: (r) => <><span className="block">{r.resource}</span><code className="block text-xs text-dim">{r.resourceId.slice(0, 18)}</code></> },
            { key: "reason", header: "Reason", render: (r) => <span className="text-xs">{r.reason ?? "—"}</span> },
            { key: "ip", header: "IP", render: (r) => <code className="text-xs">{r.ip ?? "—"}</code> },
            {
              key: "a", header: "", render: (r) => (
                <button className="min-h-[36px] border border-bone/25 px-2 text-xs"
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                  {expanded === r.id ? "Hide" : "Diff"}
                </button>
              ),
            },
          ]}
        />
        <Pager total={total} limit={limit} offset={offset} onChange={setOffset} />
      </Card>

      {expanded && rows.filter((r) => r.id === expanded).map((r) => (
        <Card key={r.id} title={`${r.action} · ${r.resourceId}`}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs uppercase tracking-[0.15em] text-dim">Before</p>
              <pre className="max-h-64 overflow-auto border border-bone/15 p-2 text-xs">{r.before === undefined ? "—" : JSON.stringify(r.before, null, 2)}</pre>
            </div>
            <div>
              <p className="mb-1 text-xs uppercase tracking-[0.15em] text-dim">After</p>
              <pre className="max-h-64 overflow-auto border border-bone/15 p-2 text-xs">{r.after === undefined ? "—" : JSON.stringify(r.after, null, 2)}</pre>
            </div>
          </div>
          {r.userAgent && <p className="mt-3 break-all text-xs text-dim">{r.userAgent}</p>}
        </Card>
      ))}

      {!rows.length && !error && total === 0 && rows.length === 0 && <Loading />}
    </AdminLayout>
  );
}