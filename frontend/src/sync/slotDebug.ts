/**
 * TEMPORARY development diagnostics for the opponent-card ordering data flow.
 *
 * Enabled only when `VITE_SLOT_DEBUG=1` (frontend) / `SLOT_DEBUG=1` (backend), so it has zero
 * effect in production. It deliberately reports only OPAQUE slot ids, counts, and turn numbers -
 * never a card identity, rank, suit or hand index.
 *
 * Stage map (each stage is answered in the report):
 *   1 server generates a permutation   -> server: [slots] built/emit
 *   2 server sends it to the right viewer -> server: [slots] emit (viewer id only)
 *   3 client receives the event         -> client: [slots] recv
 *   4 client state updated             -> client: [slots] store
 *   5 React renders that order         -> client: [slots] render
 *   6 click sends that slot            -> client: [slots] send
 */

/** Opaque ids are long and noisy; show only short prefixes so logs stay readable. */
const short = (ids: readonly string[]): string => ids.map((i) => i.slice(0, 6)).join(",");

export function slotDebugEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("SLOT_DEBUG") === "1";
  } catch {
    return false;
  }
}

export function slotDebug(stage: string, detail: Record<string, unknown>): void {
  try {
    if (!slotDebugEnabled()) return;
    // eslint-disable-next-line no-console
    console.info(`[slots] ${stage}`, detail);
  } catch {
    /* never let diagnostics break the app */
  }
}

export { short as shortSlotIds };