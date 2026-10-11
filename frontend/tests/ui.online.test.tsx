// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Card, PlayerView } from "@old-maid/shared";
import { CardFace } from "../src/components/Card";
import { Avatar } from "../src/components/Avatar";
import { render } from "@testing-library/react";
import { mountApp } from "./uiHarness";

const c = (rank: string, suit: Card["suit"]): Card => ({ id: `${rank}-${suit}`, rank, suit, isJoker: false });
const joker: Card = { id: "joker", rank: "JOKER", isJoker: true };
const P = (id: string, name: string, n: number, host = false, connected = true) => ({ id, name, cardCount: n, isConnected: connected, isHost: host, isAi: false });

function view(over: Partial<PlayerView> = {}): PlayerView {
  return {
    roomCode: "A7K9P", status: "playing", you: "me", hostId: "me", isHost: true,
    players: [P("me", "Ryuji", 3, true), P("a", "Akira", 5), P("k", "Ken", 4)],
    maxPlayers: 7, minPlayers: 2,
    game: { currentPlayerId: "me", turnId: 7, drawCount: 12, cardsRemaining: 12, discardedPairs: 20, paused: null },
    myHand: [c("8", "hearts"), c("Q", "spades"), joker], result: null,
    events: [{ seq: 1, type: "card_drawn", text: "Akira drew a card from Ken." }], ...over,
  };
}
const open = (v: PlayerView, conn: "connected" | "reconnecting" = "connected") =>
  mountApp("/online/room", {}, (svc) => svc.online.store.setState({ conn, view: v }));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe("online table renders only what the server permits", () => {
  it("shows your own cards face-up and every opponent as a card count — nothing else", async () => {
    await open(view());
    const fronts = [...document.querySelectorAll('[data-face="front"]')].map((e) => e.getAttribute("data-card"));
    expect(fronts.sort()).toEqual(["8-hearts", "Q-spades", "joker"]); // exactly your hand
    // opponents: counts visible, no card identities anywhere in the DOM outside your hand
    expect(screen.getAllByLabelText("5 cards").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("4 cards").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Akira").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/9 of clubs/);
    expect(screen.getByLabelText("Your hand")).toBeTruthy();
  });

  it("drawing sends only {target, position, turnId, actionId} and then waits for the server", async () => {
    const { svc } = await open(view());
    const spy = vi.fn().mockResolvedValue({ ok: true });
    svc.online.client.requestDraw = spy;
    fireEvent.click(screen.getAllByRole("button", { name: /^draw from akira, 5 cards/i })[0]!);
    const dlg = await screen.findByRole("dialog", { name: /choose one of akira's cards/i });
    const cards = within(dlg).getAllByRole("button", { name: /^card \d of 5$/i });
    expect(cards).toHaveLength(5);
    expect(within(dlg).queryAllByRole("img", { name: /of (hearts|spades|clubs|diamonds)/i })).toHaveLength(0); // face-down only
    fireEvent.click(cards[2]!);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]![0]).toEqual({ targetPlayerId: "a", cardIndex: 2, turnId: 7, actionId: expect.any(String) });
    // while the request is in flight the UI offers no further draws (duplicate-click protection)
    expect(svc.online.store.getState().pendingDraw).toBe(true);
    await settle();
    expect(screen.queryAllByRole("button", { name: /^draw from/i })).toHaveLength(0);
  });

  it("the card identity appears only when the server reveals it, then joins the log privately", async () => {
    const { svc } = await open(view());
    expect(screen.queryByRole("dialog", { name: /you drew/i })).toBeNull();
    act(() => svc.online.store.setState({ revealed: { card: c("9", "clubs"), pairFormed: false, pairCards: null, fromPlayerId: "a", at: 1 } }));
    const reveal = await screen.findByRole("dialog", { name: /you drew 9 of clubs/i });
    fireEvent.click(reveal);
    await waitFor(() => expect(svc.online.store.getState().revealed).toBeNull());
    await waitFor(() => expect(screen.getAllByText(/You drew 9 of clubs from Akira/).length).toBeGreaterThan(0));
  });

  it("Joker draws get the dramatic reveal", async () => {
    const { svc } = await open(view());
    act(() => svc.online.store.setState({ revealed: { card: joker, pairFormed: false, pairCards: null, fromPlayerId: "k", at: 2 } }));
    const dlg = await screen.findByRole("dialog", { name: /you drew joker/i });
    await waitFor(() => expect(within(dlg).getByText(/the joker/i)).toBeTruthy());
  });

  it("when it's not your turn there is nothing to click", async () => {
    await open(view({ game: { currentPlayerId: "a", turnId: 8, drawCount: 13, cardsRemaining: 12, discardedPairs: 20, paused: null } }));
    expect(screen.queryAllByRole("button", { name: /^draw from/i })).toHaveLength(0);
    expect(screen.getAllByText(/current turn:/i).length).toBeGreaterThan(0);
  });

  it("a lost connection blocks actions and shows the reconnecting banner", async () => {
    await open(view(), "reconnecting");
    expect(screen.getByText(/connection lost — reconnecting/i)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^draw from/i })).toHaveLength(0);
  });
});

