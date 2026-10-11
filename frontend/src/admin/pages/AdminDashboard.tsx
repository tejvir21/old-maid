import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AdminLayout, Card, Loading, Notice, Stat } from "../AdminLayout";
import { useAdminApi } from "../context";
import type { DashboardData } from "../adminApi";

export function AdminDashboard() {
  const api = useAdminApi();
  const [d, setD] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = (): void => { api.dashboard().then((x) => { if (live) setD(x); }).catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); }); };
    load();
    // The dashboard shows live counters; refresh on the existing 20s cadence.
    const id = setInterval(load, 20_000);
    return () => { live = false; clearInterval(id); };
  }, [api]);

  return (
    <AdminLayout title="Dashboard">
      {error && <Notice>{error}</Notice>}
      {!d && !error && <Loading />}

      {d && (
        <>
          <Card title="Players">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Registered users" value={d.users} />
              <Stat label="New today" value={d.usersToday} />
              <Stat label="Guests" value={d.guests} />
              <Stat label="Online now" value={d.onlinePlayers} />
            </div>
          </Card>

          <Card title="Games & rooms">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Active rooms" value={d.activeRooms} hint={`${d.roomsPlaying} playing`} />
              <Stat label="Active games" value={d.activeGames} />
              <Stat label="Games today" value={d.gamesToday} />
              <Stat label="Completed games" value={d.totalGames} />
            </div>
          </Card>

          <Card title="Moderation">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Pending reports" value={d.pendingReports} />
              <Stat label="Offline sync records" value={d.syncRecords} />
              <Stat label="Active admins" value={d.activeAdmins} />
              <Stat label="Uptime" value={`${Math.floor(d.uptimeSec / 3600)}h ${Math.floor((d.uptimeSec % 3600) / 60)}m`} />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-dim sm:grid-cols-4">
              {Object.entries(d.reportCounts).map(([k, v]) => (
                <div key={k}><dt className="uppercase tracking-[0.15em]">{k}</dt><dd className="text-bone">{v}</dd></div>
              ))}
            </dl>
          </Card>

          <Card title="System health">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="API" value={d.health.api === "ok" ? "Healthy" : d.health.api} />
              <Stat label="MongoDB" value={d.health.database.ok ? "Connected" : "Unavailable"}
                hint={`${d.health.database.kind} · ${d.health.database.latencyMs} ms`} />
              <Stat label="Socket.IO" value="Listening"
                hint={`${d.health.socket.connections} players · ${d.health.socket.rooms} rooms`} />
              <Stat label="Memory (RSS)" value={`${d.health.server.rssMb} MB`}
                hint={`heap ${d.health.server.heapUsedMb} MB · ${d.health.server.cpus} cpus`} />
            </div>
            <p className="mt-3 text-xs text-dim">
              Node {d.health.server.nodeVersion} on {d.health.server.platform} · load {d.health.server.loadAvg.join(" / ")} ·
              instance {d.instanceId.slice(0, 8)}
            </p>
            <p className="mt-2">
              <Link className="text-xs underline" to="/admin/system-health">Full system health →</Link>
            </p>
          </Card>
        </>
      )}
    </AdminLayout>
  );
}