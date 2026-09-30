import type { RoadEdge } from "../chunks/types";

/**
 * Potholes scattered along the road graph. Not in the pipeline output yet, so
 * they are generated here, seeded by edge id: the same holes are in the same
 * places every session. Unpaved roads are the worst, expressways the best.
 */

export type Pothole = {
  id: number;
  x: number;
  /** Centreline height; PotholeLayer drops the decal onto the actual road surface. */
  y: number;
  z: number;
  radius: number;
  /** Metres. */
  depth: number;
  /** 0–1. Above MICRA_TUNING.potholes.burstSeverity it can burst a tyre. */
  severity: number;
  yaw: number;
  unpaved: boolean;
};

/** Average metres of road per pothole. */
const SPACING: Record<string, number> = {
  unpaved: 35,
  residential: 100,
  unclassified: 100,
  tertiary: 140,
  secondary: 180,
  primary: 250,
  trunk: 250,
  motorway: 600,
};
const DEFAULT_SPACING = 160;
/** Keep holes this far inside the carriageway edge. */
const EDGE_MARGIN = 0.6;
const CELL = 10;

const cellKey = (i: number, j: number) => i * 73856093 + j * 19349663;

/** Small fast seeded PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointAlong(poly: [number, number, number][], s: number): { x: number; y: number; z: number; dx: number; dz: number } {
  let left = s;
  for (let i = 0; i < poly.length - 1; i++) {
    const [x0, y0, z0] = poly[i];
    const [x1, y1, z1] = poly[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (left <= len || i === poly.length - 2) {
      const t = len > 0 ? Math.min(1, left / len) : 0;
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, z: z0 + (z1 - z0) * t, dx: len ? (x1 - x0) / len : 1, dz: len ? (z1 - z0) / len : 0 };
    }
    left -= len;
  }
  const [x, y, z] = poly[0];
  return { x, y, z, dx: 1, dz: 0 };
}

export class PotholeField {
  readonly all: Pothole[] = [];
  private readonly cells = new Map<number, Pothole[]>();

  constructor(edges: RoadEdge[]) {
    for (const e of edges) {
      if (e.polyline.length < 2 || e.length < 5) continue;
      const spacing = e.surface === "unpaved" ? SPACING.unpaved : (SPACING[e.highway.replace(/_link$/, "")] ?? DEFAULT_SPACING);
      const rng = mulberry32(Math.imul(e.id + 1, 2654435761) ^ 0x5eed);
      const count = Math.floor(e.length / spacing + rng());
      const halfWidth = Math.max(0, e.width / 2 - EDGE_MARGIN);
      for (let k = 0; k < count; k++) {
        const s = rng() * e.length;
        const lateral = (rng() * 2 - 1) * halfWidth;
        const p = pointAlong(e.polyline, s);
        const unpaved = e.surface === "unpaved";
        const severity = Math.min(1, Math.pow(rng(), 3.2) + (unpaved ? 0.1 : 0));
        const hole: Pothole = {
          id: this.all.length,
          // Right of travel is (-dz, dx) in game axes.
          x: p.x - p.dz * lateral,
          y: p.y,
          z: p.z + p.dx * lateral,
          radius: 0.28 + 0.55 * severity * (0.6 + 0.4 * rng()),
          depth: 0.04 + 0.14 * severity,
          severity,
          yaw: rng() * Math.PI * 2,
          unpaved,
        };
        this.all.push(hole);
        const i0 = Math.floor((hole.x - hole.radius) / CELL);
        const i1 = Math.floor((hole.x + hole.radius) / CELL);
        const j0 = Math.floor((hole.z - hole.radius) / CELL);
        const j1 = Math.floor((hole.z + hole.radius) / CELL);
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const key = cellKey(i, j);
            let list = this.cells.get(key);
            if (!list) this.cells.set(key, (list = []));
            list.push(hole);
          }
        }
      }
    }
  }

  /** The pothole whose rim contains (x, z), if any. */
  at(x: number, z: number): Pothole | null {
    const list = this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return null;
    for (const h of list) {
      const dx = x - h.x;
      const dz = z - h.z;
      if (dx * dx + dz * dz < h.radius * h.radius) return h;
    }
    return null;
  }

  /** Potholes within `radius` of (x, z), appended to `out`. */
  near(x: number, z: number, radius: number, out: Pothole[]): Pothole[] {
    const i0 = Math.floor((x - radius) / CELL);
    const i1 = Math.floor((x + radius) / CELL);
    const j0 = Math.floor((z - radius) / CELL);
    const j1 = Math.floor((z + radius) / CELL);
    const seen = new Set<number>();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const h of this.cells.get(cellKey(i, j)) ?? []) {
          if (seen.has(h.id)) continue;
          seen.add(h.id);
          if ((h.x - x) ** 2 + (h.z - z) ** 2 <= radius * radius) out.push(h);
        }
      }
    }
    return out;
  }
}
