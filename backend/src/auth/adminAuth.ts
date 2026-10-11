import { createHash, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  effectivePermissions, permissionsForRole, SUPER_ADMIN_ONLY,
  type AdminRole, type AuditAction, type Permission,
} from "@old-maid/shared";
import type { AdminRecord, AdminSessionRecord } from "../store/types.js";
import { AppError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { Store } from "../store/types.js";

/* ------------------------------------------------------------------ TOTP (RFC 6238) */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function generateTotpSecret(bytes = 20): string {
  const raw = randomBytes(bytes);
  let bits = "";
  for (const b of raw) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function base32Decode(s: string): Buffer {
  let bits = "";
  for (const c of s.toUpperCase().replace(/=+$/, "")) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
/** Verifies a 6-digit TOTP with a ±1 step window (30s). Constant-time compare. */
export function verifyTotp(secret: string, code: string, atMs = Date.now()): boolean {
  const counter = Math.floor(atMs / 1000 / 30);
  const key = base32Decode(secret);
  for (const drift of [-1, 0, 1]) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter + drift));
    const hmac = createHmac("sha1", key).update(buf).digest();
    const off = hmac[hmac.length - 1] as number & 0xf;
    const bin = ((hmac[off] as number) & 0x7f) << 24 | (hmac[off + 1] as number) << 16 |
      (hmac[off + 2] as number) << 8 | (hmac[off + 3] as number);
    const expected = String(bin % 1_000_000).padStart(6, "0");
    const a = Buffer.from(expected);
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ helpers */

export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const MAX_FAILED = 8;
const LOCK_MS = 15 * 60 * 1000;

export function newAdminSessionSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: hashAdminSecret(secret) };
}
export const hashAdminSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** Never leaks the hash or the TOTP secret to a client. */
export function toPublicAdmin(a: AdminRecord): {
  id: string; email: string; username: string; role: AdminRole; permissions: Permission[];
  status: AdminRecord["status"]; lastLoginAt?: Date; createdAt: Date; twoFactorEnabled: boolean;
} {
  return {
    id: a.id, email: a.email, username: a.username, role: a.role,
    permissions: [...effectivePermissions(a.role, a.permissions)].sort(),
    status: a.status, createdAt: a.createdAt,
    twoFactorEnabled: Boolean(a.totpSecret),
    ...(a.lastLoginAt ? { lastLoginAt: a.lastLoginAt } : {}),
  };
}

/** The admin identity attached to every privileged request. */
export interface AdminPrincipal {
  adminId: string;
  email: string;
  username: string;
  role: AdminRole;
  permissions: Set<Permission>;
  sessionHash: string;
}

export interface RequestMeta { ip?: string; userAgent?: string }

/**
 * Admin authentication and account management. Deliberately separate from the player
 * AuthService: admin sessions, admin records and player sessions never intersect, and a
 * player token can never be exchanged for admin access.
 */
export class AdminAuthService {
  constructor(private readonly store: Store, private readonly log: Logger, private readonly bcrypt = bcryptImpl) {}

