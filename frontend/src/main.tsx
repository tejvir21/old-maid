import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import { App } from "./App";
import { ServicesProvider } from "./app/context";
import { API_URL, SOCKET_URL } from "./app/env";
import { registerServiceWorker } from "./app/pwa";
import { AppServices } from "./app/services";
import { useNetStore, useOfflineUi, useSettingsStore, useSyncStore } from "./store/ui";

const root = createRoot(document.getElementById("root") as HTMLElement);

async function boot(): Promise<void> {
  try {
    const services = await AppServices.create({
      apiUrl: API_URL,
      socketUrl: SOCKET_URL,
      listen: (up, down) => {
        window.addEventListener("online", up);
        window.addEventListener("offline", down);
        return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
      },
      onNet: (s) => useNetStore.setState(s),
      onSync: (s) => useSyncStore.setState(s),
      onOfflineUpdate: (u) => useOfflineUi.getState().apply(u),
    });
    await useSettingsStore.getState().init(services.repo);
    registerServiceWorker();
    root.render(
      <StrictMode>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <ServicesProvider services={services}><App /></ServicesProvider>
        </BrowserRouter>
      </StrictMode>,
    );
  } catch (e) {
    console.error(e);
    root.render(
      <div style={{ padding: 24, color: "#e2dcd2", fontFamily: "monospace" }}>
        <h1>Old Maid</h1>
        <p>This browser blocked local storage (IndexedDB), which the game needs to save progress. Try leaving private browsing mode.</p>
      </div>,
    );
  }
}
void boot();
