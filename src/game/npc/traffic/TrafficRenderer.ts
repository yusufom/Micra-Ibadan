import {
  type BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import type { TrafficVehicleKind } from "@/game/core/events";
import { type DirEdge, type RoadGraph, type Sample } from "@/game/world/RoadGraph";
import type { Hailer } from "../hailers/hailers";
import type { Junction, Junctions } from "./junctions";
import { buildSeatedPerson, buildSignal, buildStandingPerson, buildVehicleModels, type Layers, type StandingModel, type VehicleModel } from "./trafficModels";
import type { TrafficSim, TrafficVehicle } from "./TrafficSim";
import { VEHICLE_KINDS } from "./vehicleTypes";

/**
 * Draws the traffic: one InstancedMesh per model layer (body, head lamps,
 * tail lamps) per vehicle variant, one for everyone seated aboard, the
 * people waving at the roadside, the signal heads at nearby signalised
 * junctions, and one for soft blob shadows under all of them (traffic stays
 * out of the sun's shadow pass, which cost more than drawing it). Everything
 * is rewritten each frame from the sim.
 */

const SHIRTS = [0xb8322a, 0x2e6fa8, 0xd9a91b, 0x1e8a73, 0x7d3d8f, 0xc75a1a, 0xe8e2d0, 0x3b3b3b, 0x5a8f2e, 0xa84a7a];
const UP = new Vector3(0, 1, 0);

const m4 = new Matrix4();
const m4b = new Matrix4();
const seat = new Matrix4();
const pos = new Vector3();
const quat = new Quaternion();
const euler = new Euler(0, 0, 0, "YXZ");
const one = new Vector3(1, 1, 1);
const col = new Color();
const tmp: Sample = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };
const blobMatrix = new Matrix4();
const blobScale = new Vector3();

type LayerMeshes = { body: InstancedMesh; head: InstancedMesh; tail: InstancedMesh };

/** three's color_vertex chunk, with the instance colour weighted by the `tint` attribute. */
const TINT_COLOR_VERTEX = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR
  vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, tint );
