import { z } from "zod";

/* ------------------------------------------------------------------ permissions */

/** Granular permissions. Every privileged action is checked against exactly one of these. */
export const PERMISSIONS = [
  "USERS_READ", "USERS_WRITE", "USERS_BAN",
  "ROOMS_READ", "ROOMS_WRITE",
  "GAMES_READ", "GAMES_MANAGE", "GAME_DEBUG_READ", "GAME_DEBUG_WRITE",
  "SETTINGS_READ", "SETTINGS_WRITE",
  "DATABASE_READ", "DATABASE_WRITE",
  "REPORTS_READ", "REPORTS_MANAGE",
  "AUDIT_READ",
  "ADMINS_READ", "ADMINS_WRITE",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const permissionSchema = z.enum(PERMISSIONS);

/* ------------------------------------------------------------------ roles */

export const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN", "MODERATOR", "SUPPORT"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const adminRoleSchema = z.enum(ADMIN_ROLES);

/**
 * Role → permission matrix. Roles are a convenience layer; enforcement always checks a
 * concrete permission, so a role can be narrowed per-admin without changing any code.
 */
export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  ADMIN: [
    "USERS_READ", "USERS_WRITE", "USERS_BAN",
    "ROOMS_READ", "ROOMS_WRITE",
    "GAMES_READ", "GAMES_MANAGE",
    "SETTINGS_READ", "SETTINGS_WRITE",
    "REPORTS_READ", "REPORTS_MANAGE",
    "AUDIT_READ",
    "ADMINS_READ",
  ],
  MODERATOR: [
    "USERS_READ", "USERS_BAN",
    "ROOMS_READ",
    "GAMES_READ",
    "REPORTS_READ", "REPORTS_MANAGE",
    "AUDIT_READ",
  ],
  SUPPORT: ["USERS_READ", "ROOMS_READ", "GAMES_READ", "REPORTS_READ"],
};

/** Permissions that may never be granted to a non-SUPER_ADMIN, whatever the request says. */
export const SUPER_ADMIN_ONLY: readonly Permission[] = [
  "ADMINS_WRITE", "DATABASE_READ", "DATABASE_WRITE", "GAME_DEBUG_READ", "GAME_DEBUG_WRITE",
];

export function permissionsForRole(role: AdminRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** Effective permissions: the role's set, narrowed by explicit per-admin grants, widened only by SUPER_ADMIN. */
export function effectivePermissions(role: AdminRole, grants?: readonly Permission[]): Set<Permission> {
  const base = new Set<Permission>(ROLE_PERMISSIONS[role]);
  if (role === "SUPER_ADMIN") return base; // a SUPER_ADMIN always holds every permission
  for (const g of grants ?? []) if (!SUPER_ADMIN_ONLY.includes(g)) base.add(g);
  return base;
}

export function can(role: AdminRole, grants: readonly Permission[] | undefined, permission: Permission): boolean {
  return effectivePermissions(role, grants).has(permission);
}

/* ------------------------------------------------------------------ admin records */

export const adminStatusSchema = z.enum(["active", "suspended"]);
export type AdminStatus = z.infer<typeof adminStatusSchema>;

/** Password policy for admin accounts (stricter than the player policy on purpose). */
export const adminPasswordSchema = z
  .string()
  .min(12, "Admin password must be at least 12 characters")
  .max(128)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v), "Admin password needs upper, lower and a digit");

export const createAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(120),
  username: z.string().trim().min(2).max(32),
  password: adminPasswordSchema,
  role: adminRoleSchema,
  /** Narrowing grants only. A non-SUPER_ADMIN can never widen its own role's set this way. */
  permissions: z.array(permissionSchema).max(64).optional(),
});

export const updateAdminSchema = z
  .object({
    role: adminRoleSchema.optional(),
    permissions: z.array(permissionSchema).max(64).optional(),
    status: adminStatusSchema.optional(),
    password: adminPasswordSchema.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((v) => v.role !== undefined || v.permissions !== undefined || v.status !== undefined || v.password !== undefined, {
    message: "Nothing to change",
  });

export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(1).max(128),
  /** Optional TOTP code; when the account has 2FA enabled this becomes mandatory. */
  totp: z.string().trim().regex(/^[0-9]{6}$/, "Invalid code").optional(),
});

/* ------------------------------------------------------------------ audit + reports */

