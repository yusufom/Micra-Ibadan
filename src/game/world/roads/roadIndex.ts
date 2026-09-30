import type { RoadEdge } from "../chunks/types";

/**
 * Spatial index over the road graph's polyline segments, for "which road am
 * I on and how steep is it" queries. Built once from the manifest.
 */

const CELL = 25;
/** Points further than this from any road centreline count as off-road. */
const DEFAULT_REACH = 8;

type Segment = { edge: RoadEdge; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; /** Distance along the edge (u → v) at the segment start. */ s0: number };

export type RoadHit = {
  edge: RoadEdge;
  /** Closest point on the centreline. */
  x: number;
  y: number;
  z: number;
  /** Unit direction of the segment in the edge's u → v direction (xz). */
  dx: number;
  dz: number;
  /** Rise over run of the segment, u → v. */
  grade: number;
  /** Horizontal distance from the query point. */
  distance: number;
  /** Distance along the edge from u (horizontal metres). */
  s: number;
};

const cellKey = (i: number, j: number) => i * 73856093 + j * 19349663;

export class RoadIndex {
  private readonly cells = new Map<number, Segment[]>();

  constructor(edges: RoadEdge[]) {
    for (const edge of edges) {
      const p = edge.polyline;
      let s0 = 0;
      for (let k = 0; k < p.length - 1; k++) {
        const [x0, y0, z0] = p[k];
        const [x1, y1, z1] = p[k + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        s0 += len;
        if (len < 0.01) continue;
        const seg: Segment = { edge, x0, y0, z0, x1, y1, z1, s0: s0 - len };
        const i0 = Math.floor(Math.min(x0, x1) / CELL);
        const i1 = Math.floor(Math.max(x0, x1) / CELL);
        const j0 = Math.floor(Math.min(z0, z1) / CELL);
        const j1 = Math.floor(Math.max(z0, z1) / CELL);
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const key = cellKey(i, j);
            let list = this.cells.get(key);
            if (!list) this.cells.set(key, (list = []));
            list.push(seg);
          }
        }
      }
    }
  }

  /** Nearest road centreline within `reach` metres, or null. */
  nearest(x: number, z: number, reach = DEFAULT_REACH): RoadHit | null {
    let best: Segment | null = null;
    let bestD2 = reach * reach;
    let bestT = 0;
    const r = Math.ceil(reach / CELL);
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(z / CELL);
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const list = this.cells.get(cellKey(i, j));
        if (!list) continue;
        for (const s of list) {
          const ex = s.x1 - s.x0;
          const ez = s.z1 - s.z0;
          const t = Math.max(0, Math.min(1, ((x - s.x0) * ex + (z - s.z0) * ez) / (ex * ex + ez * ez)));
          const px = s.x0 + ex * t - x;
          const pz = s.z0 + ez * t - z;
          const d2 = px * px + pz * pz;
          // Prefer wider roads when two centrelines are about as close (junctions).
          const score = d2 - s.edge.width * 0.5;
          if (score < bestD2) {
            bestD2 = score;
            best = s;
            bestT = t;
          }
        }
      }
    }
    if (!best) return null;
    const ex = best.x1 - best.x0;
    const ez = best.z1 - best.z0;
    const run = Math.hypot(ex, ez);
    const hx = best.x0 + ex * bestT;
    const hz = best.z0 + ez * bestT;
    return {
      edge: best.edge,
      x: hx,
      y: best.y0 + (best.y1 - best.y0) * bestT,
      z: hz,
      dx: ex / run,
      dz: ez / run,
      grade: (best.y1 - best.y0) / run,
      distance: Math.hypot(hx - x, hz - z),
      s: best.s0 + run * bestT,
    };
  }

  /**
   * Uphill grade (fraction) of the road under (x, z) along the heading
   * (hx, hz), or null off the road graph. Uses the segment's own slope, so
   * short steep stretches count like on the G overlay.
   */
  gradeAlong(x: number, z: number, hx: number, hz: number): number | null {
    const hit = this.nearest(x, z);
    if (!hit) return null;
    return hit.grade * Math.sign(hit.dx * hx + hit.dz * hz || 1);
  }
}