describe("pause on disconnect", () => {
  const paused = (secondsLeft: number, isHost: boolean) =>
    view({ isHost, hostId: isHost ? "me" : "a", game: { currentPlayerId: "a", turnId: 9, drawCount: 14, cardsRemaining: 12, discardedPairs: 20, paused: { playerId: "a", secondsLeft } },
      players: [P("me", "Ryuji", 3, isHost), P("a", "Akira", 5, !isHost, false), P("k", "Ken", 4)] });

  it("shows who we're waiting for with a countdown; only the host can end it, and only after the window", async () => {
    const a = await open(paused(45, true));
    expect(screen.getByText(/waiting for akira to reconnect/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /end match/i })).toBeNull();
    a.unmount();
    const b = await open(paused(0, true));
    expect(screen.getByRole("button", { name: /end match/i })).toBeTruthy();
    b.unmount();
    await open(paused(0, false));
    expect(screen.queryByRole("button", { name: /end match/i })).toBeNull();
    expect(screen.getByText(/or the host ends the match/i)).toBeTruthy();
  });
});

describe("Joker reveal and verdict (online)", () => {
  const over = (winnerId: string, isHost = true, abandoned = false) =>
    view({ status: "finished", isHost, game: { currentPlayerId: null, turnId: 40, drawCount: 39, cardsRemaining: 1, discardedPairs: 26, paused: null },
      myHand: winnerId === "me" ? [joker] : [], players: [P("me", "Ryuji", winnerId === "me" ? 1 : 0, isHost), P("a", "Akira", winnerId === "a" ? 1 : 0), P("k", "Ken", 0)],
      result: abandoned ? { winnerId: null, finalCard: null, abandoned: true } : { winnerId, finalCard: "joker", abandoned: false } });

  it("declares the Joker holder the winner and every other player a loser (you lost)", async () => {
    await open(over("a"));
    const dlg = await screen.findByRole("dialog", { name: /game over/i });
    expect(within(dlg).getByText(/the joker was held by/i)).toBeTruthy();
    expect(within(dlg).getAllByText("Akira").length).toBeGreaterThan(0);
    expect(within(dlg).getByText(/you lost\./i)).toBeTruthy();
    expect(within(dlg).getByText(/the joker was not yours/i)).toBeTruthy();
    const rows = within(within(dlg).getByRole("list", { name: /results/i })).getAllByRole("listitem");
    expect(rows.map((r) => /WINNER/.test(r.textContent ?? ""))).toEqual([false, true, false]); // you, Akira, Ken
  });

  it("you win by holding the Joker", async () => {
    await open(over("me"));
    const dlg = await screen.findByRole("dialog", { name: /game over/i });
    expect(within(dlg).getByText(/game cleared/i)).toBeTruthy();
    expect(within(dlg).getByText(/you won\./i)).toBeTruthy();
    expect(within(dlg).getByText(/you held the joker until the end/i)).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: /play again/i })).toBeTruthy();
  });

  it("only the host can rematch; others wait", async () => {
    await open(over("a", false));
    const dlg = await screen.findByRole("dialog", { name: /game over/i });
    expect((within(dlg).getByRole("button", { name: /waiting for host/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an abandoned match declares no winner", async () => {
    await open(over("a", true, true));
    const dlg = await screen.findByRole("dialog", { name: /game over/i });
    expect(within(dlg).getByText(/the match was ended/i)).toBeTruthy();
    expect(within(dlg).getByText(/no winner was declared/i)).toBeTruthy();
    expect(within(dlg).queryByRole("list", { name: /results/i })).toBeNull(); // nobody is labelled winner/loser
    expect(within(dlg).queryByText(/game cleared|you won|you lost/i)).toBeNull();
  });
});

describe("lobby", () => {
  const lobby = (players: ReturnType<typeof P>[], isHost = true) =>
    view({ status: "waiting", isHost, hostId: isHost ? "me" : "a", game: null, myHand: [], players: players.map((p) => ({ ...p, isHost: isHost ? p.id === "me" : p.id === "a" })), events: [] });

  it("shows the room code, player count, and blocks start below 2 players", async () => {
    await open(lobby([P("me", "Ryuji", 0, true)]));
    expect(screen.getByLabelText(/room code a 7 k 9 p/i)).toBeTruthy();
    expect(screen.getByText("1 / 7 players")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^start game$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/at least 2 players are required/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy room code/i })).toBeTruthy();
  });
  it("enables start with 2 players, and AI fill reports the final table size", async () => {
    await open(lobby([P("me", "Ryuji", 0, true), P("a", "Akira", 0)]));
    expect((screen.getByRole("button", { name: /^start game$/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: /fill remaining slots with ai/i }));
    expect(screen.getByText(/2 \/ 7 players \+ 5 AI/)).toBeTruthy();
  });
  it("non-hosts see 'Waiting for host…' and no start button", async () => {
    await open(lobby([P("me", "Ryuji", 0), P("a", "Akira", 0)], false));
    expect(screen.getByText(/waiting for host/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^start game$/i })).toBeNull();
  });
});

describe("cards + avatars", () => {
  it("cards expose accessible names and the Joker is distinct", () => {
    render(<><CardFace card={c("K", "diamonds")} /><CardFace card={c("A", "spades")} /><CardFace card={joker} /></>);
    expect(screen.getByRole("img", { name: "King of diamonds" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Ace of spades" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Joker" })).toBeTruthy();
  });
  it("avatars are generated (no remote images)", () => {
    const { container } = render(<Avatar name="Akira" />);
    expect(container.querySelector("img")).toBeNull();
  });
});
