/**
 * Render quality tier, picked once at startup. "low" targets a mid-range
 * Android phone at 30 fps, "high" a mid-range laptop at 60 fps.
 * Override with ?quality=low or ?quality=high.
 */

export type QualityTier = "low" | "high";

export type QualitySettings = {
  tier: QualityTier;
  /** Device pixel ratio cap. */
  maxDpr: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Half size of the sun's shadow box around the focus, metres. */
  shadowExtent: number;
  /** Rings of full-detail chunks drawn around the focus (1 = 3×3). Physics is always 3×3. */
  detailRings: number;
  /** Chunk .glb downloads in flight at once. */
  maxConcurrentLoads: number;
  /** Main-thread time per frame for building chunk meshes and colliders, ms. */
  frameBudgetMs: number;
  /** Props (poles, kiosks, sheds) are drawn within this many rings. */
  propRings: number;
  /** Camera far plane, metres. */
  viewDistance: number;
};

const HIGH: QualitySettings = {
  tier: "high",
  maxDpr: 2,
  shadows: true,
  shadowMapSize: 2048,
  shadowExtent: 90,
  detailRings: 2,
  maxConcurrentLoads: 4,
  frameBudgetMs: 4,
  propRings: 1,
  viewDistance: 6000,
};

const LOW: QualitySettings = {
  tier: "low",
  maxDpr: 1.25,
  shadows: false,
  shadowMapSize: 1024,
  shadowExtent: 50,
  detailRings: 1,
  maxConcurrentLoads: 2,
  frameBudgetMs: 3,
  propRings: 1,
  viewDistance: 4000,
};

function detectTier(): QualityTier {
  const q = new URLSearchParams(window.location.search).get("quality");
  if (q === "low" || q === "high") return q;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const small = Math.min(window.screen.width, window.screen.height) < 820;
  const fewCores = (navigator.hardwareConcurrency ?? 8) <= 4;
  return (coarse && small) || fewCores ? "low" : "high";
}

let cached: QualitySettings | null = null;

/** Client only. */
export function getQuality(): QualitySettings {
  cached ??= detectTier() === "low" ? LOW : HIGH;
  return cached;
}
