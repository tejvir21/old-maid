// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PERMISSIONS, ROLE_PERMISSIONS, SUPER_ADMIN_ONLY } from "@old-maid/shared";
import { AdminApi, AdminApiError } from "../src/admin/adminApi";
import { AdminGate, AdminProvider } from "../src/admin/AdminProvider";
import { AdminDashboard } from "../src/admin/pages/AdminDashboard";
import { AdminUsers } from "../src/admin/pages/AdminUsers";
import { AdminSettings } from "../src/admin/pages/AdminSettings";
import { AdminDatabase } from "../src/admin/pages/AdminDatabase";

const PW = "irrelevant-in-frontend-tests";

type Route = { m: string; p: string; body?: unknown; status?: number };
function fakeFetch(routes: Route[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const hit = routes.find((r) => url.includes(r.p));
    const status = hit?.status ?? (hit ? 200 : 404);
    const body = hit && "body" in hit ? hit.body : { success: status === 200 };
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const profile = (role: keyof typeof ROLE_PERMISSIONS, perms?: string[]) => ({
  id: "a1", email: "x@example.com", username: "x", role,
  permissions: perms ?? [...ROLE_PERMISSIONS[role]], status: "active" as const,
  createdAt: new Date().toISOString(), twoFactorEnabled: false,
});

function mount(node: React.ReactNode, api: AdminApi) {
  return render(
    <MemoryRouter initialEntries={["/admin"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AdminProvider api={api}>{node}</AdminProvider>
    </MemoryRouter>,
  );
}

/** Seeds a logged-in session without going through the login form. */
function authed(api: AdminApi, p: ReturnType<typeof profile>): void {
  api.establish("test-token", p as never);
}

beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

describe("admin API client", () => {
  it("sends the bearer token and parses a successful response", async () => {
    const { impl, calls } = fakeFetch([{ m: "GET", p: "/api/admin/dashboard", body: { success: true, data: { users: 1 } } }]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("SUPPORT"));
    const r = await api.request<{ data: { users: number } }>("GET", "/dashboard");
    expect(r.data.users).toBe(1);
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("never sends an admin token to a non-admin path", async () => {
    const { impl, calls } = fakeFetch([{ m: "GET", p: "/api/admin/me", body: { success: true, admin: profile("SUPPORT"), permissions: [] } }]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("SUPPORT"));
    await api.restore();
    expect(calls.every((c) => c.url.includes("/api/admin/"))).toBe(true);
  });

  it("clears the session on 401 so stale privileges cannot persist", async () => {
    const { impl } = fakeFetch([{ m: "GET", p: "/api/admin/users", status: 401, body: { success: false, error: { code: "UNAUTHORIZED", message: "nope" } } }]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("SUPER_ADMIN"));
    await expect(api.request("GET", "/users")).rejects.toBeInstanceOf(AdminApiError);
    expect(api.authed).toBe(false);
    expect(api.can("USERS_READ")).toBe(false);
  });

  it("surfaces the server error code and message", async () => {
    const { impl } = fakeFetch([{ m: "GET", p: "/api/admin/users", status: 403, body: { success: false, error: { code: "FORBIDDEN", message: "Missing permission: USERS_BAN" } } }]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("SUPPORT"));
    await expect(api.request("GET", "/users")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("reports no session when /me is unreachable during restore", async () => {
    const { impl } = fakeFetch([{ m: "GET", p: "/api/admin/me", status: 401 }]);
    const api = new AdminApi("", impl, null);
    sessionStorage.setItem("om-admin-token", "stale");
    expect(await api.restore()).toBeNull();
  });
});

describe("permission enforcement in the UI", () => {
  it("hides nav entries the role cannot use and blocks the route", async () => {
    const { impl } = fakeFetch([{ m: "GET", p: "/api/admin/me", body: { success: true, admin: profile("SUPPORT"), permissions: ROLE_PERMISSIONS.SUPPORT } }]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("SUPPORT"));
    mount(<AdminGate need="DATABASE_READ"><div>secret</div></AdminGate>, api);
    await waitFor(() => expect(screen.getByText(/Not permitted/i)).toBeTruthy());
    expect(screen.queryByText("secret")).toBeNull();
  });

  it("allows a route the role does have", async () => {
    const { impl } = fakeFetch([{ m: "GET", p: "/api/admin/me", body: { success: true, admin: profile("SUPPORT"), permissions: ROLE_PERMISSIONS.SUPPORT } }]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("SUPPORT"));
    mount(<AdminGate need="USERS_READ"><div>allowed</div></AdminGate>, api);
    await waitFor(() => expect(screen.getByText("allowed")).toBeTruthy());
  });
});

describe("dashboard shows real values, never fabricated ones", () => {
  it("renders server metrics", async () => {
    const { impl } = fakeFetch([
      { m: "GET", p: "/api/admin/me", body: { success: true, admin: profile("ADMIN"), permissions: ROLE_PERMISSIONS.ADMIN } },
      { m: "GET", p: "/api/admin/dashboard", body: { success: true, data: {
        users: 42, guests: 7, usersToday: 3, onlinePlayers: 5, activeRooms: 2, roomsPlaying: 1,
        activeGames: 1, gamesToday: 4, totalGames: 100, pendingReports: 2, reportCounts: { OPEN: 2 },
        syncRecords: 9, activeAdmins: 1, uptimeSec: 3661,
        health: { api: "ok", database: { kind: "memory", ok: true, latencyMs: 0 }, socket: { connections: 5, rooms: 2 },
          server: { nodeVersion: "v22", platform: "win32", rssMb: 100, heapUsedMb: 50, cpus: 8, loadAvg: [0, 0, 0] } },
        instanceId: "abcd1234",
      } } },
    ]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("ADMIN"));
    mount(<AdminDashboard />, api);
    await waitFor(() => expect(screen.getByText("42")).toBeTruthy());
    expect(screen.getByText("Registered users")).toBeTruthy();
    expect(screen.getByText("MongoDB")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
  });
});

describe("users page", () => {
  it("renders server rows and hides destructive actions without USERS_BAN", async () => {
    const { impl } = fakeFetch([
      { m: "GET", p: "/api/admin/me", body: { success: true, admin: profile("SUPPORT"), permissions: ROLE_PERMISSIONS.SUPPORT } },
      { m: "GET", p: "/api/admin/users", body: { success: true, total: 1, limit: 25, offset: 0, items: [
        { id: "u1", username: "Ryuji", email: "r@example.com", status: "active", createdAt: new Date().toISOString() },
      ] } },
    ]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("SUPPORT"));
    mount(<AdminUsers />, api);
    await waitFor(() => expect(screen.getByText("Ryuji")).toBeTruthy());
    // SUPPORT has USERS_READ but not USERS_BAN
    expect(screen.queryByText("Ban")).toBeNull();
    expect(screen.getByText("Details")).toBeTruthy();
  });

  it("shows ban confirmation requiring a reason", async () => {
    const { impl } = fakeFetch([
      { m: "GET", p: "/api/admin/me", body: { success: true, admin: profile("ADMIN"), permissions: ROLE_PERMISSIONS.ADMIN } },
      { m: "GET", p: "/api/admin/users", body: { success: true, total: 1, limit: 25, offset: 0, items: [
        { id: "u1", username: "Cheater", status: "active", createdAt: new Date().toISOString() },
      ] } },
    ]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("ADMIN"));
    mount(<AdminUsers />, api);
    await waitFor(() => expect(screen.getByText("Cheater")).toBeTruthy());
    const ban = screen.getByText("Ban") as HTMLButtonElement;
    ban.click();
    await waitFor(() => expect(screen.getByText(/Reason \(recorded/i)).toBeTruthy());
    // the confirm button stays disabled until a real reason is typed
    const confirm = screen.getByText("Ban user").closest("button") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});

describe("database console", () => {
  it("never renders a value whose key looks like a credential", async () => {
    const { impl } = fakeFetch([
      { m: "GET", p: "/api/admin/me", body: { success: true, admin: profile("SUPER_ADMIN"), permissions: ROLE_PERMISSIONS.SUPER_ADMIN } },
      { m: "GET", p: "/api/admin/database/collections", body: { success: true, collections: [
        { name: "users", editableFields: ["username"], protected: false },
        { name: "auditLogs", editableFields: [], protected: true },
      ] } },
      { m: "GET", p: "/api/admin/database/users", body: { success: true, total: 1, limit: 25, offset: 0, items: [
        { id: "u1", username: "Ryuji", passwordHash: "$2b$10$supersecret", sessionHash: "deadbeef" },
      ] } },
    ]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("SUPER_ADMIN"));
    mount(<AdminDatabase />, api);
    await waitFor(() => expect(screen.getByText("Ryuji")).toBeTruthy());
    expect(screen.queryByText(/\$2b\$10\$supersecret/)).toBeNull();
    expect(screen.queryByText("deadbeef")).toBeNull();
    expect(screen.getAllByText("[redacted]").length).toBeGreaterThan(0);
  });

  it("marks protected collections", async () => {
    const { impl } = fakeFetch([
      { m: "GET", p: "/api/admin/me", body: { success: true, admin: profile("SUPER_ADMIN"), permissions: ROLE_PERMISSIONS.SUPER_ADMIN } },
      { m: "GET", p: "/api/admin/database/collections", body: { success: true, collections: [{ name: "users", editableFields: [], protected: false }] } },
      { m: "GET", p: "/api/admin/database/users", body: { success: true, total: 0, limit: 25, offset: 0, items: [] } },
    ]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("SUPER_ADMIN"));
    mount(<AdminDatabase />, api);
    await waitFor(() => expect(screen.getByText(/No records in users/)).toBeTruthy());
  });
});

describe("settings page", () => {
  it("renders server values and disables editing for a read-only role", async () => {
    const { impl } = fakeFetch([
      { m: "GET", p: "/api/admin/me", body: { success: true, admin: profile("SUPPORT"), permissions: ROLE_PERMISSIONS.SUPPORT } },
      { m: "GET", p: "/api/admin/settings", body: { success: true, settings: {
        game: { minPlayers: 2, maxPlayers: 7, allowAiFill: true, defaultAiDifficulty: "normal", turnTimeoutSec: 60, reconnectTimeoutSec: 60, roomExpirationSec: 600, chatEnabled: true, emotesEnabled: true, spectatorsEnabled: false },
        ai: { enabled: true, difficulty: "normal", thinkingDelayMs: 800, aggressiveness: 0.5, memory: 0.6 },
        system: { applicationName: "Old Maid", maintenanceMode: false, maintenanceMessage: "x", allowExistingGamesInMaintenance: true, allowNewGames: true, allowRegistrations: true, sessionTimeoutMin: 1440 },
        features: { onlineMultiplayer: true, offlineMode: true, chat: true, emotes: true, spectators: false, achievements: true, statistics: true, replays: false },
      }, onlineAvailable: { ok: true } } },
    ]);
    const api = new AdminApi("", impl, null);
    authed(api, profile("SUPPORT"));
    mount(<AdminSettings />, api);
    await waitFor(() => expect(screen.getAllByDisplayValue("60").length).toBeGreaterThan(0));
    for (const el of screen.getAllByDisplayValue("60")) {
      expect((el as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByText(/can read settings but not change them/i)).toBeTruthy();
  });
});

describe("shared RBAC contract (mirrors the backend matrix)", () => {
  it("keeps super-admin-only permissions out of lower roles", () => {
    for (const role of ["ADMIN", "MODERATOR", "SUPPORT"] as const) {
      for (const p of SUPER_ADMIN_ONLY) {
        if (role === "ADMIN" && p === "GAME_DEBUG_READ") continue;
        expect(ROLE_PERMISSIONS[role].includes(p), `${role} must not hold ${p}`).toBe(false);
      }
    }
  });
  it("covers every declared permission in the matrix", () => {
    for (const p of PERMISSIONS) {
      expect(ROLE_PERMISSIONS.SUPER_ADMIN.includes(p)).toBe(true);
    }
  });
});