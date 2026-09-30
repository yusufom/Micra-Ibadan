import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, type Texture, UnsignedByteType } from "three";

/**
 * One shared, procedurally painted texture atlas for every chunk surface and
 * prop. No texture per building: the pipeline's per-building vertex colours
 * tint a handful of neutral tiles, so thousands of buildings share one
 * texture and one draw call per chunk.
 *
 * Layout: 4×4 cells of CELL px. Each cell holds a seamless tile of CONTENT px
 * plus PAD px of wrapped border so mip levels up to MAX_LOD never bleed into
 * neighbours. The shader samples with textureGrad on the continuous tile
 * coordinate, so there is no seam where fract() wraps.
 *
 * Alpha is the tint mask: 1 = multiply by the vertex colour (walls, roofs,
 * terrain), 0 = keep the tile's own colour (window glass, burglar bars).
 */

export const ATLAS_GRID = 4;
export const CELL = 256;
export const PAD = 8;
export const CONTENT = CELL - 2 * PAD;
export const ATLAS_SIZE = CELL * ATLAS_GRID;
/** Highest mip level the shader samples before fading to the tile's average colour. */
export const MAX_LOD = 3;

export const TILE = {
  terrain: 0,
  asphalt: 1,
  laterite: 2,
  concrete: 3,
  plaster: 4,
  painted: 5,
  block: 6,
  mudBrick: 7,
  glass: 8,
  zincRusted: 9,
  zinc: 10,
  roofConcrete: 11,
  wood: 12,
  sheetMetal: 13,
  water: 14,
} as const;

export type TileId = (typeof TILE)[keyof typeof TILE];

/** How the shader derives the tile coordinate. */
export const TileMode = {
  /** World x/z (ground, flat roofs). */
  WorldXZ: 0,
  /** Mesh uv in metres (walls: along, up; drains: across, along). */
  Uv: 1,
  /** World x/z rotated so corrugations run down the roof slope. */
  RoofSlope: 2,
} as const;

export type TileMode = (typeof TileMode)[keyof typeof TileMode];

export type TileSpec = {
  /** Metres covered by one repeat of the tile (u, v). */
  scale: [number, number];
  mode: TileMode;
  roughness: number;
  metalness: number;
  /** 0 = ignore vertex colour, 1 = multiply by it (where the tile's alpha allows). */
  tint: number;
};

/** Per-tile shading. Wall tiles are one bay: 3.6 m wide, one 3.1 m storey tall. */
export const TILE_SPECS: Record<TileId, TileSpec> = {
  [TILE.terrain]: { scale: [7, 7], mode: TileMode.WorldXZ, roughness: 1, metalness: 0, tint: 1 },
  [TILE.asphalt]: { scale: [9, 9], mode: TileMode.WorldXZ, roughness: 0.92, metalness: 0, tint: 0 },
  [TILE.laterite]: { scale: [6, 6], mode: TileMode.WorldXZ, roughness: 1, metalness: 0, tint: 0 },
  [TILE.concrete]: { scale: [1.5, 3], mode: TileMode.Uv, roughness: 0.95, metalness: 0, tint: 1 },
  [TILE.plaster]: { scale: [3.6, 3.1], mode: TileMode.Uv, roughness: 0.9, metalness: 0, tint: 1 },
  [TILE.painted]: { scale: [3.6, 3.1], mode: TileMode.Uv, roughness: 0.85, metalness: 0, tint: 1 },
  [TILE.block]: { scale: [3.6, 3.1], mode: TileMode.Uv, roughness: 1, metalness: 0, tint: 1 },
  [TILE.mudBrick]: { scale: [3.6, 3.1], mode: TileMode.Uv, roughness: 1, metalness: 0, tint: 1 },
  [TILE.glass]: { scale: [3, 3.1], mode: TileMode.Uv, roughness: 0.25, metalness: 0.1, tint: 0.4 },
  [TILE.zincRusted]: { scale: [3, 3], mode: TileMode.RoofSlope, roughness: 0.8, metalness: 0.05, tint: 1 },
  [TILE.zinc]: { scale: [3, 3], mode: TileMode.RoofSlope, roughness: 0.55, metalness: 0.15, tint: 1 },
  [TILE.roofConcrete]: { scale: [6, 6], mode: TileMode.WorldXZ, roughness: 0.95, metalness: 0, tint: 1 },
  [TILE.wood]: { scale: [1, 2], mode: TileMode.Uv, roughness: 0.9, metalness: 0, tint: 1 },
  [TILE.sheetMetal]: { scale: [2, 2], mode: TileMode.Uv, roughness: 0.7, metalness: 0.05, tint: 1 },
  [TILE.water]: { scale: [8, 8], mode: TileMode.WorldXZ, roughness: 0.15, metalness: 0, tint: 1 },
};