#endif
`;

/** Lambert with vertex colours, where the instance colour only applies as much as the vertex `tint` says. */
function tintedLambert(): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float tint;")
      .replace("#include <color_vertex>", TINT_COLOR_VERTEX);
  };
  m.customProgramCacheKey = () => "traffic-tint";
  return m;
}

/** Soft dark ellipse, for blob shadows. */
function blobTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  r.addColorStop(0, "rgba(0,0,0,1)");
  r.addColorStop(0.55, "rgba(0,0,0,0.75)");
  r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

type SignalHead = { junction: Junction; de: DirEdge; x: number; y: number; z: number; yaw: number };

export class TrafficRenderer {
  readonly group = new Group();
  private readonly models: Record<TrafficVehicleKind, VehicleModel[]>;
  private readonly meshes: Record<TrafficVehicleKind, { body: LayerMeshes; trailer?: LayerMeshes }[]>;
  private readonly people: InstancedMesh;
  private readonly standing: { body: InstancedMesh; arm: InstancedMesh; model: StandingModel };
  private readonly blobs: InstancedMesh;
  private readonly blobTex: CanvasTexture;
  private readonly signal: { fixed: InstancedMesh; red: InstancedMesh; amber: InstancedMesh; green: InstancedMesh };
  private readonly materials: Material[] = [];
  private signalHeads: SignalHead[] = [];
  private signalTimer = 0;
  private readonly counts = new Map<InstancedMesh, number>();
  /** Triangles per model, for the report. */
  readonly triangles: Record<string, number> = {};

  constructor(capacity: number) {
    this.group.name = "traffic";
    const lit = tintedLambert();
    const glow = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.blobTex = blobTexture();
    const shade = new MeshBasicMaterial({ map: this.blobTex, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.materials.push(lit, glow, shade);
    const mesh = (geo: BufferGeometry, mat: Material, cap: number, receive: boolean, name: string) => {
      const m = new InstancedMesh(geo, mat, cap);
      m.name = name;
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
      m.receiveShadow = receive;
      m.count = 0;
      m.visible = false;
      // Allocate the colour buffer up front.
      m.setColorAt(0, col.setRGB(1, 1, 1));
      m.instanceColor!.setUsage(DynamicDrawUsage);
      this.group.add(m);
      return m;
    };
    const layers = (l: Layers, cap: number, name: string): LayerMeshes => ({
      body: mesh(l.body, lit, cap, true, `${name}-body`),
      head: mesh(l.head, glow, cap, false, `${name}-head`),
      tail: mesh(l.tail, glow, cap, false, `${name}-tail`),
    });

    this.models = {} as typeof this.models;
    this.meshes = {} as typeof this.meshes;
    for (const kind of VEHICLE_KINDS) {
      const models = buildVehicleModels(kind);
      this.models[kind] = models;
      this.meshes[kind] = models.map((m, i) => ({
        body: layers(m.body, capacity, `${kind}${i}`),
        trailer: m.trailer ? layers(m.trailer, capacity, `${kind}${i}-trailer`) : undefined,
      }));
      models.forEach((m, i) => (this.triangles[`${kind}${models.length > 1 ? i : ""}`] = m.triangles));
    }

    this.people = mesh(buildSeatedPerson().body, lit, capacity * 6, false, "riders");
    const st = buildStandingPerson();
    this.standing = { body: mesh(st.body, lit, 32, true, "hailers"), arm: mesh(st.arm, lit, 32, true, "hailers-arm"), model: st };
    this.blobs = mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shade, capacity * 2 + 32, false, "blob-shadows");
    this.blobs.renderOrder = -1;
    const sig = buildSignal();
    this.signal = {
      fixed: mesh(sig.fixed, lit, 64, true, "signal-poles"),
      red: mesh(sig.red, glow, 64, false, "signal-red"),
      amber: mesh(sig.amber, glow, 64, false, "signal-amber"),
      green: mesh(sig.green, glow, 64, false, "signal-green"),
    };
  }

  update(sim: TrafficSim, graph: RoadGraph, junctions: Junctions, t: number, hour: number, dt: number, focusX: number, focusZ: number): void {
    const counts = this.counts;
    counts.clear();
    const put = (m: InstancedMesh, matrix: Matrix4, c: Color) => {
      const i = counts.get(m) ?? 0;
      if (i >= m.instanceMatrix.count) return;
      m.setMatrixAt(i, matrix);
      m.setColorAt(i, c);
      counts.set(m, i + 1);
    };
    const night = hour >= 18.6 || hour < 6.4;
    const blink = t % 1 < 0.5;

    for (const v of sim.vehicles) {
      const model = this.models[v.kind][v.variant];
      const meshes = this.meshes[v.kind][v.variant];
      euler.set(v.pitch, v.yaw, v.roll);
      quat.setFromEuler(euler);
      m4.compose(pos.set(v.x, v.y, v.z), quat, one);
      this.putLayers(put, meshes.body, m4, v.color, v, night, blink);
      const spec = v.spec;
      this.putBlob(put, v.x, v.y, v.z, v.yaw, v.pitch, spec.width * 1.35, spec.length * 1.12);
      if (meshes.trailer && spec.trailer) {
        euler.set(v.tpitch, v.tyaw, 0);
        quat.setFromEuler(euler);
        m4b.compose(pos.set(v.tx, v.ty, v.tz), quat, one);
        this.putLayers(put, meshes.trailer, m4b, v.color2, v, night, blink);
        this.putBlob(put, v.tx, v.ty, v.tz, v.tyaw, v.tpitch, spec.width * 1.35, spec.trailer.length * 1.08);
      }
      // Driver and whoever is aboard (parked cars are empty).
      if (v.parked) continue;
      const n = Math.min(model.seats.length, 1 + v.passengers);
      for (let k = 0; k < n; k++) {
        const [sx, sy, sz] = model.seats[k];
        seat.makeTranslation(sx, sy, sz).premultiply(m4);
        put(this.people, seat, col.setHex(SHIRTS[(v.id * 7 + k * 3) % SHIRTS.length]));
      }
    }

    this.putHailers(put, sim.hailers.hailers);
    this.putSignals(put, graph, junctions, t, dt, focusX, focusZ);

    for (const obj of this.group.children) {
      const m = obj as InstancedMesh;
      const n = counts.get(m) ?? 0;
      m.count = n;
      m.visible = n > 0;
      if (n > 0) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
  }

  private putLayers(put: (m: InstancedMesh, mat: Matrix4, c: Color) => void, l: LayerMeshes, matrix: Matrix4, paint: number, v: TrafficVehicle, night: boolean, blink: boolean): void {
    put(l.body, matrix, col.setHex(paint));
    // Lamps: dim glass by day, lit at night (not the okada running from OYRTMA), tails bright when braking.
    const head = v.parked ? 0.2 : night ? (v.fleeing ? 0.15 : 2.4) : 0.35;
    const tail = v.parked ? (blink ? 1.6 : 0.25) : v.braking ? 2.4 : night ? (v.fleeing ? 0.2 : 0.9) : 0.3;
    put(l.head, matrix, col.setRGB(head, head, head));
    put(l.tail, matrix, col.setRGB(tail, tail, tail));
  }

  private putBlob(put: (m: InstancedMesh, mat: Matrix4, c: Color) => void, x: number, y: number, z: number, yaw: number, pitch: number, w: number, l: number): void {
    euler.set(pitch, yaw, 0);
    quat.setFromEuler(euler);
    blobScale.set(w, 1, l);
    put(this.blobs, blobMatrix.compose(pos.set(x, y + 0.02, z), quat, blobScale), col.setRGB(1, 1, 1));
  }

  private putHailers(put: (m: InstancedMesh, mat: Matrix4, c: Color) => void, hailers: readonly Hailer[]): void {
    const st = this.standing;
    const [sx, sy, sz] = st.model.shoulder;
    for (const h of hailers) {
      if (h.boarding >= 0 && h.boarding < 0.6) continue;
      quat.setFromAxisAngle(UP, h.yaw);
      m4.compose(pos.set(h.x, h.y, h.z), quat, one);
      col.setHex(SHIRTS[h.variant % SHIRTS.length]);
      put(st.body, m4, col);
      this.putBlob(put, h.x, h.y, h.z, h.yaw, 0, 0.7, 0.7);
      // Right arm: raised and flagging when a taxi is coming, else hanging.
      const raise = h.wave * (2.35 + 0.35 * Math.sin(h.phase));
      euler.set(h.wave * 0.5, 0, raise);
      quat.setFromEuler(euler);
      m4b.compose(pos.set(sx, sy, sz), quat, one).premultiply(m4);
      put(st.arm, m4b, col);
    }
  }

  private putSignals(put: (m: InstancedMesh, mat: Matrix4, c: Color) => void, graph: RoadGraph, junctions: Junctions, t: number, dt: number, fx: number, fz: number): void {
    this.signalTimer -= dt;
    if (this.signalTimer <= 0) {
      this.signalTimer = 1;
      this.signalHeads = [];
      for (const j of junctions.all()) {
        if (j.control !== "signal" || Math.hypot(j.x - fx, j.z - fz) > 350) continue;
        const trim = Math.max(graph.junctionTrim(j.node), 1.5);
        for (const de of graph.in(j.node)) {
          const len = graph.polyline(de).length;
          graph.sample(de, Math.max(0, len - trim), tmp);
          const off = graph.vergeOffset(de) + 0.3;
          this.signalHeads.push({ junction: j, de, x: tmp.x - tmp.dz * off, y: tmp.y, z: tmp.z + tmp.dx * off, yaw: Math.atan2(tmp.dx, tmp.dz) });
        }
      }
    }
    const s = this.signal;
    for (const h of this.signalHeads) {
      quat.setFromAxisAngle(UP, h.yaw);
      m4.compose(pos.set(h.x, h.y, h.z), quat, one);
      put(s.fixed, m4, col.setRGB(1, 1, 1));
      const state = h.junction.dead ? null : junctions.signal(h.junction, h.de, t);
      put(s.red, m4, col.setScalar(state === "red" ? 3 : 0.12));
      put(s.amber, m4, col.setScalar(state === "amber" ? 3 : 0.12));
      put(s.green, m4, col.setScalar(state === "green" ? 3 : 0.12));
    }
  }

  dispose(): void {
    for (const obj of this.group.children) {
      const m = obj as InstancedMesh;
      m.geometry.dispose();
      m.dispose();
    }
    // GPU resources only: three re-uploads them if the renderer is used again (StrictMode remounts).
    for (const m of this.materials) m.dispose();
    this.blobTex.dispose();
  }
}
