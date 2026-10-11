import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";
import { ServicesProvider } from "../src/app/context";
import { AppServices, type ServicesOptions } from "../src/app/services";
import { DEFAULT_SETTINGS } from "../src/offline/types";
import { useNetStore, useOfflineUi, useSettingsStore, useSyncStore } from "../src/store/ui";
import { TimeWarpScheduler, uniqueDb } from "./helpers";

export async function mountApp(path: string, opts: Partial<ServicesOptions> = {}, before?: (svc: AppServices) => void) {
  useOfflineUi.getState().reset();
  const svc = await AppServices.create({
    apiUrl: "http://127.0.0.1:9", socketUrl: "http://127.0.0.1:9", dbName: uniqueDb(),
    scheduler: new TimeWarpScheduler(400), aiDelay: () => 1000, isBrowserOnline: () => false,
    fetchImpl: (() => Promise.reject(new TypeError("no network in this test"))) as typeof fetch,
    onNet: (s) => useNetStore.setState(s), onSync: (s) => useSyncStore.setState(s), onOfflineUpdate: (u) => useOfflineUi.getState().apply(u),
    ...opts,
  });
  // Same path as production: settings live in IndexedDB and the store is loaded from it.
  await svc.repo.saveSettings({ ...DEFAULT_SETTINGS, animations: false, sound: false, aiPlayers: 2, aiDifficulty: "easy" });
  await useSettingsStore.getState().init(svc.repo);
  before?.(svc);
  const utils = render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ServicesProvider services={svc}><App /></ServicesProvider>
    </MemoryRouter>,
  );
  return { svc, ...utils };
}
