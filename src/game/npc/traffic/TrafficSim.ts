import { MICRA_TUNING } from "@/game/config/micraTuning";
import { TRAFFIC_TUNING as T } from "@/game/config/trafficTuning";
import { gameEvents, type TrafficVehicleKind } from "@/game/core/events";
import type { Manifest } from "@/game/world/chunks/types";
import { type DirEdge, highwayRank, reverseOf, type RoadGraph } from "@/game/world/RoadGraph";
import type { PlayerVehicle } from "@/game/vehicles/playerVehicle";
import { type Hailer, type HailerContext, HailerField, PLAYER_CLAIM } from "../hailers/hailers";
import { buildZones, densityNow, type DensityNow, readDensityOverrides, type Zone, zoneBoost } from "./density";
import { getJunctions, type Junction, type Junctions } from "./junctions";
import { edgePiece, LanePath, PIECE_TURN, type PathSample, type Piece, trimFor, turnPiece } from "./lanePath";
import { VEHICLE_KINDS, VEHICLE_SPECS, type VehicleSpec } from "./vehicleTypes";

/**
 * AI traffic around the player. Framework-free: TrafficLayer feeds it the
 * frame time, the player and a visibility test, and draws what it produces.
 *
 * Each vehicle follows a LanePath with the Intelligent Driver Model: a desired
 * speed (road limit × personality, capped by hills and bends) and a gap to
 * whatever is ahead. "Ahead" is found by sweeping the vehicle's own path
 * against every nearby vehicle's footprint (and the player's), so queues,
 * junction conflicts and cut-ins all come out of the same test. Junctions are
 * negotiated with signals (often ignored), roundabout yields, or road rank,
 * gaps, patience and the horn. Nothing is scripted: jams are what happens when
 * too many vehicles meet blocked junctions and taxis stopping anywhere.
 */

const G = 9.81;
const D = T.driver;
const J = T.junction;
const R = T.rivals;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp2 = (r: readonly [number, number], t: number) => r[0] + (r[1] - r[0]) * t;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Blocker id for the player (vehicle ids are ≥ 1). */
const PLAYER_ID = -2;
const NONE = -1;

export type TrafficVehicle = {
  id: number;
  kind: TrafficVehicleKind;
  spec: VehicleSpec;
  /** Model variant (e.g. sedan / SUV). */
  variant: number;
  /** Body paint and trailer paint, 0xRRGGBB. */
  color: number;
  color2: number;
  halfL: number;
  halfW: number;

  // Driver.
  aggression: number;
  patience: number;
  hornHappy: number;
  loaded: boolean;
  mass: number;
  /** W/kg at the wheels. */
  power: number;
  passengers: number;
  /** Okada/keke out after the curfew: fast, dark, running from OYRTMA. */
  fleeing: boolean;
  parked: boolean;

  // Path.
  path: LanePath;
  s: number;
  v: number;
  acc: number;
  /** Offset from the lane line, m (+ right), its target and rate. */
  dl: number;
  dlTarget: number;
  dlVel: number;
  route: DirEdge[] | null;
  routeIdx: number;
  wantsRoute: boolean;
  pathEnded: boolean;

  // Junction.
  jPiece: Piece | null;
  jGranted: boolean;
  jWait: number;
  jRunRoll: number;

  // Interaction.
  blocked: number;
  blockerId: number;
  followSlow: number;
  overtakeId: number;
  overtakeTime: number;
  ignoreId: number;
  ignoreTime: number;
  hailId: number;
  hailS: number;
  hailInLane: boolean;
  stealing: boolean;
  stopS: number;
  stopInLane: boolean;
  dwell: number;
  shaken: number;
  nudge: number;
  hornCooldown: number;
  hornAt: number;
  hornReason: "honkBack" | "impatient" | "warning" | "angry";
  thinkTimer: number;
  lastHonkAt: number;

  // Pose (world), heading unit vector and grade under the car.
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  fx: number;
  fz: number;
  grade: number;
  /** Trailer pose, articulated trucks only. */
  tx: number;
  ty: number;
  tz: number;
  tyaw: number;
  tpitch: number;
  braking: boolean;
  visible: boolean;
  /** Distance to the focus. */
  dist: number;
};

type Agent = {
  id: number;
  x: number;
  z: number;
  fx: number;
  fz: number;
  halfL: number;
  halfW: number;
  speed: number;
  vehicle: TrafficVehicle | null;
};

export type TrafficContext = {
  /** Where the bubble is centred: the player, or the free-fly camera. */
  focusX: number;
  focusZ: number;
  player: PlayerVehicle | null;
  isVisible: (x: number, y: number, z: number, radius: number) => boolean;
  /** Game time (s) and clock. */
  time: number;
  hour: number;
  weekday: number;
  day: number;
};

export type TrafficStats = {
  active: number;
  target: number;
  parked: number;
  byKind: Record<string, number>;
  hailers: number;
  stolen: number;
  horns: number;
  collisions: number;
};

const PALETTES: Record<TrafficVehicleKind, number[]> = {
  micra: [0xffffff, 0xf2eeee, 0xe8e2e0, 0xfaf4f0],
  car: [0xb8bcc2, 0x1c1d20, 0xe8e8e4, 0x1f2d4f, 0xbba27a, 0x5a1d24, 0x6c7076, 0x2f4a3a, 0xd0d2d4, 0x8e1b1b],
  peugeot: [0xe6e2d6, 0x4c6b8a, 0xd9ccaa, 0x8b2a22, 0x3f6147, 0x9a9486],
  keke: [0xe0b92c, 0xd4a82a, 0x2f7d3c, 0x2e5fa3, 0xe0b92c],
  okada: [0xa31d1d, 0x151515, 0x1c3f8f, 0xa31d1d, 0x7c7c7c],
  bus: [0xe7e0cc, 0xcfd6d9, 0xd2a93d, 0x7e8f9c, 0xf0eadb],
  truck: [0xe8e6df, 0xa82b22, 0x2c4f8a, 0x2f6b3c, 0xd9a520],
  trailer: [0xe8e6df, 0xa82b22, 0x2c4f8a, 0x444a52],
};
const CONTAINERS = [0x9b3a2a, 0x2b5d8c, 0x6f7d3f, 0xc9c3b3, 0x8a5a2b];
const VARIANTS: Record<TrafficVehicleKind, number> = { micra: 1, car: 2, peugeot: 2, keke: 1, okada: 1, bus: 1, truck: 2, trailer: 1 };

const rand = Math.random;
const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rand() * xs.length)];
/** Personality around a mean, spread ±0.3, clamped 0–1. */
const trait = (mean: number) => clamp(mean + (rand() + rand() - 1) * 0.3, 0, 1);

const scanS: PathSample = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0, piece: null as unknown as Piece };
const poseF: PathSample = { ...scanS };
const poseR: PathSample = { ...scanS };

/** Sample distances ahead of the bumper: fine near, coarse far. */
const SCAN_STEPS: number[] = [];
for (let d = 0.75; d < 15; d += 1.5) SCAN_STEPS.push(d);
for (let d = 16.5; d <= 90; d += 3) SCAN_STEPS.push(d);
const scanX = new Float32Array(SCAN_STEPS.length);
const scanZ = new Float32Array(SCAN_STEPS.length);
const scanDX = new Float32Array(SCAN_STEPS.length);
const scanDZ = new Float32Array(SCAN_STEPS.length);

type ScanHit = { gap: number; speed: number; agent: Agent | null; oncoming: boolean };
const scanHit = (): ScanHit => ({ gap: Infinity, speed: 0, agent: null, oncoming: false });
/** Reused scan results: straight ahead, right at the bumper, the far side of a junction, an overtaking lane. */
const hitMain = scanHit();
const hitNear = scanHit();
const hitExit = scanHit();
const hitPass = scanHit();

export class TrafficSim {
  readonly vehicles: TrafficVehicle[] = [];
  readonly hailers: HailerField;
  readonly junctions: Junctions;
  readonly zones: Zone[];
  readonly stats: TrafficStats = { active: 0, target: 0, parked: 0, byKind: {}, hailers: 0, stolen: 0, horns: 0, collisions: 0 };
  /** Called when a vehicle is removed (to free its physics body). */
  onRemove: ((v: TrafficVehicle) => void) | null = null;

