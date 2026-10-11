import { useCallback, useEffect, useState } from "react";
import type { ReportStatus } from "@old-maid/shared";
import { AdminLayout, Card, ConfirmAction, Loading, Notice, Pager, Table } from "../AdminLayout";
import { useAdminApi } from "../context";
import type { ReportRow } from "../adminApi";

const STATUSES: ReportStatus[] = ["OPEN", "INVESTIGATE", "RESOLVE", "DISMISS"];

export function AdminReports() {
  const api = useAdminApi();
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const limit = 25;

  const load = useCallback(() => {
    api.reports({ q, status, limit, offset })
      .then((p) => { setRows(p.items); setTotal(p.total); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, q, status, offset]);

  useEffect(load, [load]);
  const canManage = api.can("REPORTS_MANAGE");

  return (
    <AdminLayout title="Reports">
      {error && <Notice>{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Card>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setOffset(0); load(); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search description or id"
            className="min-h-[44px] flex-1 border border-bone/25 bg-transparent px-3 text-sm" />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
            className="min-h-[44px] border border-bone/25 bg-transparent px-3 text-sm">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value)} disabled={!api.can("REPORTS_READ")}
            className="min-h-[44px] border border-bone/25 bg-transparent px-3 text-sm disabled:opacity-40">
            <option value="">All categories</option>
            {["CHEATING", "HARASSMENT", "ABUSE", "OFFENSIVE_CHAT", "EXPLOIT", "OTHER"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className="min-h-[44px] border border-bone/30 px-4 text-xs uppercase tracking-[0.15em]" type="submit">Search</button>
        </form>
      </Card>

      <Card title={`${total} report${total === 1 ? "" : "s"}`}>
        <Table
          rows={rows}
          empty="No reports match this filter."
          columns={[
            { key: "id", header: "Report", render: (r) => <code className="text-xs">{r.id.slice(0, 8)}</code> },
            { key: "category", header: "Category", render: (r) => r.category.replace("_", " ") },
            { key: "status", header: "Status", render: (r) => <span className={r.status === "OPEN" ? "text-blood" : ""}>{r.status}</span> },
            { key: "description", header: "Description", render: (r) => <span className="line-clamp-2">{r.description}</span> },
            { key: "created", header: "Filed", render: (r) => new Date(r.createdAt).toLocaleString() },
            {
              key: "actions", header: "", render: (r) => (
                <button className="min-h-[36px] border border-bone/25 px-2 text-xs"
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                  {expanded === r.id ? "Hide" : "Review"}
                </button>
              ),
            },
          ]}
        />
        <Pager total={total} limit={limit} offset={offset} onChange={setOffset} />
      </Card>

      {expanded && rows.filter((r) => r.id === expanded).map((r) => (
        <Card key={r.id} title={`Report ${r.id.slice(0, 8)}`}>
          <p className="mb-3 whitespace-pre-wrap text-sm">{r.description}</p>
          <dl className="mb-4 grid grid-cols-2 gap-2 text-xs text-dim sm:grid-cols-4">
            <div><dt className="uppercase">Reporter</dt><dd className="text-bone">{r.reporterId.slice(0, 8)}</dd></div>
            {r.targetUserId && <div><dt className="uppercase">Target</dt><dd className="text-bone">{r.targetUserId.slice(0, 8)}</dd></div>}
            {r.roomCode && <div><dt className="uppercase">Room</dt><dd className="text-bone">{r.roomCode}</dd></div>}
            {r.assignedTo && <div><dt className="uppercase">Assigned</dt><dd className="text-bone">{r.assignedTo.slice(0, 8)}</dd></div>}
          </dl>

          {canManage && (
            <div className="flex flex-wrap gap-2">
              {STATUSES.filter((s) => s !== r.status).map((s) => (
                <ConfirmAction key={s} label={s.replace("_", " ")} title={`Set status to ${s}?`}
                  description="The change and your reason are stored in the report history and the audit log."
                  onConfirm={async (reason) => { await api.updateReport(r.id, { status: s, reason }); setOk(`Report marked ${s}.`); load(); }} />
              ))}
            </div>
          )}

          {r.history.length > 0 && (
            <div className="mt-4">
              <p className="mb-1 text-xs uppercase tracking-[0.15em] text-dim">History</p>
              <ol className="text-xs">
                {r.history.map((h, i) => (
                  <li key={i} className="border-b border-bone/5 py-1">
                    {new Date(h.at).toLocaleString()} · {h.adminId.slice(0, 8)} · {h.action}{h.note ? ` · ${h.note}` : ""}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {r.resolution && <p className="mt-3 text-sm"><span className="text-dim">Resolution: </span>{r.resolution}</p>}
        </Card>
      ))}
    </AdminLayout>
  );
}