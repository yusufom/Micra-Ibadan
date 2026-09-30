"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useWorldStore } from "@/game/store/worldStore";

const isDev = process.env.NODE_ENV === "development";

/** Debug tools are on in dev, or in any build with ?debug in the URL. */
export function useDebugToolsEnabled(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => isDev || new URLSearchParams(window.location.search).has("debug"),
    () => false,
  );
}

/** F: free-fly camera. G: road grade overlay. H: harmattan haze on/off. ?cam=x,y,z starts in free fly. */
export function useDebugKeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (new URLSearchParams(window.location.search).has("cam") && !useWorldStore.getState().freeFly) useWorldStore.getState().toggleFreeFly();
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const s = useWorldStore.getState();
      if (e.code === "KeyF") s.toggleFreeFly();
      else if (e.code === "KeyG") s.toggleGrades();
      else if (e.code === "KeyH") s.setHarmattan(!s.harmattan);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
