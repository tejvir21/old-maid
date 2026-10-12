import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seededRng } from "@old-maid/shared";
import { OfflineSession } from "../src/game/offlineSession";
import { NetworkMonitor } from "../src/net/network";
import { openDatabase, Repo } from "../src/offline/db";
import { ApiClient } from "../src/sync/api";
import { backoffMs, SyncEngine } from "../src/sync/syncEngine";
import { ManualScheduler, playOut, uniqueDb } from "./helpers";
import { startBackend, startProxy, type Proxy, type RunningServer } from "./serverProc";

let server: RunningServer;
let proxy: Proxy;
beforeAll(async () => {
  server = await startBackend();
  proxy = await startProxy(server.port);
});
afterAll(async () => {
  await proxy.close();
  await server.stop();
});

async function device(dbName = uniqueDb(), baseUrl = () => proxy.url) {
  const sched = new ManualScheduler();
  const db = await openDatabase(dbName);
  const repo = new Repo(db, () => sched.now());
  const api = new ApiClient({ baseUrl: baseUrl(), repo, timeoutMs: 3000 });
  const net = new NetworkMonitor({ isBrowserOnline: () => true, probe: () => api.health(), scheduler: sched });
  const engine = new SyncEngine({ repo, api, network: net, now: () => sched.now(), random: () => 0.5 });
  const session = new OfflineSession({ repo, scheduler: sched, rng: seededRng(Math.floor(Math.random() * 1e6)), aiDelay: () => 1000, onUpdate: () => undefined });
  const ctx = { dbName, sched, repo, api, net, engine, session };
  return ctx;
}
type Device = Awaited<ReturnType<typeof device>>;

async function playOfflineGame(d: Device, ai = 1, level: "easy" | "normal" | "hard" = "easy") {
  await d.session.start({ humanName: "Ryuji", aiCount: ai, level, localPlayerId: "local-xyz-1" });
  await playOut({ session: d.session, scheduler: d.sched } as never);
  return (await d.repo.listGames(1))[0]!;
}
const serverOffline = async (d: Device) => (await d.api.myStats()).stats.offline;

