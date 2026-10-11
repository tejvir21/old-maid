import { createContext, useContext, type ReactNode } from "react";
import type { AppServices } from "./services";

const Ctx = createContext<AppServices | null>(null);
export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}
export function useServices(): AppServices {
  const s = useContext(Ctx);
  if (!s) throw new Error("ServicesProvider missing");
  return s;
}
