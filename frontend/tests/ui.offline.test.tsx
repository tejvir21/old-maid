// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within, configure } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp } from "./uiHarness";

// This file plays a whole game through React while every other suite runs in parallel.
// Testing Library's 1s default is not enough on a loaded machine, which produced spurious
// failures on the render step. Raising the timeout does not weaken any assertion.
configure({ asyncUtilTimeout: 15_000 });

afterEach(() => vi.restoreAllMocks());
const tick = (ms = 10) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("offline game through the real UI (no network at all)", () => {
  it("menu → setup → intro → play by clicking → Joker reveal → verdict → result persisted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { svc } = await mountApp("/offline");
    expect(screen.getByRole("heading", { name: /play offline/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "2" }));
    fireEvent.click(screen.getByRole("radio", { name: "Easy" }));
    fireEvent.click(screen.getByRole("button", { name: /start game/i }));

    // cinematic start: SEVEN/THREE PLAYERS · ONE JOKER, then skippable
    const intro = await screen.findByRole("dialog", { name: /game starting/i });
    expect(within(intro).getByText(/three players/i)).toBeTruthy();
    expect(within(intro).getByText(/one joker/i)).toBeTruthy();
    fireEvent.click(intro);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /game starting/i })).toBeNull());

    let sawReveal = false;
    // Time-based deadline rather than a fixed iteration count: under parallel load the AI
    // timers fire slower, and a count-based loop could give up before the game finishes.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (screen.queryByRole("dialog", { name: /game over/i })) break;
      const reveal = screen.queryByRole("dialog", { name: /you drew/i });
      if (reveal) { sawReveal = true; fireEvent.click(reveal); await tick(); continue; }
      const draw = screen.queryAllByRole("button", { name: /^draw from/i });
      if (draw.length) {
        fireEvent.click(draw[0]!);
        const card = await screen.findByRole("button", { name: /^card 1 of/i });
        fireEvent.click(card);
      }
      await tick(15);
    }
    expect(sawReveal).toBe(true);

    const over = await screen.findByRole("dialog", { name: /game over/i });
    // Joker holder is declared the winner, everyone else a loser
    const results = within(over).getByRole("list", { name: /results/i });
    const rows = within(results).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => /WINNER/.test(r.textContent ?? ""))).toHaveLength(1);
    expect(rows.filter((r) => /LOSER/.test(r.textContent ?? ""))).toHaveLength(2);
    expect(within(over).getByText(/the joker has chosen its holder/i)).toBeTruthy();
    const g = svc.offline.current!;
    expect(g.finished).toBe(true);
    const winnerName = g.name(g.state.players.find((p) => p.hand.some((c) => c.isJoker))!.id);
    expect(rows.find((r) => /WINNER/.test(r.textContent ?? ""))!.textContent).toContain(winnerName);
    if (g.humanWon) {
      expect(within(over).getByText(/game cleared/i)).toBeTruthy();
      expect(within(over).getByText(/you held the joker until the end/i)).toBeTruthy();
    } else {
      expect(within(over).getByText(/game over/i)).toBeTruthy();
      expect(within(over).getByText(/the joker was not yours/i)).toBeTruthy();
    }

    // saved locally + queued for sync; the app never touched the network
    await waitFor(async () => expect((await svc.repo.listGames()).length).toBe(1));
    expect((await svc.repo.queueAll()).filter((q) => q.type === "GAME_RESULT").map((q) => q.status)).toEqual(["pending"]);
    expect((await svc.repo.getStats()).offline.games).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    // PLAY AGAIN really starts a fresh game
    fireEvent.click(within(over).getByRole("button", { name: /play again/i }));
    await screen.findByRole("dialog", { name: /game starting/i });
  }, 120_000);

  it("reload mid-game restores the saved game from IndexedDB", async () => {
    const first = await mountApp("/offline");
    fireEvent.click(screen.getByRole("button", { name: /start game/i }));
    fireEvent.click(await screen.findByRole("dialog", { name: /game starting/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /game starting/i })).toBeNull());
    await first.svc.offline.idle();
    const drawsBefore = first.svc.offline.current!.state.drawCount;
    first.unmount();
    first.svc.offline.dispose();
    first.svc.repo.close();

    // "reopen the browser" straight onto the play URL
    const { svc } = await mountApp("/offline/play", { dbName: (first.svc as unknown as { repo: { db: { name: string } } }).repo.db.name });
    await waitFor(() => expect(svc.offline.current).toBeTruthy());
    expect(svc.offline.current!.state.drawCount).toBeGreaterThanOrEqual(drawsBefore);
    expect(screen.getAllByRole("img", { name: /of (hearts|diamonds|clubs|spades)|joker/i }).length).toBeGreaterThan(0);
  }, 60_000);
});