  private readonly graph: RoadGraph;
  private readonly maxActive: number;
  private readonly byId = new Map<number, TrafficVehicle>();
  private readonly agents: Agent[] = [];
  private readonly agentPool: Agent[] = [];
  private readonly pool: TrafficVehicle[] = [];
  private readonly playerAgent: Agent = { id: PLAYER_ID, x: 0, z: 0, fx: 0, fz: -1, halfL: 1.86, halfW: 0.79, speed: 0, vehicle: null };
  private nextId = 1;
  private near: number[] = [];
  private nearWeights: number[] = [];
  private nearTimer = 0;
  private now: DensityNow = densityNow(10, 1, 0);
  private focusBoost = 1;
  /** Market activity around the focus (0 none … marketDayBoost on a market day at its peak). */
  private marketHere = 0;
  private target = 0;
  private filled = false;
  private surplusTimer = 0;
  private routesThisFrame = 0;
  private ctx: TrafficContext | null = null;
  private frameDt = 1 / 60;
  private readonly hailerCtx: HailerContext = {
    focusX: 0,
    focusZ: 0,
    player: null,
    busy: 0,
    nearEdges: [],
    isVisible: () => false,
    taxiNear: (h) => this.taxiNear(h),
  };
  private readonly nodeIds: number[];

  constructor(graph: RoadGraph, manifest: Manifest, maxActive: number) {
    this.graph = graph;
    this.maxActive = maxActive;
    this.junctions = getJunctions(graph, manifest);
    this.hailers = new HailerField(graph, manifest);
    this.zones = buildZones(manifest);
    this.nodeIds = [...graph.nodes.keys()];
    readDensityOverrides();
  }

  /** Listen for the player's horn. Returns a teardown that also clears every vehicle. */
  start(): () => void {
    const off = gameEvents.on("HORN", (e) => {
      if (e.vehicleId === this.ctx?.player?.id) this.onPlayerHorn();
    });
    return () => {
      off();
      for (const v of [...this.vehicles]) this.remove(v);
      this.filled = false;
    };
  }

  vehicle(id: number): TrafficVehicle | undefined {
    return this.byId.get(id);
  }

  // --- frame -----------------------------------------------------------------

  update(dt: number, ctx: TrafficContext): void {
    this.ctx = ctx;
    this.routesThisFrame = 0;
    if (dt <= 0) return;
    this.frameDt = dt;

    this.nearTimer -= dt;
    if (this.nearTimer <= 0) {
      this.nearTimer = 1;
      this.refreshNear(ctx);
    }

    this.buildAgents(ctx);
    for (const v of this.vehicles) this.think(v, dt, ctx);
    this.resolveDeadlocks(dt);
    for (const v of this.vehicles) this.integrate(v, dt);
    for (const v of this.vehicles) this.pose(v, ctx);
    this.honk(ctx);

    const hc = this.hailerCtx;
    hc.focusX = ctx.focusX;
    hc.focusZ = ctx.focusZ;
    hc.player = ctx.player;
    hc.busy = this.now.profile * this.focusBoost * (1 + this.marketHere * 0.3);
    hc.nearEdges = this.near;
    hc.isVisible = ctx.isVisible;
    this.hailers.update(dt, hc);

    this.cull(dt);
    this.spawn(ctx);
    this.collectStats();
  }

  // --- world around the focus ---------------------------------------------------

  private refreshNear(ctx: TrafficContext): void {
    this.now = densityNow(ctx.hour, ctx.weekday, ctx.day);
    const here = zoneBoost(this.zones, this.now, ctx.focusX, ctx.focusZ);
    this.focusBoost = here.total;
    this.marketHere = here.market;
    this.target = Math.round(this.maxActive * clamp(this.now.profile * Math.min(1.6, this.focusBoost), 0.04, 1));

    const g = this.graph;
    g.edgesNear(ctx.focusX, ctx.focusZ, T.simRadius, this.near);
    this.nearWeights.length = 0;
    let total = 0;
    for (const id of this.near) {
      const e = g.edges[id];
      const mid = e.polyline[Math.floor(e.polyline.length / 2)];
      const d = Math.hypot(mid[0] - ctx.focusX, mid[2] - ctx.focusZ);
      const base = e.highway.replace("_link", "");
      let w = e.length * (T.roadWeight[base] ?? T.roadWeight.other);
      if (d > T.simRadius) w *= 0.2;
      // Busy zones pull the traffic in tighter around you.
      const falloff = T.spawnFalloff / Math.sqrt(this.focusBoost);
      w *= zoneBoost(this.zones, this.now, mid[0], mid[2]).total / (1 + (d / falloff) ** 2);
      total += w;
      this.nearWeights.push(total);
    }
  }

  private buildAgents(ctx: TrafficContext): void {
    const agents = this.agents;
    agents.length = 0;
    let n = 0;
    const next = () => (this.agentPool[n++] ??= { id: 0, x: 0, z: 0, fx: 0, fz: -1, halfL: 0, halfW: 0, speed: 0, vehicle: null });
    for (const v of this.vehicles) {
      agents.push(agentOf(v, 0, next()));
      if (v.spec.trailer) agents.push(agentOf(v, 1, next()));
    }
    const p = ctx.player;
    if (p?.active) {
      const a = this.playerAgent;
      a.x = p.x;
      a.z = p.z;
      a.fx = p.fx;
      a.fz = p.fz;
      a.halfL = p.halfLength;
      a.halfW = p.halfWidth;
      a.speed = p.vx * p.fx + p.vz * p.fz;
      agents.push(a);
    }
  }

  // --- driving ---------------------------------------------------------------

  private think(v: TrafficVehicle, dt: number, ctx: TrafficContext): void {
    if (v.parked) {
      v.acc = 0;
      v.v = 0;
      v.braking = false;
      return;
    }
    this.extendPath(v);
    this.updateJunction(v);

    const spec = v.spec;
    const aMax = spec.accel * (v.loaded ? 0.75 : 1);
    const b = spec.brake;
    const headway = lerp2(D.headway, v.aggression);
    const s0 = lerp2(D.minGap, v.aggression) * (v.kind === "okada" ? 0.35 : 1);

    v.thinkTimer -= dt;
    const slowThink = v.thinkTimer <= 0;
    if (slowThink) v.thinkTimer = 0.25 + rand() * 0.1;

    // Desired speed.
    let v0 = this.desiredSpeed(v);

    // What's ahead in our path. Pulling out to pass, look where we're heading and creep while we get there.
    const swerving = v.overtakeId !== NONE && Math.abs(v.dlTarget - v.dl) > 0.25;
    const hit = this.scan(v, swerving ? v.dlTarget : v.dl, Math.min(90, 18 + v.v * 4), hitMain);
    // ...but not through whatever is right in front of the bumper now.
    if (swerving) v0 = Math.min(v0, this.scan(v, v.dl, 3, hitNear).gap < 0.8 ? 0.2 : 3);
    let gap = hit.gap;
    let vl = hit.speed;
    v.blockerId = hit.agent ? hit.agent.id : NONE;

    // Oncoming in our path (overtaking, narrow road): squeeze right.
    if (hit.agent && hit.oncoming && hit.gap < 30) {
      v.dlTarget = Math.max(v.dlTarget, this.kerbDl(v) - 0.1);
      if (v.overtakeId !== NONE) this.endOvertake(v);
    }

    // Junction stop line.
    if (v.jPiece && !v.jGranted) {
      const toLine = v.jPiece.s0 - (v.s + v.halfL);
      const decide = Math.max(10, (v.v * v.v) / (2 * b) + 8);
      if (toLine < decide) {
        const j = this.junctions.get(v.jPiece.node)!;
        if (this.mayEnter(v, j, v.jPiece, toLine, ctx)) {
          v.jGranted = true;
          j.occupants.add(v.id);
        } else {
          if (toLine < 4 && v.v < 0.5) v.jWait += dt;
          if (toLine - 0.3 < gap) {
            gap = toLine - 0.3;
            vl = 0;
          }
        }
      }
    }

    // People waving, drop-offs and bus stops.
    if (slowThink) this.seekHail(v, ctx);
    const stop = this.stopTarget(v);
    if (stop !== null) {
      const g = stop - (v.s + v.halfL * 0.2);
      if (g < gap) {
        gap = g;
        vl = 0;
      }
    }
    if (v.pathEnded) {
      const g = v.path.end - (v.s + v.halfL) - 1;
      if (g < gap) {
        gap = g;
        vl = 0;
      }
    }

    // IDM.
    let acc: number;
    if (v.dwell > 0 || v.shaken > 0) {
      acc = -b * 1.5;
    } else {
      const free = v.v <= v0 ? aMax * (1 - (v.v / v0) ** D.delta) : -b * Math.min(1, (v.v - v0) / 3);
      let inter = 0;
      if (gap < 150) {
        const sStar = s0 + Math.max(0, v.v * headway + (v.v * (v.v - vl)) / (2 * Math.sqrt(aMax * b)));
        inter = aMax * (sStar / Math.max(gap, 0.05)) ** 2;
      }
      acc = free - inter;
      if (gap < 0.3) acc = Math.min(acc, -D.maxBrake);
    }
    v.acc = clamp(acc, -D.maxBrake, aMax);

    // Stuck behind something.
    const stuck = v.v < 0.5 && (hit.gap < 8 || (v.jPiece !== null && !v.jGranted));
    v.blocked = stuck && v.dwell <= 0 ? v.blocked + dt : 0;
    if (v.blocked > lerp2(D.hornAfter, v.hornHappy) && v.hornCooldown <= 0 && v.hornAt < 0) this.queueHorn(v, ctx.time, "impatient");

    if (slowThink) this.considerOvertake(v, hit, dt + 0.25);
    this.steer(v);
  }

