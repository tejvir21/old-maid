import { createContext, useContext } from "react";
import type { AdminApi, AdminProfile } from "./adminApi";

export const AdminApiContext = createContext<AdminApi | null>(null);
export const useAdminApi = (): AdminApi => {
  const a = useContext(AdminApiContext);
  if (!a) throw new Error("AdminApiContext missing");
  return a;
};

export interface AdminSession {
  profile: AdminProfile | null;
  status: "loading" | "anonymous" | "authenticated";
  error: string | null;
  refresh(): Promise<void>;
  logout(): void;
}

export const AdminSessionContext = createContext<AdminSession | null>(null);
export const useAdminSession = (): AdminSession => {
  const s = useContext(AdminSessionContext);
  if (!s) throw new Error("AdminSessionContext missing");
  return s;
};