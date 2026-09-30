import { TRAFFIC_TUNING } from "@/game/config/trafficTuning";
import { gameEvents } from "@/game/core/events";
import type { Manifest } from "@/game/world/chunks/types";
import { type DirEdge, dirEdge, highwayRank, type RoadGraph, type Sample } from "@/game/world/RoadGraph";
import type { PlayerVehicle } from "@/game/vehicles/playerVehicle";

/**
 * People standing at the roadside waving for a taxi. They wait mostly at bus
 * stops and near markets, and anywhere along busy roads. Rival Micras (and
 * keke, okada, buses) race the player for them; whoever stops beside them
 * first gets them. Boarding into the player's car is up to the passenger
 * system: this only emits HAIL_REACHED.
 */

const H = TRAFFIC_TUNING.hailers;

/** `claimedBy` value when the player has stopped for them. */
export const PLAYER_CLAIM = -2;

export type Hailer = {
  id: number;
  /** They wave at traffic driving this way (they stand on its kerb side). */
  de: DirEdge;
  /** Centreline distance along `de`. */
  s: number;
  x: number;
  y: number;
  z: number;
  /** Facing, about +Y (0 = north). */
  yaw: number;
  /** -1 nobody, PLAYER_CLAIM, or the AI vehicle id coming for them. */
  claimedBy: number;
  /** Seconds left getting in, once a vehicle has stopped for them; -1 while waiting. */
  boarding: number;
  /** HAIL_REACHED already sent for the player's current stop. */
  reached: boolean;
  /** Arm raised 0–1 (eased), and animation phase. */
  wave: number;
  phase: number;
  /** Clothes palette index. */
  variant: number;
};

type Site = { de: DirEdge; s: number; x: number; z: number };

export type HailerContext = {
  focusX: number;
  focusZ: number;
  player: PlayerVehicle | null;
  /** 0–1: how many people are out (time of day × local zone). */
  busy: number;
  /** Edge ids near the focus, refreshed by traffic. */
  nearEdges: readonly number[];
  isVisible: (x: number, y: number, z: number, radius: number) => boolean;
  /** A taxi-like vehicle (or the player) is approaching this hailer: raise the arm. */
  taxiNear: (h: Hailer) => boolean;
};

const tmp: Sample = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };

export class HailerField {
  readonly hailers: Hailer[] = [];
  private readonly sites: Site[] = [];
  private nextId = 1;
  private spawnTimer = 0;

  constructor(private readonly graph: RoadGraph, manifest: Manifest) {
    const refs = [...(manifest.stops ?? []), ...(manifest.pois ?? []).filter((p) => p.type === "market")];
    for (const r of refs) {
      if (!r.road) continue;
      const e = graph.edges[r.road.edgeId];
      if (!e) continue;
      const forward = e.oneway || r.road.side === "right";
      this.sites.push({ de: dirEdge(e.id, forward), s: forward ? r.road.s : e.length - r.road.s, x: r.x, z: r.z });
    }
  }

  update(dt: number, ctx: HailerContext): void {
    const p = ctx.player;
    // Despawn far away; finish boarding.
    for (let i = this.hailers.length - 1; i >= 0; i--) {
      const h = this.hailers[i];
      if (Math.hypot(h.x - ctx.focusX, h.z - ctx.focusZ) > H.despawnDistance) {
        this.hailers.splice(i, 1);
        continue;
      }
      if (h.boarding >= 0) {
        h.boarding -= dt;
        continue;
      }
      // The player stopping beside them.
      if (p?.active) {
        const d = Math.hypot(p.x - h.x, p.z - h.z);
        if (d < H.reach && p.speed < 1.2) {
          h.claimedBy = PLAYER_CLAIM;
          if (!h.reached) {
            h.reached = true;
            gameEvents.emit("HAIL_REACHED", { hailId: h.id, vehicleId: p.id, position: [h.x, h.y, h.z] });
          }
        } else if (h.claimedBy === PLAYER_CLAIM && d > 15) {
          h.claimedBy = -1;
          h.reached = false;
        }
      }
      const target = ctx.taxiNear(h) ? 1 : 0;
      h.wave += (target - h.wave) * Math.min(1, dt * 4);
      h.phase += dt * (5 + (h.id % 3));
    }

    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 0.4;
    // Markets bring out more people than anywhere else.
    const target = Math.round(H.max * Math.min(1.7, Math.max(0.12, ctx.busy)));
    if (this.hailers.length < target) this.spawn(ctx);
  }

  /** Remove a hailer who got into a vehicle. */
  remove(h: Hailer): void {
    const i = this.hailers.indexOf(h);
    if (i >= 0) this.hailers.splice(i, 1);
  }

  get(id: number): Hailer | undefined {
    return this.hailers.find((h) => h.id === id);
  }

  private spawn(ctx: HailerContext): void {
    const [near, far] = H.spawnRange;
    const ok = (x: number, z: number) => {
      const d = Math.hypot(x - ctx.focusX, z - ctx.focusZ);
      if (d < near || d > far) return false;
      if (d < 150 && ctx.isVisible(x, 1, z, 2)) return false;
      return !this.hailers.some((h) => Math.hypot(h.x - x, h.z - z) < 6);
    };
    // Half at stops and markets when there are any around.
    if (Math.random() < 0.5) {
      const sites = this.sites.filter((s) => ok(s.x, s.z));
      if (sites.length) {
        const site = sites[Math.floor(Math.random() * sites.length)];
        this.place(site.de, site.s + (Math.random() - 0.5) * 6);
        return;
      }
    }
    const edges = ctx.nearEdges;
    for (let tries = 0; tries < 6 && edges.length; tries++) {
      const e = this.graph.edges[edges[Math.floor(Math.random() * edges.length)]];
      const rank = highwayRank(e.highway);
      if (rank < 0 || e.length < 30 || Math.random() > 0.3 + rank * 0.15) continue;
      const forward = e.oneway || Math.random() < 0.5;
      const de = dirEdge(e.id, forward);
      const s = 12 + Math.random() * (e.length - 24);
      this.graph.sample(de, s, tmp);
      if (!ok(tmp.x, tmp.z)) continue;
      this.place(de, s);
      return;
    }
  }

  private place(de: DirEdge, s: number): void {
    const g = this.graph;
    const line = g.polyline(de);
    s = Math.max(2, Math.min(line.length - 2, s));
    g.sample(de, s, tmp);
    const off = g.vergeOffset(de) + H.kerbGap;
    // Facing the road, turned towards oncoming traffic.
    const fx = tmp.dz * 0.8 - tmp.dx * 0.6;
    const fz = -tmp.dx * 0.8 - tmp.dz * 0.6;
    this.hailers.push({
      id: this.nextId++,
      de,
      s,
      x: tmp.x - tmp.dz * off,
      y: tmp.y + 0.08,
      z: tmp.z + tmp.dx * off,
      yaw: Math.atan2(-fx, -fz),
      claimedBy: -1,
      boarding: -1,
      reached: false,
      wave: 0,
      phase: Math.random() * 10,
      variant: Math.floor(Math.random() * 8),
    });
  }
}
