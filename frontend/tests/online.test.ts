import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlayerView } from "@old-maid/shared";
import { openDatabase, Repo } from "../src/offline/db";
import { createOnlineController, type OnlineController, type OnlineState } from "../src/store/onlineStore";
import { ApiClient } from "../src/sync/api";
import { uniqueDb } from "./helpers";
import { startBackend, type RunningServer } from "./serverProc";

let server: RunningServer;
beforeAll(async () => { server = await startBackend(); });
afterAll(async () => { await server.stop(); });

const open: OnlineController[] = [];
afterAll(() => open.forEach((c) => c.disconnect()));

async function user(getToken?: (force: boolean) => Promise<string>) {
  const repo = new Repo(await openDatabase(uniqueDb()));
  const api = new ApiClient({ baseUrl: server.url, repo });
  const ctl = createOnlineController({ url: server.url, getToken: getToken ?? ((f) => api.ensureToken(f)), transports: ["websocket"] });
  const views: PlayerView[] = [];
  ctl.store.subscribe((s, p) => { if (s.view && s.view !== p.view) views.push(structuredClone(s.view)); });
  open.push(ctl);
  ctl.connect();
  await until(ctl, (s) => s.conn === "connected");
  return { ctl, api, views, state: () => ctl.store.getState() };
}
type U = Awaited<ReturnType<typeof user>>;

function until(ctl: OnlineController, pred: (s: OnlineState) => boolean, ms = 8000): Promise<OnlineState> {
  return new Promise((resolve, reject) => {
    if (pred(ctl.store.getState())) return resolve(ctl.store.getState());
    const t = setTimeout(() => { off(); reject(new Error("timeout; state=" + JSON.stringify({ conn: ctl.store.getState().conn, status: ctl.store.getState().view?.status }))); }, ms);
    const off = ctl.store.subscribe((s) => { if (pred(s)) { clearTimeout(t); off(); resolve(s); } });
  });
}

/** Auto-play: whenever it's my turn, ask the server for a random legal draw. */
function autoplay(u: U) {
  const acted = new Set<number>();
  return u.ctl.store.subscribe((s) => {
    const v = s.view;
    if (!v || v.status !== "playing" || !v.game || v.game.paused || v.game.currentPlayerId !== v.you || s.pendingDraw) return;
    if (acted.has(v.game.turnId)) return;
    acted.add(v.game.turnId);
    const targets = v.players.filter((p) => p.id !== v.you && p.cardCount > 0);
    const t = targets[Math.floor(Math.random() * targets.length)]!;
    void u.ctl.draw(t.id, Math.floor(Math.random() * t.cardCount));
  });
}