// --- tileable noise -------------------------------------------------------

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise on a lattice that wraps every `period` cells. x, y in lattice units. */
function vnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal noise in [0, 1], seamless over u, v in [0, 1). */
function fbm(u: number, v: number, basePeriod: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(u * p, v * p, p, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

type RGBA = [number, number, number, number];
type TilePainter = (u: number, v: number) => RGBA;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const rgb = (c: [number, number, number], k = 1, a = 1): RGBA => [c[0] * k, c[1] * k, c[2] * k, a];

/** Distance (in tile units) to the nearest multiple of `step`, for grid lines. */
const gridDist = (x: number, step: number) => {
  const f = (x / step) % 1;
  return Math.min(f, 1 - f) * step;
};

// Window in a 3.6 × 3.1 m bay (u along, v up from floor level).
const WIN_U0 = 0.32;
const WIN_U1 = 0.68;
const WIN_V0 = 0.3;
const WIN_V1 = 0.72;

/** A burglar-proofed window: dark glass, cream frame, vertical steel bars. 0 outside. */
function window(u: number, v: number, louvres: boolean): RGBA | null {
  if (u < WIN_U0 || u > WIN_U1 || v < WIN_V0 || v > WIN_V1) return null;
  const edge = Math.min(u - WIN_U0, WIN_U1 - u, (v - WIN_V0) * 0.86, (WIN_V1 - v) * 0.86);
  if (edge < 0.012) return [0.82, 0.8, 0.74, 0];
  if (gridDist(u - WIN_U0, 0.045) < 0.004) return [0.2, 0.2, 0.2, 0];
  const glassV = (v - WIN_V0) / (WIN_V1 - WIN_V0);
  if (louvres && gridDist(glassV, 0.12) < 0.012) return [0.55, 0.57, 0.58, 0];
  const k = 0.09 + 0.08 * glassV + 0.03 * fbm(u, v, 8, 2, 3);
  return [k, k * 1.05, k * 1.12, 0];
}

/** Rain streaks under windows and general grime, as a darkening factor. */
function grime(u: number, v: number, seed: number): number {
  const streak = u > WIN_U0 && u < WIN_U1 && v < WIN_V0 ? (1 - v / WIN_V0) * 0.12 * fbm(u * 3, 0, 24, 2, seed) : 0;
  return 1 - 0.14 * fbm(u, v, 3, 4, seed) - streak;
}

const PAINTERS: Record<TileId, TilePainter> = {
  [TILE.terrain]: (u, v) => {
    const n = fbm(u, v, 4, 5, 1);
    const speck = hash(Math.floor(u * CONTENT), Math.floor(v * CONTENT), 2);
    const k = 0.84 + 0.28 * n + (speck > 0.94 ? 0.12 : speck < 0.05 ? -0.12 : 0);
    return [k * 1.02, k, k * 0.97, 1];
  },
  [TILE.asphalt]: (u, v) => {
    const n = fbm(u, v, 6, 4, 11);
    const speck = hash(Math.floor(u * CONTENT), Math.floor(v * CONTENT), 12);
    // Sun-bleached, dusty binder with light aggregate.
    let k = 0.44 + 0.05 * (n - 0.5) + (speck > 0.9 ? 0.07 : speck < 0.08 ? -0.05 : 0);
    let warm = 0.015;
    // Rectangular cut-and-fill repairs in darker, fresher tar, on a 4×4 grid of cells.
    const cu = Math.floor(u * 4);
    const cv = Math.floor(v * 4);
    if (hash(cu, cv, 13) > 0.8) {
      const fu = u * 4 - cu;
      const fv = v * 4 - cv;
      const i0 = 0.1 + 0.2 * hash(cu, cv, 14);
      const i1 = 0.9 - 0.2 * hash(cu, cv, 15);
      const j0 = 0.1 + 0.2 * hash(cu, cv, 16);
      const j1 = 0.9 - 0.2 * hash(cu, cv, 17);
      if (fu > i0 && fu < i1 && fv > j0 && fv < j1) {
        const seam = Math.min(fu - i0, i1 - fu, fv - j0, j1 - fv) < 0.015;
        k = seam ? 0.22 : 0.3 + 0.03 * n;
        warm = 0;
      }
    }
    // Sparse hairline cracks.
    const c = Math.abs(fbm(u, v, 5, 3, 18) - 0.5);
    if (c < 0.006 && fbm(u, v, 2, 2, 19) > 0.55) k *= 0.7;
    return [k + warm, k + warm * 0.4, k - warm * 0.2, 0];
  },
  [TILE.laterite]: (u, v) => {
    const n = fbm(u, v, 4, 5, 21);
    const pebble = hash(Math.floor(u * CONTENT * 0.5), Math.floor(v * CONTENT * 0.5), 22);
    const damp = smooth(0.58, 0.72, fbm(u, v, 2, 3, 23));
    let c: [number, number, number] = [0.66, 0.37, 0.22];
    c = [mix(c[0], 0.5, damp), mix(c[1], 0.27, damp), mix(c[2], 0.17, damp)];
    const k = 0.86 + 0.28 * n + (pebble > 0.95 ? 0.15 : 0);
    return rgb(c, k, 0);
  },
  [TILE.concrete]: (u, v) => {
    const n = fbm(u, v, 4, 4, 31);
    const moss = smooth(0.62, 0.8, fbm(u, v, 3, 3, 32));
    const k = 0.9 + 0.16 * (n - 0.5) - 0.3 * moss * (1 - v);
    return [k, k, k * 0.97, 1];
  },
  [TILE.plaster]: (u, v) => {
    const w = window(u, v, false);
    if (w) return w;
    const k = 0.98 * grime(u, v, 41);
    return [k, k, k * 0.98, 1];
  },
  [TILE.painted]: (u, v) => {
    const w = window(u, v, true);
    if (w) return w;
    // Faded paint: chalky pale blotches and flaking.
    const fade = smooth(0.5, 0.8, fbm(u, v, 2, 4, 51));
    const flake = fbm(u, v, 12, 2, 52) > 0.78 ? 0.9 : 1;
    const k = grime(u, v, 53) * flake;
    return [mix(k, 1.05, fade * 0.18), mix(k, 1.05, fade * 0.18), mix(k * 0.98, 1.03, fade * 0.18), 1 - fade * 0.12];
  },
  [TILE.block]: (u, v) => {
    // Opening without a frame, as on unfinished buildings.
    if (u > WIN_U0 && u < WIN_U1 && v > WIN_V0 && v < WIN_V1) return [0.07, 0.07, 0.07, 0];
    const course = Math.floor(v * 14);
    const off = course % 2 ? 1 / 16 : 0;
    const mortar = gridDist(v, 1 / 14) < 0.004 || gridDist(u + off, 1 / 8) < 0.003;
    const n = fbm(u, v, 8, 3, 61);
    const blockTone = 0.92 + 0.12 * (hash(Math.floor((u + off) * 8), course, 62) - 0.5);
    const k = mortar ? 0.8 : blockTone * (0.9 + 0.2 * n);
    return [k, k, k * 0.98, 1];
  },
  [TILE.mudBrick]: (u, v) => {
    // Small wooden shutter.
    if (u > 0.4 && u < 0.6 && v > 0.35 && v < 0.68) {
      const plank = gridDist(u, 0.04) < 0.004 ? 0.7 : 1;
      return [0.36 * plank, 0.24 * plank, 0.15 * plank, 0];
    }
    const n = fbm(u, v, 3, 5, 71);
    // Render fallen away showing bricks underneath.
    const bare = smooth(0.6, 0.64, fbm(u, v, 2, 3, 72));
    const course = Math.floor(v * 20);
    const joint = gridDist(v, 1 / 20) < 0.003 || gridDist(u + (course % 2) * 0.05, 0.1) < 0.003;
    const crack = Math.abs(fbm(u, v, 4, 3, 73) - 0.5) < 0.008;
    let k = 0.88 + 0.26 * (n - 0.5);
    if (bare > 0.5) k *= joint ? 0.72 : 0.93;
    if (crack) k *= 0.7;
    return [k, k * 0.98, k * 0.95, 1];
  },
  [TILE.glass]: (u, v) => {
    const mullion = gridDist(u, 0.5) < 0.012 || gridDist(v, 1) < 0.02;
    if (mullion) return [0.62, 0.64, 0.66, 0];
    const k = 0.22 + 0.25 * v + 0.05 * fbm(u, v, 4, 2, 81);
    return [k * 0.8, k * 0.95, k * 1.05, 0.2];
  },
  [TILE.zincRusted]: (u, v) => {
    const ridge = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 40);
    const rust = fbm(u, v, 4, 5, 91);
    const streak = fbm(u * 8, v, 4, 3, 92);
    const overlap = gridDist(v, 1 / 3) < 0.006 ? 0.7 : 1;
    const holes = hash(Math.floor(u * 40), Math.floor(v * 3), 93) > 0.97 && gridDist(v, 1 / 3) < 0.03 ? 0.4 : 1;
    const k = (0.78 + 0.22 * ridge) * (0.8 + 0.4 * rust) * (0.92 + 0.12 * streak) * overlap * holes;
    // Orange fresh rust vs dark old rust.
    const orange = smooth(0.55, 0.75, rust);
    return [k * (1 + 0.12 * orange), k * (1 - 0.02 * orange), k * (1 - 0.1 * orange), 1];
  },
  [TILE.zinc]: (u, v) => {
    const ridge = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 40);
    const spots = smooth(0.66, 0.78, fbm(u, v, 5, 4, 101));
    const overlap = gridDist(v, 1 / 3) < 0.006 ? 0.78 : 1;
    const k = (0.84 + 0.16 * ridge) * overlap * (0.95 + 0.1 * fbm(u, v, 3, 3, 102));
    return [mix(k, 0.62, spots), mix(k, 0.4, spots), mix(k, 0.28, spots), 1 - spots];
  },
  [TILE.roofConcrete]: (u, v) => {
    const n = fbm(u, v, 3, 5, 111);
    // Soft black mould where rain water sits, kept low-contrast so the tile doesn't read as a pattern.
    const mould = smooth(0.5, 0.85, fbm(u, v, 1, 4, 112));
    const k = (0.95 + 0.1 * (n - 0.5)) * (1 - 0.22 * mould);
    return [k, k, k * 0.98, 1];
  },
  [TILE.wood]: (u, v) => {
    const grain = fbm(u * 6, v * 0.5, 6, 3, 121);
    const k = 0.75 + 0.3 * grain;
    return [k, k * 0.96, k * 0.92, 1];
  },
  [TILE.sheetMetal]: (u, v) => {
    const panel = gridDist(u, 0.5) < 0.008 || gridDist(v, 0.5) < 0.008;
    const rust = smooth(0.62, 0.8, fbm(u, v, 4, 4, 131));
    const k = (panel ? 0.75 : 0.95) * (0.95 + 0.1 * fbm(u, v, 3, 3, 132));
    return [mix(k, 0.5, rust), mix(k, 0.3, rust), mix(k, 0.2, rust), 1 - rust];
  },
  [TILE.water]: (u, v) => {
    const k = 0.85 + 0.3 * fbm(u, v, 4, 4, 141);
    return [k, k, k, 1];
  },
};

