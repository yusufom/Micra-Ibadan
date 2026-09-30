import type { RapierRigidBody, useRapier } from "@react-three/rapier";
import { PROP_COLLIDERS } from "../props/propModels";
import type { BuildingCollider, Prop } from "./types";

type RapierContext = ReturnType<typeof useRapier>;
export type RapierApi = RapierContext["rapier"];
export type RapierWorld = RapierContext["world"];

export type ChunkPhysicsInput = {
  /** Chunk min corner; the body sits here and colliders are chunk-local. */
  originX: number;
  originZ: number;
  size: number;
  /** samples × samples heights, row-major, row = z (north to south). */
  heights: Float32Array;
  samples: number;
  /** Road surface and drain triangles, chunk-local. */
  roads: { positions: Float32Array; indices: Uint32Array } | null;
  buildings: BuildingCollider[];
  props: Prop[];
};

const BUILDINGS_PER_STEP = 150;
const GROUND_FRICTION = 1.0;
const WALL_FRICTION = 0.4;

/**
 * Rapier's heightfield wants a column-major matrix with rows along z and
 * columns along x; the pipeline writes row-major with row = z. Transpose.
 */
function toColumnMajor(heights: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) out[z + x * n] = heights[z * n + x];
  }
  return out;
}

/**
 * Build one fixed body with the chunk's colliders, yielding between steps so
 * the caller can spread the work over frames. `out.body` is set on the first
 * step, so an interrupted build can still be removed.
 *
 * Neighbouring chunks share their edge rows exactly (the pipeline guarantees
 * it), so the heightfields meet with no step at the seam, and
 * FIX_INTERNAL_EDGES stops phantom bumps on the triangle edges inside each one.
 */
export function* buildChunkPhysics(
  world: RapierWorld,
  rapier: RapierApi,
  input: ChunkPhysicsInput,
  out: { body: RapierRigidBody | null },
): Generator<void, void, void> {
  const { originX: ox, originZ: oz, size, samples: n } = input;
  const body = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(ox, 0, oz));
  out.body = body;

  const hf = rapier.ColliderDesc.heightfield(
    n - 1,
    n - 1,
    toColumnMajor(input.heights, n),
    { x: size, y: 1, z: size },
    rapier.HeightFieldFlags.FIX_INTERNAL_EDGES,
  )
    .setTranslation(size / 2, 0, size / 2)
    .setFriction(GROUND_FRICTION);
  world.createCollider(hf, body);
  yield;

  if (input.roads && input.roads.indices.length) {
    const flags = rapier.TriMeshFlags.FIX_INTERNAL_EDGES | rapier.TriMeshFlags.MERGE_DUPLICATE_VERTICES;
    const tm = rapier.ColliderDesc.trimesh(input.roads.positions, input.roads.indices, flags).setFriction(GROUND_FRICTION);
    world.createCollider(tm, body);
    yield;
  }

  let k = 0;
  for (const b of input.buildings) {
    const hy = (b.y1 - b.y0) / 2;
    const cy = (b.y0 + b.y1) / 2;
    let desc;
    if (b.shape === "box") {
      desc = rapier.ColliderDesc.cuboid(b.hx, hy, b.hz)
        .setTranslation(b.x - ox, cy, b.z - oz)
        .setRotation({ x: 0, y: Math.sin(b.yaw / 2), z: 0, w: Math.cos(b.yaw / 2) });
    } else {
      const pts = new Float32Array(b.pts.length * 6);
      b.pts.forEach(([x, z], i) => {
        pts.set([x - ox, b.y0, z - oz, x - ox, b.y1, z - oz], i * 6);
      });
      desc = rapier.ColliderDesc.convexHull(pts);
    }
    if (desc) world.createCollider(desc.setFriction(WALL_FRICTION), body);
    if (++k % BUILDINGS_PER_STEP === 0) yield;
  }

  for (const p of input.props) {
    const s = Math.sin(p.yaw);
    const c = Math.cos(p.yaw);
    const q = { x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) };
    for (const { at, half } of PROP_COLLIDERS[p.type] ?? []) {
      // Rotate the local offset by yaw about +Y (three.js convention).
      const lx = at[0] * c + at[2] * s;
      const lz = -at[0] * s + at[2] * c;
      const desc = rapier.ColliderDesc.cuboid(half[0], half[1], half[2])
        .setTranslation(p.x - ox + lx, p.y + at[1], p.z - oz + lz)
        .setRotation(q)
        .setFriction(WALL_FRICTION);
      world.createCollider(desc, body);
    }
  }
}

/** Removes the body and every collider on it. */
export function removeChunkPhysics(world: RapierWorld, body: RapierRigidBody | null): void {
  if (body) world.removeRigidBody(body);
}
