import { useCallback, useEffect, useState } from "react";
import { AdminLayout, Card, ConfirmAction, Loading, Notice, Pager, Table } from "../AdminLayout";
import { useAdminApi } from "../context";
import type { RoomRow } from "../adminApi";

export function AdminRooms() {
  const api = useAdminApi();
  const [rows, setRows] = useState<RoomRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<RoomRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const limit = 25;

  const load = useCallback(() => {
    api.rooms({ q, status, limit, offset })
      .then((p) => { setRows(p.items); setTotal(p.total); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, q, status, offset]);

  useEffect(load, [load]);
  const canWrite = api.can("ROOMS_WRITE");

  return (
    <AdminLayout title="Rooms">
      {error && <Notice>{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Card>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setOffset(0); load(); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search room code or host"
            className="min-h-[44px] flex-1 border border-bone/25 bg-transparent px-3 text-sm" />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
            className="min-h-[44px] border border-bone/25 bg-transparent px-3 text-sm">
            <option value="">All statuses</option>
            {["waiting", "playing", "finished", "closed", "expired"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="min-h-[44px] border border-bone/30 px-4 text-xs uppercase tracking-[0.15em]" type="submit">Search</button>
        </form>
      </Card>

      <Card title={`${total} room${total === 1 ? "" : "s"}`}>
        <Table
          rows={rows}
          empty="No rooms match this filter."
          columns={[
            { key: "code", header: "Code", render: (r) => <code className="text-bone">{r.code}</code> },
            { key: "status", header: "Status", render: (r) => (r.live ? <span className="text-emerald">{r.status} (live)</span> : r.status) },
            { key: "players", header: "Players", render: (r) => (Array.isArray(r.players) ? r.players.length : r.players ?? "—") },
            { key: "locked", header: "Locked", render: (r) => (r.locked ? "yes" : "no") },
            { key: "created", header: "Created", render: (r) => new Date(r.createdAt).toLocaleString() },
            {
              key: "actions", header: "", render: (r) => (
                <span className="flex flex-wrap gap-2">
                  <button className="min-h-[36px] border border-bone/25 px-2 text-xs" onClick={() => setSelected(r)}>Inspect</button>
                  {canWrite && (
                    <>
                      <ConfirmAction label={r.locked ? "Unlock" : "Lock"} title={`${r.locked ? "Unlock" : "Lock"} room ${r.code}?`}
                        description={r.locked ? "Players will be able to join again." : "No further players will be able to join this room."}
                        onConfirm={async (reason) => { await (r.locked ? api.unlockRoom(r.code, reason) : api.lockRoom(r.code, reason)); setOk(`Room ${r.code} updated.`); load(); }} />
                      <ConfirmAction label="Close" danger title={`Close room ${r.code}?`}
                        description="The room is ended immediately. Any running match is recorded as abandoned — no winner is assigned."
                        onConfirm={async (reason) => { await api.closeRoom(r.code, reason); setOk(`Room ${r.code} closed.`); load(); }} />
                    </>
                  )}
                </span>
              ),
            },
          ]}
        />
        <Pager total={total} limit={limit} offset={offset} onChange={setOffset} />
      </Card>

      {selected && <RoomDetail room={selected} onClose={() => setSelected(null)} />}
    </AdminLayout>
  );
}

function RoomDetail({ room, onClose }: { room: RoomRow; onClose(): void }) {
  const api = useAdminApi();
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.room>>["detail"]>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.room(room.code).then((r) => setDetail(r.detail)).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, room.code]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Room details">
      <div className="my-8 w-full max-w-2xl border border-bone/25 bg-ink p-5">
        <div className="flex items-start justify-between">
          <h2 className="title-display text-2xl">Room {room.code}</h2>
          <button type="button" onClick={onClose} className="min-h-[36px] border border-bone/25 px-3 text-xs">Close</button>
        </div>
        {error && <Notice>{error}</Notice>}
        {!detail && !error && <Loading />}
        {detail && (
          <div className="mt-4">
            <p className="mb-3 text-xs text-dim">
              Public view only. Hands and the Joker's location are never exposed to an administrator —
              <code className="mx-1">/admin/debug/game/:id</code> is SUPER_ADMIN-only and audited.
            </p>
            <Table
              rows={detail.players}
              empty="This room has no players."
              columns={[
                { key: "name", header: "Player", render: (p) => p.name },
                { key: "cards", header: "Cards", render: (p) => String(p.cardCount) },
                { key: "type", header: "Type", render: (p) => (p.isAi ? "AI" : "Human") },
                { key: "conn", header: "Connected", render: (p) => (p.isConnected ? "yes" : "no") },
              ]}
            />
            <p className="mt-3 text-sm text-dim">
              Turn: <span className="text-bone">{detail.currentPlayerId ?? "—"}</span> · draws {detail.drawCount} ·{" "}
              {detail.paused ? "paused" : "running"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}