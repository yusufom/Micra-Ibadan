import type { Manifest, RoadEdge, RoadNode } from "./chunks/types";
import { RoadIndex } from "./roads/roadIndex";

/**
 * The whole road graph from manifest.json, set up for driving on it: directed
 * edges, lanes, A* routing that respects one-way streets, lane polylines,
 * height along edges and spatial lookups.
 *
 * Directed edges are plain numbers, `edgeId * 2` for u → v and `edgeId * 2 + 1`
 * for v → u, so routes and per-vehicle state stay allocation-free.
 * Traffic drives on the right. Lane 0 is the kerb lane; lateral offsets are
 * metres to the right of the centreline, seen in the direction of travel.
 */

export type DirEdge = number;

export const dirEdge = (edgeId: number, forward: boolean): DirEdge => edgeId * 2 + (forward ? 0 : 1);
export const edgeIdOf = (de: DirEdge): number => de >> 1;
export const isForward = (de: DirEdge): boolean => (de & 1) === 0;
export const reverseOf = (de: DirEdge): DirEdge => de ^ 1;

/** Centreline in the direction of travel: interleaved x, y, z and cumulative horizontal length. */
export type Polyline = { pts: Float32Array; cum: Float32Array; length: number };

export type LaneHit = {
  edge: RoadEdge;
  /** The direction a car there would be driving (right-hand traffic). */
  dir: DirEdge;
  lane: number;
  /** Distance along `dir` from its start node. */
  s: number;
  /** Offset right of the centreline in the direction of `dir`. */
  lateral: number;
  x: number;
  y: number;
  z: number;
  distance: number;
};

export type Sample = { x: number; y: number; z: number; dx: number; dz: number; grade: number };

export type RouteOptions = {
  /** Cost multiplier for driving a directed edge (≥ 1 keeps A* exact); Infinity forbids it. */
  cost?: (edge: RoadEdge, dir: DirEdge) => number;
  /** Give up after expanding this many nodes. */
  maxExpansions?: number;
};

/** Road class rank, for right of way and spawn weights. Links rank half a step below their road. */
export function highwayRank(highway: string): number {
  const base = highway.replace("_link", "");
  const r = RANK[base] ?? 0;
  return highway.endsWith("_link") ? r - 0.5 : r;
}
const RANK: Record<string, number> = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1, road: 1, residential: 0, service: -1, living_street: -1 };

/** Top speed used by the A* heuristic, m/s (100 km/h). */
const HEURISTIC_SPEED = 100 / 3.6;
const GRID = 100;
/** Drains sit this wide beside the kerb (pipeline DRAIN_ZONE); roads without get a verge. */
const DRAIN_ZONE = 0.74;
const VERGE = 0.3;
const MITER_LIMIT = 2.5;

const gridKey = (i: number, j: number) => i * 100003 + j;

export class RoadGraph {
  readonly edges: RoadEdge[];
  readonly nodes = new Map<number, RoadNode>();
  /** Nearest-centreline queries (shared with the Micra's grade lookups). */
  readonly index: RoadIndex;

  private readonly outgoing = new Map<number, DirEdge[]>();
  private readonly incoming = new Map<number, DirEdge[]>();
  private readonly grid = new Map<number, number[]>();
  private readonly lines = new Map<DirEdge, Polyline>();
  private readonly laneLines = new Map<number, Float32Array>();
  private readonly trims = new Map<number, number>();

  // A* scratch, sized to the node count and reused between searches.
  private readonly nodeIndex = new Map<number, number>();
  private readonly nodeIds: number[] = [];
  private readonly gScore: Float64Array;
  private readonly came: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closed: Uint32Array;
  private generation = 0;

