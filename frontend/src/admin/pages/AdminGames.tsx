import { useCallback, useEffect, useState } from "react";
import { AdminLayout, Card, ConfirmAction, Loading, Notice, Pager, Table } from "../AdminLayout";
import { useAdminApi } from "../context";
import type { GameRecord } from "../adminApi";

export function AdminGames() {
  const api = useAdminApi();
  const [rows, setRows] = useState<GameRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<GameRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const limit = 25;

  const load = useCallback(() => {
    api.games({ q, status, limit, offset })
      .then((p) => { setRows(p.items); setTotal(p.total); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, q, status, offset]);

  useEffect(load, [load]);
  const canManage = api.can("GAMES_MANAGE");

  return (
    <AdminLayout title="Games">
      {error && <Notice>{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Card>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setOffset(0); load(); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search game id or room"
            className="min-h-[44px] flex-1 border border-bone/25 bg-transparent px-3 text-sm" />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
            className="min-h-[44px] border border-bone/25 bg-transparent px-3 text-sm">
            <option value="">All statuses</option>
            {["playing", "finished", "abandoned"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="min-h-[44px] border border-bone/30 px-4 text-xs uppercase tracking-[0.15em]" type="submit">Search</button>
        </form>
      </Card>

      <Card title={`${total} game${total === 1 ? "" : "s"}`}>
        <Table
          rows={rows}
          empty="No games match this filter."
          columns={[
            { key: "id", header: "Game", render: (g) => <code className="text-xs">{g.gameId.slice(0, 8)}</code> },
            { key: "room", header: "Room", render: (g) => <code>{g.roomCode}</code> },
            { key: "status", header: "Status", render: (g) => <span className={g.endedByAdmin ? "text-blood" : ""}>{g.status}{g.endedByAdmin ? " (by admin)" : ""}</span> },
            { key: "players", header: "Players", render: (g) => String(g.playerIds.length) },
            { key: "draws", header: "Draws", render: (g) => String(g.drawCount ?? "—") },
            { key: "started", header: "Started", render: (g) => new Date(g.startedAt).toLocaleString() },
            {
              key: "actions", header: "", render: (g) => (
                <span className="flex gap-2">
                  <button className="min-h-[36px] border border-bone/25 px-2 text-xs" onClick={() => setSelected(g)}>Details</button>
                  {canManage && g.status === "playing" && (
                    <ConfirmAction label="Terminate" danger title="Terminate this match?"
                      description="The match ends immediately and is recorded as abandoned with your admin id and reason. No winner is assigned."
                      onConfirm={async (reason) => { await api.terminateGame(g.gameId, reason); setOk("Match terminated."); load(); }} />
                  )}
                </span>
              ),
            },
          ]}
        />
        <Pager total={total} limit={limit} offset={offset} onChange={setOffset} />
      </Card>

      {selected && <GameDetail game={selected} onClose={() => setSelected(null)} onChanged={load} onOk={setOk} />}
    </AdminLayout>
  );
}

function GameDetail({ game, onClose, onChanged, onOk }: {
  game: GameRecord; onClose(): void; onChanged(): void; onOk(s: string): void;
}) {
  const api = useAdminApi();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.game>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.game(game.gameId).then(setData).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, game.gameId]);
  useEffect(load, [load]);
  const canManage = api.can("GAMES_MANAGE");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Game details">
      <div className="my-8 w-full max-w-3xl border border-bone/25 bg-ink p-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="title-display text-2xl">Game {game.gameId.slice(0, 8)}</h2>
            <p className="text-xs text-dim">room {game.roomCode} · {game.status}</p>
          </div>
          <button type="button" onClick={onClose} className="min-h-[36px] border border-bone/25 px-3 text-xs">Close</button>
        </div>

        {error && <Notice>{error}</Notice>}
        {!data && !error && <Loading />}

        {data && (
          <div className="mt-4 space-y-4">
            {canManage && data.game.status === "playing" && (
              <div className="flex gap-2">
                <ConfirmAction label="Pause" title="Pause this match?" description="Turn timers stop until you resume. Players see a notice."
                  onConfirm={async (reason) => { await api.pauseGame(game.gameId, reason); onOk("Game paused."); load(); onChanged(); }} />
                <ConfirmAction label="Terminate" danger title="Terminate this match?"
                  description="Recorded as abandoned with your id and reason. No winner is assigned."
                  onConfirm={async (reason) => { await api.terminateGame(game.gameId, reason); onOk("Match terminated."); load(); onChanged(); }} />
              </div>
            )}
            {canManage && data.game.status === "playing" && (
              <p className="text-xs text-dim">Use Pause first if you want the match to continue later.</p>
            )}

            <div>
              <p className="mb-1 text-xs uppercase tracking-[0.15em] text-dim">Players</p>
              <Table
                rows={data.players}
                empty="No player records."
                columns={[
                  { key: "name", header: "Player", render: (p) => p.name },
                  { key: "type", header: "Type", render: (p) => (p.isAi ? "AI" : "Human") },
                  { key: "seat", header: "Seat", render: (p) => String(p.seat) },
                  { key: "result", header: "Result", render: (p) => p.result ?? "—" },
                ]}
              />
            </div>

            <div>
              <p className="mb-1 text-xs uppercase tracking-[0.15em] text-dim">Public events</p>
              <ol className="max-h-72 overflow-y-auto text-xs">
                {data.events.map((e) => (
                  <li key={e.seq} className="border-b border-bone/5 py-1">
                    <span className="text-dim">#{e.seq}</span> {e.text}
                  </li>
                ))}
              </ol>
            </div>

            {data.game.endedByAdmin && (
              <Notice>
                Ended by administrator {data.game.endedByAdmin.adminId}: {data.game.endedByAdmin.reason}
              </Notice>
            )}
          </div>
        )}
      </div>
    </div>
  );
}