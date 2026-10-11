import { describe, expect, it } from "vitest";
import {
  ADMIN_COLLECTIONS, ADMIN_ROLES, PERMISSIONS, SUPER_ADMIN_ONLY,
  adminPasswordSchema, adminRoleSchema, createAdminSchema, dbEditSchema, effectivePermissions,
  permissionsForRole, updateAdminSchema,
} from "../src/admin.js";

describe("admin roles and permissions", () => {
  it("declares every permission and exactly the four roles", () => {
    expect(ADMIN_ROLES).toEqual(["SUPER_ADMIN", "ADMIN", "MODERATOR", "SUPPORT"]);
    expect(PERMISSIONS).toHaveLength(18);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it("gives a SUPER_ADMIN the full permission set", () => {
    expect(permissionsForRole("SUPER_ADMIN").sort()).toEqual([...PERMISSIONS].sort());
  });

  it("follows the documented matrix for the lower roles", () => {
    expect(permissionsForRole("ADMIN")).toEqual(expect.arrayContaining(["USERS_READ", "USERS_WRITE", "USERS_BAN", "SETTINGS_WRITE", "REPORTS_MANAGE", "AUDIT_READ", "ADMINS_READ"]));
    expect(permissionsForRole("ADMIN")).not.toContain("ADMINS_WRITE");
    expect(permissionsForRole("ADMIN")).not.toContain("DATABASE_READ");
    expect(permissionsForRole("ADMIN")).not.toContain("DATABASE_WRITE");

    expect(permissionsForRole("MODERATOR")).toEqual(expect.arrayContaining(["USERS_BAN", "REPORTS_MANAGE", "ROOMS_READ"]));
    expect(permissionsForRole("MODERATOR")).not.toContain("SETTINGS_WRITE");
    expect(permissionsForRole("MODERATOR")).not.toContain("ROOMS_WRITE");

    expect(permissionsForRole("SUPPORT")).toEqual(["USERS_READ", "ROOMS_READ", "GAMES_READ", "REPORTS_READ"]);
  });

  it("never lets a grant widen into a SUPER_ADMIN-only permission", () => {
    for (const role of ["ADMIN", "MODERATOR", "SUPPORT"] as const) {
      const base = effectivePermissions(role);
      for (const p of SUPER_ADMIN_ONLY) {
        expect(base.has(p), `${role} must not hold ${p}`).toBe(false);
        expect(effectivePermissions(role, [p]).has(p), `${role} must not gain ${p} via grants`).toBe(false);
      }
    }
  });

  it("still allows a SUPER_ADMIN to hold a super-admin-only permission", () => {
    expect(effectivePermissions("SUPER_ADMIN").has("DATABASE_WRITE")).toBe(true);
    expect(effectivePermissions("SUPER_ADMIN", ["ADMINS_WRITE"]).has("ADMINS_WRITE")).toBe(true);
  });

  it("treats grants as additive for non-super permissions", () => {
    expect(effectivePermissions("SUPPORT", ["AUDIT_READ"]).has("AUDIT_READ")).toBe(true);
  });
});

describe("admin input schemas", () => {
  it("requires a strong admin password", () => {
    expect(adminPasswordSchema.safeParse("short").success).toBe(false);
    expect(adminPasswordSchema.safeParse("alllowercase123").success).toBe(false);
    expect(adminPasswordSchema.safeParse("NoDigitsHereAtAll").success).toBe(false);
    expect(adminPasswordSchema.safeParse("Str0ngEnoughPassw0rd").success).toBe(true);
  });

  it("validates the admin create payload", () => {
    const base = { email: "a@b.co", username: "admin1", password: "Str0ngEnoughPassw0rd" };
    expect(createAdminSchema.safeParse({ ...base, role: "ADMIN" }).success).toBe(true);
    expect(createAdminSchema.safeParse({ ...base, role: "GOD" }).success).toBe(false);
    expect(createAdminSchema.safeParse({ ...base }).success).toBe(false); // role required
    expect(createAdminSchema.safeParse({ ...base, role: "ADMIN", permissions: ["NOPE"] }).success).toBe(false);
  });

  it("requires a reason on privileged updates", () => {
    expect(updateAdminSchema.safeParse({ status: "suspended", reason: "left company" }).success).toBe(true);
    expect(updateAdminSchema.safeParse({ status: "suspended" }).success).toBe(false);
    expect(updateAdminSchema.safeParse({ reason: "anything at all" }).success).toBe(false); // nothing to change
  });

  it("constrains database edits to allow-listed collections", () => {
    expect(dbEditSchema.safeParse({ collection: "users", id: "x", changes: { status: "active" }, reason: "fixing a record" }).success).toBe(true);
    expect(dbEditSchema.safeParse({ collection: "secrets", id: "x", changes: {}, reason: "fixing a record" }).success).toBe(false);
  });

  it("rejects an unknown role", () => {
    expect(adminRoleSchema.safeParse("SUPER_ADMIN").success).toBe(true);
    expect(adminRoleSchema.safeParse("root").success).toBe(false);
  });
});

describe("database console allow-list", () => {
  it("only exposes the documented collections", () => {
    expect(ADMIN_COLLECTIONS).toContain("users");
    expect(ADMIN_COLLECTIONS).toContain("auditLogs");
    expect(ADMIN_COLLECTIONS).not.toContain("admins");      // admin accounts have a dedicated API
    expect(ADMIN_COLLECTIONS).not.toContain("adminSessions");
    expect(ADMIN_COLLECTIONS).not.toContain("sessions");
    expect(ADMIN_COLLECTIONS).not.toContain("bans");
  });
});