  async login(input: z.infer<typeof import("@old-maid/shared").adminLoginSchema>, meta: RequestMeta): Promise<{ token: string; admin: ReturnType<typeof toPublicAdmin> }> {
    const rec = await this.store.admin.admins.findByEmail(input.email);
    // Always run a bcrypt comparison so timing does not reveal whether the email exists.
    const hash = rec?.passwordHash ?? "$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu";
    const ok = await this.bcrypt.compare(input.password, hash);
    if (!rec || !ok) {
      if (rec) {
        const lockedUntil = rec.failedLogins + 1 >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null;
        await this.store.admin.admins.recordFailedLogin(rec.id, lockedUntil);
      }
      await this.audit(null, "ADMIN_LOGIN_FAILED", "admin", input.email, undefined, undefined, "invalid credentials", meta);
      throw new AppError("UNAUTHORIZED", "Invalid email or password.", 401);
    }
    if (rec.lockedUntil && rec.lockedUntil > new Date()) {
      await this.audit(rec, "ADMIN_LOGIN_FAILED", "admin", rec.id, undefined, undefined, "account locked", meta);
      throw new AppError("UNAUTHORIZED", "Account temporarily locked. Try again later.", 429);
    }
    if (rec.status !== "active") {
      await this.audit(rec, "ADMIN_LOGIN_FAILED", "admin", rec.id, undefined, undefined, "account suspended", meta);
      throw new AppError("FORBIDDEN", "This admin account is suspended.", 403);
    }
    if (rec.totpSecret) {
      if (!input.totp || !verifyTotp(rec.totpSecret, input.totp)) {
        await this.audit(rec, "ADMIN_LOGIN_FAILED", "admin", rec.id, undefined, undefined, "invalid 2fa code", meta);
        throw new AppError("UNAUTHORIZED", "Invalid authentication code.", 401);
      }
    }

    const { secret, hash: sessionHash } = newAdminSessionSecret();
    const now = new Date();
    const rec2: AdminSessionRecord = {
      sessionHash, adminId: rec.id, createdAt: now, lastSeenAt: now,
      expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_MS), revoked: false,
      ...(meta.ip ? { ip: meta.ip } : {}), ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    };
    await this.store.admin.adminSessions.create(rec2);
    await this.store.admin.admins.update(rec.id, { failedLogins: 0, lastLoginAt: now, ...(rec.lockedUntil ? { lockedUntil: null } : {}) });
    const fresh = (await this.store.admin.admins.findById(rec.id)) ?? rec;
    await this.audit(fresh, "ADMIN_LOGIN", "admin", rec.id, undefined, undefined, undefined, meta);
    return { token: secret, admin: toPublicAdmin(fresh) };
  }

  /** Resolves a bearer secret to a live principal; null when invalid, expired or revoked. */
  async authenticate(token: string): Promise<AdminPrincipal | null> {
    const session = await this.store.admin.adminSessions.resolve(hashAdminSecret(token));
    if (!session) return null;
    const rec = await this.store.admin.admins.findById(session.adminId);
    if (!rec || rec.status !== "active") return null;
    await this.store.admin.adminSessions.touch(session.sessionHash, new Date());
    return {
      adminId: rec.id, email: rec.email, username: rec.username, role: rec.role,
      permissions: effectivePermissions(rec.role, rec.permissions), sessionHash: session.sessionHash,
    };
  }

  async logout(principal: AdminPrincipal, meta: RequestMeta): Promise<void> {
    await this.store.admin.adminSessions.revoke(principal.sessionHash);
    await this.audit(principal, "ADMIN_LOGOUT", "admin", principal.adminId, undefined, undefined, undefined, meta);
  }

  async createAdmin(
    principal: AdminPrincipal,
    input: z.infer<typeof import("@old-maid/shared").createAdminSchema>,
    meta: RequestMeta,
  ): Promise<AdminRecord> {
    if (await this.store.admin.admins.findByEmail(input.email)) throw new AppError("CONFLICT", "That admin email already exists.", 409);
    // Only a SUPER_ADMIN may mint another SUPER_ADMIN, or grant super-admin-only permissions.
    if (input.role === "SUPER_ADMIN" && principal.role !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Only a SUPER_ADMIN can create another SUPER_ADMIN.", 403);
    }
    const grants = (input.permissions ?? []).filter((p) => {
      if (SUPER_ADMIN_ONLY.includes(p) && principal.role !== "SUPER_ADMIN") {
        this.log.warn("blocked super-admin permission grant", { adminId: principal.adminId, permission: p });
        return false;
      }
      return true;
    });
    const rec = await this.store.admin.admins.create({
      email: input.email, username: input.username, passwordHash: await this.bcrypt.hash(input.password, 12),
      role: input.role, permissions: grants, status: "active", createdBy: principal.adminId,
    });
    await this.audit(principal, "ADMIN_CREATE", "admin", rec.id, undefined, { email: rec.email, role: rec.role }, undefined, meta);
    return rec;
  }

  /**
   * Changes role / grants / status / password. Self-demotion and self-suspension are blocked
   * so an admin can never lock the platform out of its own last SUPER_ADMIN.
   */
  async updateAdmin(
    principal: AdminPrincipal,
    id: string,
    patch: z.infer<typeof import("@old-maid/shared").updateAdminSchema>,
    meta: RequestMeta,
  ): Promise<AdminRecord> {
    const target = await this.store.admin.admins.findById(id);
    if (!target) throw new AppError("NOT_FOUND", "Admin not found.", 404);
    if (target.role === "SUPER_ADMIN" && principal.role !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Only a SUPER_ADMIN can modify a SUPER_ADMIN.", 403);
    }
    if (patch.role === "SUPER_ADMIN" && principal.role !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Only a SUPER_ADMIN can grant the SUPER_ADMIN role.", 403);
    }
    if (target.id === principal.adminId && (patch.status === "suspended" || (patch.role && patch.role !== "SUPER_ADMIN"))) {
      throw new AppError("FORBIDDEN", "You cannot suspend or demote your own account.", 403);
    }
    const grants = patch.permissions?.filter((p) => !(SUPER_ADMIN_ONLY.includes(p) && principal.role !== "SUPER_ADMIN"));
    const update: Partial<AdminRecord> = {};
    if (patch.role) update.role = patch.role;
    if (grants) update.permissions = grants;
    if (patch.status) { update.status = patch.status; update.suspendedAt = patch.status === "suspended" ? new Date() : undefined; }
    if (patch.password) update.passwordHash = await this.bcrypt.hash(patch.password, 12);
    const next = await this.store.admin.admins.update(id, update);
    if (!next) throw new AppError("NOT_FOUND", "Admin not found.", 404);
    // A password change or a suspension must invalidate existing sessions.
    if (patch.password || patch.status === "suspended") await this.store.admin.adminSessions.revokeAllForAdmin(id);
    const action: AuditAction = patch.status === "suspended" ? "ADMIN_SUSPEND"
      : patch.status === "active" ? "ADMIN_RESTORE"
      : patch.password ? "ADMIN_UPDATE" : "ADMIN_UPDATE";
    await this.audit(principal, action, "admin", id,
      { role: target.role, status: target.status, permissions: target.permissions },
      { role: next.role, status: next.status, permissions: next.permissions },
      patch.reason, meta);
    return next;
  }

  async revokeSessions(principal: AdminPrincipal, id: string, meta: RequestMeta): Promise<void> {
    await this.store.admin.adminSessions.revokeAllForAdmin(id);
    await this.audit(principal, "ADMIN_SESSION_REVOKE", "admin", id, undefined, undefined, "sessions revoked", meta);
  }

  /** Writes one audit record. Never throws: auditing must not break the operation. */
  async audit(
    who: AdminRecord | AdminPrincipal | null,
    action: AuditAction,
    resource: string,
    resourceId: string,
    before: unknown,
    after: unknown,
    reason: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    try {
      const subject = who as AdminPrincipal | AdminRecord | null;
      await this.store.admin.audit.append({
        adminId: subject ? ("adminId" in subject ? subject.adminId : subject.id) : "anonymous",
        adminUsername: subject?.username ?? "anonymous",
        adminRole: who?.role ?? "SUPPORT",
        action, resource, resourceId,
        ...(before !== undefined ? { before: redact(before) } : {}),
        ...(after !== undefined ? { after: redact(after) } : {}),
        ...(reason ? { reason } : {}),
        ...(meta.ip ? { ip: meta.ip } : {}),
        ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
        createdAt: new Date(),
      });
    } catch (e) {
      this.log.error("audit write failed", { action, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** Strips anything that looks like a credential before it reaches an audit record. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/password|secret|token|hash|authorization|cookie/i.test(k)) continue;
    out[k] = redact(v, depth + 1);
  }
  return out;
}

export { permissionsForRole };

/* bcrypt is injected so tests can run fast; the real implementation is the default. */
export type BcryptLike = { hash(s: string, r: number): Promise<string>; compare(s: string, h: string): Promise<boolean> };
const bcryptImpl: BcryptLike = bcrypt;