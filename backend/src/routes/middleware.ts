import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { verifyPlayerToken } from "../auth/tokens.js";
import type { Services } from "../services/container.js";
import { AppError, statusFor } from "../util/errors.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: { userId: string };
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

export function requireAuth(s: Services) {
  return asyncHandler(async (req, _res, next) => {
    const h = req.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7) : undefined;
    const claims = token ? verifyPlayerToken(s.env.jwtAccessSecret, token) : null;
    if (!claims) throw new AppError("UNAUTHORIZED", "Authentication required.", 401);
    const user = await s.store.users.findById(claims.userId);
    if (!user) throw new AppError("UNAUTHORIZED", "Authentication required.", 401);
    if (user.status === "banned" || user.status === "suspended" || (await s.store.bans.isBanned(user.id))) {
      throw new AppError("BANNED", "This account is not allowed to play.", 403);
    }
    req.auth = { userId: user.id };
    next();
  });
}

export function errorHandler(s: Services) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (e: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (e instanceof AppError) {
      res.status(e.status).json({ success: false, error: { code: e.code, message: e.message } });
      return;
    }
    if (e instanceof ZodError) {
      res.status(400).json({ success: false, error: { code: "VALIDATION", message: e.issues[0]?.message ?? "Invalid request.", details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } });
      return;
    }
    if (typeof e === "object" && e !== null && (e as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ success: false, error: { code: "BAD_REQUEST", message: "Malformed JSON body." } });
      return;
    }
    if (typeof e === "object" && e !== null && (e as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ success: false, error: { code: "BAD_REQUEST", message: "Request body too large." } });
      return;
    }
    s.log.error("unhandled http error", { error: e instanceof Error ? e.message : String(e) });
    // Never leak stack traces.
    res.status(500).json({ success: false, error: { code: "INTERNAL", message: "Something went wrong." } });
  };
}

export { statusFor };
