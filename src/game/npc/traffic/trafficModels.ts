import { BufferAttribute, BufferGeometry, Color } from "three";
import { MICRA_LIVERY as L } from "@/game/config/livery";
import type { TrafficVehicleKind } from "@/game/core/events";
import { MICRA_DRIVER_SEAT, MICRA_SEATS } from "@/game/vehicles/micraSpec";

/**
 * Low-poly procedural traffic, built from flat-shaded, vertex-coloured boxes
 * so every vehicle type is a handful of instanced draw calls. Local frame as
 * the player's Micra: origin on the ground under the middle, -Z the nose, +X
 * the right side.
 *
 * Each model has three layers:
 * - body: paint and fixed parts in one geometry. A per-vertex `tint` (1 on
 *   paint, 0 on glass, tyres, bumpers and loads) says how much the instance
 *   colour applies, so one draw gives every vehicle its own paint (the rival
 *   Micras keep their livery and only fade a little)
 * - head / tail: lamps, drawn unlit and scaled by the instance colour so they
 *   can glow at night or when braking
 */

type V3 = [number, number, number];

export type Layers = { body: BufferGeometry; head: BufferGeometry; tail: BufferGeometry };

export type VehicleModel = {
  body: Layers;
  /** Articulated trucks: the trailer, origin at its middle, posed separately. */
  trailer?: Layers;
  /** Hip points for the people drawn aboard: driver first, then passengers. */
  seats: V3[];
  /** Triangles in all layers. */
  triangles: number;
};

class Builder {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly c = new Color();

  get triangles(): number {
    return this.pos.length / 9;
  }

