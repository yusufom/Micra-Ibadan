import { BufferAttribute, BufferGeometry, Color } from "three";
import { MICRA_LIVERY as C } from "@/game/config/livery";
import { MICRA_TUNING } from "@/game/config/micraTuning";
import { MICRA_DRIVER_SEAT, MICRA_SEATS } from "../micraSpec";

/**
 * Procedural early-90s Nissan Micra (K10/K11) five-door hatch, built from
 * vertex-coloured triangles so the whole car is a handful of draw calls.
 * Local frame: origin on the ground under the middle of the car, -Z is the
 * nose, +X the right side. About 3.66 m long, 1.56 m wide, 1.40 m tall.
 *
 * Layers (one BufferGeometry each, see MicraModel for the materials):
 * paint, trim (matte black and plastics), glass, lamps, brake (tail lights),
 * interior (dash, seats, people), wheel (one wheel, instanced four times).
 */

type V3 = [number, number, number];

const SUSP = MICRA_TUNING.suspension;
const TYRE = MICRA_TUNING.tyres;

/** Collects triangles with per-vertex colours. Indexed so smooth normals work. */
class Builder {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];
  private readonly c = new Color();

  get triangles(): number {
    return this.idx.length / 3;
  }

  vertex(p: V3, color: string): number {
    // Color.set() already converts the sRGB hex into the linear working space.
    this.c.set(color);
    this.pos.push(p[0], p[1], p[2]);
    this.col.push(this.c.r, this.c.g, this.c.b);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Quad a-b-c-d, counter-clockwise seen from its front. */
  quad(a: V3, b: V3, c: V3, d: V3, color: string): void {
    const i = this.vertex(a, color);
    this.vertex(b, color);
    this.vertex(c, color);
    this.vertex(d, color);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  /**
   * Hexahedron from 8 corners: bottom face 0-3 then top face 4-7, both
   * counter-clockwise seen from above. Flat-shaded (unshared vertices).
   */
  hexa(p: V3[], color: string): void {
    const faces = [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ];
    for (const [a, b, c, d] of faces) this.quad(p[a], p[b], p[c], p[d], color);
  }

  box(center: V3, size: V3, color: string): void {
    const [x, y, z] = center;
    const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
    this.hexa(
      [
        [x - hx, y - hy, z + hz],
        [x + hx, y - hy, z + hz],
        [x + hx, y - hy, z - hz],
        [x - hx, y - hy, z - hz],
        [x - hx, y + hy, z + hz],
        [x + hx, y + hy, z + hz],
        [x + hx, y + hy, z - hz],
        [x - hx, y + hy, z - hz],
      ],
      color,
    );
  }

  /** Square-section beam from a to b (limbs, spokes, pillars). */
  limb(a: V3, b: V3, width: number, depth: number, color: string): void {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const f = [d[0] / len, d[1] / len, d[2] / len];
    // Side axis: perpendicular to the beam, horizontal where possible.
    let s = [f[2], 0, -f[0]];
    let sl = Math.hypot(s[0], s[2]);
    if (sl < 1e-3) {
      s = [1, 0, 0];
      sl = 1;
    }
    s = [s[0] / sl, 0, s[2] / sl];
    const u = [f[1] * s[2] - f[2] * s[1], f[2] * s[0] - f[0] * s[2], f[0] * s[1] - f[1] * s[0]];
    const w = width / 2;
    const h = depth / 2;
    const corner = (p: V3, i: number, j: number): V3 => [p[0] + s[0] * w * i + u[0] * h * j, p[1] + s[1] * w * i + u[1] * h * j, p[2] + s[2] * w * i + u[2] * h * j];
    this.hexa([corner(a, -1, -1), corner(a, 1, -1), corner(a, 1, 1), corner(a, -1, 1), corner(b, -1, -1), corner(b, 1, -1), corner(b, 1, 1), corner(b, -1, 1)], color);
  }

  /** Closed loft through rings of equal length; caps both ends with fans. Smooth-shaded. */
  loft(rings: V3[][], color: (ring: number) => string): void {
    const n = rings[0].length;
    const base = this.pos.length / 3;
    rings.forEach((ring, r) => ring.forEach((p) => this.vertex(p, color(r))));
    for (let r = 0; r < rings.length - 1; r++) {
      for (let k = 0; k < n; k++) {
        const a = base + r * n + k;
        const b = base + r * n + ((k + 1) % n);
        const c = base + (r + 1) * n + ((k + 1) % n);
        const d = base + (r + 1) * n + k;
        this.idx.push(a, b, c, a, c, d);
      }
    }
    // End caps get their own vertices so they shade flat.
    for (const r of [0, rings.length - 1]) {
      const first = this.pos.length / 3;
      rings[r].forEach((p) => this.vertex(p, color(r)));
      for (let k = 1; k < n - 1; k++) this.idx.push(first, first + k, first + k + 1);
    }
  }

  /**
   * Grid over a bilinear patch (corners at t,v = 00, 10, 11, 01), with an
   * optional inward displacement `dent(t, v)` along `inward`.
   */
  grid(p00: V3, p10: V3, p11: V3, p01: V3, nt: number, nv: number, color: (t: number, v: number) => string, dent?: (t: number, v: number) => number, inward: V3 = [0, 0, 0]): void {
    const base = this.pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nt; i++) {
        const t = i / nt;
        const v = j / nv;
        const bottom = lerp3(p00, p10, t);
        const top = lerp3(p01, p11, t);
        const p = lerp3(bottom, top, v);
        const d = dent ? dent(t, v) : 0;
        this.vertex([p[0] + inward[0] * d, p[1] + inward[1] * d, p[2] + inward[2] * d], color(t, v));
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nt; i++) {
        const a = base + j * (nt + 1) + i;
        this.idx.push(a, a + 1, a + nt + 2, a, a + nt + 2, a + nt + 1);
      }
    }
  }

  /** Bilinear patch split at tBreaks × vBreaks, skipping the cells in `holes` ("ti,vi"). */
  panelWithHoles(p00: V3, p10: V3, p11: V3, p01: V3, tBreaks: number[], vBreaks: number[], holes: Set<string>, color: string): void {
    const at = (t: number, v: number) => lerp3(lerp3(p00, p10, t), lerp3(p01, p11, t), v);
    for (let i = 0; i < tBreaks.length - 1; i++) {
      for (let j = 0; j < vBreaks.length - 1; j++) {
        if (holes.has(`${i},${j}`)) continue;
        const [t0, t1, v0, v1] = [tBreaks[i], tBreaks[i + 1], vBreaks[j], vBreaks[j + 1]];
        this.quad(at(t0, v0), at(t1, v0), at(t1, v1), at(t0, v1), color);
      }
    }
  }

  /** Disc facing +normalAxis sign along x, y or z. */
  disc(center: V3, radius: number, segments: number, axis: 0 | 1 | 2, color: string): void {
    const c = this.vertex(center, color);
    const first = this.pos.length / 3;
    for (let k = 0; k < segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      const p: V3 = [...center];
      const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
      p[i] += Math.cos(a) * radius;
      p[j] += Math.sin(a) * radius;
      this.vertex(p, color);
    }
    for (let k = 0; k < segments; k++) this.tri(c, first + k, first + ((k + 1) % segments));
  }

  /** Cylinder along X (wheels), optionally without caps. */
  cylinderX(cx: number, radius: number, width: number, segments: number, color: string, caps = true): void {
    const x0 = cx - width / 2;
    const x1 = cx + width / 2;
    const base = this.pos.length / 3;
    for (let k = 0; k < segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      const y = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      this.vertex([x0, y, z], color);
      this.vertex([x1, y, z], color);
    }
    for (let k = 0; k < segments; k++) {
      const a = base + k * 2;
      const b = base + ((k + 1) % segments) * 2;
      this.idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
    if (caps) {
      this.disc([x0, 0, 0], radius, segments, 0, color);
      this.disc([x1, 0, 0], radius, segments, 0, color);
    }
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("color", new BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ---------------------------------------------------------------------------
// Body dimensions.

/** Half width of the body sides and of the (inset) door-area shell behind the door skins. */
const HW = 0.78;
const HW_DOOR = 0.74;
const BELT = 0.905;
/** Door openings, z along the car. */
const DOOR_FRONT = -0.79;
const DOOR_SPLIT = 0.15;
const DOOR_REAR = 0.745;
const DOOR_BOTTOM = 0.3;
const SIDE_X = HW + 0.002;

/** Glasshouse rings: bottom (beltline), shoulder, roof top. */
const GH = [
  { y: BELT, hw: 0.745, zf: -0.8, zr: 1.76 },
  { y: 1.33, hw: 0.63, zf: -0.22, zr: 1.64 },
  { y: 1.4, hw: 0.55, zf: -0.12, zr: 1.58 },
];

/** Arch-shaped sill height around each axle. */
function sillAt(z: number): number {
  for (const axle of [SUSP.frontAxleZ, SUSP.rearAxleZ]) {
    const d = Math.abs(z - axle);
    if (d < 0.38) return Math.max(0.24, TYRE.radius + Math.sqrt(0.38 * 0.38 - d * d));
  }
  return 0.24;
}

/** Lower body stations: z, bottom, top (bonnet / beltline), half width. */
function lowerStations(): [number, number, number, number][] {
  const s: [number, number, number, number][] = [
    [-1.83, 0.26, 0.66, 0.7],
    [-1.79, 0.23, 0.72, 0.76],
    [-1.62, 0.23, 0.77, HW],
  ];
  const bonnet = (z: number) => lerp(0.79, 0.9, (z + 1.54) / (1.54 - 0.8));
  for (const z of [-1.54, -1.46, -1.34, -1.16, -0.98, -0.86]) s.push([z, sillAt(z), bonnet(z), HW]);
  s.push([-0.8, 0.24, BELT, HW]);
  // Door area: inset shell behind the door skins.
  s.push([DOOR_FRONT + 0.02, 0.24, BELT, HW_DOOR], [DOOR_REAR - 0.02, 0.24, BELT, HW_DOOR]);
  s.push([DOOR_REAR + 0.01, 0.24, BELT + 0.01, HW]);
  for (const z of [0.84, 1.0, 1.14, 1.28, 1.44]) s.push([z, sillAt(z), BELT + 0.02, HW]);
  s.push([1.52, 0.26, BELT + 0.01, HW], [1.74, 0.26, BELT, 0.77], [1.83, 0.3, 0.87, 0.72]);
  return s;
}

function ring(yb: number, yt: number, hw: number, z: number): V3[] {
  const half: [number, number][] = [
    [hw * 0.93, yb],
    [hw, yb + 0.06],
    [hw, yt - 0.1],
    [hw * 0.96, yt - 0.03],
    [hw * 0.86, yt],
  ];
  const right = half.map(([x, y]): V3 => [x, y, z]);
  const left = [...half].reverse().map(([x, y]): V3 => [-x, y, z]);
  return [...right, ...left];
}

/** Point on a glasshouse side (+1 right, -1 left) at t (front→rear) and v (belt→shoulder). */
function sidePoint(side: number, t: number, v: number): V3 {
  const [b, u] = GH;
  const bottom: V3 = [side * b.hw, b.y, lerp(b.zf, b.zr, t)];
  const top: V3 = [side * u.hw, u.y, lerp(u.zf, u.zr, t)];
  return lerp3(bottom, top, v);
}

/** Front (windscreen, end 0) or rear (hatch, end 1) face point, t across left→right, v up. */
function endPoint(end: 0 | 1, t: number, v: number): V3 {
  const [b, u] = GH;
  const bz = end === 0 ? b.zf : b.zr;
  const uz = end === 0 ? u.zf : u.zr;
  const bottom: V3 = [lerp(-b.hw, b.hw, t), b.y, bz];
  const top: V3 = [lerp(-u.hw, u.hw, t), u.y, uz];
  return lerp3(bottom, top, v);
}

/** Side window openings as [t0, t1] along the glasshouse side, and the v range. */
export const SIDE_WINDOWS: [number, number][] = [
  [0.035, 0.4],
  [0.445, 0.76],
];
const WINDOW_V: [number, number] = [0.08, 0.9];
const SCREEN = { t: [0.06, 0.94], v: [0.07, 0.93] };
const HATCH = { t: [0.1, 0.9], v: [0.12, 0.9] };

// ---------------------------------------------------------------------------

export type Quad = [V3, V3, V3, V3];

export type MicraGeometry = {
  paint: BufferGeometry;
  trim: BufferGeometry;
  glass: BufferGeometry;
  lamps: BufferGeometry;
  brake: BufferGeometry;
  interior: BufferGeometry;
  wheel: BufferGeometry;
  /** Surfaces for textured decals, corners bottom-left, bottom-right, top-right, top-left as seen from outside. */
  decals: { doorLeft: Quad; doorRight: Quad; plateFront: Quad; plateRear: Quad; sticker: Quad; mirror: Quad };
  /** Pivots for moving parts. */
  pivots: { wheels: V3[]; steeringWheel: V3; steeringTilt: number; speedo: V3 };
  triangles: number;
};

function buildPaint(): Builder {
  const b = new Builder();

  // Lower body.
  const stations = lowerStations();
  b.loft(
    stations.map(([z, yb, yt, hw]) => ring(yb, yt, hw, z)),
    () => C.body,
  );

  // Glasshouse: cream pillars and roof with real window openings.
  const [, g1, g2] = GH;
  for (const side of [1, -1]) {
    const tBreaks = [0, SIDE_WINDOWS[0][0], SIDE_WINDOWS[0][1], SIDE_WINDOWS[1][0], SIDE_WINDOWS[1][1], 1];
    const vBreaks = [0, WINDOW_V[0], WINDOW_V[1], 1];
    const p00 = sidePoint(side, 0, 0);
    const p10 = sidePoint(side, 1, 0);
    const p11 = sidePoint(side, 1, 1);
    const p01 = sidePoint(side, 0, 1);
    b.panelWithHoles(p00, p10, p11, p01, tBreaks, vBreaks, new Set(["1,1", "3,1"]), C.roof);
  }
  for (const end of [0, 1] as const) {
    const w = end === 0 ? SCREEN : HATCH;
    b.panelWithHoles(endPoint(end, 0, 0), endPoint(end, 1, 0), endPoint(end, 1, 1), endPoint(end, 0, 1), [0, w.t[0], w.t[1], 1], [0, w.v[0], w.v[1], 1], new Set(["1,1"]), C.roof);
  }
  // Roof: sloped rim between shoulder and top ring, then the flat top.
  const corners = (r: typeof g1): V3[] => [
    [-r.hw, r.y, r.zf],
    [r.hw, r.y, r.zf],
    [r.hw, r.y, r.zr],
    [-r.hw, r.y, r.zr],
  ];
  const lo = corners(g1);
  const hi = corners(g2);
  for (let k = 0; k < 4; k++) b.quad(lo[k], lo[(k + 1) % 4], hi[(k + 1) % 4], hi[k], C.roof);
  b.quad(hi[0], hi[1], hi[2], hi[3], C.roof);

  // Door skins. Front-right door has the dent; rear-left is the unpainted replacement.
  const doors: { side: number; z0: number; z1: number; color: string; dented?: boolean }[] = [
    { side: -1, z0: DOOR_FRONT, z1: DOOR_SPLIT, color: C.body },
    { side: -1, z0: DOOR_SPLIT, z1: DOOR_REAR, color: C.mismatchedPanel },
    { side: 1, z0: DOOR_FRONT, z1: DOOR_SPLIT, color: C.body, dented: true },
    { side: 1, z0: DOOR_SPLIT, z1: DOOR_REAR, color: C.body },
  ];
  for (const d of doors) {
    const x = d.side * SIDE_X;
    const top = BELT - 0.004;
    // Seen from outside, t runs front→rear on the right side and rear→front on the left.
    const [za, zb] = d.side > 0 ? [d.z1, d.z0] : [d.z0, d.z1];
    const p00: V3 = [x, DOOR_BOTTOM, za];
    const p10: V3 = [x, DOOR_BOTTOM, zb];
    const p11: V3 = [x, top, zb];
    const p01: V3 = [x, top, za];
    if (d.dented) {
      // Dent low on the door's leading half: a soft bowl with a crease through it, paint scuffed grey.
      const dent = (t: number, v: number) => {
        const z = lerp(za, zb, t);
        const y = lerp(DOOR_BOTTOM, top, v);
        const r2 = ((z + 0.5) / 0.17) ** 2 + ((y - 0.47) / 0.11) ** 2;
        const crease = Math.exp(-(((y - 0.47 - (z + 0.5) * 0.25) / 0.025) ** 2)) * Math.exp(-(((z + 0.5) / 0.26) ** 2));
        return 0.034 * Math.exp(-r2) + 0.012 * crease;
      };
      const scuff = (t: number, v: number) => (dent(t, v) > 0.012 ? "#6d4a4f" : d.color);
      b.grid(p00, p10, p11, p01, 12, 8, scuff, dent, [-1, 0, 0]);
    } else {
      b.quad(p00, p10, p11, p01, d.color);
    }
  }

  return b;
}

function buildTrim(): Builder {
  const b = new Builder();
  const black = C.trim;

  for (const side of [1, -1]) {
    const x = side * (SIDE_X + 0.002);
    const face = (z0: number, z1: number, y0: number, y1: number, color: string, out = 0) => {
      const xx = x + side * out;
      const [a, c] = side > 0 ? [z1, z0] : [z0, z1];
      b.quad([xx, y0, a], [xx, y0, c], [xx, y1, c], [xx, y1, a], color);
    };
    // Shut lines.
    for (const z of [DOOR_FRONT, DOOR_SPLIT, DOOR_REAR]) face(z - 0.006, z + 0.006, DOOR_BOTTOM, BELT, "#0c0c0c");
    // Rub strip, sill and door handles.
    const rub = (z0: number, z1: number) => b.box([side * (SIDE_X + 0.01), 0.56, (z0 + z1) / 2], [0.025, 0.055, z1 - z0], black);
    rub(DOOR_FRONT + 0.01, DOOR_SPLIT - 0.01);
    rub(DOOR_SPLIT + 0.01, DOOR_REAR - 0.01);
    face(DOOR_FRONT - 0.01, DOOR_REAR + 0.01, 0.22, DOOR_BOTTOM, black);
    face(DOOR_SPLIT - 0.2, DOOR_SPLIT - 0.08, 0.8, 0.83, black, 0.006);
    face(DOOR_REAR - 0.2, DOOR_REAR - 0.08, 0.8, 0.83, black, 0.006);
    // Wing mirror on a stalk.
    b.box([side * 0.84, 0.97, -0.72], [0.12, 0.1, 0.06], black);
    b.limb([side * 0.76, 0.93, -0.7], [side * 0.8, 0.96, -0.71], 0.03, 0.03, black);
    // Window rubbers along the beltline.
    b.box([side * (GH[0].hw + 0.006), BELT + 0.01, (GH[0].zf + GH[0].zr) / 2], [0.02, 0.02, GH[0].zr - GH[0].zf - 0.1], black);
  }

  // Bumpers: plain black, the rear one taller.
  b.box([0, 0.31, -1.84], [1.6, 0.2, 0.13], C.bumper);
  b.box([0, 0.34, 1.84], [1.58, 0.22, 0.13], C.bumper);
  // Grille between the headlamps.
  b.quad([-0.44, 0.47, -1.836], [0.44, 0.47, -1.836], [0.44, 0.62, -1.836], [-0.44, 0.62, -1.836], "#101010");
  // Underbody and arch liners: dark shape visible through the arches.
  b.box([0, 0.36, 0], [1.28, 0.3, 3.4], "#0b0b0b");
  // Wipers resting on the scuttle.
  b.limb([-0.6, 0.93, -0.83], [-0.05, 0.94, -0.8], 0.02, 0.015, black);
  b.limb([0.05, 0.93, -0.83], [0.58, 0.94, -0.8], 0.02, 0.015, black);
  // Hatch handle and exhaust.
  b.box([0, 0.85, 1.8], [0.2, 0.03, 0.02], black);
  b.limb([0.45, 0.2, 1.7], [0.45, 0.2, 1.93], 0.05, 0.05, "#2b2b2b");
  return b;
}

function buildGlass(): Builder {
  const b = new Builder();
  for (const side of [1, -1]) {
    for (const [t0, t1] of SIDE_WINDOWS) {
      const [v0, v1] = WINDOW_V;
      b.quad(sidePoint(side, t0, v0), sidePoint(side, t1, v0), sidePoint(side, t1, v1), sidePoint(side, t0, v1), C.glass);
    }
  }
  for (const [end, w] of [[0, SCREEN], [1, HATCH]] as const) {
    b.quad(endPoint(end, w.t[0], w.v[0]), endPoint(end, w.t[1], w.v[0]), endPoint(end, w.t[1], w.v[1]), endPoint(end, w.t[0], w.v[1]), C.glass);
  }
  return b;
}

function buildLamps(): Builder {
  const b = new Builder();
  const z = -1.837;
  for (const s of [1, -1]) {
    // Rectangular headlamps and amber corner indicators.
    const [x0, x1] = s > 0 ? [0.46, 0.66] : [-0.66, -0.46];
    b.quad([x0, 0.5, z], [x1, 0.5, z], [x1, 0.64, z], [x0, 0.64, z], C.headLight);
    const [i0, i1] = s > 0 ? [0.66, 0.72] : [-0.72, -0.66];
    b.quad([i0, 0.5, z + 0.01], [i1, 0.5, z + 0.01], [i1, 0.62, z + 0.03], [i0, 0.62, z + 0.03], C.indicator);
  }
  return b;
}

function buildBrake(): Builder {
  const b = new Builder();
  const z = 1.84;
  for (const s of [1, -1]) {
    // Tall tail lamps in the rear corners, seen from behind (right side is -X).
    const [x0, x1] = s > 0 ? [0.7, 0.5] : [-0.5, -0.7];
    b.quad([x0, 0.52, z], [x1, 0.52, z], [x1, 0.84, z - 0.02], [x0, 0.84, z - 0.02], C.tailLight);
  }
  return b;
}

const SKINS = ["#5a3825", "#6b4329", "#4a2e1f", "#7a4e32", "#3f271a", "#62402a"];
const SHIRTS = ["#b8322a", "#2e6fa8", "#d9a91b", "#1e8a73", "#7d3d8f", "#c75a1a"];
const TROUSERS = ["#2c2f38", "#3b3226", "#1f2a3a", "#4a4a4a", "#2d3a2a", "#3a2a2a"];

/** Seated person facing -Z with hips at `hip`. `hands` puts the forearms on a steering wheel. */
function addPerson(b: Builder, hip: V3, variant: number, hands?: { left: V3; right: V3 }): void {
  const [x, y, z] = hip;
  const skin = SKINS[variant % SKINS.length];
  const shirt = SHIRTS[variant % SHIRTS.length];
  const trousers = TROUSERS[variant % TROUSERS.length];
  // Thighs and shins.
  for (const s of [-1, 1]) {
    const kx = x + s * 0.09;
    b.limb([kx, y + 0.02, z + 0.02], [kx, y + 0.06, z - 0.4], 0.14, 0.13, trousers);
    b.limb([kx, y + 0.05, z - 0.4], [kx, y - 0.25, z - 0.5], 0.11, 0.11, trousers);
  }
  // Torso leaning back a little.
  b.limb([x, y + 0.02, z + 0.04], [x, y + 0.47, z + 0.1], 0.36, 0.2, shirt);
  // Arms: to the wheel for the driver, onto the lap for passengers.
  for (const s of [-1, 1]) {
    const shoulder: V3 = [x + s * 0.2, y + 0.43, z + 0.08];
    const hand = hands ? (s < 0 ? hands.left : hands.right) : ([x + s * 0.13, y + 0.1, z - 0.22] as V3);
    const elbow: V3 = hands ? lerp3(shoulder, hand, 0.5) : [x + s * 0.22, y + 0.2, z + 0.02];
    if (hands) elbow[1] -= 0.08;
    b.limb(shoulder, elbow, 0.09, 0.09, shirt);
    b.limb(elbow, hand, 0.07, 0.07, skin);
  }
  // Neck and head (a low-poly octahedron-ish block), with a cap or gele on some.
  b.limb([x, y + 0.47, z + 0.09], [x, y + 0.55, z + 0.08], 0.08, 0.08, skin);
  const hy = y + 0.63;
  const hz = z + 0.06;
  b.hexa(
    [
      [x - 0.08, hy - 0.1, hz + 0.09],
      [x + 0.08, hy - 0.1, hz + 0.09],
      [x + 0.08, hy - 0.1, hz - 0.09],
      [x - 0.08, hy - 0.1, hz - 0.09],
      [x - 0.09, hy + 0.08, hz + 0.1],
      [x + 0.09, hy + 0.08, hz + 0.1],
      [x + 0.09, hy + 0.08, hz - 0.09],
      [x - 0.09, hy + 0.08, hz - 0.09],
    ],
    skin,
  );
  if (variant % 3 === 1) b.box([x, hy + 0.12, hz], [0.22, 0.08, 0.22], SHIRTS[(variant + 2) % SHIRTS.length]);
  else if (variant % 3 === 2) b.box([x, hy + 0.1, hz], [0.19, 0.04, 0.2], "#121212");
}

/** Seats with covers, dash, steering wheel, mirror, and whoever is on board. */
function buildInterior(passengers: number, showDriver: boolean, luggageBags: number) {
  const b = new Builder();
  const cover = C.seatCover;
  const band = C.seatCoverBand;

  // Floor and parcel shelf.
  b.box([0, 0.3, 0.3], [1.44, 0.04, 2.3], C.interior);
  b.box([0, 0.9, 1.5], [1.4, 0.03, 0.5], C.interior);

  // Dashboard, binnacle and gauges.
  b.hexa(
    [
      [-0.73, 0.7, -0.56],
      [0.73, 0.7, -0.56],
      [0.73, 0.7, -0.84],
      [-0.73, 0.7, -0.84],
      [-0.73, 0.96, -0.6],
      [0.73, 0.96, -0.6],
      [0.73, 0.92, -0.86],
      [-0.73, 0.92, -0.86],
    ],
    C.dashboard,
  );
  const dx = MICRA_DRIVER_SEAT[0];
  b.box([dx, 0.99, -0.64], [0.36, 0.07, 0.14], C.dashboard);
  b.disc([dx - 0.08, 0.955, -0.598], 0.045, 10, 2, "#d8d4c8");
  b.disc([dx + 0.08, 0.955, -0.598], 0.045, 10, 2, "#d8d4c8");
  // Radio slot and a sticker-plastered glovebox.
  b.quad([-0.1, 0.8, -0.555], [0.1, 0.8, -0.555], [0.1, 0.86, -0.555], [-0.1, 0.86, -0.555], "#0a0a0a");
  b.quad([0.25, 0.74, -0.555], [0.62, 0.74, -0.555], [0.62, 0.86, -0.555], [0.25, 0.86, -0.555], "#27231f");

  // Steering column and wheel.
  const wheelAt: V3 = [dx, 0.9, -0.47];
  const tilt = -0.45;
  b.limb([dx, 0.76, -0.66], [dx, 0.88, -0.5], 0.06, 0.06, "#151515");

  // Seats: front buckets with covers and headrests, rear bench.
  for (const sx of [dx, -dx]) {
    b.box([sx, 0.44, 0.02], [0.5, 0.14, 0.5], cover);
    b.limb([sx, 0.5, 0.27], [sx, 0.72, 0.31], 0.5, 0.1, cover);
    b.limb([sx, 0.72, 0.31], [sx, 0.82, 0.33], 0.5, 0.1, band);
    b.limb([sx, 0.82, 0.33], [sx, 1.06, 0.38], 0.5, 0.1, cover);
    b.box([sx, 1.13, 0.39], [0.26, 0.13, 0.08], cover);
  }
  b.box([0, 0.43, 0.7], [1.34, 0.14, 0.5], cover);
  b.limb([0, 0.5, 0.96], [0, 0.72, 1.0], 1.34, 0.1, cover);
  b.limb([0, 0.72, 1.0], [0, 0.82, 1.02], 1.34, 0.1, band);
  b.limb([0, 0.82, 1.02], [0, 1.04, 1.07], 1.34, 0.1, cover);

  // Luggage: Ghana-must-go bags in the hatch.
  for (let i = 0; i < luggageBags; i++) {
    const colors = ["#3f6fb4", "#b43f3f", "#3f9a6a"];
    b.box([-0.4 + i * 0.4, 0.62 + (i % 2) * 0.05, 1.45], [0.36, 0.28, 0.34], colors[i % colors.length]);
  }

  // People.
  const hands = {
    left: [wheelAt[0] - 0.17, wheelAt[1] + 0.02, wheelAt[2] + 0.02] as V3,
    right: [wheelAt[0] + 0.17, wheelAt[1] + 0.02, wheelAt[2] + 0.02] as V3,
  };
  if (showDriver) addPerson(b, [...MICRA_DRIVER_SEAT] as V3, 5, hands);
  for (let i = 0; i < passengers; i++) addPerson(b, [...MICRA_SEATS[i].at] as V3, i);

  return { builder: b, wheelAt, tilt };
}

/** Steering wheel as its own small geometry (it turns). Centred at the origin, in the XY plane. */
export function buildSteeringWheel(): BufferGeometry {
  const b = new Builder();
  const n = 12;
  const r = 0.18;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    b.limb([Math.cos(a0) * r, Math.sin(a0) * r, 0], [Math.cos(a1) * r, Math.sin(a1) * r, 0], 0.03, 0.03, "#141414");
  }
  b.limb([-r, 0, 0], [r, 0, 0], 0.035, 0.02, "#1c1c1c");
  b.limb([0, 0, 0], [0, -r, 0], 0.035, 0.02, "#1c1c1c");
  b.box([0, 0, 0.01], [0.09, 0.07, 0.04], "#222");
  return b.build();
}

/** Speedo needle: thin quad pointing up from the origin, facing +Z. */
export function buildNeedle(): BufferGeometry {
  const b = new Builder();
  b.quad([-0.003, 0, 0], [0.003, 0, 0], [0.002, 0.038, 0], [-0.002, 0.038, 0], "#e0501c");
  return b.build();
}

/** One wheel centred at the origin, axle along X, rim face on +X. */
function buildWheel(): Builder {
  const b = new Builder();
  const r = TYRE.radius;
  const w = TYRE.width;
  b.cylinderX(0, r, w, 16, "#161616");
  // Black steel wheel with slots, set in from the sidewall.
  b.disc([w / 2 + 0.002, 0, 0], r * 0.64, 12, 0, C.wheel);
  b.disc([w / 2 + 0.004, 0, 0], r * 0.2, 8, 0, C.rim);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const cy = Math.cos(a) * r * 0.42;
    const cz = Math.sin(a) * r * 0.42;
    const x = w / 2 + 0.004;
    b.quad([x, cy - 0.02, cz - 0.02], [x, cy - 0.02, cz + 0.02], [x, cy + 0.02, cz + 0.02], [x, cy + 0.02, cz - 0.02], "#050505");
  }
  return b;
}

/** Hard points for wheel pivots; the wheel centre sits below by the suspension length. */
export function wheelHardPoints(): V3[] {
  const s = SUSP;
  return [0, 1, 2, 3].map((i): V3 => [i % 2 === 0 ? -s.halfTrack : s.halfTrack, s.hardPointY, i < 2 ? s.frontAxleZ : s.rearAxleZ]);
}

export function buildMicraGeometry(opts: { passengers: number; showDriver: boolean; luggageKg: number }): MicraGeometry {
  const paint = buildPaint();
  const trim = buildTrim();
  const glass = buildGlass();
  const lamps = buildLamps();
  const brake = buildBrake();
  const bags = Math.min(3, Math.ceil(opts.luggageKg / 25));
  const interior = buildInterior(opts.passengers, opts.showDriver, bags);
  const wheel = buildWheel();

  // Decal surfaces.
  const doorDecal = (side: number): Quad => {
    const x = side * (SIDE_X + 0.004);
    const [za, zb] = side > 0 ? [DOOR_SPLIT - 0.08, DOOR_FRONT + 0.1] : [DOOR_FRONT + 0.1, DOOR_SPLIT - 0.08];
    return [
      [x, 0.6, za],
      [x, 0.6, zb],
      [x, 0.87, zb],
      [x, 0.87, za],
    ];
  };
  const plate = (z: number, y: number, facing: number): Quad => {
    // Seen from the front the plate's left edge is at +X; from behind, at -X.
    const [a, c] = facing < 0 ? [0.23, -0.23] : [-0.23, 0.23];
    return [
      [a, y - 0.055, z],
      [c, y - 0.055, z],
      [c, y + 0.055, z],
      [a, y + 0.055, z],
    ];
  };
  // Sticker across the top of the hatch glass, just outside it.
  const out = 0.004;
  const hatchPt = (t: number, v: number): V3 => {
    const p = endPoint(1, t, v);
    return [p[0], p[1] + out * 0.27, p[2] + out];
  };
  const sticker: Quad = [hatchPt(0.28, 0.7), hatchPt(0.72, 0.7), hatchPt(0.72, 0.84), hatchPt(0.28, 0.84)];
  const mirror: Quad = [
    [-0.12, 1.235, -0.17],
    [0.12, 1.235, -0.19],
    [0.12, 1.295, -0.19],
    [-0.12, 1.295, -0.17],
  ];
  interior.builder.box([0, 1.265, -0.19], [0.27, 0.08, 0.025], "#111");
  interior.builder.limb([0, 1.3, -0.2], [0, 1.37, -0.22], 0.02, 0.02, "#111");

  const parts = [paint, trim, glass, lamps, brake, interior.builder];
  const steering = buildSteeringWheel();
  // Plus six decal quads and the speedo needle.
  const triangles = parts.reduce((n, p) => n + p.triangles, 0) + wheel.triangles * 4 + steering.index!.count / 3 + 6 * 2 + 2;
  steering.dispose();

  return {
    paint: paint.build(),
    trim: trim.build(),
    glass: glass.build(),
    lamps: lamps.build(),
    brake: brake.build(),
    interior: interior.builder.build(),
    wheel: wheel.build(),
    decals: { doorLeft: doorDecal(-1), doorRight: doorDecal(1), plateFront: plate(-1.908, 0.31, -1), plateRear: plate(1.908, 0.36, 1), sticker, mirror },
    pivots: { wheels: wheelHardPoints(), steeringWheel: interior.wheelAt, steeringTilt: interior.tilt, speedo: [MICRA_DRIVER_SEAT[0] - 0.08, 0.955, -0.594] },
    triangles,
  };
}

