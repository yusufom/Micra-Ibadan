import type { useRapier } from "@react-three/rapier";
import { TRAFFIC_TUNING as T } from "@/game/config/trafficTuning";
import type { TrafficVehicleKind } from "@/game/core/events";
import { playerVehicle } from "@/game/vehicles/playerVehicle";
import type { TrafficSim, TrafficVehicle } from "./TrafficSim";

type RapierContext = ReturnType<typeof useRapier>;
type World = RapierContext["world"];
type Rapier = RapierContext["rapier"];
type Body = ReturnType<World["createRigidBody"]>;
type Collider = ReturnType<World["createCollider"]>;

/**
 * Kinematic Rapier bodies for the AI vehicles near the player, so the Micra
 * bumps into them (and they into it). Far vehicles have no body. Bodies are
 * pooled per vehicle type and disabled rather than freed.
 *
 * react-three-rapier only reports collisions between colliders it created,
 * so contacts with the player are polled after each physics step instead.
 */

/** Traffic colliders are in group 3: they touch the player and the world; wheel rays and the camera skip them. */
export const TRAFFIC_COLLISION_GROUPS = (0x0004 << 16) | (0xffff & ~0x0004);

type Entry = {
  kind: TrafficVehicleKind;
  body: Body;
  collider: Collider;
  trailer: Body | null;
  trailerCollider: Collider | null;
  vehicle: TrafficVehicle | null;
  touching: boolean;
  lastHit: number;
};

const q = { x: 0, y: 0, z: 0, w: 1 };

/** Quaternion for yaw (about +Y), then pitch (about X, nose up), then roll (about Z). Written into `q`. */
export function yawPitchRoll(yaw: number, pitch: number, roll: number): typeof q {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  // q = qy * qx * qz
  q.w = cy * cp * cr + sy * sp * sr;
  q.x = cy * sp * cr + sy * cp * sr;
  q.y = sy * cp * cr - cy * sp * sr;
  q.z = cy * cp * sr - sy * sp * cr;
  return q;
}

export class TrafficPhysics {
  private readonly active = new Map<number, Entry>();
  private readonly pool = new Map<TrafficVehicleKind, Entry[]>();
  private readonly pvel = { x: 0, y: 0, z: 0 };
  private time = 0;
  private released = true;

  constructor(private readonly world: World, private readonly rapier: Rapier, private readonly sim: TrafficSim) {}

  /** Start (or restart after dispose) handing out bodies. */
  resume(): void {
    this.released = false;
    this.sim.onRemove = (v) => this.release(v.id);
  }

  get count(): number {
    return this.active.size;
  }

  /** Once per frame: bodies for vehicles near the player, none for the rest. */
  sync(): void {
    if (this.released) return;
    const p = playerVehicle;
    const r2 = T.physicsRadius * T.physicsRadius;
    for (const v of this.sim.vehicles) {
      const near = p.active && (v.x - p.x) ** 2 + (v.z - p.z) ** 2 < r2;
      const has = this.active.has(v.id);
      if (near && !has) this.acquire(v);
      else if (!near && has) this.release(v.id);
    }
  }

  /** Before each physics step: move bodies to their vehicles' poses; remember the player's velocity. */
  beforeStep(dt: number): void {
    this.time += dt;
    const b = playerVehicle.body;
    if (b) {
      const v = b.linvel();
      this.pvel.x = v.x;
      this.pvel.y = v.y;
      this.pvel.z = v.z;
    }
    for (const e of this.active.values()) {
      const v = e.vehicle!;
      e.body.setNextKinematicTranslation({ x: v.x, y: v.y, z: v.z });
      e.body.setNextKinematicRotation(yawPitchRoll(v.yaw, v.pitch, v.roll));
      if (e.trailer) {
        e.trailer.setNextKinematicTranslation({ x: v.tx, y: v.ty, z: v.tz });
        e.trailer.setNextKinematicRotation(yawPitchRoll(v.tyaw, v.tpitch, 0));
      }
    }
  }

