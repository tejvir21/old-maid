import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * The listener is registered once at module scope, not inside the hook.
 *
 * Chrome may fire `beforeinstallprompt` very early (before React mounts). A listener attached in
 * a `useEffect` would miss it and the install action could never be offered — a button that can
 * never be triggered. Capturing it eagerly means `canInstall` is true whenever the browser
 * actually supports installing.
 */
let captured: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

const emit = (): void => { for (const l of listeners) l(); };

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e: Event) => {
    // Keep the event so the user can trigger the native prompt from our own button later.
    e.preventDefault();
    captured = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    captured = null;
    emit();
  });
}

const isStandalone = (): boolean =>
  typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches;

/** Real PWA install prompt (Chromium). `canInstall` is false where the browser offers none. */
export function useInstall() {
  const [, bump] = useState(0);
  const [wasInstalled, setWasInstalled] = useState(installed || isStandalone());

  useEffect(() => {
    installed = installed || isStandalone();
    setWasInstalled(installed);
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  return {
    /** True only when the browser really offered an install prompt. */
    canInstall: !!captured && !wasInstalled,
    installed: wasInstalled,
    install: async () => {
      const evt = captured;
      if (!evt) return;
      await evt.prompt();
      const choice = await evt.userChoice;
      captured = null;
      if (choice.outcome === "accepted") { installed = true; setWasInstalled(true); }
      bump((n) => n + 1);
    },
  };
}