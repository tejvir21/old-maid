import { useEffect, useState } from "react";
import { useServices } from "../app/context";
import { Page } from "../components/Page";
import { useSyncStore } from "../store/ui";
import { ACHIEVEMENTS, type AchievementDoc, type OfflineGameRecord, type StatsDoc } from "../offline/types";

const rate = (w: number, g: number) => (g === 0 ? "—" : `${Math.round((w / g) * 100)}%`);

function Block({ title, tag, doc, note }: { title: string; tag: string; doc: { games: number; wins: number; losses: number }; note?: string }) {
  return (
    <section className="border border-bone/10 bg-coal/60 p-4" aria-label={title}>
      <div className="flex items-baseline justify-between"><h2 className="title-display text-xl">{title}</h2><span className="text-[10px] uppercase tracking-[0.25em] text-ember">{tag}</span></div>
      <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
        {[["Games", doc.games], ["Wins", doc.wins], ["Losses", doc.losses], ["Win rate", rate(doc.wins, doc.games)]].map(([k, v]) => (
          <div key={String(k)}><dd className="text-2xl">{v}</dd><dt className="text-[10px] uppercase tracking-[0.2em] text-dim">{k}</dt></div>
        ))}
      </dl>
      {note && <p className="mt-2 text-[11px] text-dim">{note}</p>}
    </section>
  );
}

export function Stats() {
  const svc = useServices();
  const sync = useSyncStore();
  const [stats, setStats] = useState<{ offline: StatsDoc; online: StatsDoc } | null>(null);
  const [ach, setAch] = useState<AchievementDoc[]>([]);
  const [games, setGames] = useState<OfflineGameRecord[]>([]);
  useEffect(() => {
    void (async () => {
      setStats(await svc.repo.getStats());
      setAch(await svc.repo.getAchievements());
      setGames(await svc.repo.listGames(10));
    })();
  }, [svc, sync.pending, sync.lastSyncAt, sync.failed]);
  if (!stats) return <Page title="Statistics"><p className="text-dim">Loading…</p></Page>;

  const total = { games: stats.offline.games + stats.online.games, wins: stats.offline.wins + stats.online.wins, losses: stats.offline.losses + stats.online.losses };
  const unlocked = new Set(ach.map((a) => a.id));
  return (
    <Page title="Statistics" narrow={false}>
      <div className="grid gap-3 md:grid-cols-2">
        <Block title="Offline" tag="This device · unverified" doc={stats.offline} note="Played against AI without the server. Counted on your account as offline results, never as verified online wins." />
        <Block title="Online" tag="Verified by server" doc={stats.online} note={stats.online.updatedAt ? `Last updated ${new Date(stats.online.updatedAt).toLocaleString()}` : "Updated after you sync while online."} />
      </div>
      <div className="mt-3"><Block title="Combined" tag="Offline + online" doc={total} /></div>

      <section className="mt-8" aria-label="Achievements">
        <h2 className="title-display mb-2 text-xl">Achievements</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {ACHIEVEMENTS.map((a) => (
            <li key={a.id} className={`border px-3 py-2 ${unlocked.has(a.id) ? "border-ember/60 bg-blood/20" : "border-bone/10 opacity-60"}`}>
              <div className="text-sm uppercase tracking-[0.15em]">{unlocked.has(a.id) ? "★ " : ""}{a.title}</div>
              <div className="text-xs text-dim">{a.hint}</div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8" aria-label="Recent offline games">
        <h2 className="title-display mb-2 text-xl">Recent offline games</h2>
        {games.length === 0 ? <p className="text-sm text-dim">No games yet.</p> : (
          <table className="w-full text-left text-xs">
            <thead className="text-dim"><tr><th className="py-1">When</th><th>Players</th><th>AI</th><th>Result</th><th>Sync</th></tr></thead>
            <tbody>
              {games.map((g) => (
                <tr key={g.localGameId} className="border-t border-bone/10">
                  <td className="py-1.5">{new Date(g.finishedAt).toLocaleString()}</td><td>{g.playerCount}</td><td className="uppercase">{g.aiDifficulty}</td>
                  <td className={g.result === "win" ? "text-ember" : ""}>{g.result.toUpperCase()}</td>
                  <td>{g.syncStatus === "synced" ? "✓ synced" : g.syncStatus === "failed" ? "rejected" : "pending"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(sync.pending > 0 || sync.failed > 0) && (
          <div className="mt-3 flex items-center gap-3 text-xs text-dim">
            <span>{sync.pending} waiting · {sync.failed} rejected</span>
            {sync.pending > 0 && <button type="button" className="btn !min-h-[40px] !py-1" onClick={() => void svc.sync.run()}>Sync now</button>}
          </div>
        )}
      </section>
    </Page>
  );
}
