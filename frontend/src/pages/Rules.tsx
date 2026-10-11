import { Page } from "../components/Page";

export function Rules() {
  return (
    <Page title="How to play">
      <ol className="space-y-4 text-sm leading-relaxed [counter-reset:r]">
        {[
          "Every player receives cards from a 53-card deck: 52 normal cards and one Joker.",
          "Matching pairs (same rank) are removed immediately — at the start, and after every draw.",
          "On your turn, draw one hidden card from another player. You choose the player and the card. You won't know what it is until it's yours.",
          "If it forms a pair with a card in your hand, the pair is discarded.",
          "The Joker can never be paired. It keeps moving from hand to hand.",
          "When every normal card has been paired, one card remains: the Joker.",
          "The player holding the Joker at the end WINS. Everyone else loses.",
        ].map((t, i) => (
          <li key={i} className="flex gap-4 border-b border-bone/10 pb-3 [counter-increment:r]">
            <span className="title-display text-2xl text-ember before:content-[counter(r)]" aria-hidden />
            <span>{t}</span>
          </li>
        ))}
      </ol>
      <h2 className="title-display mt-8 text-xl">Online rooms</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-dim">
        <li>2–7 players. The host can fill empty seats with AI.</li>
        <li>The server deals, shuffles and judges every move. You only ever see your own hand; others show card counts.</li>
        <li>If the player whose turn it is disconnects, the game <span className="text-bone">pauses</span> until they return — or the host ends the match.</li>
        <li>If you stay idle on your turn for 60 seconds, the server draws a random valid card for you (recorded as a timeout).</li>
        <li>If you leave a game in progress, an AI takes over your seat.</li>
      </ul>
      <h2 className="title-display mt-8 text-xl">Offline mode</h2>
      <p className="mt-3 text-sm text-dim">Play against 1–6 AI opponents with no connection at all. Results are saved on this device and synced when you're back online — they count as <span className="text-bone">unverified, offline</span> results, separate from verified online ones.</p>
    </Page>
  );
}
