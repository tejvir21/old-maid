import { Router } from "express";
import {
  offlineGameSchema, profileUpdateSchema, settingsUpdateSchema, syncBatchSchema,
  type OfflineGamePayload, type SyncItemResult,
} from "@old-maid/shared";
import type { Services } from "../services/container.js";
import { asyncHandler, requireAuth } from "./middleware.js";

/** Fastest plausible pace: AI turns take >=0.8s and a human needs time to click, so >~6 draws/s is not real play. */
const MIN_SECONDS_PER_DRAW = 0.15;
const MIN_DURATION_S = 1;
const MAX_FUTURE_MS = 5 * 60_000;
const MAX_AGE_MS = 400 * 24 * 3600_000;

/**
 * Offline results are NOT trusted. We validate the shape and plausibility, never accept
 * aggregate counters from the browser, and only ever add to the user's *offline* stats.
 */
export function plausibilityProblem(p: OfflineGamePayload, nowMs: number): string | null {
  if (p.finishedAt < p.startedAt) return "finishedAt is before startedAt";
  if (p.finishedAt > nowMs + MAX_FUTURE_MS) return "finishedAt is in the future";
  if (p.startedAt < nowMs - MAX_AGE_MS) return "game is too old";
  const spanS = (p.finishedAt - p.startedAt) / 1000;
  if (p.durationSeconds > spanS + 5) return "duration exceeds the recorded time span";
  if (p.durationSeconds < MIN_DURATION_S) return "game was implausibly short";
  if (p.durationSeconds < p.turnCount * MIN_SECONDS_PER_DRAW) return "game was implausibly fast for its number of turns";
  if (p.turnCount < 1) return "no turns were played";
  return null;
}

export function syncRouter(s: Services): Router {
  const r = Router();
  const auth = requireAuth(s);

  r.post("/", auth, asyncHandler(async (req, res) => {
    const userId = (req.auth as { userId: string }).userId;
    const { items } = syncBatchSchema.parse(req.body);
    const results: SyncItemResult[] = [];
    const nowMs = Date.now();

    for (const item of items) {
      try {
        if (item.type === "GAME_RESULT") {
          const p = offlineGameSchema.safeParse(item.payload);
          if (!p.success) {
            await s.store.syncRecords.markRejected(userId, item.id, item.type, "invalid payload");
            results.push({ id: item.id, status: "rejected", reason: "Invalid game record." });
            continue;
          }
          // The idempotency key is the game's own localGameId; the queue item id must match it.
          if (p.data.localGameId !== item.id) {
            results.push({ id: item.id, status: "rejected", reason: "Item id does not match localGameId." });
            continue;
          }
          const problem = plausibilityProblem(p.data, nowMs);
          if (problem) {
            await s.store.syncRecords.markRejected(userId, item.id, item.type, problem);
            results.push({ id: item.id, status: "rejected", reason: problem });
            continue;
          }
          const out = await s.store.syncRecords.processGameResult(userId, p.data);
          results.push({ id: item.id, status: out === "applied" ? "synced" : "duplicate" });
        } else if (item.type === "SETTINGS_UPDATE") {
          const p = settingsUpdateSchema.safeParse(item.payload);
          if (!p.success) { results.push({ id: item.id, status: "rejected", reason: "Invalid settings." }); continue; }
          // Idempotent by design: compare-and-set on updatedAt (last-writer-wins by client timestamp).
          const out = await s.store.users.applySettings(userId, p.data.settings, Math.min(p.data.updatedAt, nowMs + MAX_FUTURE_MS));
          results.push({ id: item.id, status: out.applied ? "synced" : "stale" });
        } else {
          const p = profileUpdateSchema.safeParse(item.payload);
          if (!p.success) { results.push({ id: item.id, status: "rejected", reason: "Invalid profile." }); continue; }
          if (p.data.displayName) {
            const holder = await s.store.users.findByUsername(p.data.displayName);
            if (holder && holder.id !== userId && holder.status !== "guest") {
              results.push({ id: item.id, status: "rejected", reason: "That display name is taken." });
              continue;
            }
          }
          const out = await s.store.users.applyProfile(userId, {
            ...(p.data.displayName ? { displayName: p.data.displayName } : {}),
            ...(p.data.avatar ? { avatar: p.data.avatar } : {}),
          }, Math.min(p.data.updatedAt, nowMs + MAX_FUTURE_MS));
          results.push({ id: item.id, status: out.applied ? "synced" : "stale" });
        }
      } catch (e) {
        // Retryable: nothing was recorded for this item, so the client keeps it queued.
        s.log.error("sync item failed", { type: item.type, error: e instanceof Error ? e.message : String(e) });
        results.push({ id: item.id, status: "failed", reason: "Temporary server error." });
      }
    }
    res.json({ success: true, results });
  }));

  r.get("/status", auth, asyncHandler(async (req, res) => {
    const userId = (req.auth as { userId: string }).userId;
    const summary = await s.store.syncRecords.summary(userId);
    res.json({ success: true, summary });
  }));

  return r;
}