  /** After each physics step: new contacts with the player become collisions. */
  afterStep(): void {
    const pb = playerVehicle.body;
    if (!pb || this.released) return;
    const n = pb.numColliders();
    for (const e of this.active.values()) {
      let touching = false;
      for (let i = 0; i < n && !touching; i++) {
        const pc = pb.collider(i);
        const test = (c: Collider | null) => {
          if (!c) return;
          this.world.contactPair(pc, c, (m) => {
            if (m.numContacts() > 0) touching = true;
          });
        };
        test(e.collider);
        test(e.trailerCollider);
      }
      if (touching && !e.touching && this.time - e.lastHit > 0.8) {
        e.lastHit = this.time;
        this.hit(e.vehicle!);
      }
      if (touching) this.sim.onPlayerContact(e.vehicle!);
      e.touching = touching;
    }
  }

  private hit(v: TrafficVehicle): void {
    const p = playerVehicle;
    let nx = v.x - p.x;
    let nz = v.z - p.z;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    const closing = (this.pvel.x - v.v * v.fx) * nx + (this.pvel.z - v.v * v.fz) * nz;
    this.sim.onPlayerCollision(v, Math.max(0, closing), [(v.x + p.x) / 2, (v.y + p.y) / 2 + 0.6, (v.z + p.z) / 2]);
  }

  private acquire(v: TrafficVehicle): void {
    const list = this.pool.get(v.kind);
    let e = list?.pop();
    if (!e) e = this.create(v);
    e.vehicle = v;
    e.touching = false;
    const pos = { x: v.x, y: v.y, z: v.z };
    e.body.setTranslation(pos, false);
    e.body.setRotation(yawPitchRoll(v.yaw, v.pitch, v.roll), false);
    e.body.setEnabled(true);
    if (e.trailer) {
      e.trailer.setTranslation({ x: v.tx, y: v.ty, z: v.tz }, false);
      e.trailer.setRotation(yawPitchRoll(v.tyaw, v.tpitch, 0), false);
      e.trailer.setEnabled(true);
    }
    this.active.set(v.id, e);
  }

  private release(id: number): void {
    const e = this.active.get(id);
    if (!e) return;
    this.active.delete(id);
    e.vehicle = null;
    if (this.released) return;
    e.body.setEnabled(false);
    e.trailer?.setEnabled(false);
    let list = this.pool.get(e.kind);
    if (!list) this.pool.set(e.kind, (list = []));
    list.push(e);
  }

  private create(v: TrafficVehicle): Entry {
    const R = this.rapier;
    const spec = v.spec;
    const make = (hw: number, hh: number, hl: number, lift: number): [Body, Collider] => {
      const body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
      const desc = R.ColliderDesc.cuboid(hw, hh, hl).setTranslation(0, lift + hh, 0).setCollisionGroups(TRAFFIC_COLLISION_GROUPS).setFriction(0.6);
      return [body, this.world.createCollider(desc, body)];
    };
    // Bodies start a little off the ground, like the Micra's, so they meet bumpers and doors.
    const lift = spec.kind === "okada" ? 0.25 : 0.2;
    const [body, collider] = make(spec.width / 2, (spec.height * 0.85 - lift) / 2, spec.length / 2, lift);
    let trailer: Body | null = null;
    let trailerCollider: Collider | null = null;
    if (spec.trailer) [trailer, trailerCollider] = make(spec.width / 2, 1.5, spec.trailer.length / 2, 0.6);
    return { kind: v.kind, body, collider, trailer, trailerCollider, vehicle: v, touching: false, lastHit: -9 };
  }

  /** Free every body. Call before <Physics> frees the world. */
  dispose(): void {
    if (this.released) return;
    this.released = true;
    const all = [...this.active.values(), ...[...this.pool.values()].flat()];
    for (const e of all) {
      this.world.removeRigidBody(e.body);
      if (e.trailer) this.world.removeRigidBody(e.trailer);
    }
    this.active.clear();
    this.pool.clear();
    this.sim.onRemove = null;
  }
}