export type Atlas = {
  texture: Texture;
  /** Mean linear colour of each tile, for the far-mip fade. rgba. */
  averages: Float32Array;
};

let atlas: Atlas | null = null;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Paint the atlas once (≈50–150 ms) and share it. A DataTexture rather than a
 * canvas, because a canvas premultiplies alpha and would wipe the colour of
 * every pixel whose tint mask is 0. Row 0 is v = 0.
 */
export function getAtlas(): Atlas {
  if (atlas) return atlas;
  const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  const averages = new Float32Array(ATLAS_GRID * ATLAS_GRID * 4);
  const tile = new Float32Array(CONTENT * CONTENT * 4);

  for (const [idStr, paint] of Object.entries(PAINTERS)) {
    const id = Number(idStr);
    const ox = (id % ATLAS_GRID) * CELL;
    const oy = Math.floor(id / ATLAS_GRID) * CELL;
    const sum = [0, 0, 0, 0];
    for (let y = 0; y < CONTENT; y++) {
      const v = (y + 0.5) / CONTENT;
      for (let x = 0; x < CONTENT; x++) {
        const c = paint((x + 0.5) / CONTENT, v);
        const k = (y * CONTENT + x) * 4;
        for (let i = 0; i < 4; i++) {
          tile[k + i] = clamp01(c[i]);
          sum[i] += i < 3 ? srgbToLinear(tile[k + i]) : tile[k + i];
        }
      }
    }
    const n = CONTENT * CONTENT;
    for (let i = 0; i < 4; i++) averages[id * 4 + i] = sum[i] / n;
    // Copy with wrapped padding.
    for (let y = -PAD; y < CONTENT + PAD; y++) {
      const sy = (y + CONTENT) % CONTENT;
      for (let x = -PAD; x < CONTENT + PAD; x++) {
        const sx = (x + CONTENT) % CONTENT;
        const s = (sy * CONTENT + sx) * 4;
        const d = ((oy + PAD + y) * ATLAS_SIZE + (ox + PAD + x)) * 4;
        data[d] = Math.round(tile[s] * 255);
        data[d + 1] = Math.round(tile[s + 1] * 255);
        data[d + 2] = Math.round(tile[s + 2] * 255);
        data[d + 3] = Math.round(tile[s + 3] * 255);
      }
    }
  }

  const texture = new DataTexture(data, ATLAS_SIZE, ATLAS_SIZE, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  atlas = { texture, averages };
  return atlas;
}
