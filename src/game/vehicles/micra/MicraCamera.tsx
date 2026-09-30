"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { type RapierRigidBody, useRapier } from "@react-three/rapier";
import { type RefObject, useEffect, useState } from "react";
import { type Group, PerspectiveCamera, Quaternion, type Scene, Vector3, type WebGLRenderer, WebGLRenderTarget } from "three";
import { MICRA_TUNING } from "@/game/config/micraTuning";
import type { CameraMode } from "@/game/store/vehicleStore";
import { getQuality } from "@/game/world/quality";
import { MICRA_DRIVER_EYE } from "../micraSpec";
import type { MicraRig } from "./MicraModel";
import type { MicraSim } from "./micraSim";

type RapierContext = ReturnType<typeof useRapier>;

type Props = {
  /** Group inside the RigidBody: its world transform is the interpolated chassis. */
  chassis: RefObject<Group | null>;
  body: RefObject<RapierRigidBody | null>;
  rig: RefObject<MicraRig | null>;
  sim: RefObject<MicraSim | null>;
  mode: CameraMode;
};

const CHASE_NEAR = 0.3;
const COCKPIT_NEAR = 0.05;
/** Chase camera shape casts start from here above the car's origin. */
const PIVOT_HEIGHT = 1.3;
/** Rear-view mirror image: size, and render every n frames. */
const MIRROR_SIZE: [number, number] = [256, 72];
const MIRROR_EVERY = 2;
/** Rear-view mirror position in the car. */
const MIRROR_AT = new Vector3(0, 1.3, -0.18);

/**
 * Chase camera that swings after the car's heading and the terrain pitch,
 * pulled in so it never ends up inside a building or under the ground, and a
 * cockpit camera at the driver's eyes with a live rear-view mirror.
 */
class MicraCameraRig {
  private readonly rapier: RapierContext["rapier"];
  private readonly ball: InstanceType<RapierContext["rapier"]["Ball"]>;
  private readonly ray: InstanceType<RapierContext["rapier"]["Ray"]>;
  private readonly mirror: { target: WebGLRenderTarget; cam: PerspectiveCamera } | null;
  private initialised = false;
  private frame = 0;
  private readonly heading = new Vector3(0, 0, -1);
  private readonly pos = new Vector3();
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private readonly scale = new Vector3();
  private readonly fwd = new Vector3();
  private readonly target = new Vector3();
  private readonly desired = new Vector3();
  private readonly pivot = new Vector3();
  private readonly dir = new Vector3();
  private readonly look = new Quaternion();
  private readonly axisX = new Vector3(1, 0, 0);
  private readonly axisY = new Vector3(0, 1, 0);

  constructor(rapier: RapierContext["rapier"]) {
    this.rapier = rapier;
    this.ball = new rapier.Ball(MICRA_TUNING.camera.clearance);
    this.ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.mirror =
      getQuality().tier === "low"
        ? null
        : { target: new WebGLRenderTarget(MIRROR_SIZE[0], MIRROR_SIZE[1]), cam: new PerspectiveCamera(22, MIRROR_SIZE[0] / MIRROR_SIZE[1], 0.5, 800) };
  }

  dispose(): void {
    this.mirror?.target.dispose();
  }

  /** Lens and mirror texture for a mode. Returns an undo for unmount. */
  applyMode(camera: PerspectiveCamera, mode: CameraMode, rig: MicraRig | null): () => void {
    const c = MICRA_TUNING.camera;
    camera.near = mode === "cockpit" ? COCKPIT_NEAR : CHASE_NEAR;
    camera.fov = mode === "cockpit" ? c.cockpitFov : c.fov;
    camera.updateProjectionMatrix();
    if (rig) {
      rig.mirror.map = mode === "cockpit" && this.mirror ? this.mirror.target.texture : null;
      rig.mirror.color.set(rig.mirror.map ? "#ffffff" : "#39434d");
      rig.mirror.needsUpdate = true;
    }
    this.initialised = false;
    return () => {
      camera.near = CHASE_NEAR;
      camera.fov = c.fov;
      camera.updateProjectionMatrix();
    };
  }

