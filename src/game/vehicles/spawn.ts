import type { Manifest, RoadEdge } from "@/game/world/chunks/types";

/**
 * Where the Micra starts: Dugbe garage, in the right-hand lane, pointing along
 * the road-graph route towards Mokola.
 *
 * OSM has no taxi garage at Dugbe, so the garage is a curated point by the
 * Dugbe junction (the projection origin). The heading is not hard-coded: a
 * shortest path over the road graph (respecting one-way streets) from the
 * roads around the garage to Mokola roundabout picks the first road and the
 * direction to face on it.
 */

export type Spawn = {
  position: [number, number, number];
  /** Yaw about +Y; 0 faces north (-Z). */
  yaw: number;
  /** Nose-up pitch matching the road, radians. */
  pitch: number;
  /** Road the car starts on, for the HUD / debugging. */
  road: string | null;
};

/** Dugbe garage (curated; OSM has none here). Game metres. */
export const DUGBE_GARAGE = { name: "Dugbe Garage", x: 12, z: -6 };

/** Mokola roundabout, where Oyo Road, Sabo Road and Fajuyi Road meet. */
export const MOKOLA = { name: "Mokola", x: 1200, z: -1180 };

/** Candidate start roads within this radius of the garage. */
const SEARCH_RADIUS = 60;
/** Start this far along the chosen road, clear of the junction box. */
const START_ALONG = 18;
/** Drop the car from this high above the road so the wheels settle. */
const DROP_HEIGHT = 0.35;

/** Used when no map chunks were built: the fallback slope, facing north. */
export const FALLBACK_SPAWN: Spawn = { position: [0, 1.2, 0], yaw: 0, pitch: 0, road: null };

type Adj = Map<number, { to: number; edge: RoadEdge }[]>;

/** Road distance from every node to `target` (Dijkstra on the reversed graph). */
function distancesTo(target: number, edges: RoadEdge[]): Map<number, number> {
  const rev: Adj = new Map();
  for (const e of edges) {
    const push = (from: number, to: number) => {
      let list = rev.get(from);
      if (!list) rev.set(from, (list = []));
      list.push({ to, edge: e });
    };
    push(e.v, e.u);
    if (!e.oneway) push(e.u, e.v);
  }
  const dist = new Map<number, number>([[target, 0]]);
  // Binary heap of [distance, node].
  const heap: [number, number][] = [[0, target]];
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  const push = (item: [number, number]) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  while (heap.length) {
    const [d, n] = pop();
    if (d > (dist.get(n) ?? Infinity)) continue;
    for (const { to, edge } of rev.get(n) ?? []) {
      const nd = d + edge.length;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        push([nd, to]);
      }
    }
  }
  return dist;
}

/** Point and unit direction at distance s along a polyline (clamped). */
function along(poly: [number, number, number][], s: number) {
  let left = Math.max(0, s);
  for (let i = 0; i < poly.length - 1; i++) {
    const [x0, y0, z0] = poly[i];
    const [x1, y1, z1] = poly[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (left <= len || i === poly.length - 2) {
      const t = len ? Math.min(1, left / len) : 0;
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, z: z0 + (z1 - z0) * t, dx: (x1 - x0) / len, dy: (y1 - y0) / len, dz: (z1 - z0) / len };
    }
    left -= len;
  }
  throw new Error("empty polyline");
}

/** Distance along a polyline to the point closest to (x, z). */
function project(poly: [number, number, number][], x: number, z: number): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  let acc = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const [x0, , z0] = poly[i];
    const [x1, , z1] = poly[i + 1];
    const ex = x1 - x0;
    const ez = z1 - z0;
    const len2 = ex * ex + ez * ez;
    const t = len2 ? Math.max(0, Math.min(1, ((x - x0) * ex + (z - z0) * ez) / len2)) : 0;
    const d = Math.hypot(x0 + ex * t - x, z0 + ez * t - z);
    if (d < best.d) best = { s: acc + Math.sqrt(len2) * t, d };
    acc += Math.sqrt(len2);
  }
  return best;
}

const reversed = (p: [number, number, number][]) => [...p].reverse();

export function findGarageSpawn(manifest: Manifest): Spawn {
  const { nodes, edges } = manifest.roadGraph;
  if (!nodes?.length || !edges.length) return FALLBACK_SPAWN;

  let target = nodes[0];
  for (const n of nodes) {
    if (Math.hypot(n.x - MOKOLA.x, n.z - MOKOLA.z) < Math.hypot(target.x - MOKOLA.x, target.z - MOKOLA.z)) target = n;
  }
  const dist = distancesTo(target.id, edges);

  // Every drivable direction of every road near the garage: cost = walk to it + drive the rest of it + onward to Mokola.
  let best: { cost: number; poly: [number, number, number][]; s: number; edge: RoadEdge } | null = null;
  for (const e of edges) {
    const { s, d } = project(e.polyline, DUGBE_GARAGE.x, DUGBE_GARAGE.z);
    if (d > SEARCH_RADIUS || e.length < 12) continue;
    const dirs: [number[], [number, number, number][], number, number][] = [[[e.u, e.v], e.polyline, s, e.v]];
    if (!e.oneway) dirs.push([[e.v, e.u], reversed(e.polyline), e.length - s, e.u]);
    for (const [, poly, sAlong, end] of dirs) {
      const onward = dist.get(end);
      if (onward === undefined) continue;
      const start = Math.min(Math.max(sAlong, START_ALONG), e.length - START_ALONG / 2);
      const cost = d * 3 + (e.length - start) + onward;
      if (!best || cost < best.cost) best = { cost, poly, s: start, edge: e };
    }
  }
  if (!best) return FALLBACK_SPAWN;

  const p = along(best.poly, best.s);
  // Keep right: a quarter of the carriageway to the right of the centreline.
  const offset = best.edge.width / 4;
  const x = p.x - p.dz * offset;
  const z = p.z + p.dx * offset;
  return {
    position: [x, p.y + DROP_HEIGHT, z],
    yaw: Math.atan2(-p.dx, -p.dz),
    pitch: Math.atan(p.dy),
    road: best.edge.name ?? best.edge.ref,
  };
}