  /** Road limit × personality, capped by type, hills (power per kg), bends ahead and the curfew. */
  private desiredSpeed(v: TrafficVehicle): number {
    const spec = v.spec;
    const piece = v.path.pieceAt(v.s);
    const de = piece.kind === PIECE_TURN ? piece.next : piece.de;
    const e = this.graph.edge(de);
    let v0 = Math.min(spec.maxSpeed, (e.speedLimitKph / 3.6) * lerp2(D.speedFactor, v.aggression));
    if (e.surface === "unpaved") v0 *= 0.7;
    if (v.fleeing) v0 = spec.maxSpeed;
    if (v.stealing) v0 *= R.stealSpeedBoost;
    if (v.nudge > 0) v0 *= 0.8;

    // Hills: sustained power caps the climb; downhill, drivers let it run (trucks hold back).
    const grade = v.grade;
    if (grade > 0) v0 = Math.min(v0, v.power / (G * (grade + 0.015)));
    else if (spec.downhill < 1) v0 *= 1 - Math.min(0.3, -grade * 2) * (1 - spec.downhill) * 3;
    else v0 *= 1 + Math.min(D.downhillMax, -grade * D.downhillGain) * (0.4 + v.aggression);

    // Bends: slow down in time for each turn in the next 80 m.
    const aLat = lerp2(D.lateralAccel, v.aggression) * (v.kind === "okada" ? 1.2 : spec.height > 2 ? 0.7 : 1);
    const b = spec.brake;
    for (const p of v.path.pieces) {
      if (p.kind !== PIECE_TURN || p.s0 + p.length < v.s) continue;
      const d = p.s0 - (v.s + v.halfL);
      if (d > 80) break;
      const vt = Math.max(2.5, Math.sqrt(aLat * p.radius));
      v0 = Math.min(v0, Math.sqrt(vt * vt + 2 * b * Math.max(0, d)));
    }
    return Math.max(1, v0);
  }

  /**
   * Nearest thing in this vehicle's path within maxDist, with `lateral` offset
   * from its lane: sweep points along the path and test them against each
   * nearby footprint (oriented rectangles).
   */
  private scan(v: TrafficVehicle, lateral: number, maxDist: number, out: ScanHit): ScanHit {
    const path = v.path;
    const front = v.s + v.halfL;
    let n = 0;
    const end = path.end;
    for (; n < SCAN_STEPS.length; n++) {
      const d = SCAN_STEPS[n];
      if (d > maxDist || front + d > end) break;
      path.sample(front + d, lateral, scanS);
      scanX[n] = scanS.x;
      scanZ[n] = scanS.z;
      scanDX[n] = scanS.dx;
      scanDZ[n] = scanS.dz;
    }
    out.gap = Infinity;
    out.speed = 0;
    out.agent = null;
    out.oncoming = false;
    if (n === 0) return out;
    const reach = maxDist + 20;
    for (const a of this.agents) {
      if (a.vehicle === v || a.id === v.ignoreId) continue;
      const rx = a.x - v.x;
      const rz = a.z - v.z;
      if (rx * rx + rz * rz > reach * reach) continue;
      // Behind us (and not overlapping): skip.
      if (rx * v.fx + rz * v.fz < -a.halfL) continue;
      for (let k = 0; k < n; k++) {
        const d = SCAN_STEPS[k];
        if (d - 0.75 >= out.gap) break;
        const px = scanX[k] - a.x;
        const pz = scanZ[k] - a.z;
        const lz = px * a.fx + pz * a.fz;
        const lx = px * -a.fz + pz * a.fx;
        const align = Math.abs(scanDX[k] * a.fx + scanDZ[k] * a.fz);
        const opposite = scanDX[k] * a.fx + scanDZ[k] * a.fz < -0.5;
        const margin = opposite ? 0.15 : a.id === PLAYER_ID ? 0.35 : 0.25;
        const ex = a.halfW + v.halfW * align + (1 - align) * 0.5 + margin;
        const ez = a.halfL + v.halfW * (1 - align) + 0.3;
        if (Math.abs(lx) < ex && Math.abs(lz) < ez) {
          out.gap = Math.max(0, d - 0.75);
          out.speed = Math.max(0, a.speed * (scanDX[k] * a.fx + scanDZ[k] * a.fz));
          out.agent = a;
          out.oncoming = opposite;
          break;
        }
      }
    }
    return out;
  }

  private steer(v: TrafficVehicle): void {
    const kerb = this.kerbDl(v);
    const far = this.farDl(v);
    let target = v.dlTarget;
    if (v.nudge > 0) target = Math.max(target, Math.min(kerb, T.horn.nudge * (v.spec.maxSpeed < 20 ? 1.3 : 1)));
    // Ease back to the lane line in bends unless passing.
    const piece = v.path.pieceAt(v.s);
    if (piece.kind === PIECE_TURN && v.overtakeId === NONE && v.hailId === NONE && !hasStop(v)) target *= 0.3;
    v.dlTarget = clamp(v.dlTarget, far, kerb);
    target = clamp(target, far, kerb);
    const rate = Math.min(lerp2(D.swerveRate, v.aggression) * (v.stealing ? 1.5 : 1), 0.35 * v.v + 0.25);
    v.dlVel = clamp((target - v.dl) * 2, -rate, rate);
    // Never slide sideways into someone alongside (cutting in ahead of them is another matter).
    if (Math.abs(v.dlVel) > 0.01 && this.sideBlocked(v, Math.sign(v.dlVel), Math.abs(target - v.dl))) v.dlVel = 0;
  }

  /** Is anything alongside on side `dir` (+1 right, -1 left) within `move` metres of our flank? */
  private sideBlocked(v: TrafficVehicle, dir: number, move: number): boolean {
    for (const a of this.agents) {
      if (a.vehicle === v) continue;
      const rx = a.x - v.x;
      const rz = a.z - v.z;
      if (rx * rx + rz * rz > 400) continue;
      const lz = rx * v.fx + rz * v.fz;
      const lx = rx * -v.fz + rz * v.fx;
      if (Math.sign(lx) !== dir) continue;
      // Their extent across our heading.
      const across = Math.abs(a.fx * -v.fz + a.fz * v.fx);
      const theirHalfW = a.halfW * (1 - across) + a.halfL * across;
      const theirHalfL = a.halfL * (1 - across) + a.halfW * across;
      if (Math.abs(lz) > v.halfL + theirHalfL + 0.3) continue;
      if (Math.abs(lx) - v.halfW - theirHalfW < Math.min(move, 1.5) + 0.25) return true;
    }
    return false;
  }

