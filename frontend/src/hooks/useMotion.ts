import { useEffect, useState } from "react";
import { useSettingsStore } from "../store/ui";

/** True when animations should be minimised (OS setting OR the in-app toggle). */
export function useReducedMotion(): boolean {
  const animations = useSettingsStore((s) => s.values.animations);
  const [os, setOs] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setOs(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return os || !animations;
}
