import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { Attribution, Manifest } from "@/game/world/chunks/types";

export type WorldStatus = "loading" | "ready" | "missing";

/**
 * World streaming and presentation state. Changes on chunk loads and key
 * presses, not per frame.
 */
export type WorldState = {
  /** "ready" once the chunks around the spawn have colliders. */
  status: WorldStatus;
  /** Chunks currently loaded (any detail level). */
  loadedChunks: number;
  /** Attribution text from manifest.json. Must be shown in game. */
  attribution: Attribution[];
  /** The area's manifest (road graph, garages), once fetched. */
  manifest: Manifest | null;
  /** Harmattan dust haze in the fog and sky. Config flag; ?haze=0 turns it off. */
  harmattan: boolean;
  /** Debug free-fly camera (F). */
  freeFly: boolean;
  /** Debug road grade overlay (G). */
  showGrades: boolean;

  setStatus: (status: WorldStatus) => void;
  setLoadedChunks: (n: number) => void;
  setAttribution: (a: Attribution[]) => void;
  setManifest: (m: Manifest | null) => void;
  setHarmattan: (on: boolean) => void;
  toggleFreeFly: () => void;
  toggleGrades: () => void;
};

export const useWorldStore = create<WorldState>()(
  subscribeWithSelector((set) => ({
    status: "loading",
    loadedChunks: 0,
    attribution: [],
    manifest: null,
    harmattan: true,
    freeFly: false,
    showGrades: false,

    setStatus: (status) => set({ status }),
    setLoadedChunks: (loadedChunks) => set({ loadedChunks }),
    setAttribution: (attribution) => set({ attribution }),
    setManifest: (manifest) => set({ manifest }),
    setHarmattan: (harmattan) => set({ harmattan }),
    toggleFreeFly: () => set((s) => ({ freeFly: !s.freeFly })),
    toggleGrades: () => set((s) => ({ showGrades: !s.showGrades })),
  })),
);
