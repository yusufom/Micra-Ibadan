"use client";

import { useFrame } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useEffect, useState } from "react";
import { BufferAttribute, BufferGeometry, Color, InstancedMesh, Matrix4, MeshStandardMaterial, type Object3D, Quaternion, Vector3 } from "three";
import type { Pothole, PotholeField } from "./potholes";

/** Potholes are drawn within this radius of the focus, re-picked after it moves this far. */
const DRAW_RADIUS = 110;
const REPICK_DISTANCE = 25;
/** While some holes have no collider under them yet, retry this often (s). */
const RETRY_INTERVAL = 0.5;
const MAX_INSTANCES = 600;
/** Decals float this far above the road surface. */
const LIFT = 0.025;

/** Unit ragged disc: dark wet middle, broken lighter rim. */
function potholeGeometry(): BufferGeometry {
  const n = 12;
  const pos: number[] = [0, 0, 0];
  const col: number[] = [0.35, 0.35, 0.35];
  const idx: number[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const inner = 0.62 + rnd() * 0.18;
    const outer = 0.9 + rnd() * 0.2;
    pos.push(Math.cos(a) * inner, 0, Math.sin(a) * inner);
    col.push(0.5, 0.5, 0.5);
    pos.push(Math.cos(a) * outer, 0, Math.sin(a) * outer);
    col.push(1, 1, 1);
  }
  for (let k = 0; k < n; k++) {
    const i0 = 1 + k * 2;
    const i1 = 1 + ((k + 1) % n) * 2;
    idx.push(0, i1, i0, i0, i1, i1 + 1, i0, i1 + 1, i0 + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const PAVED = new Color("#2a2826");
const UNPAVED = new Color("#4a3322");

type Props = {
  field: PotholeField;
  /** Follows this object; the camera if omitted. */
  focus?: Object3D;
};

type RapierContext = ReturnType<typeof useRapier>;

/** The instanced decals and the per-frame work of picking and placing them. */
class PotholeDecals {
  readonly mesh: InstancedMesh;
  private readonly ray: InstanceType<RapierContext["rapier"]["Ray"]>;
  private readonly last = new Vector3(Number.NaN, 0, 0);
  private readonly near: Pothole[] = [];
  private missing = false;
  private retryAt = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly yaw = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly n = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly c = new Color();

  constructor(rapier: RapierContext["rapier"]) {
    this.mesh = new InstancedMesh(
      potholeGeometry(),
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
      MAX_INSTANCES,
    );
    this.mesh.name = "potholes";
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
    this.mesh.dispose();
  }

  update(field: PotholeField, focus: Vector3, time: number, world: RapierContext["world"], rapier: RapierContext["rapier"]): void {
    const moved = Number.isNaN(this.last.x) || this.last.distanceToSquared(focus) > REPICK_DISTANCE * REPICK_DISTANCE;
    const retry = this.missing && time > this.retryAt;
    if (!moved && !retry) return;
    this.last.copy(focus);
    this.retryAt = time + RETRY_INTERVAL;
    this.near.length = 0;
    field.near(focus.x, focus.z, DRAW_RADIUS, this.near);
    this.missing = false;
    const flags = rapier.QueryFilterFlags.EXCLUDE_SENSORS | rapier.QueryFilterFlags.EXCLUDE_DYNAMIC;
    let count = 0;
    for (const h of this.near) {
      if (count >= MAX_INSTANCES) break;
      this.ray.origin = { x: h.x, y: h.y + 4, z: h.z };
      const hit = world.castRayAndGetNormal(this.ray, 10, true, flags);
      if (!hit) {
        this.missing = true;
        continue;
      }
      this.n.set(hit.normal.x, hit.normal.y, hit.normal.z);
      if (this.n.y < 0.7) continue; // a wall or kerb, not the road
      this.p.set(h.x, h.y + 4 - hit.timeOfImpact, h.z).addScaledVector(this.n, LIFT);
      this.q.setFromUnitVectors(this.up, this.n).multiply(this.yaw.setFromAxisAngle(this.up, h.yaw));
      this.s.set(h.radius, 1, h.radius * 0.8);
      this.mesh.setMatrixAt(count, this.m.compose(this.p, this.q, this.s));
      this.mesh.setColorAt(count, this.c.copy(h.unpaved ? UNPAVED : PAVED).multiplyScalar(0.75 + h.severity * 0.4));
      count++;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/**
 * Draws the potholes near the focus as one instanced mesh, each dropped onto
 * the road collider with a raycast so it sits on the real surface. Must be
 * inside <Physics>; holes over chunks without colliders yet are retried.
 */
export function PotholeLayer({ field, focus }: Props) {
  const { world, rapier } = useRapier();
  const [decals] = useState(() => new PotholeDecals(rapier));
  useEffect(() => () => decals.dispose(), [decals]);

  useFrame(({ camera, clock }) => {
    decals.update(field, focus?.position ?? camera.position, clock.elapsedTime, world, rapier);
  });

  return <primitive object={decals.mesh} />;
}
