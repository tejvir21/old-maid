import { useEffect, useState } from "react";
import { AdminLayout, Card, Loading, Notice, Stat } from "../AdminLayout";
import { useAdminApi } from "../context";
import type { StatsPage } from "../adminApi";

export function AdminStatistics() {
  const api = useAdminApi();
  const [d, setD] = useState<StatsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.statistics().then((r) => setD(r.data)).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);

  return (
    <AdminLayout title="Statistics">
      {error && <Notice>{error}</Notice>}
      {!d && !error && <Loading />}
      {d && (
        <>
          <Card title="Players">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Total users" value={d.users} />
              <Stat label="New today" value={d.usersToday} />
              <Stat label="Guests" value={d.guests} />
              <Stat label="Online now" value={d.onlinePlayers} />
            </div>
          </Card>
          <Card title="Games">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Completed (all time)" value={d.games.total} />
              <Stat label="Completed today" value={d.games.finishedToday} />
              <Stat label="Started today" value={d.games.today} />
              <Stat label="Active now" value={d.games.active} />
            </div>
          </Card>
          <Card title="Rooms & sync">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Rooms (all time)" value={d.rooms.total} />
              <Stat label="Live rooms" value={d.rooms.live} hint={`${d.rooms.playing} playing`} />
              <Stat label="Offline sync records" value={d.syncRecords} />
              <Stat label="Open reports" value={(d.reports["OPEN"] ?? 0) + (d.reports["INVESTIGATE"] ?? 0)} />
            </div>
          </Card>
          <Card title="Reports by status">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Object.entries(d.reports).map(([k, v]) => (
                <div key={k}><dt className="text-xs uppercase tracking-[0.15em] text-dim">{k}</dt><dd className="title-display text-xl">{v}</dd></div>
              ))}
              {Object.keys(d.reports).length === 0 && <p className="text-sm text-dim">No reports filed.</p>}
            </dl>
          </Card>
          <p className="text-xs text-dim">
            Offline (AI) games sync as unverified and are never mixed into these verified online counters.
          </p>
        </>
      )}
    </AdminLayout>
  );
}