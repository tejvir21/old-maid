// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Card } from "@old-maid/shared";
import { GameTable } from "../src/components/GameTable";
import type { TableVM } from "../src/game/tableVm";

/**
 * These tests assert the ACTUAL RENDERED ORDER of the opponent's selectable face-down cards.
 *
 * Asserting that slot id strings changed would pass even if the UI ignored them and kept
 * rendering a fixed positional list - which is exactly the production bug. Each test clicks a
 * specific rendered position and asserts the slot id that position now sends.
 */

const c = (rank: string, suit: string): Card => ({ id: `${rank}-${suit}`, rank, suit, isJoker: false } as unknown as Card);

const seat = (id: string, name: string, cardCount: number, isYou = false) => ({
  id, name, cardCount, isYou, isCurrent: false, isConnected: true, isHost: false, isAi: false, reaction: false,
});

function vm(over: Partial<TableVM> = {}): TableVM {
  return {
    mode: "online", youId: "me", seats: [seat("me", "Me", 2, true), seat("a", "Akira", 5), seat("k", "Ken", 4)],
    myHand: [c("8", "hearts"), c("Q", "spades")],
    drawSlots: [],
    currentId: "me", currentName: "Me", canAct: true, cardsRemaining: 11, round: 2,
    playersWithCards: 3, log: [], paused: null, finished: false, abandoned: false,
    winnerId: null, winnerName: "", youWon: false,
    ...over,
  };
}

/** Opens the draw panel and returns its card buttons in DOM order plus the click spy. */
async function openPanel(model: TableVM, onDraw = vi.fn()) {
  const utils = render(<GameTable vm={model} reduce busy={false} onDraw={onDraw} />);
  fireEvent.click(screen.getAllByRole("button", { name: /^draw from akira, 5 cards/i })[0]!);
  const dlg = await screen.findByRole("dialog", { name: /choose one of akira's cards/i });
  const buttons = within(dlg).queryAllByRole("button", { name: /^card \d+ of \d+$/i });
  return { ...utils, dlg, buttons, onDraw };
}

describe("opponent slots render in the server's shuffled order", () => {
  it("renders exactly the slots the server issued", async () => {
    const slots = ["alpha-slot", "bravo-slot", "charlie-slot", "delta-slot", "echo-slot"];
    const { buttons } = await openPanel(vm({ drawSlots: [{ targetId: "a", slots }] }));
    expect(buttons).toHaveLength(5);
  });

  it("each rendered position sends the slot the server put at that position", async () => {
    const slots = ["pos-0", "pos-1", "pos-2"];
    // Open once per position: the panel closes after a pick, by design.
    for (let i = 0; i < slots.length; i++) {
      const onDraw = vi.fn();
      const { unmount } = render(<GameTable vm={vm({ drawSlots: [{ targetId: "a", slots }] })} reduce busy={false} onDraw={onDraw} />);
      fireEvent.click(screen.getAllByRole("button", { name: /^draw from akira, 5 cards/i })[0]!);
      const dlg = await screen.findByRole("dialog", { name: /choose one of akira's cards/i });
      const buttons = within(dlg).getAllByRole("button", { name: /^card \d+ of \d+$/i });
      fireEvent.click(buttons[i]!);
      expect(onDraw, `rendered position ${i}`).toHaveBeenCalledWith("a", slots[i]);
      unmount();
    }
  });

  it("a new permutation changes which slot each rendered position sends", async () => {
    // Realistic opaque ids and a genuinely different permutation, as the server would send.
    const first = ["aGVsbG8gd29ybGQ", "c2Vjb25kIHNsaXQ", "dGhpcmQgdG9rZW4", "Zm91cnRoIHZhbHVl", "ZmlmdGggc2xvdA"];
    const second = ["ZmlmdGggc2xvdA", "dGhpcmQgdG9rZW4", "Zm91cnRoIHZhbHVl", "Yzl2aHJ0d2Fz", "YWxwaGEgZ2FtZQ"];

    const onDrawA = vi.fn();
    const firstRender = render(<GameTable vm={vm({ drawSlots: [{ targetId: "a", slots: first }] })} reduce busy={false} onDraw={onDrawA} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^draw from akira, 5 cards/i })[0]!);
    const dlg1 = await screen.findByRole("dialog", { name: /choose one of akira's cards/i });
    fireEvent.click(within(dlg1).getAllByRole("button", { name: /^card \d+ of \d+$/i })[0]!);
    // The FIRST rendered card of turn 1 sends the FIRST slot of turn 1.
    expect(onDrawA).toHaveBeenCalledWith("a", first[0]);
    firstRender.unmount();

    const onDrawB = vi.fn();
    render(<GameTable vm={vm({ drawSlots: [{ targetId: "a", slots: second }] })} reduce busy={false} onDraw={onDrawB} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^draw from akira, 5 cards/i })[0]!);
    const dlg2 = await screen.findByRole("dialog", { name: /choose one of akira's cards/i });
    fireEvent.click(within(dlg2).getAllByRole("button", { name: /^card \d+ of \d+$/i })[0]!);
    // The FIRST rendered card of turn 2 sends the NEW first slot - not the old one.
    expect(onDrawB).toHaveBeenCalledWith("a", second[0]);
    expect(second[0]).not.toBe(first[0]);
  });

  it("does NOT render a positional fallback when no slots were issued", async () => {
    // A positional fallback would expose a stable, trackable layout. With no slots, show nothing.
    const { buttons, dlg } = await openPanel(vm({ drawSlots: [] }));
    expect(buttons).toHaveLength(0);
    expect(within(dlg).getByText(/no cards available from akira/i)).toBeTruthy();
  });

  it("renders nothing for a target the server issued no slots for", async () => {
    const { buttons } = await openPanel(vm({ drawSlots: [{ targetId: "k", slots: ["k1", "k2"] }] }));
    expect(buttons).toHaveLength(0);
  });

  it("renders the number of cards the server issued, not seat.cardCount", async () => {
    // seat.cardCount is 5; only three slots exist, so only three cards may be offered.
    const { buttons } = await openPanel(vm({ drawSlots: [{ targetId: "a", slots: ["x1", "x2", "x3"] }] }));
    expect(buttons).toHaveLength(3);
  });

  it("the DOM exposes no card identity or index for an opponent's card", async () => {
    const { dlg } = await openPanel(vm({ drawSlots: [{ targetId: "a", slots: ["q1", "q2", "q3", "q4", "q5"] }] }));
    expect(dlg.querySelector("[data-card]")).toBeNull();
    expect(dlg.innerHTML).not.toMatch(/isJoker|hearts|spades|clubs|diamonds/);
    expect(dlg.innerHTML).not.toMatch(/cardIndex|handIndex/);
    // No attribute may carry a slot id, so the DOM cannot be scraped for the mapping.
    for (const el of Array.from(dlg.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.value, `attribute ${attr.name} leaked a slot`).not.toMatch(/q[1-5]/);
      }
    }
  });

  it("offline mode still offers positional choices against the local engine", async () => {
    const onDraw = vi.fn();
    const model = vm({ mode: "offline", drawSlots: [], youId: "me" });
    render(<GameTable vm={model} reduce busy={false} onDraw={onDraw} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^draw from akira, 5 cards/i })[0]!);
    const dlg = await screen.findByRole("dialog", { name: /choose one of akira's cards/i });
    const buttons = within(dlg).getAllByRole("button", { name: /^card \d+ of \d+$/i });
    expect(buttons).toHaveLength(5);
    fireEvent.click(buttons[3]!);
    expect(onDraw).toHaveBeenCalledWith("a", "3"); // positional index for the local engine
  });
});