  constructor(manifest: Manifest, index?: RoadIndex) {
    const { nodes, edges } = manifest.roadGraph;
    this.edges = [];
    for (const e of edges) this.edges[e.id] = e;
    for (const n of nodes) {
      this.nodes.set(n.id, n);
      this.nodeIndex.set(n.id, this.nodeIds.length);
      this.nodeIds.push(n.id);
    }
    this.index = index ?? new RoadIndex(edges);

    const push = (map: Map<number, DirEdge[]>, node: number, de: DirEdge) => {
      let list = map.get(node);
      if (!list) map.set(node, (list = []));
      list.push(de);
    };
    for (const e of edges) {
      push(this.outgoing, e.u, dirEdge(e.id, true));
      push(this.incoming, e.v, dirEdge(e.id, true));
      if (!e.oneway) {
        push(this.outgoing, e.v, dirEdge(e.id, false));
        push(this.incoming, e.u, dirEdge(e.id, false));
      }
      // Coarse grid of edges by polyline bounds.
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, , z] of e.polyline) {
        x0 = Math.min(x0, x);
        z0 = Math.min(z0, z);
        x1 = Math.max(x1, x);
        z1 = Math.max(z1, z);
      }
      for (let i = Math.floor(x0 / GRID); i <= Math.floor(x1 / GRID); i++) {
        for (let j = Math.floor(z0 / GRID); j <= Math.floor(z1 / GRID); j++) {
          const k = gridKey(i, j);
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          list.push(e.id);
        }
      }
    }
    this.computeTrims();

    const n = this.nodeIds.length;
    this.gScore = new Float64Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  // --- topology --------------------------------------------------------------

  edge(de: DirEdge): RoadEdge {
    return this.edges[edgeIdOf(de)];
  }

  fromNode(de: DirEdge): number {
    const e = this.edges[edgeIdOf(de)];
    return isForward(de) ? e.u : e.v;
  }

  toNode(de: DirEdge): number {
    const e = this.edges[edgeIdOf(de)];
    return isForward(de) ? e.v : e.u;
  }

  /** Directed edges a car may take out of `node`. */
  out(node: number): readonly DirEdge[] {
    return this.outgoing.get(node) ?? EMPTY;
  }

  /** Directed edges arriving at `node`. */
  in(node: number): readonly DirEdge[] {
    return this.incoming.get(node) ?? EMPTY;
  }

  /** Number of road edges meeting at `node`. */
  degree(node: number): number {
    return this.nodes.get(node)?.degree ?? 0;
  }

  // --- lanes -----------------------------------------------------------------

  /** Lanes in the direction of travel. */
  lanes(de: DirEdge): number {
    const e = this.edge(de);
    return e.oneway ? Math.max(1, e.lanes) : Math.max(1, Math.floor(e.lanes / 2));
  }

  laneWidth(de: DirEdge): number {
    const e = this.edge(de);
    if (e.oneway) return e.width / Math.max(1, e.lanes);
    return e.lanes <= 1 ? e.width / 2 : e.width / 2 / this.lanes(de);
  }

  /** Centre of `lane` (0 = kerb), metres right of the centreline in the direction of travel. */
  laneOffset(de: DirEdge, lane: number): number {
    const e = this.edge(de);
    const n = this.lanes(de);
    const l = Math.min(Math.max(0, lane), n - 1);
    const lw = this.laneWidth(de);
    if (e.oneway) return e.width / 2 - lw * (l + 0.5);
    // Single-lane two-way roads: keep right of the middle.
    if (e.lanes <= 1) return e.width / 4;
    return lw * (n - l - 0.5);
  }

  /** The kerb on the right of travel, metres from the centreline. */
  kerbOffset(de: DirEdge): number {
    return this.edge(de).width / 2;
  }

  /** Where the verge starts beyond the kerb (past the drains), metres from the centreline. */
  vergeOffset(de: DirEdge): number {
    const e = this.edge(de);
    return e.width / 2 + (e.drains ? DRAIN_ZONE : VERGE);
  }

  /** Nearest lane to a point. With a heading, picks the direction you'd be driving; else the side of the road. */
  nearestLane(x: number, z: number, reach = 8, headingX?: number, headingZ?: number): LaneHit | null {
    const hit = this.index.nearest(x, z, reach);
    if (!hit) return null;
    const e = hit.edge;
    // Right of u → v.
    const lat = (x - hit.x) * -hit.dz + (z - hit.z) * hit.dx;
    let forward = true;
    if (!e.oneway) {
      forward = headingX !== undefined && headingZ !== undefined ? hit.dx * headingX + hit.dz * headingZ >= 0 : lat >= 0;
    }
    const de = dirEdge(e.id, forward);
    const lateral = forward ? lat : -lat;
    let lane = 0;
    let best = Infinity;
    for (let i = 0; i < this.lanes(de); i++) {
      const d = Math.abs(this.laneOffset(de, i) - lateral);
      if (d < best) {
        best = d;
        lane = i;
      }
    }
    return { edge: e, dir: de, lane, s: forward ? hit.s : e.length - hit.s, lateral, x: hit.x, y: hit.y, z: hit.z, distance: hit.distance };
  }

  // --- geometry --------------------------------------------------------------

  /** Centreline of a directed edge, cached. */
  polyline(de: DirEdge): Polyline {
    let line = this.lines.get(de);
    if (line) return line;
    const e = this.edge(de);
    const src = isForward(de) ? e.polyline : [...e.polyline].reverse();
    const pts = new Float32Array(src.length * 3);
    const cum = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      pts[i * 3] = src[i][0];
      pts[i * 3 + 1] = src[i][1];
      pts[i * 3 + 2] = src[i][2];
      if (i > 0) cum[i] = cum[i - 1] + Math.hypot(src[i][0] - src[i - 1][0], src[i][2] - src[i - 1][2]);
    }
    line = { pts, cum, length: cum[cum.length - 1] };
    this.lines.set(de, line);
    return line;
  }

  /**
   * Lane centreline: the edge's polyline offset `laneOffset(de, lane)` to the
   * right, mitred at the bends. Interleaved x, y, z. Cached.
   */
  lanePolyline(de: DirEdge, lane: number): Float32Array {
    const key = de * 8 + Math.min(lane, 7);
    let pts = this.laneLines.get(key);
    if (!pts) {
      pts = offsetPolyline(this.polyline(de).pts, this.laneOffset(de, lane));
      this.laneLines.set(key, pts);
    }
    return pts;
  }

  /** Point, direction and grade at distance `s` along a directed edge's centreline (clamped). */
  sample(de: DirEdge, s: number, out: Sample): Sample {
    const { pts, cum } = this.polyline(de);
    return samplePolyline(pts, cum, s, out);
  }

  /** Road height at distance `s` from u along an edge (u → v), metres. */
  heightAt(edgeId: number, s: number): number {
    const { pts, cum } = this.polyline(dirEdge(edgeId, true));
    const n = cum.length;
    if (s <= 0) return pts[1];
    if (s >= cum[n - 1]) return pts[(n - 1) * 3 + 1];
    const i = findSegment(cum, s);
    const t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
    return pts[i * 3 + 1] + (pts[(i + 1) * 3 + 1] - pts[i * 3 + 1]) * t;
  }

  /** Unit xz heading leaving the start (`end` false) or arriving at the end of a directed edge. */
  heading(de: DirEdge, end: boolean, out: { x: number; z: number }): { x: number; z: number } {
    const { pts, cum } = this.polyline(de);
    const n = cum.length;
    // Look a few metres in, so a kink right at the node doesn't dominate.
    const probe = Math.min(6, cum[n - 1] * 0.5);
    const a = end ? cum[n - 1] - probe : 0;
    const b = end ? cum[n - 1] : probe;
    const pa = samplePolyline(pts, cum, a, tmpA);
    const ax = pa.x;
    const az = pa.z;
    const pb = samplePolyline(pts, cum, b, tmpB);
    const len = Math.hypot(pb.x - ax, pb.z - az) || 1;
    out.x = (pb.x - ax) / len;
    out.z = (pb.z - az) / len;
    return out;
  }

  /**
   * How far road ribbons pull back from a node for its junction patch (matches
   * the pipeline's _junction_trim). 0 where roads simply join.
   */
  junctionTrim(node: number): number {
    return this.trims.get(node) ?? 0;
  }

  /** Edge ids whose polylines come within about `radius` of (x, z). Fills and returns `out`. */
  edgesNear(x: number, z: number, radius: number, out: number[] = []): number[] {
    out.length = 0;
    const i0 = Math.floor((x - radius) / GRID);
    const i1 = Math.floor((x + radius) / GRID);
    const j0 = Math.floor((z - radius) / GRID);
    const j1 = Math.floor((z + radius) / GRID);
    const seen = seenScratch;
    seen.clear();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.grid.get(gridKey(i, j));
        if (!list) continue;
        for (const id of list) {
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(id);
        }
      }
    }
    return out;
  }

  /** Nearest node to (x, z) among nodes with at least `minDegree` edges. Linear scan: call rarely. */
  nearestNode(x: number, z: number, minDegree = 1): RoadNode | null {
    let best: RoadNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      if (n.degree < minDegree) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  // --- routing ---------------------------------------------------------------

  /**
   * A* shortest-time route from node `from` to node `to`, over directed edges
   * (one-way streets only u → v). Returns the directed edges in order, or null.
   */
  route(from: number, to: number, opts: RouteOptions = {}): DirEdge[] | null {
    const start = this.nodeIndex.get(from);
    const goal = this.nodeIndex.get(to);
    const target = this.nodes.get(to);
    if (start === undefined || goal === undefined || !target) return null;
    if (start === goal) return [];
    const cost = opts.cost;
    const maxExp = opts.maxExpansions ?? 20000;
    const gen = ++this.generation;
    const heap = heapScratch;
    heap.clear();
    const h = (idx: number) => {
      const n = this.nodes.get(this.nodeIds[idx])!;
      return Math.hypot(n.x - target.x, n.z - target.z) / HEURISTIC_SPEED;
    };
    this.stamp[start] = gen;
    this.gScore[start] = 0;
    this.came[start] = -1;
    heap.push(h(start), start);
    let expansions = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      if (cur === goal) return this.unwind(goal);
      if (++expansions > maxExp) return null;
      const g = this.gScore[cur];
      for (const de of this.out(this.nodeIds[cur])) {
        const e = this.edges[edgeIdOf(de)];
        const mult = cost ? cost(e, de) : 1;
        if (!(mult < Infinity)) continue;
        const next = this.nodeIndex.get(isForward(de) ? e.v : e.u)!;
        if (this.closed[next] === gen) continue;
        const ng = g + (e.length / Math.max(3, e.speedLimitKph / 3.6)) * mult;
        if (this.stamp[next] !== gen || ng < this.gScore[next]) {
          this.stamp[next] = gen;
          this.gScore[next] = ng;
          this.came[next] = de;
          heap.push(ng + h(next), next);
        }
      }
    }
    return null;
  }

  private unwind(goal: number): DirEdge[] {
    const path: DirEdge[] = [];
    let cur = goal;
    while (this.came[cur] !== -1) {
      const de = this.came[cur];
      path.push(de);
      cur = this.nodeIndex.get(this.fromNode(de))!;
    }
    return path.reverse();
  }

  private computeTrims(): void {
    const corridor = (e: RoadEdge) => e.width / 2 + (e.drains ? DRAIN_ZONE : VERGE);
    const h0 = { x: 0, z: 0 };
    const h1 = { x: 0, z: 0 };
    for (const [id, node] of this.nodes) {
      const touching = [...this.out(id), ...this.in(id)];
      const edgeIds = new Set(touching.map(edgeIdOf));
      if (node.degree >= 3) {
        let w = 0;
        for (const eid of edgeIds) w = Math.max(w, corridor(this.edges[eid]));
        this.trims.set(id, w * 1.1 + 0.5);
      } else if (node.degree === 2 && edgeIds.size === 2) {
        // A bend where two ways meet gets a patch too if it turns more than 20°.
        const [a, b] = [...edgeIds];
        const ea = this.edges[a];
        const eb = this.edges[b];
        this.heading(dirEdge(a, ea.u === id), false, h0);
        this.heading(dirEdge(b, eb.u === id), false, h1);
        const bend = (Math.acos(Math.max(-1, Math.min(1, -(h0.x * h1.x + h0.z * h1.z)))) * 180) / Math.PI;
        if (bend > 20) this.trims.set(id, Math.max(corridor(ea), corridor(eb)) * 1.1 + 0.5);
      }
    }
  }
}