describe("online client against the real server", () => {
  it("lobby: create → join → host-only start; room code is short and case-insensitive", async () => {
    const [a, b] = [await user(), await user()];
    expect(await a.ctl.createRoom("x")).toMatch(/2 characters/);
    expect(await a.ctl.createRoom("Ryuji")).toBeNull();
    const code = a.state().view!.roomCode;
    expect(code).toMatch(/^[A-Z2-9]{5}$/);
    expect(await b.ctl.joinRoom("ZZZZZ", "Akira")).toMatch(/does not exist/);
    expect(await b.ctl.joinRoom(code.toLowerCase(), "Akira")).toBeNull();
    await until(a.ctl, (s) => s.view?.players.length === 2);
    expect(a.state().view!.isHost).toBe(true);
    expect(b.state().view!.isHost).toBe(false);
    expect(await b.ctl.start(false)).toMatch(/host/i);
    expect(await a.ctl.start(false)).toBeNull();
    await until(b.ctl, (s) => s.view?.status === "playing");
    await a.ctl.leave(); await b.ctl.leave();
  });

  it("plays a full game; renders only permitted info; the Joker holder is declared the winner on both clients", async () => {
    const [a, b] = [await user(), await user()];
    await a.ctl.createRoom("Ryuji");
    await b.ctl.joinRoom(a.state().view!.roomCode, "Akira");
    const offA = autoplay(a), offB = autoplay(b);
    await a.ctl.start(false);
    const [fa, fb] = await Promise.all([until(a.ctl, (s) => !!s.gameOver && s.view?.status === "finished", 20_000), until(b.ctl, (s) => !!s.gameOver && s.view?.status === "finished", 20_000)]);
    offA(); offB();
    expect(fa.gameOver!.winnerId).toBe(fb.gameOver!.winnerId);
    const winner = fa.gameOver!.winnerId;
    const winnerClient = winner === a.state().view!.you ? a : b;
    const loserClient = winnerClient === a ? b : a;
    // Joker holder wins: they alone hold the final card, and it is the Joker
    expect(winnerClient.state().view!.myHand.map((c) => c.isJoker)).toEqual([true]);
    expect(loserClient.state().view!.myHand).toHaveLength(0);
    expect(fa.view!.result).toMatchObject({ winnerId: winner, finalCard: "joker", abandoned: false });

    // privacy audit over every view this browser ever held
    for (const u of [a, b]) {
      for (const v of u.views) {
        expect(Object.keys(v).sort()).toEqual(["events", "game", "hostId", "isHost", "maxPlayers", "minPlayers", "myHand", "players", "result", "roomCode", "status", "you"]);
        for (const p of v.players) expect(Object.keys(p).sort()).toEqual(["cardCount", "id", "isAi", "isConnected", "isHost", "name"]);
        expect(JSON.stringify({ ...v, myHand: [] })).not.toMatch(/"isJoker"|"suit"|"rank"/);
      }
    }
    await a.ctl.leave(); await b.ctl.leave();
  }, 30_000);

  it("reconnect restores the same private hand and room without restarting the game", async () => {
    const [a, b] = [await user(), await user()];
    await a.ctl.createRoom("Ryuji");
    await b.ctl.joinRoom(a.state().view!.roomCode, "Akira");
    await a.ctl.start(false);
    await until(b.ctl, (s) => s.view?.status === "playing");
    const before = b.state().view!;
    const handBefore = before.myHand.map((c) => c.id);
    // cut the transport (no clean goodbye) – socket.io reconnects with a fresh auth callback
    ((b.ctl.client as unknown as { socket: { io: { engine: { close(): void } } } }).socket).io.engine.close();
    await until(b.ctl, (s) => s.conn === "reconnecting");
    await until(b.ctl, (s) => s.conn === "connected");
    await until(b.ctl, (s) => s.view?.status === "playing" && s.view.myHand.length > 0);
    expect(b.state().view!.roomCode).toBe(before.roomCode);
    expect(b.state().view!.myHand.map((c) => c.id).sort()).toEqual([...handBefore].sort());
    expect(a.state().notices.some((n) => /Akira disconnected/.test(n.message))).toBe(true);
    await until(a.ctl, (s) => s.notices.some((n) => /Akira reconnected/.test(n.message)));
    await a.ctl.leave(); await b.ctl.leave();
  });

  it("a second tab takes over without the first fighting back (no reconnect ping-pong)", async () => {
    const a = await user();
    const token = await a.api.ensureToken();
    const dupe = await user(async () => token);
    await until(a.ctl, (s) => s.notices.some((n) => n.code === "TAKEOVER"));
    await new Promise((r) => setTimeout(r, 600));
    expect(a.state().conn).toBe("disconnected");
    expect(dupe.state().conn).toBe("connected");
  });

  it("surfaces an authentication failure instead of looping forever", async () => {
    const repo = new Repo(await openDatabase(uniqueDb()));
    void repo;
    const ctl = createOnlineController({ url: server.url, getToken: async () => "garbage.token.value", transports: ["websocket"] });
    open.push(ctl);
    ctl.connect();
    await until(ctl, (s) => s.authFailed);
    expect(ctl.store.getState().conn).toBe("disconnected");
  });
});
