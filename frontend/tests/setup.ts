import "fake-indexeddb/auto";

if (typeof window !== "undefined") {
  // jsdom gaps used by the UI
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as never;
  }
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css) (globalThis as unknown as { CSS: { escape(s: string): string } }).CSS = { escape: (s) => s.replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
  else if (!css.escape) css.escape = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
}

if (typeof window !== "undefined") {
  const { afterEach } = await import("vitest");
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());
}
