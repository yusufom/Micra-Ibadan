import { BoxGeometry, BufferAttribute, type BufferGeometry, CylinderGeometry, Euler, Matrix4, Quaternion, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TILE, type TileId } from "../materials/atlas";
import type { PropType } from "../chunks/types";

/**
 * Low-poly street furniture built from boxes and cylinders, each merged into
 * one geometry per prop type for the shared atlas material. Local frame:
 * origin at ground level, +Y up, the front (-Z) faces the road.
 *
 * Vertex colour alpha is the instance-colour weight: 1 = painted in the
 * instance's colour (kiosk brand paint), 0 = keeps its own colour.
 */

type RGB = [number, number, number];

type Part = {
  geometry: BufferGeometry;
  tile: TileId;
  color: RGB;
  /** 1 = take the instance colour. */
  paint?: number;
  at?: [number, number, number];
  rot?: [number, number, number];
};

/** Scale BoxGeometry's per-face 0..1 uvs to metres so atlas tiles keep their real size. */
function box(w: number, h: number, d: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  const uv = g.attributes.uv as BufferAttribute;
  // Face order +x, -x, +y, -y, +z, -z; 4 vertices each.
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
    }
  }
  return g;
}

function cylinder(rTop: number, rBottom: number, h: number, segments = 6): BufferGeometry {
  const g = new CylinderGeometry(rTop, rBottom, h, segments, 1, false);
  const uv = g.attributes.uv as BufferAttribute;
  const circ = Math.PI * (rTop + rBottom);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h);
  return g;
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();

function build(parts: Part[]): BufferGeometry {
  const geoms = parts.map((p) => {
    const g = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry;
    tmpE.set(...(p.rot ?? [0, 0, 0]));
    tmpQ.setFromEuler(tmpE);
    tmpM.compose(new Vector3(...(p.at ?? [0, 0, 0])), tmpQ, new Vector3(1, 1, 1));
    g.applyMatrix4(tmpM);
    const n = g.attributes.position.count;
    const col = new Uint8Array(n * 4);
    const mat = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      col[i * 4] = Math.round(p.color[0] * 255);
      col[i * 4 + 1] = Math.round(p.color[1] * 255);
      col[i * 4 + 2] = Math.round(p.color[2] * 255);
      col[i * 4 + 3] = Math.round((p.paint ?? 0) * 255);
    }
    mat.fill(p.tile);
    g.setAttribute("color", new BufferAttribute(col, 4, true));
    g.setAttribute("aMat", new BufferAttribute(mat, 1));
    return g;
  });
  const merged = mergeGeometries(geoms, false)!;
  for (const g of geoms) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

// Colours are linear.
const WOOD: RGB = [0.2, 0.13, 0.08];
const CONCRETE: RGB = [0.45, 0.44, 0.41];
const STEEL: RGB = [0.18, 0.18, 0.18];
const RUST: RGB = [0.3, 0.12, 0.05];
const ZINC: RGB = [0.45, 0.46, 0.47];
const TYRE: RGB = [0.02, 0.02, 0.02];
const WHITE: RGB = [0.8, 0.8, 0.78];
const DARK: RGB = [0.03, 0.03, 0.03];

/** Crossarm wire attachment points: offsets across the road (local z) at WIRE_Y. */
export const WIRE_OFFSETS = [-0.8, 0, 0.8];
export const WIRE_Y = 7.75;

/** Pole shaft paint (instance colour): creosoted wood or spun concrete. */
export const POLE_PAINT: RGB[] = [
  [0.2, 0.13, 0.08],
  [0.45, 0.44, 0.41],
];

/** Kiosk paint, linear RGB: MTN yellow, Glo green, Airtel red, faded blue. */
export const KIOSK_PAINT: RGB[] = [
  [0.85, 0.52, 0.03],
  [0.1, 0.33, 0.08],
  [0.55, 0.05, 0.04],
  [0.1, 0.2, 0.4],
];

export const SHED_ROOF_Y = 3.0;

function pole(): BufferGeometry {
  return build([
    { geometry: cylinder(0.09, 0.12, 9), tile: TILE.wood, color: [1, 1, 1], paint: 1, at: [0, 3.5, 0] },
    // Crossarm runs across the road so the wires can run along it.
    { geometry: box(0.1, 0.1, 1.9), tile: TILE.wood, color: WOOD, at: [0, 7.6, 0] },
    ...WIRE_OFFSETS.map((z): Part => ({ geometry: box(0.08, 0.16, 0.08), tile: TILE.concrete, color: WHITE, at: [0, WIRE_Y - 0.07, z] })),
    { geometry: box(0.06, 0.9, 0.1), tile: TILE.wood, color: WOOD, at: [0, 7.2, 0.45], rot: [-0.7, 0, 0] },
  ]);
}

function kiosk(): BufferGeometry {
  return build([
    { geometry: box(2.2, 2.0, 1.8), tile: TILE.sheetMetal, color: [1, 1, 1], paint: 1, at: [0, 1.15, 0] },
    { geometry: box(1.6, 0.8, 0.04), tile: TILE.sheetMetal, color: DARK, at: [0, 1.4, -0.9] },
    { geometry: box(2.0, 0.06, 0.4), tile: TILE.wood, color: WOOD, at: [0, 1.0, -1.1] },
    { geometry: box(2.2, 0.35, 0.04), tile: TILE.sheetMetal, color: [1, 1, 1], paint: 1, at: [0, 2.0, -0.93] },
    { geometry: box(2.6, 0.06, 2.4), tile: TILE.zincRusted, color: RUST, at: [0, 2.2, -0.15], rot: [0.06, 0, 0] },
    ...[-0.9, 0.9].flatMap((x) => [-0.7, 0.7].map((z): Part => ({ geometry: box(0.15, 0.3, 0.15), tile: TILE.concrete, color: CONCRETE, at: [x, 0.0, z] }))),
  ]);
}