export const AUDIT_ACTIONS = [
  "ADMIN_LOGIN", "ADMIN_LOGIN_FAILED", "ADMIN_LOGOUT",
  "ADMIN_CREATE", "ADMIN_UPDATE", "ADMIN_SUSPEND", "ADMIN_RESTORE", "ADMIN_SESSION_REVOKE",
  "USER_BAN", "USER_UNBAN", "USER_SUSPEND", "USER_RESTORE", "USER_UPDATE",
  "ROOM_CLOSE", "ROOM_LOCK", "ROOM_UNLOCK", "ROOM_HOST_TRANSFER", "ROOM_EXPIRE",
  "GAME_TERMINATE", "GAME_PAUSE", "GAME_RESUME", "GAME_PLAYER_REMOVE",
  "SETTINGS_UPDATE", "FEATURE_FLAG_UPDATE", "MAINTENANCE_MODE",
  "DB_EDIT", "DB_DELETE", "DB_EXPORT", "DB_SOFT_DELETE", "DB_RESTORE",
  "REPORT_STATUS", "REPORT_ASSIGN", "REPORT_DELETE_MESSAGE",
  "DEBUG_STATE_READ", "DIAGNOSTIC_READ",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const auditActionSchema = z.enum(AUDIT_ACTIONS);

export const auditEntrySchema = z.object({
  adminId: z.string().min(1),
  adminRole: adminRoleSchema,
  action: auditActionSchema,
  resource: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(128),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  reason: z.string().max(500).optional(),
  ip: z.string().max(64).optional(),
  userAgent: z.string().max(256).optional(),
  createdAt: z.coerce.date(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const REPORT_CATEGORIES = ["CHEATING", "HARASSMENT", "ABUSE", "OFFENSIVE_CHAT", "EXPLOIT", "OTHER"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_STATUSES = ["OPEN", "INVESTIGATE", "RESOLVE", "DISMISS"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const createReportSchema = z.object({
  category: z.enum(REPORT_CATEGORIES),
  targetUserId: z.string().min(1).max(64).optional(),
  roomCode: z.string().trim().max(16).optional(),
  chatMessageId: z.string().max(64).optional(),
  description: z.string().trim().min(10, "Please describe the issue").max(2000),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

export const updateReportSchema = z.object({
  status: z.enum(REPORT_STATUSES).optional(),
  assignedTo: z.string().min(1).max(64).nullish(),
  resolution: z.string().trim().max(2000).optional(),
  reason: z.string().trim().max(500).optional(),
}).refine((v) => v.status !== undefined || v.assignedTo !== undefined || v.resolution !== undefined, {
  message: "Nothing to change",
});

/* ------------------------------------------------------------------ moderation */

export const banUserSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required").max(500),
  expiresAt: z.coerce.date().optional(),
});

/* ------------------------------------------------------------------ generic admin query */

export const adminListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.string().trim().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type AdminListQuery = z.infer<typeof adminListQuerySchema>;

export const reasonSchema = z.object({ reason: z.string().trim().min(3, "A reason is required").max(500) });

/* ------------------------------------------------------------------ database console */

/** Collections an admin may inspect. Hard allow-list — no arbitrary collection access. */
export const ADMIN_COLLECTIONS = [
  "users", "rooms", "games", "gamePlayers", "gameEvents", "chatMessages",
  "syncRecords", "settings", "reports", "auditLogs",
] as const;
export type AdminCollection = (typeof ADMIN_COLLECTIONS)[number];
export const adminCollectionSchema = z.enum(ADMIN_COLLECTIONS);

/** Fields that must never be returned by any admin read, export or edit response. */
export const REDACTED_FIELDS = ["passwordHash", "sessionHash", "token", "secret", "password"] as const;

/** The only mutable per-collection field sets. Anything else is read-only by design. */
export const EDITABLE_FIELDS: Partial<Record<AdminCollection, readonly string[]>> = {
  users: ["username", "avatar", "status"],
  reports: ["status", "assignedTo", "resolution"],
  chatMessages: ["status"],
  rooms: ["status"],
  games: ["status"],
};

export const dbEditSchema = z.object({
  collection: adminCollectionSchema,
  id: z.string().min(1).max(128),
  changes: z.record(z.string().min(1).max(64), z.unknown()),
  reason: z.string().trim().min(3, "A reason is required").max(500),
});
export type DbEditInput = z.infer<typeof dbEditSchema>;