import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PlayerView } from "@old-maid/shared";
import { openDatabase, Repo } from "../src/offline/db";
import { createOnlineController, type OnlineController } from "../src/store/onlineStore";
import { ApiClient } from "../src/sync/api";
import { onlineVm } from "../src/game/tableVm";
import { uniqueDb } from "./helpers";
import { startBackend, type RunningServer } from "./serverProc";

/**
 * REAL BACKEND -> REAL SOCKET -> REAL STORE, asserting the data the renderer receives.
 *
 * Runs in the node environment because jsdom's WebSocket cannot complete the Socket.IO
 * handshake against the test server (it yields UNAUTHORIZED), which is an environment
 * limitation rather than a product defect. The rendering half of the chain is covered by
 * `ui.slotOrder.test.tsx`, which drives the REAL `GameTable` from store-shaped state.
 *
 * What this file proves about the live wire:
 *   1. the client receives a fresh permutation for the current turn;
 *   2. the permutation DIFFERS from the previous turn's for the same target;
 *   3. `onlineVm` carries that order through to the renderer unchanged;
 *   4. the draw payload carries the FIRST slot of that order (what the first card sends);
 *   5. the idle player never receives the viewer's mapping.
 */
let server: RunningServer;
beforeAll(async () => { server = await startBackend(); }, 60_000);
afterAll(async () => { await server.stop(); });

const open: OnlineController[] = [];
afterAll(() => open.forEach((c) => c.disconnect()));

type U = { ctl: OnlineController; state: () => ReturnType<OnlineController["store"]["getState"]> };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function user(): Promise<U> {
  const repo = new Repo(await openDatabase(uniqueDb()));
  const api = new ApiClient({ baseUrl: server.url, repo });
  const ctl = createOnlineController({ url: server.url, getToken: (f) => api.ensureToken(f), transports: ["websocket"] });
  open.push(ctl);
  ctl.connect();
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    if (ctl.store.getState().conn === "connected") break;
    await sleep(100);
  }
  if (ctl.store.getState().conn !== "connected") throw new Error("socket did not connect: " + ctl.store.getState().error);
  return { ctl, state: () => ctl.store.getState() };
}

/** Creates a started 2-human room and returns both users. */
async function startedRoom(label: string): Promise<{ a: U; b: U; code: string }> {
  const a = await user();
  const b = await user();
  await a.ctl.createRoom("Alpha" + label);
  let t0 = Date.now();
  while (!a.state().view?.roomCode && Date.now() - t0 < 15_000) await sleep(50);
  const code = a.state().view?.roomCode ?? "";
  expect(code, "room code should be issued").not.toBe("");
  await b.ctl.joinRoom(code, "Bravo" + label);
  t0 = Date.now();
  while (b.state().view?.roomCode !== code && Date.now() - t0 < 15_000) await sleep(50);
  await a.ctl.start(false);
  t0 = Date.now();
  while (a.state().view?.status !== "playing" && Date.now() - t0 < 20_000) await sleep(50);
  expect(a.state().view?.status, "game should be playing").toBe("playing");
  return { a, b, code };
}

/** Waits for `u` to be on turn with slots issued for `targetId`; returns that slot order. */
async function waitForTurnSlots(u: U, targetId: string, ms = 15_000): Promise<string[] | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = u.state();
    if (s.view?.status !== "playing") return null;
    if (s.view?.game?.currentPlayerId === s.view.you && s.slotsTurnId === s.view.game.turnId) {
      const t = s.drawSlots.find((x) => x.targetId === targetId);
      if (t && t.slots.length > 0) return [...t.slots];
    }
    await sleep(80);
  }
  return null;
}