const EMPTY: readonly DirEdge[] = [];
const seenScratch = new Set<number>();
const tmpA: Sample = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };
const tmpB: Sample = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };

/** Index i with cum[i] ≤ s < cum[i + 1] (binary search). */
export function findSegment(cum: ArrayLike<number>, s: number): number {
  let lo = 0;
  let hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** Point, unit xz direction and grade at distance s along interleaved xyz points with cumulative lengths `cum`. */
export function samplePolyline(pts: ArrayLike<number>, cum: ArrayLike<number>, s: number, out: Sample): Sample {
  const n = cum.length;
  const i = n < 2 ? 0 : findSegment(cum, Math.min(Math.max(s, 0), cum[n - 1]));
  const j = Math.min(i + 1, n - 1);
  const len = cum[j] - cum[i];
  const t = len > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / len)) : 0;
  const x0 = pts[i * 3], y0 = pts[i * 3 + 1], z0 = pts[i * 3 + 2];
  const x1 = pts[j * 3], y1 = pts[j * 3 + 1], z1 = pts[j * 3 + 2];
  out.x = x0 + (x1 - x0) * t;
  out.y = y0 + (y1 - y0) * t;
  out.z = z0 + (z1 - z0) * t;
  if (len > 0) {
    out.dx = (x1 - x0) / len;
    out.dz = (z1 - z0) / len;
    out.grade = (y1 - y0) / len;
  }
  return out;
}