  private integrate(v: TrafficVehicle, dt: number): void {
    if (v.parked) return;
    const nv = Math.max(0, v.v + v.acc * dt);
    v.s += (v.v + nv) * 0.5 * dt;
    v.v = nv;
    v.dl += v.dlVel * dt;
    v.braking = v.acc < -0.8 || v.v < 0.3;

    if (v.dwell > 0) {
      v.dwell -= dt;
      if (v.dwell <= 0) this.finishStop(v);
    }
    v.shaken = Math.max(0, v.shaken - dt);
    v.nudge = Math.max(0, v.nudge - dt);
    v.hornCooldown = Math.max(0, v.hornCooldown - dt);
    v.ignoreTime -= dt;
    if (v.ignoreTime <= 0) v.ignoreId = NONE;

    // Random drop-offs: a Micra, keke or okada stops wherever someone wants down.
    if (v.passengers > 0 && v.spec.takesHails > 0 && v.hailId === NONE && !hasStop(v) && v.dwell <= 0 && v.v > 3) {
      if (rand() < (R.dropsPerKm / 1000) * v.v * dt) {
        v.stopS = v.s + (v.v * v.v) / (2 * v.spec.brake) + 5 + rand() * 10;
        v.stopInLane = rand() < R.stopInLane;
        if (!v.stopInLane) v.dlTarget = this.kerbDl(v);
      }
    }

    // Leaving a junction box.
    if (v.jPiece && v.s - v.halfL > v.jPiece.s0 + v.jPiece.length) {
      this.junctions.get(v.jPiece.node)?.occupants.delete(v.id);
      v.jPiece = null;
      v.jGranted = false;
      v.jWait = 0;
    }
    if (v.overtakeId !== NONE) {
      v.overtakeTime += dt;
      this.progressOvertake(v);
    }
    v.path.dropBefore(v.s - 40);
  }

