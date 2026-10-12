import cors from "cors";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { PROTOCOL_VERSION } from "@old-maid/shared";
import { asyncHandler, errorHandler, requireAuth } from "./routes/middleware.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter, reportRouter } from "./routes/admin.js";
import { syncRouter } from "./routes/sync.js";
import type { Services } from "./services/container.js";

export interface AppOptions {
  /** Per-IP request cap per minute for the whole API. */
  globalLimitPerMin?: number;
  authLimitPerMin?: number;
}

export function createApp(s: Services, opts: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      credentials: true,
      origin(origin, cb) {
        // Non-browser clients (health checks, curl) send no Origin. Browsers must be allow-listed.
        if (!origin || s.env.allowedOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(
    rateLimit({
      windowMs: 60_000, limit: opts.globalLimitPerMin ?? 300, standardHeaders: true, legacyHeaders: false,
      handler: (_req, res) => void res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Too many requests." } }),
    }),
  );

  app.get("/health", asyncHandler(async (_req, res) => {
    const db = await s.store.ping();
    res.status(db.ok ? 200 : 503).json({
      status: db.ok ? "ok" : "degraded",
      database: db.kind === "memory" ? "memory" : db.ok ? "connected" : "disconnected",
    });
  }));

  // Public, non-sensitive runtime config for the client (feature flags are *enforced* server-side too).
  app.get("/api/config", (_req, res) => {
    const sys = s.settings.getSystem();
    const game = s.settings.getGame();
    res.json({
      success: true,
      // Lets a stale client detect that it is out of date and say so, instead of issuing
      // requests the server will reject with an opaque validation error.
      protocolVersion: PROTOCOL_VERSION,
      appName: sys.applicationName,
      maintenance: { enabled: sys.maintenanceMode, message: sys.maintenanceMessage },
      features: s.settings.getFlags(),
      game: { minPlayers: game.minPlayers, maxPlayers: game.maxPlayers, allowAiFill: game.allowAiFill, chat: game.chatEnabled, emotes: game.emotesEnabled },
    });
  });

  app.use("/api/auth", authRouter(s, opts.authLimitPerMin ?? 20));
  app.use("/api/sync", syncRouter(s));
  app.use("/api/reports", reportRouter(s));
  // Phase 4: the admin API. Mounted under /api/admin and guarded by its own
  // authentication boundary (separate sessions, separate token format).
  app.use("/api/admin", adminRouter(s, s.adminAuth));
  app.get("/api/stats/me", requireAuth(s), asyncHandler(async (req, res) => {
    const userId = (req.auth as { userId: string }).userId;
    const [stats, sync] = await Promise.all([s.store.stats.get(userId), s.store.syncRecords.summary(userId)]);
    res.json({ success: true, stats, sync });
  }));

  app.use((_req, res) => void res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }));
  app.use(errorHandler(s));
  return app;
}
