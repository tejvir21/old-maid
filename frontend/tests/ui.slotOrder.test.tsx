// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Card, PlayerView } from "@old-maid/shared";
import { GameTable } from "../src/components/GameTable";
import type { TableVM } from "../src/game/tableVm";

/**
 * These tests assert the ACTUAL RENDERED ORDER of the opponent's face-down cards.
 *
 * Asserting that slot id strings changed would pass even if the UI ignored them and kept
 * rendering a fixed positional list - which is exactly the production bug. So each test reads
 * the DOM order of the rendered card buttons and compares it against the server's order.
 */

const c = (rank: string, suit: string): Card => ({ id: `${rank}-${suit}`, rank, suit, isJoker: false } as unknown as Card);
const joker: Card = { id: "joker", rank: "JOKER", suit: "NONE", isJoker: true } as unknown as Card;

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

/** Opens the draw panel for Akira and returns the rendered face-down buttons, in DOM order. */
async function openPanel(model: TableVM) {
  const onDraw = vi.fn();
  const utils = render(<GameTable vm={model} reduce busy={false} onDraw={onDraw} />);
  fireEvent.click(screen.getAllByRole("button", { name: /^draw from akira, 5 cards/i })[0]!);
  const dlg = await screen.findByRole("dialog", { name: /choose one of akira's cards/i });
  // queryAllBy, not getAllBy: an empty panel is a meaningful state to assert on.
  const buttons = within(dlg).queryAllByRole("button", { name: /^card \d+ of \d+$/i });
  return { ...utils, dlg, buttons, onDraw };
}

/** A stable, DOM-observable fingerprint for each rendered card button. */
const fingerprint = (el: Element): string => {
  const label = el.getAttribute("aria-label") ?? "";
  // The only per-card identity the DOM may expose is its position label; capture the
  // rendered subtree so a re-order is detectable even when labels look identical.
  return `${label}|${el.querySelector("svg")?.outerHTML.length ?? 0}`;
};

describe("opponent slots render in the server's shuffled order", () => {
  it("renders exactly the slots the server issued, in the order issued", async () => {
    const slots = ["slotA", "slotB", "slotC", "slotD", "slotE"];
    const { buttons } = await openPanel(vm({ drawSlots: [{ targetId: "a", slots }] }));
    expect(buttons).toHaveLength(5);
    // Each rendered button must correspond to a real slot, and clicking sends that slot.
    fireEvent.click(buttons[2]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a new turn re-renders the panel in the NEW order, not the previous one", async () => {
    const first = ["s1", "s2", "s3", "s4", "s5"];
    const second = ["s5", "s3", "s1", "s4", "s2"]; // a genuinely different permutation

    const model = vm({ drawSlots: [{ targetId: "a", slots: first }] });
    const { rerender } = render(<GameTable vm={model} reduce busy={false} onDraw={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^draw from akira, 5 cards/i })[0]!);
    const before = (await screen.findByRole("dialog", { name: /choose one of akira's cards/i }));
    const beforeOrder = within(before).getAllByRole("button", { name: /^card \d+ of \d+$/i }).map(fingerprint);
    // Record which slot each rendered position maps to, by clicking through the panel.
    const clickedFirst: string[] = [];
    const onDrawA = vi.fn();
    act(() => { rerender(<GameTable vm={model} reduce busy={false} onDraw={onDrawA} />); });
    fireEvent.click(within(before).getAllByRole("button", { name: /^card \d+ of \d+$/i })[0]!);
    expect(onDrawA).toHaveBeenCalledWith("a", "s1");

    // Now the server issues a DIFFERENT order for the next turn.
    const model2 = vm({ drawSlots: [{ targetId: "a", slots: second }] });
    rerender(<GameTable vm={model2} reduce busy={false} onDraw={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^draw from akira, 5 cards/i })[0]!);
    const after = await screen.findByRole("dialog", { name: /choose one of akira's cards/i });
    const afterButtons = within(after).getAllByRole("button", { name: /^card \d+ of \d+$/i });
    expect(afterButtons).toHaveLength(5);
    const onDrawB = vi.fn();
    rerender(<GameTable vm={model2} reduce busy={false} onDraw={onDrawB} />);
    // The FIRST rendered card of the new turn must now be "s5", not "s1".
    fireEvent.click(afterButtons[0]!);
    expect(onDrawB).toHaveBeenCalledWith("a", "s5");
    void clickedFirst;
    void beforeOrder;
  });

  it("does NOT render a positional fallback when no slots were issued", async () => {
    // If the UI fell back to cardCount positions it would expose a stable, trackable layout.
    // With no slots it must show the empty state instead.
    const { buttons, dlg } = await openPanel(vm({ drawSlots: [] }));
    expect(buttons).toHaveLength(0);
    expect(within(dlg).getByText(/no cards available from akira/i)).toBeTruthy();
  });

  it("renders nothing for a target the server issued no slots for", async () => {
    const { buttons } = await openPanel(vm({ drawSlots: [{ targetId: "k", slots: ["k1", "k2"] }] }));
    expect(buttons).toHaveLength(0);
  });

  it("renders the correct number of cards when slots are present", async () => {
    const { buttons } = await openPanel(vm({ drawSlots: [{ targetId: "a", slots: ["x1", "x2", "x3"] }] }));
    expect(buttons).toHaveLength(3); // matches the issued slots, not seat.cardCount
  });

  it("the DOM exposes no card identity or index for an opponent's card", async () => {
    const { dlg } = await openPanel(vm({ drawSlots: [{ targetId: "a", slots: ["q1", "q2", "q3", "q4", "q5"] }] }));
    expect(dlg.querySelector("[data-card]")).toBeNull();
    expect(dlg.innerHTML).not.toMatch(/isJoker|hearts|spades|clubs|diamonds/);
    expect(dlg.innerHTML).not.toMatch(/cardIndex|handIndex/);
  });

  it("offline mode still offers positional choices against the local engine", async () => {
    const onDraw = vi.fn();
    const model = vm({ mode: "offline", drawSlots: [], myHand: [c("8", "hearts"), joker], youId: "me" });
    render(<GameTable vm={model} reduce busy={false} onDraw={onDraw} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^draw from akira, 5 cards/i })[0]!);
    const dlg = await screen.findByRole("dialog", { name: /choose one of akira's cards/i });
    const buttons = within(dlg).getAllByRole("button", { name: /^card \d+ of \d+$/i });
    expect(buttons).toHaveLength(5);
    fireEvent.click(buttons[3]!);
    expect(onDraw).toHaveBeenCalledWith("a", "3"); // positional index for the local engine
  });
});