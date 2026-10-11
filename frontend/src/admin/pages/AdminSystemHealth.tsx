import { useEffect, useState } from "react";
import { AdminLayout, Card, Loading, Notice, Stat } from "../AdminLayout";
import { useAdminApi } from "../context";
import type { HealthPage } from "../adminApi";

export function AdminSystemHealth() {
  const api = useAdminApi();
  const [d, setD] = useState<HealthPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = (): void => { api.systemHealth().then((r) => setD(r.data)).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); };
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [api]);

  return (
    <AdminLayout title="System health">
      {error && <Notice>{error}</Notice>}
      {!d && !error && <Loading />}
      {d && (
        <>
          <Card title="Services">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="API" value={d.api.status === "ok" ? "Healthy" : d.api.status}
                hint={`up ${Math.floor(d.api.uptimeSec / 3600)}h ${Math.floor((d.api.uptimeSec % 3600) / 60)}m`} />
              <Stat label="MongoDB" value={d.database.ok ? "Connected" : "Unavailable"}
                hint={`${d.database.kind} · ${d.database.latencyMs} ms`} />
              <Stat label="Socket.IO" value={d.socket.ok ? "Listening" : "Down"}
                hint={`${d.socket.connectedPlayers} players · ${d.socket.rooms} rooms`} />
              <Stat label="Runtime" value={d.node} hint={d.api.instanceId.slice(0, 8)} />
            </div>
          </Card>

          <Card title="Memory">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="RSS" value={`${Math.round((d.memory["rss"] ?? 0) / 1_048_576)} MB`} />
              <Stat label="Heap used" value={`${Math.round((d.memory["heapUsed"] ?? 0) / 1_048_576)} MB`} />
              <Stat label="Heap total" value={`${Math.round((d.memory["heapTotal"] ?? 0) / 1_048_576)} MB`} />
              <Stat label="External" value={`${Math.round((d.memory["external"] ?? 0) / 1_048_576)} MB`} />
            </div>
          </Card>

          <Card title="Active configuration">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs uppercase tracking-[0.15em] text-dim">Game</p>
                <dl className="text-sm">{Object.entries(d.settings.game).map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-bone/5 py-0.5">
                    <dt className="text-dim">{k.replace(/([A-Z])/g, " $1")}</dt><dd>{String(v)}</dd>
                  </div>
                ))}</dl>
              </div>
              <div>
                <p className="mb-1 text-xs uppercase tracking-[0.15em] text-dim">Feature flags</p>
                <dl className="text-sm">{Object.entries(d.settings.features).map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-bone/5 py-0.5">
                    <dt className="text-dim">{k.replace(/([A-Z])/g, " $1")}</dt><dd className={v ? "text-emerald" : "text-dim"}>{v ? "on" : "off"}</dd>
                  </div>
                ))}</dl>
              </div>
            </div>
          </Card>

          <Card title="Notes">
            <ul className="list-inside list-disc space-y-1 text-xs text-dim">
              <li>Live game state is held in the server process; a restart ends active matches (no Redis adapter yet).</li>
              <li>When the in-memory store is active the database reports <code>{d.database.kind}</code> and data is not durable.</li>
              <li>Admin sessions expire after 8 hours and are revoked on suspension or password change.</li>
            </ul>
          </Card>
        </>
      )}
    </AdminLayout>
  );
}