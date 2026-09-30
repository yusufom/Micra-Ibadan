import { BufferAttribute, BufferGeometry, type Material, Mesh } from "three";
import { TILE, type TileId } from "../materials/atlas";

/** Chunk .glb mesh names (the pipeline's material ids) to atlas tiles. Water is drawn separately. */
export const MATERIAL_TILE: Record<string, TileId> = {
  terrain: TILE.terrain,
  road_paved: TILE.asphalt,
  road_unpaved: TILE.laterite,
  drain: TILE.concrete,
  plaster: TILE.plaster,
  painted: TILE.painted,
  unfinished_block: TILE.block,
  mud_brick: TILE.mudBrick,
  glass: TILE.glass,
  roof_zinc_rusted: TILE.zincRusted,
  roof_zinc: TILE.zinc,
  roof_concrete: TILE.roofConcrete,
};

export const ROAD_MATERIALS = ["road_paved", "road_unpaved"] as const;

/** "full" within one ring of the focus; "reduced" further out drops drains (a third of a chunk's triangles). */
export type ChunkDetail = "full" | "reduced";

const REDUCED_SKIP = new Set(["drain"]);

/** glTF vertex colours are linear by spec, but the pipeline wrote sRGB design colours. */
const SRGB_TO_LINEAR_U8 = (() => {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    const l = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    lut[i] = Math.round(l * 255);
  }
  return lut;
})();

/**
 * Merge a chunk's per-material geometries into one indexed geometry for the
 * atlas material: position, int8 normal, uv, linear RGBA8 colour and a uint8
 * tile id (aMat). Copies typed arrays only, so it takes about a millisecond.
 */
export function mergeChunkGeometry(parts: Map<string, BufferGeometry>, detail: ChunkDetail): BufferGeometry | null {
  const list: { g: BufferGeometry; tile: number }[] = [];
  let vCount = 0;
  let iCount = 0;
  for (const [name, g] of parts) {
    const tile = MATERIAL_TILE[name];
    if (tile === undefined || (detail === "reduced" && REDUCED_SKIP.has(name))) continue;
    list.push({ g, tile });
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  if (vCount === 0) return null;

  const pos = new Float32Array(vCount * 3);
  const nrm = new Int8Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const col = new Uint8Array(vCount * 4);
  const mat = new Uint8Array(vCount);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);

  let vo = 0;
  let io = 0;
  for (const { g, tile } of list) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array as Float32Array, vo * 3);
    const srcN = g.attributes.normal?.array as Float32Array | undefined;
    if (srcN) {
      for (let i = 0; i < n * 3; i++) nrm[vo * 3 + i] = Math.round(srcN[i] * 127);
    } else {
      for (let i = 0; i < n; i++) nrm[(vo + i) * 3 + 1] = 127;
    }
    const srcUv = g.attributes.uv?.array as Float32Array | undefined;
    if (srcUv) uv.set(srcUv, vo * 2);
    const srcC = g.attributes.color;
    if (srcC && srcC.array instanceof Uint8Array && srcC.itemSize === 4) {
      const a = srcC.array;
      for (let i = 0; i < n * 4; i++) col[vo * 4 + i] = (i & 3) === 3 ? a[i] : SRGB_TO_LINEAR_U8[a[i]];
    } else {
      col.fill(255, vo * 4, (vo + n) * 4);
    }
    mat.fill(tile, vo, vo + n);
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
      io += src.length;
    } else {
      for (let i = 0; i < n; i++) idx[io + i] = vo + i;
      io += n;
    }
    vo += n;
  }

  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(pos, 3));
  out.setAttribute("normal", new BufferAttribute(nrm, 3, true));
  out.setAttribute("uv", new BufferAttribute(uv, 2));
  out.setAttribute("color", new BufferAttribute(col, 4, true));
  out.setAttribute("aMat", new BufferAttribute(mat, 1));
  out.setIndex(new BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/** A merged chunk mesh. Shared material; the geometry belongs to the chunk. */
export function makeChunkMesh(geometry: BufferGeometry, material: Material, castShadow: boolean): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.name = "chunk-surface";
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