  /** Triangle a-b-c, flipped if needed so its front faces away from `inside`. */
  tri(a: V3, b: V3, c: V3, color: string, inside: V3): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const out = nx * (a[0] - inside[0]) + ny * (a[1] - inside[1]) + nz * (a[2] - inside[2]);
    const order = out >= 0 ? [a, b, c] : [a, c, b];
    this.c.set(color);
    for (const p of order) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(this.c.r, this.c.g, this.c.b);
    }
  }

  quad(a: V3, b: V3, c: V3, d: V3, color: string, inside: V3): void {
    this.tri(a, b, c, color, inside);
    this.tri(a, c, d, color, inside);
  }

  /** Hexahedron: bottom corners 0-3 then top 4-7, same winding. */
  hexa(p: V3[], color: string): void {
    const inside: V3 = [0, 0, 0];
    for (const q of p) for (let k = 0; k < 3; k++) inside[k] += q[k] / 8;
    const faces = [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ];
    for (const [a, b, c, d] of faces) this.quad(p[a], p[b], p[c], p[d], color, inside);
  }

  box(center: V3, size: V3, color: string): void {
    const [x, y, z] = center;
    const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
    this.hexa(
      [
        [x - hx, y - hy, z + hz], [x + hx, y - hy, z + hz], [x + hx, y - hy, z - hz], [x - hx, y - hy, z - hz],
        [x - hx, y + hy, z + hz], [x + hx, y + hy, z + hz], [x + hx, y + hy, z - hz], [x - hx, y + hy, z - hz],
      ],
      color,
    );
  }

  /**
   * Body section from z0 (front) to z1 (rear): bottom at y0, top rising from
   * yf at the front to yr at the rear, half widths at the bottom and top.
   */
  section(z0: number, z1: number, y0: number, yf: number, yr: number, hwBottom: number, hwTop: number, color: string): void {
    this.hexa(
      [
        [-hwBottom, y0, z1], [hwBottom, y0, z1], [hwBottom, y0, z0], [-hwBottom, y0, z0],
        [-hwTop, yr, z1], [hwTop, yr, z1], [hwTop, yf, z0], [-hwTop, yf, z0],
      ],
      color,
    );
  }

  /** Glasshouse / cab: bottom rectangle (z0..z1 at y0, half width hw0) to top (z2..z3 at y1, half width hw1). */
  cabin(y0: number, z0: number, z1: number, hw0: number, y1: number, z2: number, z3: number, hw1: number, color: string): void {
    this.hexa(
      [
        [-hw0, y0, z1], [hw0, y0, z1], [hw0, y0, z0], [-hw0, y0, z0],
        [-hw1, y1, z3], [hw1, y1, z3], [hw1, y1, z2], [-hw1, y1, z2],
      ],
      color,
    );
  }

  /** Square-section beam from a to b. */
  limb(a: V3, b: V3, width: number, color: string): void {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const f = [d[0] / len, d[1] / len, d[2] / len];
    let s = [f[2], 0, -f[0]];
    let sl = Math.hypot(s[0], s[2]);
    if (sl < 1e-3) {
      s = [1, 0, 0];
      sl = 1;
    }
    s = [s[0] / sl, 0, s[2] / sl];
    const u = [f[1] * s[2] - f[2] * s[1], f[2] * s[0] - f[0] * s[2], f[0] * s[1] - f[1] * s[0]];
    const w = width / 2;
    const c = (p: V3, i: number, j: number): V3 => [p[0] + (s[0] * i + u[0] * j) * w, p[1] + (s[1] * i + u[1] * j) * w, p[2] + (s[2] * i + u[2] * j) * w];
    this.hexa([c(a, -1, -1), c(a, 1, -1), c(a, 1, 1), c(a, -1, 1), c(b, -1, -1), c(b, 1, -1), c(b, 1, 1), c(b, -1, 1)], color);
  }

  /** Wheel: a short cylinder along X centred at (x, y, z). */
  wheel(x: number, y: number, z: number, r: number, w: number, color = "#141414", hub = "#3a3a3a", sides = 10): void {
    const ring = (xx: number, rr: number): V3[] =>
      Array.from({ length: sides }, (_, k) => [xx, y + Math.cos((k / sides) * Math.PI * 2) * rr, z + Math.sin((k / sides) * Math.PI * 2) * rr] as V3);
    const a = ring(x - w / 2, r);
    const b = ring(x + w / 2, r);
    const inside: V3 = [x, y, z];
    for (let k = 0; k < sides; k++) {
      const n = (k + 1) % sides;
      this.quad(a[k], b[k], b[n], a[n], color, inside);
      this.tri([x - w / 2, y, z], a[k], a[n], color, [x + w, y, z]);
      this.tri([x + w / 2, y, z], b[n], b[k], hub, [x - w, y, z]);
    }
  }

  /** Flat panel (lamp, window) facing along `normal` (unit axis), centred at c with size (u, v). */
  panel(c: V3, normal: V3, su: number, sv: number, color: string): void {
    const [nx, , nz] = normal;
    // Panels on the front/back faces span x and y; on the sides, z and y.
    const ux: V3 = Math.abs(nz) > 0.5 ? [su / 2, 0, 0] : [0, 0, su / 2];
    if (Math.abs(nx) < 0.5 && Math.abs(nz) < 0.5) ux[0] = su / 2;
    const vy: V3 = Math.abs(normal[1]) > 0.5 ? [0, 0, sv / 2] : [0, sv / 2, 0];
    const p = (i: number, j: number): V3 => [c[0] + ux[0] * i + vy[0] * j, c[1] + ux[1] * i + vy[1] * j, c[2] + ux[2] * i + vy[2] * j];
    const inside: V3 = [c[0] - normal[0], c[1] - normal[1], c[2] - normal[2]];
    this.quad(p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), color, inside);
  }

  /** `tint`: how much the instance colour applies to these triangles (0–1). */
  build(tint = 1): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("color", new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute("tint", new BufferAttribute(new Float32Array(this.pos.length / 3).fill(tint), 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

type Parts = { paint: Builder; fixed: Builder; head: Builder; tail: Builder };
const parts = (): Parts => ({ paint: new Builder(), fixed: new Builder(), head: new Builder(), tail: new Builder() });
const build = (p: Parts): Layers => ({ body: tinted(p.paint, p.fixed), head: p.head.build(), tail: p.tail.build() });

/** One geometry from a tinted builder and an untinted one. */
function tinted(paint: Builder, fixed: Builder): BufferGeometry {
  const a = paint.build(1);
  const b = fixed.build(0);
  const g = new BufferGeometry();
  for (const name of ["position", "normal", "color", "tint"]) {
    const x = a.getAttribute(name) as BufferAttribute;
    const y = b.getAttribute(name) as BufferAttribute;
    const data = new Float32Array(x.array.length + y.array.length);
    data.set(x.array as Float32Array, 0);
    data.set(y.array as Float32Array, x.array.length);
    g.setAttribute(name, new BufferAttribute(data, x.itemSize));
  }
  a.dispose();
  b.dispose();
  g.computeBoundingSphere();
  return g;
}
const count = (p: Parts) => p.paint.triangles + p.fixed.triangles + p.head.triangles + p.tail.triangles;

const WHITE = "#ffffff";
const GLASS = "#1b232b";
const BLACK = "#141414";
const CHROME = "#9a9c9e";
const HEAD = "#fff4d8";
const TAIL = "#ff2a1a";

/** Head and tail lamps as pairs at the given x, height and ends. */
function lamps(p: Parts, x: number, y: number, zf: number, zr: number, w = 0.2, h = 0.12): void {
  for (const s of [-1, 1]) {
    p.head.panel([s * x, y, zf - 0.005], [0, 0, -1], w, h, HEAD);
    p.tail.panel([s * x, y, zr + 0.005], [0, 0, 1], w * 0.8, h * 1.2, TAIL);
  }
}

// --- vehicles ----------------------------------------------------------------

function micra(): VehicleModel {
  const p = parts();
  const paint = p.paint;
  // Livery straight from the player's car; the instance colour only fades it.
  paint.section(-1.83, -0.75, 0.3, 0.72, 0.9, 0.78, 0.77, L.body);
  paint.section(-0.75, 1.83, 0.3, 0.9, 0.9, 0.78, 0.77, L.body);
  p.fixed.cabin(0.9, -0.75, 1.72, 0.74, 1.37, -0.1, 1.6, 0.64, GLASS);
  paint.cabin(1.37, -0.12, 1.62, 0.655, 1.42, -0.05, 1.56, 0.62, L.roof);
  for (const s of [-1, 1]) {
    paint.limb([s * 0.73, 0.9, -0.74], [s * 0.64, 1.38, -0.1], 0.07, L.roof);
    paint.limb([s * 0.745, 0.9, 0.56], [s * 0.65, 1.38, 0.6], 0.09, L.roof);
    paint.limb([s * 0.745, 0.9, 1.7], [s * 0.645, 1.38, 1.57], 0.11, L.roof);
    p.fixed.box([s * 0.79, 0.56, 0.1], [0.03, 0.06, 2.4], L.trim);
  }
  p.fixed.box([0, 0.32, -1.85], [1.6, 0.2, 0.12], L.bumper);
  p.fixed.box([0, 0.34, 1.85], [1.58, 0.22, 0.12], L.bumper);
  for (const [x, z] of [[-0.68, -1.18], [0.68, -1.18], [-0.68, 1.12], [0.68, 1.12]]) p.fixed.wheel(x, 0.28, z, 0.28, 0.18, BLACK, L.wheel);
  lamps(p, 0.56, 0.57, -1.84, 1.84, 0.22, 0.14);
  const seats: V3[] = [[...MICRA_DRIVER_SEAT] as V3, ...MICRA_SEATS.map((s) => [...s.at] as V3)];
  return { body: build(p), seats, triangles: count(p) };
}

function sedan(): VehicleModel {
  const p = parts();
  p.paint.section(-2.3, -1.0, 0.32, 0.78, 0.9, 0.89, 0.86, WHITE);
  p.paint.section(-1.0, 1.25, 0.32, 0.9, 0.9, 0.89, 0.87, WHITE);
  p.paint.section(1.25, 2.3, 0.32, 0.92, 0.86, 0.89, 0.86, WHITE);
  p.fixed.cabin(0.9, -1.0, 1.25, 0.84, 1.44, -0.3, 0.72, 0.7, GLASS);
  p.paint.cabin(1.43, -0.32, 0.74, 0.715, 1.46, -0.28, 0.7, 0.69, WHITE);
  for (const s of [-1, 1]) p.paint.limb([s * 0.84, 0.9, 1.22], [s * 0.7, 1.44, 0.72], 0.12, WHITE);
  p.fixed.box([0, 0.45, -2.31], [0.9, 0.16, 0.04], "#101010");
  p.fixed.box([0, 0.36, -2.3], [1.76, 0.14, 0.1], "#262626");
  p.fixed.box([0, 0.38, 2.3], [1.76, 0.14, 0.1], "#262626");
  for (const [x, z] of [[-0.77, -1.38], [0.77, -1.38], [-0.77, 1.38], [0.77, 1.38]]) p.fixed.wheel(x, 0.31, z, 0.31, 0.2, BLACK, CHROME);
  lamps(p, 0.62, 0.66, -2.31, 2.31, 0.28, 0.12);
  return { body: build(p), seats: [[-0.38, 0.5, -0.1], [0.38, 0.5, -0.1], [-0.38, 0.5, 0.75]], triangles: count(p) };
}

function suv(): VehicleModel {
  const p = parts();
  p.paint.section(-2.35, -1.2, 0.42, 0.95, 1.08, 0.92, 0.9, WHITE);
  p.paint.section(-1.2, 2.35, 0.42, 1.08, 1.08, 0.92, 0.9, WHITE);
  p.fixed.cabin(1.08, -1.2, 2.3, 0.88, 1.72, -0.55, 2.2, 0.8, GLASS);
  p.paint.cabin(1.71, -0.57, 2.22, 0.815, 1.76, -0.5, 2.18, 0.79, WHITE);
  for (const s of [-1, 1]) {
    p.paint.limb([s * 0.88, 1.08, 0.5], [s * 0.8, 1.72, 0.5], 0.12, WHITE);
    p.paint.limb([s * 0.88, 1.08, 2.28], [s * 0.8, 1.72, 2.18], 0.14, WHITE);
  }
  p.fixed.box([0, 0.5, -2.36], [1.8, 0.2, 0.1], "#262626");
  p.fixed.box([0, 0.5, 2.36], [1.8, 0.2, 0.1], "#262626");
  for (const [x, z] of [[-0.8, -1.45], [0.8, -1.45], [-0.8, 1.45], [0.8, 1.45]]) p.fixed.wheel(x, 0.37, z, 0.37, 0.24, BLACK, CHROME);
  lamps(p, 0.66, 0.85, -2.36, 2.36, 0.3, 0.14);
  return { body: build(p), seats: [[-0.4, 0.66, -0.25], [0.4, 0.66, -0.25], [-0.4, 0.66, 0.65]], triangles: count(p) };
}

function peugeot(v: number): VehicleModel {
  const p = parts();
  const w = v === 0 ? 0.84 : 0.87;
  // 504: long drooping bonnet and boot; 505: squarer.
  p.paint.section(-2.24, -0.85, 0.32, v === 0 ? 0.74 : 0.8, 0.9, w, w - 0.03, WHITE);
  p.paint.section(-0.85, 1.05, 0.32, 0.9, 0.9, w, w - 0.02, WHITE);
  p.paint.section(1.05, 2.24, 0.32, 0.9, v === 0 ? 0.8 : 0.88, w, w - 0.03, WHITE);
  p.fixed.cabin(0.9, -0.85, 1.05, w - 0.04, 1.42, -0.32, 0.72, w - 0.16, GLASS);
  p.paint.cabin(1.41, -0.34, 0.74, w - 0.15, 1.45, -0.3, 0.7, w - 0.17, WHITE);
  for (const s of [-1, 1]) p.paint.limb([s * (w - 0.04), 0.9, 1.02], [s * (w - 0.16), 1.42, 0.72], 0.1, WHITE);
  p.fixed.box([0, 0.36, -2.25], [1.7, 0.12, 0.08], CHROME);
  p.fixed.box([0, 0.38, 2.25], [1.7, 0.12, 0.08], CHROME);
  p.fixed.box([0, 0.62, -2.25], [0.7, 0.14, 0.03], "#101010");
  if (v === 0) {
    // Roof rack with a load of bags and a spare.
    p.fixed.box([0, 1.5, 0.2], [1.3, 0.04, 1.2], "#2a2a2a");
    p.fixed.box([-0.3, 1.66, 0.1], [0.55, 0.28, 0.5], "#3f6fb4");
    p.fixed.box([0.3, 1.64, 0.35], [0.5, 0.24, 0.6], "#b43f3f");
  }
  for (const [x, z] of [[-0.72, -1.37], [0.72, -1.37], [-0.72, 1.37], [0.72, 1.37]]) p.fixed.wheel(x, 0.3, z, 0.3, 0.19, BLACK, CHROME);
  lamps(p, 0.58, 0.62, -2.25, 2.25, v === 0 ? 0.26 : 0.34, 0.14);
  return { body: build(p), seats: [[-0.36, 0.5, -0.05], [0.36, 0.5, -0.05], [-0.36, 0.5, 0.8], [0.36, 0.5, 0.8]], triangles: count(p) };
}

function bus(): VehicleModel {
  const p = parts();
  p.paint.section(-2.5, 2.5, 0.35, 1.2, 1.2, 0.95, 0.95, WHITE);
  p.paint.cabin(1.2, -2.5, 2.5, 0.95, 2.15, -2.05, 2.5, 0.92, WHITE);
  // Window band (a hair outside the body) and the windscreen.
  for (const s of [-1, 1]) p.fixed.box([s * 0.94, 1.6, 0.35], [0.03, 0.55, 3.9], GLASS);
  p.fixed.cabin(1.25, -2.52, -2.35, 0.9, 1.95, -2.12, -2.0, 0.88, GLASS);
  p.fixed.box([0, 1.55, 2.51], [1.6, 0.5, 0.02], GLASS);
  p.fixed.box([0, 2.2, 0.3], [1.5, 0.08, 3.2], "#2b2b2b");
  p.fixed.box([0, 0.4, -2.52], [1.84, 0.2, 0.1], "#1f1f1f");
  p.fixed.box([0, 0.4, 2.52], [1.84, 0.2, 0.1], "#1f1f1f");
  for (const [x, z] of [[-0.82, -1.62], [0.82, -1.62], [-0.82, 1.35], [0.82, 1.35]]) p.fixed.wheel(x, 0.33, z, 0.33, 0.22, BLACK, "#c8c8c8");
  lamps(p, 0.7, 0.85, -2.52, 2.52, 0.22, 0.16);
  return { body: build(p), seats: [[-0.45, 0.72, -1.55]], triangles: count(p) };
}

function keke(): VehicleModel {
  const p = parts();
  // Front cowl narrowing to the nose, open cab, rear tub.
  p.paint.hexa(
    [
      [-0.62, 0.28, -0.7], [0.62, 0.28, -0.7], [0.3, 0.28, -1.32], [-0.3, 0.28, -1.32],
      [-0.62, 1.05, -0.7], [0.62, 1.05, -0.7], [0.25, 0.85, -1.3], [-0.25, 0.85, -1.3],
    ],
    WHITE,
  );
  p.paint.section(-0.7, 1.32, 0.28, 0.72, 0.8, 0.64, 0.64, WHITE);
  p.fixed.box([0, 0.25, 0.3], [1.2, 0.08, 2.0], "#1c1c1c");
  p.fixed.cabin(1.05, -0.72, -0.68, 0.58, 1.55, -0.95, -0.9, 0.56, GLASS);
  p.fixed.cabin(1.66, -1.02, 1.3, 0.66, 1.76, -0.95, 1.25, 0.64, "#1e3a26");
  for (const [x, z] of [[-0.6, -0.9], [0.6, -0.9], [-0.62, 1.28], [0.62, 1.28]]) p.fixed.limb([x, 0.8, z], [x, 1.68, z], 0.05, "#111");
  p.fixed.limb([-0.4, 1.05, -0.62], [0.4, 1.05, -0.62], 0.04, "#111");
  p.fixed.wheel(0, 0.2, -1.02, 0.2, 0.12);
  p.fixed.wheel(-0.58, 0.2, 0.9, 0.2, 0.12);
  p.fixed.wheel(0.58, 0.2, 0.9, 0.2, 0.12);
  p.head.panel([0, 0.78, -1.33], [0, 0, -1], 0.16, 0.1, HEAD);
  for (const s of [-1, 1]) p.tail.panel([s * 0.5, 0.7, 1.325], [0, 0, 1], 0.1, 0.1, TAIL);
  return {
    body: build(p),
    seats: [[0, 0.62, -0.45], [-0.36, 0.64, 0.55], [0.36, 0.64, 0.55], [0, 0.66, 0.6], [0.34, 0.6, -0.35]],
    triangles: count(p),
  };
}

function okada(): VehicleModel {
  const p = parts();
  p.paint.hexa(
    [
      [-0.14, 0.72, -0.2], [0.14, 0.72, -0.2], [0.13, 0.72, -0.62], [-0.13, 0.72, -0.62],
      [-0.12, 0.9, -0.22], [0.12, 0.9, -0.22], [0.11, 0.86, -0.6], [-0.11, 0.86, -0.6],
    ],
    WHITE,
  );
  p.paint.box([0, 0.66, 0.55], [0.2, 0.12, 0.5], WHITE);
  p.fixed.box([0, 0.82, 0.3], [0.26, 0.1, 0.9], "#161616");
  p.fixed.box([0, 0.45, -0.1], [0.24, 0.3, 0.45], "#4a4a4a");
  p.fixed.limb([0, 0.3, -0.72], [0, 1.02, -0.58], 0.05, CHROME);
  p.fixed.limb([-0.36, 1.05, -0.56], [0.36, 1.05, -0.56], 0.03, "#111");
  p.fixed.limb([0, 0.3, 0.72], [0, 0.55, 0.1], 0.05, "#222");
  p.fixed.wheel(0, 0.3, -0.72, 0.3, 0.09);
  p.fixed.wheel(0, 0.3, 0.72, 0.3, 0.1);
  p.head.panel([0, 0.95, -0.68], [0, 0, -1], 0.14, 0.12, HEAD);
  p.tail.panel([0, 0.74, 0.82], [0, 0, 1], 0.1, 0.06, TAIL);
  return { body: build(p), seats: [[0, 0.86, 0.02], [0, 0.9, 0.42], [0, 0.94, 0.74]], triangles: count(p) };
}

/** Truck cab (paint) and chassis from zf (front of the cab). */
function truckCab(p: Parts, zf: number, cabLen: number, chassisEnd: number): void {
  const zc = zf + cabLen;
  p.paint.cabin(0.95, zf, zc, 1.24, 3.05, zf + 0.25, zc, 1.2, WHITE);
  p.fixed.cabin(2.0, zf - 0.005, zf + 0.2, 1.1, 2.85, zf + 0.22, zf + 0.26, 1.08, GLASS);
  for (const s of [-1, 1]) p.fixed.box([s * 1.23, 2.35, zf + 0.75], [0.02, 0.6, 0.8], GLASS);
  p.fixed.box([0, 0.75, (zf + chassisEnd) / 2], [1.0, 0.35, chassisEnd - zf - 0.2], "#1d1d1d");
  p.fixed.box([0, 0.72, zf - 0.02], [2.4, 0.35, 0.18], "#2a2a2a");
  for (const s of [-1, 1]) {
    p.head.panel([s * 0.9, 0.95, zf - 0.12], [0, 0, -1], 0.28, 0.16, HEAD);
  }
}

function truck(v: number): VehicleModel {
  const p = parts();
  truckCab(p, -4.25, 1.7, 4.25);
  if (v === 0) {
    // Tipper with a load of laterite.
    p.fixed.box([0, 1.1, 0.95], [2.46, 0.2, 6.5], "#4d3b2a");
    for (const s of [-1, 1]) p.fixed.box([s * 1.2, 1.85, 0.95], [0.06, 1.3, 6.5], "#7a5a3a");
    p.fixed.box([0, 1.85, 4.18], [2.46, 1.3, 0.06], "#7a5a3a");
    p.fixed.box([0, 1.85, -2.28], [2.46, 1.3, 0.06], "#7a5a3a");
    p.fixed.box([0, 2.2, 0.95], [2.34, 0.4, 6.35], "#a3542c");
  } else {
    // Fuel tanker.
    const sides = 8;
    const r = 1.1;
    const pts: V3[][] = [-2.3, 4.2].map((z) => Array.from({ length: sides }, (_, k) => [Math.cos((k / sides) * Math.PI * 2 + Math.PI / 8) * r * 1.1, 2.1 + Math.sin((k / sides) * Math.PI * 2 + Math.PI / 8) * r, z] as V3));
    for (let k = 0; k < sides; k++) {
      const n = (k + 1) % sides;
      p.fixed.quad(pts[0][k], pts[1][k], pts[1][n], pts[0][n], "#c9ccce", [0, 2.1, 1]);
      p.fixed.tri([0, 2.1, -2.3], pts[0][k], pts[0][n], "#b4b7b9", [0, 2.1, 1]);
      p.fixed.tri([0, 2.1, 4.2], pts[1][n], pts[1][k], "#b4b7b9", [0, 2.1, 1]);
    }
  }
  for (const s of [-1, 1]) {
    p.fixed.wheel(s * 1.02, 0.5, -3.3, 0.5, 0.34);
    p.fixed.wheel(s * 1.02, 0.5, 2.1, 0.5, 0.5);
    p.fixed.wheel(s * 1.02, 0.5, 3.3, 0.5, 0.5);
    p.tail.panel([s * 1.05, 0.95, 4.26], [0, 0, 1], 0.2, 0.14, TAIL);
  }
  return { body: build(p), seats: [[-0.55, 1.9, -3.6]], triangles: count(p) };
}

function articulated(): VehicleModel {
  const t = parts();
  truckCab(t, -3.1, 1.9, 3.1);
  t.fixed.box([0, 1.2, 1.9], [1.2, 0.12, 1.0], "#2a2a2a");
  for (const s of [-1, 1]) {
    t.fixed.wheel(s * 1.02, 0.52, -2.1, 0.52, 0.34);
    t.fixed.wheel(s * 1.02, 0.52, 1.5, 0.52, 0.5);
    t.fixed.wheel(s * 1.02, 0.52, 2.65, 0.52, 0.5);
  }
  // Trailer: a 40-ft container on a skeletal chassis. Paint is the container.
  const tr = parts();
  tr.paint.box([0, 2.62, 0], [2.44, 2.6, 12.2], WHITE);
  for (let z = -5.8; z <= 5.8; z += 0.6) for (const s of [-1, 1]) tr.paint.box([s * 1.225, 2.62, z], [0.02, 2.5, 0.12], "#d0d0d0");
  tr.fixed.box([0, 1.2, 0], [1.1, 0.25, 12.4], "#1b1b1b");
  for (const s of [-1, 1]) {
    for (const z of [3.9, 5.1]) tr.fixed.wheel(s * 1.02, 0.52, z, 0.52, 0.5);
    tr.fixed.box([s * 1.1, 0.9, -1.5], [0.06, 0.6, 0.06], "#333");
    tr.tail.panel([s * 1.05, 1.0, 6.26], [0, 0, 1], 0.22, 0.14, TAIL);
  }
  return { body: build(t), trailer: build(tr), seats: [[-0.55, 1.95, -2.5]], triangles: count(t) + count(tr) };
}

const MODEL_BUILDERS: Record<TrafficVehicleKind, ((variant: number) => VehicleModel)[]> = {
  micra: [micra],
  car: [sedan, suv],
  peugeot: [() => peugeot(0), () => peugeot(1)],
  keke: [keke],
  okada: [okada],
  bus: [bus],
  truck: [() => truck(0), () => truck(1)],
  trailer: [articulated],
};

/** Every model variant for a vehicle type. */
export function buildVehicleModels(kind: TrafficVehicleKind): VehicleModel[] {
  return MODEL_BUILDERS[kind].map((f, i) => f(i));
}

// --- people and street furniture -----------------------------------------------------

/** A person: clothes tinted per instance, skin and trousers not. */
export type PersonModel = { body: BufferGeometry };

const SKIN = "#553522";
const TROUSERS = "#2a2b30";

/** Seated rider or passenger, hips at the origin, facing -Z. Clothes are white (tinted per instance). */
export function buildSeatedPerson(): PersonModel {
  const clothes = new Builder();
  const skin = new Builder();
  for (const s of [-1, 1]) {
    const kx = s * 0.09;
    skin.limb([kx, 0.02, 0.02], [kx, 0.06, -0.4], 0.14, TROUSERS);
    skin.limb([kx, 0.05, -0.4], [kx, -0.3, -0.48], 0.11, TROUSERS);
    clothes.limb([s * 0.2, 0.43, 0.08], [s * 0.2, 0.2, -0.12], 0.09, WHITE);
    skin.limb([s * 0.2, 0.2, -0.12], [s * 0.18, 0.25, -0.38], 0.07, SKIN);
  }
  clothes.limb([0, 0.02, 0.04], [0, 0.47, 0.08], 0.36, WHITE);
  skin.limb([0, 0.47, 0.08], [0, 0.55, 0.07], 0.08, SKIN);
  skin.box([0, 0.64, 0.05], [0.17, 0.2, 0.19], SKIN);
  return { body: tinted(clothes, skin) };
}

export type StandingModel = PersonModel & { arm: BufferGeometry; shoulder: V3 };

/** Standing person, feet at the origin, facing -Z. The right arm is separate so it can wave (pivot at `shoulder`, hanging down -Y). */
export function buildStandingPerson(): StandingModel {
  const clothes = new Builder();
  const skin = new Builder();
  for (const s of [-1, 1]) skin.limb([s * 0.1, 0, 0], [s * 0.1, 0.85, 0], 0.13, TROUSERS);
  clothes.limb([0, 0.82, 0], [0, 1.42, 0], 0.4, WHITE);
  clothes.limb([-0.24, 1.38, 0], [-0.26, 0.9, 0.02], 0.09, WHITE);
  skin.limb([-0.26, 0.9, 0.02], [-0.26, 0.78, 0.02], 0.07, SKIN);
  skin.limb([0, 1.42, 0], [0, 1.5, 0], 0.09, SKIN);
  skin.box([0, 1.6, 0], [0.18, 0.21, 0.2], SKIN);
  const armSleeve = new Builder();
  const arm = new Builder();
  armSleeve.limb([0, 0, 0], [0, -0.32, 0], 0.09, WHITE);
  arm.limb([0, -0.32, 0], [0, -0.58, 0], 0.07, SKIN);
  return { body: tinted(clothes, skin), arm: tinted(armSleeve, arm), shoulder: [0.25, 1.38, 0] };
}

export type SignalModel = { fixed: BufferGeometry; red: BufferGeometry; amber: BufferGeometry; green: BufferGeometry };

/** Traffic light on a pole, lamps facing -Z (towards the traffic it controls). */
export function buildSignal(): SignalModel {
  const fixed = new Builder();
  fixed.limb([0, 0, 0], [0, 3.3, 0], 0.12, "#5d6166");
  fixed.box([0, 2.85, -0.1], [0.34, 0.95, 0.22], "#151515");
  const lamp = (y: number, color: string) => {
    const b = new Builder();
    b.panel([0, y, -0.215], [0, 0, -1], 0.2, 0.2, color);
    return b.build();
  };
  return { fixed: fixed.build(), red: lamp(3.15, "#ff2a1a"), amber: lamp(2.86, "#ffb020"), green: lamp(2.57, "#35e070") };
}