  /** Front/rear axle samples give position, yaw and pitch; swerving turns the nose. */
  private pose(v: TrafficVehicle, ctx: TrafficContext): void {
    if (v.parked && v.x !== 0) {
      v.dist = Math.hypot(v.x - ctx.focusX, v.z - ctx.focusZ);
      v.visible = ctx.isVisible(v.x, v.y + 1, v.z, v.halfL + 1);
      return;
    }
    const half = v.spec.wheelbase / 2;
    const f = v.path.sample(v.s + half, v.dl, poseF);
    const r = v.path.sample(v.s - half, v.dl, poseR);
    let dx = f.x - r.x;
    let dz = f.z - r.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-3) {
      dx /= len;
      dz /= len;
    } else {
      dx = f.dx;
      dz = f.dz;
    }
    const prevYaw = v.yaw;
    v.x = (f.x + r.x) / 2;
    v.y = (f.y + r.y) / 2 + 0.05;
    v.z = (f.z + r.z) / 2;
    v.fx = dx;
    v.fz = dz;
    v.yaw = Math.atan2(-dx, -dz) - Math.atan2(v.dlVel, Math.max(v.v, 2));
    v.pitch = Math.atan2(f.y - r.y, Math.max(len, 0.1));
    v.grade = (f.y - r.y) / Math.max(len, 0.1);
    if (v.kind === "okada") {
      // Lean into bends from the yaw rate.
      let dyaw = v.yaw - prevYaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const lean = clamp(Math.atan((v.v * dyaw) / this.frameDt / G), -0.45, 0.45);
      v.roll += (lean - v.roll) * 0.15;
    }
    const tr = v.spec.trailer;
    if (tr) {
      const h = v.path.sample(v.s - tr.hitch, v.dl, poseF);
      const a = v.path.sample(v.s - tr.hitch - tr.axle, v.dl, poseR);
      let tdx = h.x - a.x;
      let tdz = h.z - a.z;
      const tl = Math.hypot(tdx, tdz) || 1;
      tdx /= tl;
      tdz /= tl;
      const back = tr.length / 2 - 1;
      v.tx = h.x - tdx * back;
      v.ty = (h.y + a.y) / 2 + 0.05;
      v.tz = h.z - tdz * back;
      v.tyaw = Math.atan2(-tdx, -tdz);
      v.tpitch = Math.atan2(h.y - a.y, tl);
    }
    v.dist = Math.hypot(v.x - ctx.focusX, v.z - ctx.focusZ);
    v.visible = ctx.isVisible(v.x, v.y + 1, v.z, v.halfL + (tr ? tr.length : 0) + 1);
  }

  // --- path planning -----------------------------------------------------------

  private extendPath(v: TrafficVehicle): void {
    let guard = 0;
    while (!v.pathEnded && v.path.end - v.s < 150 && guard++ < 6) {
      const last = v.path.last!;
      const node = this.graph.toNode(last.de);
      const next = this.chooseNext(v, last.de, node);
      if (next === null) {
        v.pathEnded = true;
        break;
      }
      const e = this.graph.edge(next);
      const far = this.graph.toNode(next);
      const a = trimFor(this.graph, node, e.length, this.graph.junctionTrim(far));
      const b = e.length - trimFor(this.graph, far, e.length, this.graph.junctionTrim(node));
      const lane = this.laneFor(v, next);
      const piece = edgePiece(this.graph, next, lane, a, Math.max(a + 0.1, b));
      v.path.append(turnPiece(last, piece, node));
      v.path.append(piece);
    }
  }

  private laneFor(v: TrafficVehicle, de: DirEdge): number {
    const n = this.graph.lanes(de);
    if (n < 2) return 0;
    // Private cars and fleeing okada take the fast lane; everyone who stops for people keeps to the kerb.
    return v.kind === "car" || v.fleeing ? n - 1 : 0;
  }

  private chooseNext(v: TrafficVehicle, cur: DirEdge, node: number): DirEdge | null {
    const g = this.graph;
    // Follow the route while it still starts here.
    if (v.route && v.routeIdx < v.route.length) {
      const de = v.route[v.routeIdx];
      if (g.fromNode(de) === node) {
        v.routeIdx++;
        return de;
      }
      v.route = null;
    }
    const out = g.out(node);
    const back = reverseOf(cur);
    let total = 0;
    const weights = weightScratch;
    weights.length = 0;
    const h0 = headScratch0;
    const h1 = headScratch1;
    g.heading(cur, true, h0);
    for (const de of out) {
      let w = 0;
      if (de !== back) {
        const e = g.edge(de);
        const rank = highwayRank(e.highway);
        g.heading(de, false, h1);
        const cos = h0.x * h1.x + h0.z * h1.z;
        w = (cos > 0.8 ? 3 : cos > -0.3 ? 1 : 0.25) * (1.5 + rank);
        if (rank < v.spec.minRank) w *= 0.01;
        if (!e.oneway && e.lanes <= 1) w *= 0.3;
        if (v.fleeing && rank >= 3) w *= 0.3;
      }
      total += w;
      weights.push(total);
    }
    if (total <= 0) {
      // Dead end: turn round if the road allows it.
      return out.includes(back) ? back : null;
    }
    const r = rand() * total;
    for (let i = 0; i < out.length; i++) if (r < weights[i]) return out[i];
    return out[out.length - 1];
  }

  /** A* to somewhere 0.6–2.5 km away, for vehicles going somewhere in particular. */
  private planRoute(v: TrafficVehicle): void {
    v.wantsRoute = false;
    if (this.routesThisFrame >= 2) {
      v.wantsRoute = true;
      return;
    }
    this.routesThisFrame++;
    const g = this.graph;
    const start = g.toNode(v.path.last!.de);
    const sn = g.nodes.get(start);
    if (!sn) return;
    for (let tries = 0; tries < 4; tries++) {
      const id = pick(this.nodeIds);
      const n = g.nodes.get(id)!;
      const d = Math.hypot(n.x - sn.x, n.z - sn.z);
      if (d < 600 || d > 2500 || n.degree < 3) continue;
      const spec = v.spec;
      const route = g.route(start, id, {
        maxExpansions: 3000,
        cost: (e) => {
          const r = highwayRank(e.highway);
          let c = r < spec.minRank ? spec.minorCost : 1;
          if (!e.oneway && e.lanes <= 1) c *= 3;
          if (v.fleeing && r >= 3) c *= 2.5;
          return c;
        },
      });
      if (route) {
        v.route = route;
        v.routeIdx = 0;
        return;
      }
    }
  }

  // --- junctions ---------------------------------------------------------------

  /** Track the next junction turn ahead that needs a decision. */
  private updateJunction(v: TrafficVehicle): void {
    if (v.jPiece) return;
    for (const p of v.path.pieces) {
      if (p.kind !== PIECE_TURN || p.s0 + p.length < v.s - v.halfL) continue;
      if (p.s0 - v.s > 90) break;
      if (!this.junctions.get(p.node)) continue;
      v.jPiece = p;
      v.jGranted = p.s0 < v.s; // already in the box (spawned there)
      v.jWait = 0;
      v.jRunRoll = rand();
      if (v.jGranted) this.junctions.get(p.node)!.occupants.add(v.id);
      return;
    }
  }

  private mayEnter(v: TrafficVehicle, j: Junction, piece: Piece, toLine: number, ctx: TrafficContext): boolean {
    if (v.jWait > lerp2(J.forceAfter, 1 - v.patience)) return true;
    const impatient = v.jWait > lerp2(J.patienceWait, 1 - v.patience);
    let gapT = lerp2(J.gapAccept, v.aggression) * (impatient ? 0.5 : 1) * (v.fleeing ? 0.3 : 1);
    if (impatient && v.hornCooldown <= 0 && v.hornAt < 0 && rand() < v.hornHappy) this.queueHorn(v, ctx.time, "impatient");

    let green = false;
    if (j.control === "signal" && !j.dead) {
      const light = this.junctions.signal(j, piece.de, ctx.time);
      if (light === "red") {
        const chance = lerp2(J.runRed, v.aggression) + (this.now.night ? J.runRedNight : 0) + (v.fleeing ? 1 : 0);
        const rightOnRed = piece.turn > 0.6 && v.aggression > 0.5;
        if (v.jRunRoll > chance && !rightOnRed) return false;
        gapT *= 0.8;
      } else if (light === "amber") {
        const cantStop = toLine < (v.v * v.v) / (2 * v.spec.brake) + 1;
        if (!cantStop && v.aggression < 0.55) return false;
        green = true;
      } else green = true;
    }

    // Whoever is already in the box on a crossing path goes first.
    for (const id of j.occupants) {
      const u = this.byId.get(id);
      if (!u || !u.jPiece || u === v || u.jPiece.de === piece.de) continue;
      const left = u.jPiece.s0 + u.jPiece.length - (u.s - u.halfL);
      if (left < 1.5) continue;
      if (piecesCross(piece, u.jPiece, v.halfW + u.halfW + 0.6)) return false;
    }
    const p = ctx.player;
    if (p?.active && minDistToPiece(piece, p.x, p.z) < p.halfWidth + v.halfW + 1.5 && Math.hypot(p.x - j.x, p.z - j.z) < this.graph.junctionTrim(j.node) + 4) {
      return false;
    }

    // Timid drivers don't enter a box they can't clear.
    if (v.aggression < 0.5 && !this.exitClear(v, piece)) return false;
    if (green) return true;

    const myRank = highwayRank(this.graph.edge(piece.de).highway);
    const myRing = this.graph.edge(piece.de).roundabout === true;
    const enteringRing = j.control === "roundabout" && !myRing && this.graph.edge(piece.next).roundabout === true;

    for (const u of this.vehicles) {
      const up = u.jPiece;
      if (u === v || !up || up.node !== j.node || u.jGranted || up.de === piece.de || u.parked) continue;
      const du = up.s0 - (u.s + u.halfL);
      if (du > 45) continue;
      if (!piecesCross(piece, up, v.halfW + u.halfW + 0.6)) continue;
      const eta = du / Math.max(u.v, 0.1);
      const uRing = this.graph.edge(up.de).roundabout === true;
      if (enteringRing && uRing) {
        // Roundabout: give way to traffic already going round.
        if (du < J.roundaboutYield && (u.v > 0.5 || du < 4)) return false;
        continue;
      }
      const uRank = highwayRank(this.graph.edge(up.de).highway);
      if (uRank > myRank + 0.4 && !myRing) {
        if (eta < gapT) return false;
      } else if (Math.abs(uRank - myRank) <= 0.4 || myRing === uRing) {
        const bothWaiting = du < 3 && u.v < 0.5 && toLine < 3 && v.v < 0.5;
        if (bothWaiting) {
          if (assertiveness(u, ctx.time) > assertiveness(v, ctx.time)) return false;
        } else if (u.v > 1 && eta < gapT * 0.8) return false;
      } else if (u.v > 3 && eta < 1) {
        // They should give way, but they're not going to.
        return false;
      }
    }

    // The player coming at the junction from another arm.
    if (p?.active && p.speed > 1) {
      const dx = j.x - p.x;
      const dz = j.z - p.z;
      const d = Math.hypot(dx, dz);
      const toward = (dx * p.fx + dz * p.fz) / (d || 1);
      const inHead = headScratch0;
      this.graph.heading(piece.de, true, inHead);
      const sameArm = inHead.x * p.fx + inHead.z * p.fz > 0.85;
      if (d < 50 && toward > 0.5 && !sameArm) {
        const eta = (d - this.graph.junctionTrim(j.node)) / p.speed;
        const hit = this.graph.nearestLane(p.x, p.z, 8, p.fx, p.fz);
        const pRank = hit ? highwayRank(hit.edge.highway) : myRank;
        if (eta < gapT * (pRank > myRank + 0.4 ? 1 : 0.6)) return false;
      }
    }
    return true;
  }

  /** Room on the far side of the turn for the whole vehicle? */
  private exitClear(v: TrafficVehicle, piece: Piece): boolean {
    const beyond = piece.s0 + piece.length + v.halfL * 2 + 2;
    const hit = this.scan(v, v.dl, Math.max(0, beyond - (v.s + v.halfL)), hitExit);
    return !(hit.agent && hit.speed < 1 && hit.agent.id !== PLAYER_ID && hit.gap > piece.s0 - (v.s + v.halfL));
  }

  /** Two vehicles each waiting on the other: the pushier one goes. */
  private resolveDeadlocks(dt: number): void {
    for (const v of this.vehicles) {
      if (v.blocked < 2.5 || v.blockerId <= 0) continue;
      const u = this.byId.get(v.blockerId);
      if (!u || u.blockerId !== v.id || u.blocked < 2.5) continue;
      const t = this.ctx?.time ?? 0;
      const [win, lose] = assertiveness(v, t) >= assertiveness(u, t) ? [v, u] : [u, v];
      win.ignoreId = lose.id;
      win.ignoreTime = 3;
      // Head-on on a narrow road: the loser squeezes onto the verge.
      if (win.fx * lose.fx + win.fz * lose.fz < -0.3) lose.dlTarget = this.kerbDl(lose) + 0.6;
      if (lose.hornCooldown <= 0 && lose.hornAt < 0 && rand() < lose.hornHappy) this.queueHorn(lose, t + dt, "angry");
    }
  }

  // --- rivals, hailers, stops -----------------------------------------------------

  private seekHail(v: TrafficVehicle, ctx: TrafficContext): void {
    if (v.hailId !== NONE) {
      const h = this.hailers.get(v.hailId);
      if (!h || (h.claimedBy !== v.id && h.boarding < 0)) {
        // Someone else (maybe you) got them.
        if (v.kind === "micra" && h?.claimedBy === PLAYER_CLAIM && v.hornCooldown <= 0 && v.hornAt < 0) this.queueHorn(v, ctx.time, "angry");
        this.releaseHail(v);
      }
      return;
    }
    const spec = v.spec;
    if (spec.takesHails <= 0 || v.fleeing || v.passengers >= capacity(v) || v.dwell > 0 || hasStop(v)) return;
    const p = ctx.player;
    let best: Hailer | null = null;
    let bestS = Infinity;
    for (const h of this.hailers.hailers) {
      if (h.boarding >= 0) continue;
      if (h.claimedBy !== NONE) {
        const other = this.byId.get(h.claimedBy);
        // Steal from a slower claimant further back; never from the player once stopped for them.
        if (h.claimedBy === PLAYER_CLAIM || !other || other.kind !== "micra" || v.kind !== "micra" || other.dist < v.dist) continue;
      }
      const hs = v.path.pathSOnEdge(h.de, h.s, v.s);
      if (hs === null) continue;
      const ahead = hs - v.s;
      if (ahead < 6 + (v.v * v.v) / (2 * spec.brake * 1.6) || ahead > R.hailSight) continue;
      // Keke, okada and buses don't stop for everyone.
      if (spec.takesHails < 1 && hashPair(v.id, h.id) > spec.takesHails) continue;
      if (hs < bestS) {
        bestS = hs;
        best = h;
      }
    }
    if (!best) return;
    const prev = best.claimedBy > 0 ? this.byId.get(best.claimedBy) : undefined;
    if (prev) this.releaseHail(prev);
    best.claimedBy = v.id;
    v.hailId = best.id;
    v.hailS = bestS;
    v.hailInLane = rand() < R.stopInLane * (0.5 + v.aggression);
    // Is the player between us and them, going for the same person? Race them.
    v.stealing = false;
    if (v.kind === "micra" && p?.active) {
      const dp = Math.hypot(p.x - best.x, p.z - best.z);
      const toP = (p.x - v.x) * v.fx + (p.z - v.z) * v.fz;
      if (dp < R.stealRange && toP > 0 && toP < bestS - v.s && v.aggression > 0.35) v.stealing = true;
    }
    if (!v.hailInLane && !v.stealing) v.dlTarget = this.kerbDl(v);
  }

  private releaseHail(v: TrafficVehicle): void {
    const h = this.hailers.get(v.hailId);
    if (h && h.claimedBy === v.id && h.boarding < 0) h.claimedBy = NONE;
    v.hailId = NONE;
    v.stealing = false;
    if (!hasStop(v)) v.dlTarget = 0;
  }

  /** Path s to stop at (a hailer or a drop-off), and start the dwell once stopped there. */
  private stopTarget(v: TrafficVehicle): number | null {
    let at: number | null = null;
    if (v.hailId !== NONE) at = v.hailS + 1.2;
    else if (hasStop(v)) at = v.stopS;
    if (at === null || v.dwell > 0) return at;
    const ahead = at - v.s;
    if (ahead < 3 && v.v < 0.6) {
      const market = zoneBoost(this.zones, this.now, v.x, v.z).market;
      v.dwell = lerp2(R.dwell, rand()) * (v.kind === "bus" ? 1.4 : 1) * (1 + market * 0.4);
      if (v.hailId !== NONE) {
        const h = this.hailers.get(v.hailId);
        if (h && h.claimedBy === v.id) h.boarding = v.dwell;
      }
      return null;
    }
    // Missed it (pushed past by traffic): give up.
    if (ahead < -4) {
      if (v.hailId !== NONE) this.releaseHail(v);
      v.stopS = Number.NaN;
      v.dlTarget = 0;
      return null;
    }
    return at;
  }

  private finishStop(v: TrafficVehicle): void {
    if (v.hailId !== NONE) {
      const h = this.hailers.get(v.hailId);
      if (h && h.claimedBy === v.id) {
        this.hailers.remove(h);
        v.passengers = Math.min(capacity(v), v.passengers + 1 + (rand() < 0.25 ? 1 : 0));
        this.stats.stolen++;
        gameEvents.emit("PASSENGER_STOLEN", { hailId: h.id, vehicleId: `traffic-${v.id}`, position: [h.x, h.y, h.z] });
      }
      v.hailId = NONE;
      v.stealing = false;
    } else if (hasStop(v)) {
      v.passengers = Math.max(0, v.passengers - 1 - (rand() < 0.2 ? 1 : 0));
    }
    v.stopS = Number.NaN;
    v.dlTarget = 0;
  }

  /** Arm up when a taxi (or the player) is coming their way. */
  private taxiNear(h: Hailer): boolean {
    const p = this.ctx?.player;
    if (p?.active) {
      const dx = h.x - p.x;
      const dz = h.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 70 && (dx * p.fx + dz * p.fz) / (d || 1) > 0.3) return true;
    }
    for (const v of this.vehicles) {
      if (v.kind !== "micra" && v.kind !== "keke" && v.kind !== "okada") continue;
      const dx = h.x - v.x;
      const dz = h.z - v.z;
      const d = dx * dx + dz * dz;
      if (d < 3600 && dx * v.fx + dz * v.fz > 0) return true;
    }
    return false;
  }

  // --- overtaking and cut-ins -------------------------------------------------------

  private considerOvertake(v: TrafficVehicle, hit: ScanHit, dt: number): void {
    if (v.overtakeId !== NONE || v.dwell > 0) return;
    const a = hit.agent;
    if (!a || hit.oncoming || hit.gap > 30) {
      v.followSlow = 0;
      return;
    }
    const v0 = this.desiredSpeed(v);
    const slow = hit.speed < Math.min(v0 * 0.55, 5) || (a.vehicle !== null && (a.vehicle.dwell > 0 || a.vehicle.parked));
    const racing = v.stealing && a.id === PLAYER_ID;
    if (!slow && !racing) {
      v.followSlow = 0;
      return;
    }
    v.followSlow += dt;
    const wait = racing ? 0.3 : lerp2(D.overtakeAfter, v.aggression) * (a.vehicle?.parked ? 0.5 : 1);
    if (v.followSlow < wait) return;
    // Passing moving traffic, not through junctions (unless you're an okada). Going round something parked is fine anywhere.
    const stopped = a.vehicle !== null && (a.vehicle.parked || a.vehicle.dwell > 0);
    if (!stopped && v.kind !== "okada" && v.jPiece && v.jPiece.s0 - v.s < 25) return;

    // How far left to clear them.
    v.path.sample(v.s + v.halfL + hit.gap + a.halfL, 0, scanS);
    const aLat = (a.x - scanS.x) * -scanS.dz + (a.z - scanS.z) * scanS.dx;
    const need = aLat - a.halfW - v.halfW - 0.5;
    if (need >= v.dl) return;
    const far = this.farDl(v);
    if (need < far) {
      // No room: sit and honk.
      if (v.hornCooldown <= 0 && v.hornAt < 0 && rand() < v.hornHappy * 0.5) this.queueHorn(v, this.ctx?.time ?? 0, "impatient");
      return;
    }
    // Clear road (no oncoming) for long enough at that offset?
    const passLen = hit.gap + a.halfL * 2 + v.halfL * 2 + 12 + Math.max(v.v, 6) * 2.5;
    const check = this.scan(v, need, Math.min(90, passLen), hitPass);
    if (check.agent && check.agent !== a && (check.oncoming || check.gap < hit.gap + a.halfL * 2 + 6)) return;
    v.overtakeId = a.id;
    v.overtakeTime = 0;
    v.dlTarget = need;
  }

  private progressOvertake(v: TrafficVehicle): void {
    const a = this.agents.find((x) => x.id === v.overtakeId);
    if (!a || v.overtakeTime > 14) {
      this.endOvertake(v);
      return;
    }
    // Past them: cut back in, hard right if there's a passenger at the kerb.
    const along = (v.x - a.x) * v.fx + (v.z - a.z) * v.fz;
    if (along > v.halfL + a.halfL + (v.stealing ? 1.5 : 4)) {
      if (v.stealing && v.hornCooldown <= 0 && v.hornAt < 0) this.queueHorn(v, this.ctx?.time ?? 0, "warning");
      this.endOvertake(v);
    }
  }

  private endOvertake(v: TrafficVehicle): void {
    v.overtakeId = NONE;
    v.followSlow = 0;
    v.dlTarget = (v.hailId !== NONE && !v.hailInLane) || (hasStop(v) && !v.stopInLane) ? this.kerbDl(v) : 0;
  }

  /** Lane-relative offset of the kerb (a vehicle's right side against it). */
  private kerbDl(v: TrafficVehicle): number {
    const p = v.path.pieceAt(v.s);
    const de = p.kind === PIECE_TURN ? p.next : p.de;
    const g = this.graph;
    return g.kerbOffset(de) - g.laneOffset(de, p.lane) - v.halfW - 0.15 + (v.kind === "okada" || v.kind === "keke" ? 0.35 : 0);
  }

  /** Lane-relative offset of the far kerb (across the oncoming lanes on two-way roads). */
  private farDl(v: TrafficVehicle): number {
    const p = v.path.pieceAt(v.s);
    const de = p.kind === PIECE_TURN ? p.next : p.de;
    const g = this.graph;
    return -(g.laneOffset(de, p.lane) + g.edge(de).width / 2) + v.halfW + 0.15;
  }

  // --- horn ------------------------------------------------------------------------

  private onPlayerHorn(): void {
    const p = this.ctx?.player;
    if (!p?.active) return;
    const t = this.ctx!.time;
    for (const v of this.vehicles) {
      const rx = v.x - p.x;
      const rz = v.z - p.z;
      const ahead = rx * p.fx + rz * p.fz;
      const side = Math.abs(rx * -p.fz + rz * p.fx);
      if (ahead < -3 || ahead > T.horn.reach || side > 7 || v.parked) continue;
      if (v.aggression > T.horn.honkBackAggression || v.hornHappy > 0.85) {
        // "Who are you horning?"
        if (v.hornAt < 0) {
          v.hornAt = t + 0.25 + rand() * 0.6;
          v.hornReason = "honkBack";
        }
      } else {
        v.nudge = T.horn.nudgeTime;
        // Timid drivers waiting at a junction take the hint and go.
        if (v.jPiece && !v.jGranted) v.jWait += 4;
      }
    }
  }

  private queueHorn(v: TrafficVehicle, t: number, reason: TrafficVehicle["hornReason"]): void {
    v.hornAt = t + 0.1 + rand() * 0.3;
    v.hornReason = reason;
  }

  private honk(ctx: TrafficContext): void {
    for (const v of this.vehicles) {
      if (v.hornAt < 0 || ctx.time < v.hornAt) continue;
      v.hornAt = -1;
      v.hornCooldown = T.driver.hornCooldown * (1.5 - v.hornHappy);
      v.lastHonkAt = ctx.time;
      this.stats.horns++;
      gameEvents.emit("HORN", { vehicleId: `traffic-${v.id}`, position: [v.x, v.y + 1, v.z], vehicleKind: v.kind, reason: v.hornReason });
    }
  }

  // --- collisions (from TrafficPhysics) ---------------------------------------------

  /** The player's Micra hit vehicle `v` with this closing speed (m/s). */
  onPlayerCollision(v: TrafficVehicle, closing: number, at: [number, number, number]): void {
    const C = MICRA_TUNING.condition;
    const p = this.ctx?.player;
    const [lo, hi] = C.vehicleHitMassScale;
    const scale = clamp(Math.sqrt(v.mass / (p?.mass ?? 865)), lo, hi);
    const damage = Math.min(C.vehicleHitMaxDamage, Math.max(0, closing - C.vehicleHitMinSpeed) * C.vehicleHitDamage * scale);
    this.stats.collisions++;
    // They stop, shaken, and let you hear about it.
    v.shaken = Math.max(v.shaken, 2 + closing * 0.6);
    if (v.hornAt < 0) this.queueHorn(v, this.ctx?.time ?? 0, "angry");
    gameEvents.emit("COLLISION", { vehicleId: p?.id ?? "player", otherId: `traffic-${v.id}`, otherKind: v.kind, position: at, relativeSpeed: closing, damage });
  }

  /**
   * Still touching the player (every physics step): stop pushing. Kinematic
   * bodies can't be pushed back, so the vehicle freezes where it is instead.
   */
  onPlayerContact(v: TrafficVehicle): void {
    v.v *= 0.5;
    v.acc = Math.min(v.acc, 0);
    v.dlTarget = v.dl;
    v.dlVel = 0;
    v.shaken = Math.max(v.shaken, 1.2);
  }

  // --- spawning ------------------------------------------------------------------------

  private cull(dt: number): void {
    this.surplusTimer -= dt;
    const surplus = this.vehicles.length > this.target + 3 && this.surplusTimer <= 0;
    const full = this.vehicles.length >= this.target;
    const ctx = this.ctx;
    let culledSurplus = false;
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      const hidden = !v.visible;
      let drop = v.dist > T.despawnRadius;
      drop ||= v.pathEnded && v.v < 0.3 && (hidden || v.dist > 60);
      drop ||= v.blocked > T.stuckRecycleSeconds && hidden && v.dist > T.stuckRecycleDistance;
      drop ||= v.fleeing && hidden && v.dist > 100;
      // Full bubble: recycle hidden vehicles heading away, so new ones appear where you are.
      if (!drop && hidden && full && v.dist > T.recycleAwayDistance && ctx) {
        const away = (v.x - ctx.focusX) * v.fx + (v.z - ctx.focusZ) * v.fz > 0;
        drop = (away || v.parked) && rand() < T.recycleAwayRate * dt;
      }
      if (!drop && surplus && !culledSurplus && hidden && v.dist > 150) {
        drop = true;
        culledSurplus = true;
        this.surplusTimer = 0.5;
      }
      // Curfew falls while they're out: the okada and keke still running start fleeing.
      if (!v.fleeing && v.spec.restrictedHours && !this.now.okadaAllowed) {
        v.fleeing = true;
        v.aggression = 0.95;
        this.releaseHail(v);
      }
      if (drop) this.remove(v);
    }
  }

  private spawn(ctx: TrafficContext): void {
    if (!this.near.length) return;
    const parked = this.stats.parked;
    for (let i = 0; i < T.spawnsPerFrame && this.vehicles.length < this.target; i++) {
      // Around a busy market, lorries offload and cars park half in the road.
      const share = T.parkedShare * (1 + this.marketHere * T.marketParkedGain);
      const wantParked = parked < this.target * share && rand() < 0.3;
      this.trySpawn(ctx, wantParked);
    }
    if (this.vehicles.length >= this.target * 0.9) this.filled = true;
    for (const v of this.vehicles) if (v.wantsRoute) this.planRoute(v);
  }

  private trySpawn(ctx: TrafficContext, parked: boolean): void {
    const g = this.graph;
    const weights = this.nearWeights;
    const total = weights[weights.length - 1];
    if (!(total > 0)) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = rand() * total;
      let lo = 0;
      let hi = weights.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (weights[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      const e = g.edges[this.near[lo]];
      if (e.length < 20) continue;
      const rank = highwayRank(e.highway);
      const forward = e.oneway || rand() < 0.5;
      const de = e.id * 2 + (forward ? 0 : 1);
      const kind = this.pickKind(e.highway, rank, e.name ?? e.ref ?? "", parked);
      if (!kind) continue;
      const spec = VEHICLE_SPECS[kind];
      const halfL = spec.length / 2;
      const tail = spec.trailer ? spec.trailer.hitch + spec.trailer.length : 0;
      const start = g.toNode(de) === e.v ? e.u : e.v;
      const end = g.toNode(de);
      const a = trimFor(g, start, e.length, g.junctionTrim(end));
      const b = e.length - trimFor(g, end, e.length, g.junctionTrim(start));
      // Parked vehicles keep clear of junction mouths.
      const clearEnds = parked ? 25 : 0;
      if (b - a - 2 * clearEnds < spec.length + tail + 4) continue;
      const s = a + clearEnds + tail + halfL + 1 + rand() * (b - a - 2 * clearEnds - tail - spec.length - 2);
      const pos = g.sample(de, s, scanS);
      const d = Math.hypot(pos.x - ctx.focusX, pos.z - ctx.focusZ);
      const minD = this.filled ? T.spawnMinDistance : 25;
      if (d < minD || d > T.simRadius) continue;
      if (this.filled && d < T.spawnVisibleMinDistance && ctx.isVisible(pos.x, pos.y + 1, pos.z, halfL + 2)) continue;
      const clear = T.spawnClearance + halfL + tail;
      if (this.agents.some((o) => (o.x - pos.x) ** 2 + (o.z - pos.z) ** 2 < clear * clear)) continue;
      if (ctx.player?.active && Math.hypot(ctx.player.x - pos.x, ctx.player.z - pos.z) < clear + 10) continue;
      this.create(kind, de, s, a, b, parked);
      return;
    }
  }

  private pickKind(highway: string, rank: number, name: string, parked: boolean): TrafficVehicleKind | null {
    const now = this.now;
    let total = 0;
    const w = kindWeights;
    for (let i = 0; i < VEHICLE_KINDS.length; i++) {
      const kind = VEHICLE_KINDS[i];
      const spec = VEHICLE_SPECS[kind];
      let x = spec.weight;
      if (rank < spec.minRank) x = 0;
      if (spec.restrictedHours && !now.okadaAllowed) x *= T.okadaNightShare;
      if (kind === "truck" || kind === "trailer") {
        if (T.truckCorridors.test(name) || highway.startsWith("trunk") || highway.startsWith("motorway")) x *= T.truckCorridorBoost;
        if (now.night) x *= 1.5;
      }
      if (kind === "car") x *= 1 + now.school * 1.5;
      if (kind === "okada" && rank >= 5) x *= 0.4;
      if (kind === "keke" && rank >= 5) x *= 0.3;
      if (parked && (kind === "okada" || kind === "trailer")) x *= 0.2;
      if (parked && kind === "truck") x *= 1 + this.marketHere;
      total += x;
      w[i] = total;
    }
    if (total <= 0) return null;
    const r = rand() * total;
    for (let i = 0; i < VEHICLE_KINDS.length; i++) if (r < w[i]) return VEHICLE_KINDS[i];
    return null;
  }

  private create(kind: TrafficVehicleKind, de: DirEdge, s: number, a: number, b: number, parked: boolean): void {
    const spec = VEHICLE_SPECS[kind];
    const v = this.pool.pop() ?? ({ path: new LanePath() } as TrafficVehicle);
    const id = this.nextId++;
    const loaded = rand() < spec.loadedChance;
    const restricted = spec.restrictedHours && !this.now.okadaAllowed;
    const aggression = restricted ? 0.95 : trait(spec.aggression);
    const [pMin, pMax] = spec.passengers;
    Object.assign(v, {
      id,
      kind,
      spec,
      variant: Math.floor(rand() * VARIANTS[kind]),
      color: pick(PALETTES[kind]),
      color2: pick(CONTAINERS),
      halfL: spec.length / 2,
      halfW: spec.width / 2,
      aggression,
      patience: clamp(1 - aggression * 0.7 + (rand() - 0.5) * 0.3, 0, 1),
      hornHappy: trait(spec.horn),
      loaded,
      mass: loaded ? spec.massLoaded : spec.massEmpty,
      power: loaded ? spec.powerLoaded : spec.powerEmpty,
      passengers: loaded ? Math.max(1, Math.round(lerp(pMin, pMax, 0.5 + rand() * 0.5))) : Math.round(lerp(pMin, pMax, rand() * 0.4)),
      fleeing: restricted,
      parked,
      s: 0,
      v: 0,
      acc: 0,
      dl: 0,
      dlTarget: 0,
      dlVel: 0,
      route: null,
      routeIdx: 0,
      wantsRoute: !parked && (kind === "micra" || kind === "bus" || kind === "truck" || kind === "trailer" || rand() < 0.4),
      pathEnded: false,
      jPiece: null,
      jGranted: false,
      jWait: 0,
      jRunRoll: rand(),
      blocked: 0,
      blockerId: NONE,
      followSlow: 0,
      overtakeId: NONE,
      overtakeTime: 0,
      ignoreId: NONE,
      ignoreTime: 0,
      hailId: NONE,
      hailS: 0,
      hailInLane: false,
      stealing: false,
      stopS: Number.NaN,
      stopInLane: false,
      dwell: 0,
      shaken: 0,
      nudge: 0,
      hornCooldown: 0,
      hornAt: -1,
      hornReason: "impatient",
      thinkTimer: rand() * 0.25,
      lastHonkAt: -99,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      fx: 0,
      fz: -1,
      grade: 0,
      tx: 0,
      ty: 0,
      tz: 0,
      tyaw: 0,
      tpitch: 0,
      braking: false,
      visible: false,
      dist: 0,
    } satisfies Omit<TrafficVehicle, "path">);
    v.path.clear();
    const lane = this.laneFor(v, de);
    const piece = edgePiece(this.graph, de, lane, a, b);
    v.path.append(piece);
    // Path s of edge distance s (lane pieces run a touch longer or shorter on bends).
    v.s = v.path.pathSOnEdge(de, s, 0) ?? s - a;
    if (parked) {
      // Near a market, half in the lane.
      const at = this.graph.sample(de, s, scanS);
      const intoLane = zoneBoost(this.zones, this.now, at.x, at.z).market > 0.3 ? rand() * 0.9 : 0;
      v.dl = v.dlTarget = this.kerbDl(v) + 0.25 - intoLane;
      v.passengers = 0;
    } else {
      v.v = Math.min(this.graph.edge(de).speedLimitKph / 3.6, spec.maxSpeed) * (0.4 + rand() * 0.4);
    }
    this.vehicles.push(v);
    this.byId.set(id, v);
    this.pose(v, this.ctx!);
  }

  private remove(v: TrafficVehicle): void {
    const i = this.vehicles.indexOf(v);
    if (i < 0) return;
    this.vehicles.splice(i, 1);
    this.byId.delete(v.id);
    if (v.jPiece) this.junctions.get(v.jPiece.node)?.occupants.delete(v.id);
    if (v.hailId !== NONE) this.releaseHail(v);
    this.onRemove?.(v);
    v.path.clear();
    v.route = null;
    v.jPiece = null;
    this.pool.push(v);
  }

  private collectStats(): void {
    const st = this.stats;
    st.active = this.vehicles.length;
    st.target = this.target;
    st.hailers = this.hailers.hailers.length;
    st.parked = 0;
    for (const k of VEHICLE_KINDS) st.byKind[k] = 0;
    for (const v of this.vehicles) {
      st.byKind[v.kind]++;
      if (v.parked) st.parked++;
    }
  }
}