describe("offline result → sync queue → server (real backend)", () => {
  it("an offline game syncs once connectivity exists, is marked synced, and counted exactly once", async () => {
    const d = await device();
    proxy.setDown(true); // start OFFLINE
    const rec = await playOfflineGame(d);
    expect(rec.syncStatus).toBe("pending");
    expect((await d.repo.queueAll()).map((i) => i.status)).toEqual(["pending"]);
    const hitsWhileOffline = proxy.hits;

    proxy.setDown(false); // internet restored
    const st = await d.engine.run();
    expect(st.state).toBe("idle");
    expect(st.pending).toBe(0);
    expect(proxy.hits).toBeGreaterThan(hitsWhileOffline);
    expect((await d.repo.getGame(rec.localGameId))!.syncStatus).toBe("synced");
    expect((await d.repo.queueAll())[0]!.status).toBe("synced");
    expect(await serverOffline(d)).toEqual({ games: 1, wins: rec.result === "win" ? 1 : 0, losses: rec.result === "win" ? 0 : 1 });
    // the guest identity was created on first sync and persisted
    expect((await d.repo.getProfile()).auth?.userId).toBeTruthy();
    expect((await d.repo.getStats()).online.updatedAt).toBeGreaterThan(0); // verified-online cache refreshed
    // nothing left to do
    const before = proxy.hits;
    await d.engine.run();
    expect(proxy.hits).toBe(before);
  });

  it("failed sync keeps the data, backs off exponentially, then retries safely once the server returns", async () => {
    const d = await device();
    const rec = await playOfflineGame(d, 2);
    proxy.setDown(true);
    const s1 = await d.engine.run();
    expect(s1.state).toBe("error");
    let item = (await d.repo.queueAll())[0]!;
    expect(item).toMatchObject({ status: "pending", attempts: 1 });
    expect(item.nextAttemptAt).toBe(d.sched.now() + backoffMs(0, () => 0.5));
    expect(await d.repo.getGame(rec.localGameId)).toBeTruthy(); // never deleted

    // not due yet → no request is made
    proxy.setDown(false);
    const hits = proxy.hits;
    await d.engine.run();
    expect(proxy.hits).toBe(hits);

    // second failure doubles the delay
    d.sched.advance(backoffMs(0, () => 0.5) + 1);
    proxy.setDown(true);
    await d.engine.run();
    item = (await d.repo.queueAll())[0]!;
    expect(item.attempts).toBe(2);
    expect(item.nextAttemptAt - d.sched.now()).toBe(backoffMs(1, () => 0.5));
    expect(backoffMs(1, () => 0.5)).toBe(2 * backoffMs(0, () => 0.5));

    proxy.setDown(false);
    d.sched.advance(backoffMs(1, () => 0.5) + 1);
    const ok = await d.engine.run();
    expect(ok.state).toBe("idle");
    expect((await serverOffline(d)).games).toBe(1);
  });

  it("is duplicate-safe when the server processed the result but the client never learned (crash window)", async () => {
    const d = await device();
    const rec = await playOfflineGame(d);
    const item = (await d.repo.queueAll())[0]!;
    // the "lost response": send directly, leave the local queue item pending
    expect((await d.api.sync([{ id: item.id, type: item.type, payload: item.payload }]))[0]!.status).toBe("synced");
    expect(await d.repo.queueCounts()).toMatchObject({ pending: 1 });
    await d.engine.run();
    expect((await d.repo.queueAll())[0]!.status).toBe("synced");
    expect((await serverOffline(d)).games).toBe(1); // not 2
    // replaying everything again, many times, still can't inflate stats
    await d.api.sync([{ id: item.id, type: item.type, payload: item.payload }]);
    await d.api.sync([{ id: item.id, type: item.type, payload: item.payload }]);
    expect((await serverOffline(d)).games).toBe(1);
    expect(rec.localGameId).toBe(item.id);
  });

  it("the queue survives a browser restart and syncs afterwards", async () => {
    const a = await device();
    const r1 = await playOfflineGame(a);
    const r2 = await playOfflineGame(a, 3);
    expect((await a.repo.queueAll()).filter((i) => i.type === "GAME_RESULT")).toHaveLength(2);
    a.repo.close(); // browser closed

    const b = await device(a.dbName); // browser reopened: new objects, same IndexedDB
    expect((await b.repo.queueAll()).filter((i) => i.status === "pending")).toHaveLength(2);
    await b.engine.init();
    const st = await b.engine.run();
    expect(st.state).toBe("idle");
    expect((await serverOffline(b)).games).toBe(2);
    expect((await b.repo.getGame(r1.localGameId))!.syncStatus).toBe("synced");
    expect((await b.repo.getGame(r2.localGameId))!.syncStatus).toBe("synced");
  });

  it("items stuck in 'syncing' after a crash are reset and re-sent", async () => {
    const d = await device();
    await playOfflineGame(d);
    const [it] = await d.repo.queueAll();
    await d.repo.markSyncing([it!.id]); // simulate being killed mid-request
    expect((await d.repo.queueAll())[0]!.status).toBe("syncing");
    await d.engine.init();
    expect((await d.repo.queueAll())[0]!.status).toBe("pending");
    await d.engine.run();
    expect((await serverOffline(d)).games).toBe(1);
  });

  it("a record the server rejects is surfaced as failed (not retried forever) and doesn't block others", async () => {
    const d = await device();
    const good = await playOfflineGame(d);
    const bad = await playOfflineGame(d, 2);
    // tamper with the stored queue payload (e.g. devtools / corrupted data): impossible duration
    const q = (await d.repo.queueAll()).find((i) => i.id === bad.localGameId)!;
    (q.payload as { durationSeconds: number }).durationSeconds = 80_000; // passes the schema, fails plausibility
    await (d.repo as unknown as { db: { put(s: string, v: unknown): Promise<void> } }).db.put("syncQueue", q);
    const st = await d.engine.run();
    expect(st.failed).toBe(1);
    const items = Object.fromEntries((await d.repo.queueAll()).map((i) => [i.id, i]));
    expect(items[good.localGameId]!.status).toBe("synced");
    expect(items[bad.localGameId]!.status).toBe("failed");
    expect(items[bad.localGameId]!.lastError).toMatch(/duration/);
    expect((await d.repo.getGame(bad.localGameId))!.syncStatus).toBe("failed");
    expect((await serverOffline(d)).games).toBe(1); // only the legitimate game counts
    const hits = proxy.hits;
    d.sched.advance(10 * 60_000);
    await d.engine.run();
    expect(proxy.hits).toBe(hits); // failed items are not re-sent
  });

  it("settings + profile changes sync by timestamp (newer wins, replays are harmless)", async () => {
    const d = await device();
    await d.repo.saveSettings({ sound: false, theme: "ember" });
    await d.repo.patchProfile({ displayName: "Ryuji" }, { sync: true });
    const st = await d.engine.run();
    expect(st.pending).toBe(0);
    expect((await d.repo.queueAll()).filter((i) => i.status === "synced").map((i) => i.type).sort()).toEqual(["PROFILE_UPDATE", "SETTINGS_UPDATE"]);
    // an older settings upload (e.g. another device) is reported stale and still resolves cleanly
    const stale = await d.api.sync([{ id: "11111111-aaaa-bbbb-cccc-000000000001", type: "SETTINGS_UPDATE", payload: { updatedAt: 5, settings: { sound: true } } }]);
    expect(stale[0]!.status).toBe("stale");
  });

  it("recovers from an expired/invalid access token by re-establishing the session", async () => {
    const d = await device();
    await playOfflineGame(d);
    await d.api.ensureToken();
    (d.api as unknown as { token: string }).token = "not-a-valid-token";
    const st = await d.engine.run();
    expect(st.state).toBe("idle");
    expect((await serverOffline(d)).games).toBe(1);
  });

  it("concurrent run() calls do not double-send", async () => {
    const d = await device();
    await playOfflineGame(d);
    const spy = vi.spyOn(d.api, "sync");
    await Promise.all([d.engine.run(), d.engine.run(), d.engine.run()]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await serverOffline(d)).games).toBe(1);
  });
});