/** Offsets interleaved xyz points `offset` metres to the right of travel (+X east, +Z south), mitred. */
export function offsetPolyline(pts: Float32Array, offset: number): Float32Array {
  const n = pts.length / 3;
  const out = new Float32Array(pts.length);
  for (let i = 0; i < n; i++) {
    const p = i > 0 ? i - 1 : i;
    const q = i < n - 1 ? i + 1 : i;
    // Unit directions of the segments either side of point i.
    let ax = pts[i * 3] - pts[p * 3];
    let az = pts[i * 3 + 2] - pts[p * 3 + 2];
    let bx = pts[q * 3] - pts[i * 3];
    let bz = pts[q * 3 + 2] - pts[i * 3 + 2];
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la > 1e-6) {
      ax /= la;
      az /= la;
    }
    if (lb > 1e-6) {
      bx /= lb;
      bz /= lb;
    }
    if (la <= 1e-6) {
      ax = bx;
      az = bz;
    }
    if (lb <= 1e-6) {
      bx = ax;
      bz = az;
    }
    // Right normals, then the miter (their bisector scaled so the offset stays `offset` from both segments).
    const nx = -az - bz;
    const nz = ax + bx;
    const nl = Math.hypot(nx, nz) || 1;
    const mx = nx / nl;
    const mz = nz / nl;
    const cos = mx * -az + mz * ax;
    const scale = Math.min(MITER_LIMIT, 1 / Math.max(cos, 1e-3));
    out[i * 3] = pts[i * 3] + mx * offset * scale;
    out[i * 3 + 1] = pts[i * 3 + 1];
    out[i * 3 + 2] = pts[i * 3 + 2] + mz * offset * scale;
  }
  return out;
}

/** Binary min-heap of (priority, value) pairs in flat arrays. */
class MinHeap {
  private pri: number[] = [];
  private val: number[] = [];

  get size(): number {
    return this.pri.length;
  }

  clear(): void {
    this.pri.length = 0;
    this.val.length = 0;
  }

  push(p: number, v: number): void {
    const pri = this.pri;
    const val = this.val;
    let i = pri.length;
    pri.push(p);
    val.push(v);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      pri[i] = pri[parent];
      val[i] = val[parent];
      i = parent;
    }
    pri[i] = p;
    val[i] = v;
  }

  pop(): number {
    const pri = this.pri;
    const val = this.val;
    const top = val[0];
    const lp = pri.pop()!;
    const lv = val.pop()!;
    const n = pri.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && pri[r] < pri[l] ? r : l;
        if (pri[m] >= lp) break;
        pri[i] = pri[m];
        val[i] = val[m];
        i = m;
      }
      pri[i] = lp;
      val[i] = lv;
    }
    return top;
  }
}

const heapScratch = new MinHeap();
