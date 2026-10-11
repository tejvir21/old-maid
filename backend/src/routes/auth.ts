import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { loginSchema, registerSchema } from "../auth/authService.js";
import { verifyPlayerToken } from "../auth/tokens.js";
import type { Services } from "../services/container.js";
import { AppError } from "../util/errors.js";
import { asyncHandler, requireAuth } from "./middleware.js";

export function authRouter(s: Services, limitPerMin = 20): Router {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 60_000, limit: limitPerMin, standardHeaders: true, legacyHeaders: false,
    handler: (_req, res) => void res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." } }),
  });
  r.use(limiter);

  r.post("/guest", asyncHandler(async (_req, res) => {
    res.status(201).json({ success: true, ...(await s.auth.createGuest()) });
  }));

  r.post("/session", asyncHandler(async (req, res) => {
    const { sessionId } = z.object({ sessionId: z.string().min(16).max(100) }).parse(req.body);
    const out = await s.auth.refresh(sessionId);
    if (!out) throw new AppError("UNAUTHORIZED", "Session expired. Please sign in again.", 401);
    res.json({ success: true, ...out });
  }));

  r.post("/register", asyncHandler(async (req, res) => {
    if (!s.settings.getSystem().allowRegistrations) throw new AppError("FORBIDDEN", "Registrations are currently closed.", 403);
    const input = registerSchema.parse(req.body);
    // If a guest token is supplied the guest account is upgraded, preserving its history.
    const h = req.headers.authorization;
    const guest = h?.startsWith("Bearer ") ? verifyPlayerToken(s.env.jwtAccessSecret, h.slice(7)) : null;
    res.status(201).json({ success: true, ...(await s.auth.register(input, guest?.userId)) });
  }));

  r.post("/login", asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await s.auth.login(loginSchema.parse(req.body))) });
  }));

  r.get("/me", requireAuth(s), asyncHandler(async (req, res) => {
    const user = await s.store.users.findById((req.auth as { userId: string }).userId);
    if (!user) throw new AppError("UNAUTHORIZED", "Authentication required.", 401);
    res.json({ success: true, user: { id: user.id, username: user.username, status: user.status, isGuest: user.status === "guest", ...(user.avatar ? { avatar: user.avatar } : {}) } });
  }));

  r.post("/logout-all", requireAuth(s), asyncHandler(async (req, res) => {
    const userId = (req.auth as { userId: string }).userId;
    await s.auth.logoutEverywhere(userId);
    s.registry.disconnectPlayer(userId);
    res.json({ success: true });
  }));

  return r;
}