describe("network gate: NO requests while an offline game is active", () => {
  it("suspended network makes zero requests (sync, probes, auth) and resumes afterwards", async () => {
    const d = await device();
    await playOfflineGame(d);
    d.net.suspend("offline-game");
    const hits = proxy.hits;
    const st = await d.engine.run();
    await d.net.check();
    expect(st.state).toBe("offline");
    expect(proxy.hits).toBe(hits);
    expect(d.net.snapshot.suspended).toBe(true);
    d.net.resume("offline-game");
    await d.engine.run();
    expect(proxy.hits).toBeGreaterThan(hits);
    expect((await serverOffline(d)).games).toBe(1);
  });

  it("browser-offline: run() is a no-op, and the monitor reports offline / unreachable correctly", async () => {
    const sched = new ManualScheduler();
    let online = false;
    const d = await device();
    const net = new NetworkMonitor({ isBrowserOnline: () => online, probe: async () => false, scheduler: sched });
    expect(net.snapshot.state).toBe("offline");
    const engine = new SyncEngine({ repo: d.repo, api: d.api, network: net });
    await playOfflineGame(d);
    const hits = proxy.hits;
    expect((await engine.run()).state).toBe("offline");
    expect(proxy.hits).toBe(hits);
    online = true;
    // A single failed probe must NOT strand the app offline; the threshold is 2.
    const n2 = new NetworkMonitor({ isBrowserOnline: () => online, probe: async () => false, scheduler: sched });
    await n2.check();
    expect(n2.snapshot.state).not.toBe("unreachable");
    expect(n2.snapshot.failures).toBe(1);
    await n2.check();
    expect(n2.snapshot.state).toBe("unreachable");
  });

  it("NetworkMonitor fires onReconnect when the server comes back", async () => {
    const sched = new ManualScheduler();
    let reachable = false;
    let up: () => void = () => undefined;
    const net = new NetworkMonitor({ isBrowserOnline: () => true, probe: async () => reachable, scheduler: sched, listen: (u) => { up = u; return () => undefined; } });
    const cb = vi.fn();
    net.onReconnect(cb);
    net.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(net.snapshot.state).not.toBe("unreachable"); // one failure tolerated
    // Two consecutive failures do declare it unreachable.
    await net.check();
    expect(net.snapshot.state).toBe("unreachable");
    reachable = true;
    up();
    await new Promise((r) => setTimeout(r, 10));
    expect(net.snapshot.state).toBe("online");
    expect(cb).toHaveBeenCalledTimes(1);
    net.stop();
  });
});