  update(dt: number, camera: PerspectiveCamera, world: RapierContext["world"], chassis: Group, body: RapierRigidBody, mode: CameraMode, jolt: number, rig: MicraRig | null, gl: WebGLRenderer, scene: Scene): void {
    const c = MICRA_TUNING.camera;
    const { p, q, fwd, target, desired, pivot, dir } = this;
    chassis.updateWorldMatrix(true, false);
    chassis.matrixWorld.decompose(p, q, this.scale);
    fwd.set(0, 0, -1).applyQuaternion(q);
    const shake = jolt * c.shake;

    if (mode === "cockpit") {
      camera.position.set(MICRA_DRIVER_EYE[0], MICRA_DRIVER_EYE[1], MICRA_DRIVER_EYE[2]).applyQuaternion(q).add(p);
      camera.position.y += (Math.random() - 0.5) * shake * 0.5;
      camera.quaternion
        .copy(q)
        .multiply(this.look.setFromAxisAngle(this.axisY, c.cockpitYaw))
        .multiply(this.look.setFromAxisAngle(this.axisX, c.cockpitPitch));
      this.renderMirror(rig, gl, scene);
      return;
    }

    if (!this.initialised) {
      this.heading.copy(fwd);
      this.pos.set(0, -1e6, 0);
      this.initialised = true;
    }
    // Yaw and pitch smoothed separately, so a hill tilts the view without whipping it sideways.
    const kYaw = 1 - Math.exp(-dt * c.headingFollow);
    const kPitch = 1 - Math.exp(-dt * c.pitchFollow);
    const flat = Math.hypot(fwd.x, fwd.z) || 1;
    const h = this.heading;
    const hFlat = Math.hypot(h.x, h.z) || 1;
    const yawX = h.x / hFlat + (fwd.x / flat - h.x / hFlat) * kYaw;
    const yawZ = h.z / hFlat + (fwd.z / flat - h.z / hFlat) * kYaw;
    const yl = Math.hypot(yawX, yawZ) || 1;
    const slope = h.y / hFlat + (fwd.y / flat - h.y / hFlat) * kPitch;
    h.set(yawX / yl, slope, yawZ / yl);
    dir.copy(h).normalize();

    target.copy(p).addScaledVector(dir, c.lookAhead);
    target.y += c.lookHeight;
    desired.copy(p).addScaledVector(dir, -c.distance);
    desired.y += c.height;

    // Smoothed, unshaken position; snaps when far away (spawn, mode switch).
    const kPos = 1 - Math.exp(-dt * c.positionFollow);
    this.pos.lerp(desired, this.pos.distanceToSquared(desired) < 400 ? kPos : 1);

    // Never inside a wall: sphere-cast from above the car out to the camera.
    const flags = this.rapier.QueryFilterFlags.EXCLUDE_SENSORS;
    pivot.copy(p);
    pivot.y += PIVOT_HEIGHT;
    dir.subVectors(this.pos, pivot);
    const dist = dir.length();
    if (dist > 1e-3) {
      dir.divideScalar(dist);
      const hit = world.castShape(pivot, { x: 0, y: 0, z: 0, w: 1 }, dir, this.ball, 0, dist, true, flags, undefined, undefined, body);
      if (hit) this.pos.copy(pivot).addScaledVector(dir, Math.max(0.2, hit.time_of_impact - 0.05));
    }
    // Never under the ground: ray down onto terrain and roads only (not rooftops).
    this.ray.origin = { x: this.pos.x, y: this.pos.y + 3, z: this.pos.z };
    const ground = world.castRay(this.ray, 6, true, flags, undefined, undefined, body, this.isGround);
    if (ground) this.pos.y = Math.max(this.pos.y, this.pos.y + 3 - ground.timeOfImpact + c.clearance + 0.2);

    camera.position.copy(this.pos);
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.lookAt(target);
  }

  private readonly isGround = (col: { shape: { type: number } }) =>
    col.shape.type === this.rapier.ShapeType.HeightField || col.shape.type === this.rapier.ShapeType.TriMesh;

  private renderMirror(rig: MicraRig | null, gl: WebGLRenderer, scene: Scene): void {
    if (!this.mirror || !rig || ++this.frame % MIRROR_EVERY !== 0) return;
    const m = this.mirror.cam;
    // From the mirror, looking back over the car.
    m.position.copy(MIRROR_AT).applyQuaternion(this.q).add(this.p);
    m.quaternion.copy(this.q).multiply(this.look.setFromAxisAngle(this.axisY, Math.PI));
    m.updateMatrixWorld();
    // Hide the mirror face while rendering into its own texture.
    rig.mirrorMesh.visible = false;
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(this.mirror.target);
    gl.render(scene, m);
    gl.setRenderTarget(prev);
    rig.mirrorMesh.visible = true;
  }
}

/** Chase / cockpit camera for the Micra (C toggles). Mount inside <Physics>. */
export function MicraCamera({ chassis, body, rig, sim, mode }: Props) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const { world, rapier } = useRapier();
  const [cam] = useState(() => new MicraCameraRig(rapier));
  useEffect(() => () => cam.dispose(), [cam]);
  useEffect(() => cam.applyMode(camera, mode, rig.current), [cam, camera, mode, rig]);

  useFrame((_, dt) => {
    if (!chassis.current || !body.current) return;
    cam.update(dt, camera, world, chassis.current, body.current, mode, sim.current?.jolt ?? 0, rig.current, gl, scene);
  });

  return null;
}
