import { type DirEdge, type RoadGraph, type Sample, samplePolyline } from "@/game/world/RoadGraph";

/**
 * The road ahead of (and a little behind) one AI vehicle: a chain of pieces
 * along lane polylines, joined through junctions by Bézier turns. Distances
 * are "path s", which only ever grows while the vehicle lives.
 *
 * Edge pieces follow `graph.lanePolyline(de, lane)`, trimmed back from each
 * junction by its patch radius. Turn pieces run from the end of one lane to
 * the start of the next. A vehicle's lateral state (`dl`) is its offset from
 * the piece line, so swerves and overtakes don't touch the geometry.
 */

export const PIECE_EDGE = 0;
export const PIECE_TURN = 1;

export type Piece = {
  kind: typeof PIECE_EDGE | typeof PIECE_TURN;
  /** Edge: the directed edge. Turn: the arriving one. */
  de: DirEdge;
  /** Turn: the leaving directed edge; -1 on edges. */
  next: DirEdge;
  /** Turn: the junction node; -1 on edges. */
  node: number;
  lane: number;
  /** Interleaved x, y, z and cumulative horizontal length. */
  pts: Float32Array;
  cum: Float32Array;
  length: number;
  /** Path s at the piece start. */
  s0: number;
  /** Edge: centreline distance along `de` at the piece start and end. */
  edgeS0: number;
  edgeS1: number;
  /** Turn: bend radius (m) for the speed through it; Infinity on edges. */
  radius: number;
  /** Turn: signed heading change, rad (+ = right turn, - = left). */
  turn: number;
};

export type PathSample = Sample & { piece: Piece };

/** Always keep at least this much edge before a junction, and never trim below this. */
const MIN_TRIM = 1.5;
const TURN_STEPS = 8;

export class LanePath {
  readonly pieces: Piece[] = [];
  private cursor = 0;

  get end(): number {
    const last = this.pieces[this.pieces.length - 1];
    return last ? last.s0 + last.length : 0;
  }

  get last(): Piece | undefined {
    return this.pieces[this.pieces.length - 1];
  }

  clear(): void {
    this.pieces.length = 0;
    this.cursor = 0;
  }

  append(p: Piece): void {
    p.s0 = this.end;
    this.pieces.push(p);
  }

  /** Piece containing path s (clamped to the ends). */
  pieceAt(s: number): Piece {
    const ps = this.pieces;
    let i = Math.min(this.cursor, ps.length - 1);
    while (i > 0 && s < ps[i].s0) i--;
    while (i < ps.length - 1 && s >= ps[i].s0 + ps[i].length) i++;
    this.cursor = i;
    return ps[i];
  }

  /** Point, direction and grade at path s, offset `lateral` metres to the right. */
  sample(s: number, lateral: number, out: PathSample): PathSample {
    const p = this.pieceAt(s);
    samplePolyline(p.pts, p.cum, s - p.s0, out);
    out.x += -out.dz * lateral;
    out.z += out.dx * lateral;
    out.piece = p;
    return out;
  }

  /** Drop pieces that end before path s. */
  dropBefore(s: number): void {
    let n = 0;
    while (n < this.pieces.length - 1 && this.pieces[n].s0 + this.pieces[n].length < s) n++;
    if (n > 0) {
      this.pieces.splice(0, n);
      this.cursor = Math.max(0, this.cursor - n);
    }
  }

  /** Path s of a point `edgeS` along directed edge `de`, if an upcoming edge piece covers it. */
  pathSOnEdge(de: DirEdge, edgeS: number, from: number): number | null {
    for (const p of this.pieces) {
      if (p.kind !== PIECE_EDGE || p.de !== de || p.s0 + p.length < from) continue;
      if (edgeS < p.edgeS0 - 0.5 || edgeS > p.edgeS1 + 0.5) continue;
      const k = p.edgeS1 > p.edgeS0 ? p.length / (p.edgeS1 - p.edgeS0) : 1;
      return p.s0 + (edgeS - p.edgeS0) * k;
    }
    return null;
  }
}

/** How far the lane pulls back from `node` on an edge of length `len` with trim `other` at its far end. */
export function trimFor(graph: RoadGraph, node: number, len: number, other: number): number {
  const t = Math.max(graph.junctionTrim(node), MIN_TRIM);
  const sum = t + Math.max(other, MIN_TRIM);
  return sum > len * 0.8 ? (t * len * 0.8) / sum : t;
}

