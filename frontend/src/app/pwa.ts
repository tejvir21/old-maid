import { registerSW } from "virtual:pwa-register";

/** Registers the service worker (precaches the whole app shell so it launches with no network). */
export function registerServiceWorker(onReady?: () => void): void {
  if (!("serviceWorker" in navigator)) return;
  registerSW({
    immediate: true,
    onOfflineReady: () => onReady?.(),
    onRegisterError: (e) => console.warn("Service worker registration failed", e),
  });
}
