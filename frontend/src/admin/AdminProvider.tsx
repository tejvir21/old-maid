import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Permission } from "@old-maid/shared";
import { AdminApiContext, AdminSessionContext, useAdminApi, useAdminSession } from "./context";
import type { AdminApi, AdminProfile } from "./adminApi";

export function AdminProvider({ api, children }: { api: AdminApi; children: ReactNode }) {
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [status, setStatus] = useState<"loading" | "anonymous" | "authenticated">("loading");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const p = await api.restore();
    setProfile(p);
    setStatus(p ? "authenticated" : "anonymous");
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const logout = useCallback(() => {
    api.logout();
    setProfile(null);
    setStatus("anonymous");
  }, [api]);

  return (
    <AdminApiContext.Provider value={api}>
      <AdminSessionContext.Provider value={{ profile, status, error, refresh, logout }}>
        {children}
      </AdminSessionContext.Provider>
    </AdminApiContext.Provider>
  );
}

/**
 * Route guard. This is UX only — every admin API call is independently authorized on the
 * server, so bypassing this component grants nothing.
 */
export function AdminGate({ need, children }: { need?: Permission; children: ReactNode }) {
  const { status, profile } = useAdminSession();
  const api = useAdminApi();
  if (status === "loading") return <p className="p-8 text-center text-dim">Checking admin session…</p>;
  if (status === "anonymous") return <RedirectToLogin />;
  if (need && !api.can(need)) {
    return (
      <div className="p-8 text-center">
        <h1 className="title-display mb-2 text-2xl">Not permitted</h1>
        <p className="text-dim">
          Your role ({profile?.role}) does not include <code>{need}</code>.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

function RedirectToLogin() {
  return (
    <div className="p-8 text-center text-dim">
      No active admin session. <a className="underline" href="/admin/login">Sign in</a> to continue.
    </div>
  );
}