/** Edge piece along `de`'s lane from centreline distance a to b. */
export function edgePiece(graph: RoadGraph, de: DirEdge, lane: number, a: number, b: number): Piece {
  const line = graph.polyline(de);
  const lanePts = graph.lanePolyline(de, lane);
  const cum = line.cum;
  const n = cum.length;
  a = Math.max(0, Math.min(a, line.length));
  b = Math.max(a, Math.min(b, line.length));
  // Lane points share the centreline's parametrisation: slice by centreline distance.
  const out: number[] = [];
  const push = (s: number) => {
    let i = 0;
    while (i < n - 2 && cum[i + 1] <= s) i++;
    const len = cum[i + 1] - cum[i];
    const t = len > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / len)) : 0;
    for (let k = 0; k < 3; k++) out.push(lanePts[i * 3 + k] + (lanePts[(i + 1) * 3 + k] - lanePts[i * 3 + k]) * t);
  };
  push(a);
  for (let i = 0; i < n; i++) if (cum[i] > a + 0.05 && cum[i] < b - 0.05) for (let k = 0; k < 3; k++) out.push(lanePts[i * 3 + k]);
  push(b);
  return makePiece(PIECE_EDGE, de, -1, -1, lane, out, a, b, Infinity, 0);
}

/** Turn from the end of `from` (an edge piece) into the start of `to` (the next edge piece) through `node`. */
export function turnPiece(from: Piece, to: Piece, node: number): Piece {
  const a = from.pts;
  const na = a.length / 3;
  const p0x = a[(na - 1) * 3], p0y = a[(na - 1) * 3 + 1], p0z = a[(na - 1) * 3 + 2];
  const b = to.pts;
  const p3x = b[0], p3y = b[1], p3z = b[2];
  const t0 = endDir(a, true);
  const t3 = endDir(b, false);
  const chord = Math.hypot(p3x - p0x, p3z - p0z);
  const cos = Math.max(-1, Math.min(1, t0.x * t3.x + t0.z * t3.z));
  const angle = Math.acos(cos);
  // Right turn when the new heading is clockwise of the old (seen from above, +Z south).
  const cross = t0.x * t3.z - t0.z * t3.x;
  const turn = cross >= 0 ? angle : -angle;
  // U-turns need longer handles to swing round.
  const h = Math.max(0.3, chord * (angle > 2.5 ? 0.9 : 0.42));
  const p1x = p0x + t0.x * h, p1z = p0z + t0.z * h;
  const p2x = p3x - t3.x * h, p2z = p3z - t3.z * h;
  const pts: number[] = [];
  for (let i = 0; i <= TURN_STEPS; i++) {
    const t = i / TURN_STEPS;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    pts.push(w0 * p0x + w1 * p1x + w2 * p2x + w3 * p3x, p0y + (p3y - p0y) * (t * t * (3 - 2 * t)), w0 * p0z + w1 * p1z + w2 * p2z + w3 * p3z);
  }
  const piece = makePiece(PIECE_TURN, from.de, to.de, node, to.lane, pts, 0, 0, Infinity, turn);
  piece.radius = angle > 0.05 ? Math.max(2.5, piece.length / angle) : Infinity;
  return piece;
}

function endDir(pts: Float32Array, atEnd: boolean): { x: number; z: number } {
  const n = pts.length / 3;
  // Walk in until the step is long enough to trust.
  const i = atEnd ? n - 1 : 0;
  let j = atEnd ? n - 2 : 1;
  while (j > 0 && j < n - 1 && Math.hypot(pts[i * 3] - pts[j * 3], pts[i * 3 + 2] - pts[j * 3 + 2]) < 0.5) j += atEnd ? -1 : 1;
  if (j < 0 || j >= n) j = atEnd ? 0 : n - 1;
  let x = atEnd ? pts[i * 3] - pts[j * 3] : pts[j * 3] - pts[i * 3];
  let z = atEnd ? pts[i * 3 + 2] - pts[j * 3 + 2] : pts[j * 3 + 2] - pts[i * 3 + 2];
  const l = Math.hypot(x, z) || 1;
  x /= l;
  z /= l;
  if (i === j) return { x: 0, z: -1 };
  return { x, z };
}

function makePiece(kind: Piece["kind"], de: DirEdge, next: DirEdge, node: number, lane: number, flat: number[], edgeS0: number, edgeS1: number, radius: number, turn: number): Piece {
  const pts = new Float32Array(flat);
  const n = pts.length / 3;
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 3] - pts[(i - 1) * 3], pts[i * 3 + 2] - pts[(i - 1) * 3 + 2]);
  return { kind, de, next, node, lane, pts, cum, length: cum[n - 1], s0: 0, edgeS0, edgeS1, radius, turn };
}