function mechanicShed(): BufferGeometry {
  const posts: Part[] = [-3.4, 0, 3.4].flatMap((x) => [
    { geometry: box(0.1, 3.4, 0.1), tile: TILE.wood, color: WOOD, at: [x, 1.4, -2.4] } as Part,
    { geometry: box(0.1, 3.0, 0.1), tile: TILE.wood, color: WOOD, at: [x, 1.2, 2.4] } as Part,
  ]);
  const tyres: Part[] = [];
  for (const [x, z] of [[2.6, -1.6], [-2.9, 1.3]] as const) {
    for (let k = 0; k < 4; k++) tyres.push({ geometry: cylinder(0.33, 0.33, 0.2, 8), tile: TILE.concrete, color: TYRE, at: [x, 0.1 + k * 0.21, z] });
  }
  return build([
    ...posts,
    { geometry: box(7.4, 0.05, 5.4), tile: TILE.zincRusted, color: RUST, at: [0, SHED_ROOF_Y, 0], rot: [-0.08, 0, 0] },
    { geometry: box(7.0, 2.3, 0.04), tile: TILE.zincRusted, color: RUST, at: [0, 1.1, 2.45] },
    { geometry: box(2.0, 0.9, 0.6), tile: TILE.wood, color: WOOD, at: [0.2, 0.45, 1.8] },
    { geometry: cylinder(0.3, 0.3, 0.9, 8), tile: TILE.sheetMetal, color: [0.05, 0.12, 0.3], at: [1.7, 0.45, 1.5] },
    ...tyres,
  ]);
}

function garageShelter(): BufferGeometry {
  const posts: Part[] = [-6.8, -2.3, 2.3, 6.8].flatMap((x) => [
    { geometry: box(0.12, 3.4, 0.12), tile: TILE.sheetMetal, color: STEEL, at: [x, 1.6, -2.3] } as Part,
    { geometry: box(0.12, 3.8, 0.12), tile: TILE.sheetMetal, color: STEEL, at: [x, 1.8, 2.3] } as Part,
  ]);
  return build([
    ...posts,
    { geometry: box(14.6, 0.06, 5.6), tile: TILE.zinc, color: ZINC, at: [0, 3.5, 0], rot: [-0.07, 0, 0] },
    { geometry: box(6, 0.45, 0.4), tile: TILE.wood, color: WOOD, at: [-3.5, 0.22, 1.4] },
    { geometry: box(6, 0.45, 0.4), tile: TILE.wood, color: WOOD, at: [3.5, 0.22, 1.4] },
  ]);
}

export const BOARD_SIZE = { w: 4.0, h: 1.3, y: 2.6 };

function garageBoard(): BufferGeometry {
  return build([
    { geometry: box(0.1, 3.4, 0.1), tile: TILE.wood, color: WOOD, at: [-1.8, 1.5, 0] },
    { geometry: box(0.1, 3.4, 0.1), tile: TILE.wood, color: WOOD, at: [1.8, 1.5, 0] },
    { geometry: box(BOARD_SIZE.w, BOARD_SIZE.h, 0.06), tile: TILE.sheetMetal, color: WHITE, at: [0, BOARD_SIZE.y, 0.02] },
  ]);
}

const builders: Record<PropType, () => BufferGeometry> = {
  pole,
  kiosk,
  mechanic_shed: mechanicShed,
  garage_shelter: garageShelter,
  garage_board: garageBoard,
};

const geometryCache = new Map<PropType, BufferGeometry>();

/** Shared per-type geometry. Built once; never dispose. */
export function propGeometry(type: PropType): BufferGeometry {
  let g = geometryCache.get(type);
  if (!g) {
    g = builders[type]();
    geometryCache.set(type, g);
  }
  return g;
}

/** Solid parts, as local boxes: centre and half extents. Open sheds only block at their posts and walls. */
export type ColliderBox = { at: [number, number, number]; half: [number, number, number] };

export const PROP_COLLIDERS: Record<PropType, ColliderBox[]> = {
  pole: [{ at: [0, 3.5, 0], half: [0.12, 4.5, 0.12] }],
  kiosk: [{ at: [0, 1.1, 0], half: [1.1, 1.1, 0.9] }],
  mechanic_shed: [
    ...[-3.4, 0, 3.4].map((x): ColliderBox => ({ at: [x, 1.4, -2.4], half: [0.06, 1.7, 0.06] })),
    { at: [0, 1.1, 2.45], half: [3.5, 1.15, 0.05] },
    { at: [2.6, 0.45, -1.6], half: [0.33, 0.45, 0.33] },
  ],
  garage_shelter: [-6.8, -2.3, 2.3, 6.8].flatMap((x): ColliderBox[] => [
    { at: [x, 1.6, -2.3], half: [0.08, 1.7, 0.08] },
    { at: [x, 1.8, 2.3], half: [0.08, 1.9, 0.08] },
  ]),
  garage_board: [
    { at: [-1.8, 1.5, 0], half: [0.06, 1.7, 0.06] },
    { at: [1.8, 1.5, 0], half: [0.06, 1.7, 0.06] },
  ],
};
