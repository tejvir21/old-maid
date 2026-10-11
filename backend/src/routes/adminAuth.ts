import type { NextFunction, Request, Response } from "express";
import type { Permission } from "@old-maid/shared";
import type { AdminAuthService, AdminPrincipal } from "../auth/adminAuth.js";
import type { Services } from "../services/container.js";
import { AppError } from "../util/errors.js";
import { asyncHandler } from "./middleware.js";

declare module "express-serve-static-core" {
  interface Request {
    admin?: AdminPrincipal;
  }
}

export function requestMeta(req: Request): { ip?: string; userAgent?: string } {
  const ip = req.ip ?? req.socket.remoteAddress ?? undefined;
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined;
  return { ...(ip ? { ip } : {}), ...(ua ? { userAgent: ua.slice(0, 256) } : {}) };
}

/**
 * Requires a valid admin session. A player token is NOT accepted: admin sessions live in a
 * separate store with their own hash, TTL and revocation.
 */
export function requireAdmin(s: Services, adminAuth: AdminAuthService) {
  return asyncHandler(async (req, _res, next) => {
    const h = req.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7) : undefined;
    const principal = token ? await adminAuth.authenticate(token) : null;
    if (!principal) throw new AppError("UNAUTHORIZED", "Admin authentication required.", 401);
    req.admin = principal;
    next();
  });
}

/**
 * Granular permission gate. Authorization is decided by the permission set, never by the
 * role name, so an individual admin can be narrowed without changing any route.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const p = req.admin;
    if (!p) return next(new AppError("UNAUTHORIZED", "Admin authentication required.", 401));
    if (!p.permissions.has(permission)) {
      return next(new AppError("FORBIDDEN", `Missing permission: ${permission}`, 403));
    }
    next();
  };
}

/** SUPER_ADMIN-only operations (admin management, raw database, hidden-state diagnostics). */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.admin?.role !== "SUPER_ADMIN") return next(new AppError("FORBIDDEN", "SUPER_ADMIN only.", 403));
  next();
}

export { asyncHandler };