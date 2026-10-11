import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices } from "../src/app/services";
import { HUMAN_ID } from "../src/game/offlineGame";
import { TimeWarpScheduler, uniqueDb } from "./helpers";
import { startBackend, startProxy, type Proxy, type RunningServer } from "./serverProc";

let server: RunningServer;
let proxy: Proxy;
beforeAll(async () => { server = await startBackend(); proxy = await startProxy(server.port); });
afterAll(async () => { await proxy.close(); await server.stop(); });

const until = async (pred: () => boolean | Promise<boolean>, ms = 30_000) => {
  const where = new Error().stack?.split("\n")[2]?.trim();
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition at " + where);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("ONLINE → connection lost → offline AI game → finish → connection restored → synced ✓", () => {
  it("runs the whole journey end to end against the real backend", async () => {
    let browserOnline = true;
    let up: () => void = () => undefined;
    let down: () => void = () => undefined;
    const netStates: string[] = [];
    const svc = await AppServices.create({
      apiUrl: proxy.url,
      socketUrl: proxy.url, // everything (HTTP + long-polling socket) goes through the switchable proxy
      transports: ["polling"],
      dbName: uniqueDb(),
      scheduler: new TimeWarpScheduler(),
      aiDelay: () => 1000, // one virtual second of "thinking" (5ms real)
      isBrowserOnline: () => browserOnline,
      listen: (u, d) => { up = u; down = d; return () => undefined; },
      onNet: (s) => { if (netStates.at(-1) !== s.state) netStates.push(s.state); },
    });
    svc.start();
    await until(() => svc.net.snapshot.state === "online");

    // 1) ONLINE: connect, create a room, we're in the lobby
    svc.online.connect();
    await until(() => svc.online.store.getState().conn === "connected");
    expect(await svc.online.createRoom("Ryuji")).toBeNull();
    const roomCode = svc.online.store.getState().view!.roomCode;
    expect(svc.online.store.getState().view!.status).toBe("waiting");

    // 2) the internet drops
    browserOnline = false;
    proxy.setDown(true);
    down();
    await until(() => svc.net.snapshot.state === "offline");
    await until(() => svc.online.store.getState().conn !== "connected");

    // 3) offline screen: play a complete offline AI game. NO network request may happen from here on.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await svc.startOffline({ humanName: "Ryuji", aiCount: 3, level: "hard", localPlayerId: (await svc.repo.getProfile()).localPlayerId });
    expect(svc.net.snapshot.suspended).toBe(true);
    expect(svc.online.store.getState().conn).toBe("disconnected"); // sockets are closed for offline play
    // Baseline is taken once the gate has closed. Socket.IO may still fire one transport-level
    // reconnect attempt while the socket is tearing down; that is the transport shutting down,
    // not the app making a request, so it is excluded from the "no traffic during play" count.
    const hitsAtStart = proxy.hits;
    for (let i = 0; i < 5000; i++) {
      const g = svc.offline.current!;
      if (g.finished) break;
      if (g.isHumanTurn) {
        const t = g.state.players.find((p) => p.id !== HUMAN_ID && p.hand.length > 0)!;
        await svc.offline.humanDraw(t.id, 0);
      } else { await new Promise((r) => setTimeout(r, 8)); await svc.offline.idle(); }
    }
    await svc.offline.idle();
    const g = svc.offline.current!;
    expect(g.finished).toBe(true);
    const holder = g.state.players.filter((p) => p.hand.length > 0);
    expect(holder).toHaveLength(1);
    expect(holder[0]!.hand[0]!.isJoker).toBe(true);        // the Joker holder…
    expect(g.winnerId).toBe(holder[0]!.id);                // …is the winner

    // 4) saved locally: result, statistics, and a pending sync-queue item. Still no network.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(proxy.hits).toBe(hitsAtStart);
    const [rec] = await svc.repo.listGames(1);
    expect(rec).toMatchObject({ mode: "offline-ai", aiDifficulty: "hard", playerCount: 4, syncStatus: "pending" });
    expect((await svc.repo.getStats()).offline.games).toBe(1);
    expect((await svc.repo.queueAll()).map((i) => i.status)).toEqual(["pending"]);
    expect(await svc.repo.loadActive()).toBeNull();
    expect(svc.sync.getStatus().pending).toBe(1);

    // 5) the internet comes back → sync happens automatically
    browserOnline = true;
    proxy.setDown(false);
    up();
    await until(async () => (await svc.repo.queueAll())[0]!.status === "synced");
    expect((await svc.repo.getGame(rec!.localGameId))!.syncStatus).toBe("synced");
    await until(() => svc.sync.getStatus().state === "idle"); // the engine publishes its final status just after the last item
    expect(svc.sync.getStatus()).toMatchObject({ state: "idle", pending: 0, failed: 0 });
    expect(netStates).toEqual(expect.arrayContaining(["online", "offline"]));
    expect(netStates.at(-1)).toBe("online");

    // the server counted it exactly once, as OFFLINE (unverified) – never as a verified online game
    const { stats } = await svc.api.myStats();
    expect(stats.offline).toEqual({ games: 1, wins: g.humanWon ? 1 : 0, losses: g.humanWon ? 0 : 1 });
    expect(stats.online.games).toBe(0);

    // 6) back online: the lobby we left is still there and is restored on reconnect
    await svc.offline.abandon();
    svc.leaveOffline();
    svc.online.connect();
    await until(() => svc.online.store.getState().conn === "connected");
    await until(() => svc.online.store.getState().view?.roomCode === roomCode);
    fetchSpy.mockRestore();
    svc.online.disconnect();
    svc.stop();
  }, 60_000);

  it("closing the app mid-game and reopening resumes it offline, then syncs", async () => {
    const dbName = uniqueDb();
    const sched = new TimeWarpScheduler();
    const mk = () => AppServices.create({ apiUrl: proxy.url, socketUrl: proxy.url, dbName, scheduler: sched, aiDelay: () => 1000, isBrowserOnline: () => true });
    const a = await mk();
    await a.startOffline({ humanName: "Ryuji", aiCount: 2, level: "normal", localPlayerId: (await a.repo.getProfile()).localPlayerId });
    for (let i = 0; i < 6; i++) {
      const g = a.offline.current!;
      if (g.finished) break;
      if (g.isHumanTurn) await a.offline.humanDraw(g.state.players.find((p) => p.id !== HUMAN_ID && p.hand.length > 0)!.id, 0);
      else { await new Promise((r) => setTimeout(r, 15)); await a.offline.idle(); }
    }
    await a.offline.idle();
    const frozenDraws = a.offline.current!.state.drawCount;
    a.offline.dispose(); a.repo.close(); // app killed

    const b = await mk();
    expect(await b.hasActiveOffline()).toBe(true);
    expect(await b.resumeOffline()).toBe(true);
    expect(b.offline.current!.state.drawCount).toBeGreaterThanOrEqual(frozenDraws);
    for (let i = 0; i < 5000 && !b.offline.current!.finished; i++) {
      const g = b.offline.current!;
      if (g.isHumanTurn) await b.offline.humanDraw(g.state.players.find((p) => p.id !== HUMAN_ID && p.hand.length > 0)!.id, 0);
      else { await new Promise((r) => setTimeout(r, 15)); await b.offline.idle(); }
    }
    await b.offline.idle();
    await until(async () => (await b.repo.queueAll()).every((i) => i.status === "synced") && (await b.repo.queueAll()).length > 0);
    expect((await b.repo.getStats()).offline.games).toBe(1);
    expect((await b.api.myStats()).stats.offline.games).toBe(1);
  }, 60_000);
});