const weightScratch: number[] = [];
const kindWeights: number[] = [];
const headScratch0 = { x: 0, z: 0 };
const headScratch1 = { x: 0, z: 0 };

function agentOf(v: TrafficVehicle, part: 0 | 1, a: Agent): Agent {
  const tr = v.spec.trailer;
  const trailer = part === 1 && tr;
  a.id = v.id;
  a.x = trailer ? v.tx : v.x;
  a.z = trailer ? v.tz : v.z;
  a.fx = trailer ? -Math.sin(v.tyaw) : v.fx;
  a.fz = trailer ? -Math.cos(v.tyaw) : v.fz;
  a.halfL = trailer ? tr.length / 2 : v.halfL;
  a.halfW = v.halfW;
  a.speed = v.v;
  a.vehicle = v;
  return a;
}

const hasStop = (v: TrafficVehicle) => !Number.isNaN(v.stopS);
/** Buses carry more than we draw. */
const capacity = (v: TrafficVehicle) => (v.kind === "bus" ? 14 : v.spec.seats);

/** Who pushes in first when two drivers wait on each other: waiting time, temper, a recent horn. */
function assertiveness(v: TrafficVehicle, t: number): number {
  return v.jWait + v.blocked + v.aggression * 4 + (t - v.lastHonkAt < 3 ? 2 : 0) + v.id * 1e-6;
}

/** Do two turn paths come within `clearance` metres of each other? */
function piecesCross(a: Piece, b: Piece, clearance: number): boolean {
  const c2 = clearance * clearance;
  const pa = a.pts;
  const pb = b.pts;
  for (let i = 0; i < pa.length; i += 3) {
    for (let k = 0; k < pb.length; k += 3) {
      const dx = pa[i] - pb[k];
      const dz = pa[i + 2] - pb[k + 2];
      if (dx * dx + dz * dz < c2) return true;
    }
  }
  return false;
}

function minDistToPiece(p: Piece, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < p.pts.length; i += 3) best = Math.min(best, Math.hypot(p.pts[i] - x, p.pts[i + 2] - z));
  return best;
}

/** Stable 0–1 hash of a (vehicle, hailer) pair, so a keke decides once whether to stop for someone. */
function hashPair(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