describe("live server -> store: the permutation reaches the client and changes each turn", () => {
  it("emits a fresh, different order per turn, and the draw payload uses its first slot", async () => {
    const { a, b } = await startedRoom("");

    const orders: string[][] = [];
    const sentFirsts: string[] = [];
    const handled = new Set<number>();

    for (let i = 0; i < 40 && orders.length < 3; i++) {
      const onTurn = a.state().view?.game?.currentPlayerId === a.state().view?.you ? a : b;
      const other = onTurn === a ? b : a;
      const otherId = other.state().view?.you ?? "";
      if (!otherId) { await sleep(100); continue; }

      const slots = await waitForTurnSlots(onTurn, otherId);
      if (!slots) break;

      const turnId = onTurn.state().view?.game?.turnId ?? -1;
      if (handled.has(turnId)) { await sleep(120); continue; } // opponent has not moved yet
      handled.add(turnId);

      if (onTurn === a) {
        orders.push(slots);

        // (3) the renderer must receive that exact order, unchanged.
        const s = a.state();
        const vm = onlineVm(s.view as PlayerView, [], null, s.view?.game?.turnId === s.slotsTurnId ? s.drawSlots : []);
        const vmSlots = vm.drawSlots.find((x) => x.targetId === otherId)?.slots ?? [];
        expect(vmSlots, "onlineVm must carry the server order through unchanged").toEqual(slots);

        // (4) the first visible card must send the first slot.
        // Spy WITHOUT mocking so the real draw still happens and the turn genuinely advances.
        const spy = vi.spyOn(a.ctl.client, "requestDraw");
        const err = await a.ctl.draw(otherId, slots[0]!);
        expect(err, "a valid slot draw must succeed").toBeNull();
        expect(spy).toHaveBeenCalled();
        const payload = spy.mock.calls[0]![0] as { slotId: string; targetPlayerId: string; turnId: number };
        expect(payload.slotId, "first rendered card sends the first current slot").toBe(slots[0]!);
        expect(payload.targetPlayerId).toBe(otherId);
        expect(payload, "legacy cardIndex must never be sent").not.toHaveProperty("cardIndex");
        sentFirsts.push(payload.slotId);
        spy.mockRestore();
      } else {
        await onTurn.ctl.draw(otherId, slots[0]!);
      }
      await sleep(220);
    }

    expect(orders.length, "expected at least two turns to compare orders").toBeGreaterThanOrEqual(2);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]!, `turn ${i} repeated the previous order`).not.toEqual(orders[i - 1]!);
    }
    expect(new Set(sentFirsts).size, "the first slot must differ between turns").toBe(sentFirsts.length);
  }, 120_000);

  it("the idle player never receives the other player's slot mapping", async () => {
    const { a, b } = await startedRoom("2");
    await sleep(800);
    const acting = a.state().view?.you === a.state().view?.game?.currentPlayerId ? a : b;
    const idle = acting === a ? b : a;
    expect(acting.state().drawSlots.length, "acting player receives slots").toBeGreaterThan(0);
    expect(idle.state().drawSlots, "idle player must receive none").toHaveLength(0);
    expect(idle.state().slotsTurnId).toBeNull();
  }, 60_000);

  it("a consumed slot cannot be reused on the same turn", async () => {
    const { a, b } = await startedRoom("3");
    const onTurn = a.state().view?.you === a.state().view?.game?.currentPlayerId ? a : b;
    const other = onTurn === a ? b : a;
    const otherId = other.state().view?.you ?? "";
    const slots = await waitForTurnSlots(onTurn, otherId);
    expect(slots, "slots should be issued").not.toBeNull();
    const turnId = onTurn.state().view?.game?.turnId ?? -1;

    const ok = await onTurn.ctl.client.requestDraw({ targetPlayerId: otherId, slotId: slots![0]!, turnId, actionId: randomUUID() });
    expect(ok.ok).toBe(true);
    // Replaying the same slot with a NEW action id on the same turn must still be refused.
    const again = await onTurn.ctl.client.requestDraw({ targetPlayerId: otherId, slotId: slots![0]!, turnId, actionId: randomUUID() });
    expect(again.ok, "a consumed slot must not be reusable").toBe(false);
  }, 60_000);
});