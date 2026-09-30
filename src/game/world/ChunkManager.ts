import type { RapierRigidBody } from "@react-three/rapier";
import { type BufferGeometry, Group, type Material, type Mesh, MeshStandardMaterial, type Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { type ChunkDetail, makeChunkMesh, mergeChunkGeometry, ROAD_MATERIALS } from "./chunks/chunkMesh";
import { buildChunkPhysics, type RapierApi, type RapierWorld, removeChunkPhysics } from "./chunks/chunkPhysics";
import type { ChunkJson, ChunkMeta, Manifest, Prop } from "./chunks/types";
import { getAtlasMaterial } from "./materials/atlasMaterial";
import { PropLayer } from "./props/PropLayer";
import type { QualitySettings } from "./quality";
import type { FarField } from "./terrain/FarField";

/**
 * Streams the Ibadan chunks from public/chunks/{area}/ around a focus point
 * (the camera for now, the Micra later).
 *
 * - The 3×3 chunks around the focus are required: full detail, colliders, props.
 * - The next ring is preloaded in the direction of travel (all of it on the
 *   high tier, for the view from hilltops) at reduced detail, with no physics.
 * - Chunks more than 2 rings away are unloaded and their GPU memory freed.
 *
 * Downloads and glTF parsing are async. Everything that touches the scene or
 * the physics world runs in update() under a per-frame time budget, one small
 * step at a time, so streaming never stalls a frame.
 */

const REQUIRED_RINGS = 1;
const PRELOAD_RING = 2;
const KEEP_RINGS = 2;
/** Travel direction must be within ~55° of a ring-2 chunk to preload it. */
const PRELOAD_DOT = 0.57;
const MIN_TRAVEL_SPEED = 1.5;

type ChunkState = "loading" | "loaded" | "failed";

type ChunkSource = {
  /** Geometry per pipeline material name, chunk-local. */
  parts: Map<string, BufferGeometry>;
  json: ChunkJson;
  heights: Float32Array;
};

type ChunkRecord = {
  key: string;
  meta: ChunkMeta;
  ring: number;
  state: ChunkState;
  abort: AbortController;
  source: ChunkSource | null;
  group: Group | null;
  surface: Mesh | null;
  water: Mesh | null;
  detail: ChunkDetail | null;
  physics: { out: { body: RapierRigidBody | null }; task: Generator<void, void, void> | null; done: boolean } | null;
};

export type ChunkManagerOptions = {
  baseUrl: string;
  manifest: Manifest;
  quality: QualitySettings;
  world: RapierWorld;
  rapier: RapierApi;
  farField: FarField | null;
  /** Called when the chunks around the focus first have colliders, and when the loaded count changes. */
  onReady?: () => void;
  onLoadedCount?: (n: number) => void;
};

const keyOf = (cx: number, cz: number) => `${cx}_${cz}`;

let waterMaterial: MeshStandardMaterial | null = null;
function getWaterMaterial(): MeshStandardMaterial {
  waterMaterial ??= new MeshStandardMaterial({
    color: 0x3f5a4a,
    roughness: 0.15,
    metalness: 0,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  return waterMaterial;
}

export class ChunkManager {
  readonly root = new Group();
  readonly manifest: Manifest;
  private readonly opts: ChunkManagerOptions;
  private readonly metas = new Map<string, ChunkMeta>();
  private readonly chunks = new Map<string, ChunkRecord>();
  private readonly loader = new GLTFLoader();
  private readonly surfaceMaterial: Material;
  private readonly props: PropLayer;
  private inFlight = 0;
  private queue: ChunkRecord[] = [];
  private focusCx = Number.NaN;
  private focusCz = Number.NaN;
  private travelSector = -1;
  private propsDirty = false;
  private ready = false;
  private disposed = false;
  /** Set by releasePhysics(); after that the world is never touched again. */
  private physicsReleased = false;

  constructor(opts: ChunkManagerOptions) {
    this.opts = opts;
    this.manifest = opts.manifest;
    for (const m of opts.manifest.chunks) this.metas.set(keyOf(m.cx, m.cz), m);
    this.root.name = "chunks";
    this.surfaceMaterial = getAtlasMaterial("world", opts.quality.tier);
    this.props = new PropLayer(getAtlasMaterial("props", opts.quality.tier), opts.quality.shadows);
    this.root.add(this.props.group);
    if (opts.farField) this.root.add(opts.farField.mesh);
  }

  /** Call once per frame with the focus position and its velocity (m/s). */
  update(focus: Vector3, velocity: Vector3): void {
    if (this.disposed) return;
    const size = this.manifest.chunkSize;
    const cx = Math.floor(focus.x / size);
    const cz = Math.floor(focus.z / size);
    const speed = Math.hypot(velocity.x, velocity.z);
    const sector = speed > MIN_TRAVEL_SPEED ? Math.round((Math.atan2(velocity.z, velocity.x) / (Math.PI * 2)) * 8 + 8) % 8 : -1;

    if (cx !== this.focusCx || cz !== this.focusCz || sector !== this.travelSector) {
      this.focusCx = cx;
      this.focusCz = cz;
      this.travelSector = sector;
      this.plan(cx, cz, sector === -1 ? null : [velocity.x / speed, velocity.z / speed]);
    }

    this.pumpDownloads();
    this.runJobs(performance.now() + this.opts.quality.frameBudgetMs);
  }

  /** Decide which chunks to hold at which ring; queue loads and drop far chunks. */
  private plan(fcx: number, fcz: number, dir: [number, number] | null): void {
    const alwaysRings = Math.max(REQUIRED_RINGS, this.opts.quality.detailRings);
    const wanted = new Set<string>();
    for (let dz = -PRELOAD_RING; dz <= PRELOAD_RING; dz++) {
      for (let dx = -PRELOAD_RING; dx <= PRELOAD_RING; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        let want = ring <= alwaysRings;
        if (!want && ring === PRELOAD_RING && dir) {
          const l = Math.hypot(dx, dz);
          want = (dx * dir[0] + dz * dir[1]) / l > PRELOAD_DOT;
        }
        const key = keyOf(fcx + dx, fcz + dz);
        if (want && this.metas.has(key)) wanted.add(key);
      }
    }

    for (const rec of this.chunks.values()) {
      const ring = Math.max(Math.abs(rec.meta.cx - fcx), Math.abs(rec.meta.cz - fcz));
      if (ring > KEEP_RINGS) this.unload(rec);
      else {
        if ((rec.ring <= this.opts.quality.propRings) !== (ring <= this.opts.quality.propRings)) this.propsDirty = true;
        rec.ring = ring;
      }
    }

    for (const key of wanted) {
      if (this.chunks.has(key)) continue;
      const meta = this.metas.get(key)!;
      const rec: ChunkRecord = {
        key,
        meta,
        ring: Math.max(Math.abs(meta.cx - fcx), Math.abs(meta.cz - fcz)),
        state: "loading",
        abort: new AbortController(),
        source: null,
        group: null,
        surface: null,
        water: null,
        detail: null,
        physics: null,
      };
      this.chunks.set(key, rec);
      this.queue.push(rec);
    }
    // Nearest first.
    this.queue = this.queue.filter((r) => this.chunks.get(r.key) === r);
    this.queue.sort((a, b) => a.ring - b.ring);
    this.opts.onLoadedCount?.(this.chunks.size);
    this.checkReady();
  }

  private pumpDownloads(): void {
    while (this.inFlight < this.opts.quality.maxConcurrentLoads && this.queue.length) {
      const rec = this.queue.shift()!;
      this.inFlight++;
      this.download(rec)
        .then((source) => {
          if (this.chunks.get(rec.key) !== rec) disposeSource(source);
          else {
            rec.source = source;
            rec.state = "loaded";
          }
        })
        .catch((err: unknown) => {
          if (rec.abort.signal.aborted) return;
          rec.state = "failed";
          console.warn(`chunk ${rec.key} failed to load`, err);
        })
        .finally(() => this.inFlight--);
    }
  }

  private async download(rec: ChunkRecord): Promise<ChunkSource> {
    const base = this.opts.baseUrl;
    const { signal } = rec.abort;
    const get = async (file: string) => {
      const r = await fetch(`${base}/${file}`, { signal });
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
      return r;
    };
    const [glbRes, jsonRes, binRes] = await Promise.all([get(rec.meta.files.glb), get(rec.meta.files.json), get(rec.meta.files.heightfield)]);
    const [glb, json, bin] = await Promise.all([glbRes.arrayBuffer(), jsonRes.json() as Promise<ChunkJson>, binRes.arrayBuffer()]);

    const gltf = await this.loader.parseAsync(glb, "");
    const parts = new Map<string, BufferGeometry>();
    gltf.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      parts.set(mesh.name, mesh.geometry);
      // We draw with the shared atlas material; the glTF's own materials are never used.
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
    });
    return { parts, json, heights: new Float32Array(bin) };
  }

  /** Scene and physics work, a step at a time, until the deadline. */
  private runJobs(deadline: number): void {
    const records = [...this.chunks.values()].filter((r) => r.state === "loaded").sort((a, b) => a.ring - b.ring);
    for (const rec of records) {
      if (performance.now() > deadline) return;
      const detail: ChunkDetail = rec.ring <= REQUIRED_RINGS ? "full" : "reduced";
      if (rec.detail !== detail) {
        this.buildMesh(rec, detail);
        if (performance.now() > deadline) return;
      }
      const needsPhysics = rec.ring <= REQUIRED_RINGS;
      if (needsPhysics && !rec.physics && !this.physicsReleased) this.startPhysics(rec);
      if (!needsPhysics && rec.physics) this.dropPhysics(rec);
      const task = rec.physics?.task;
      while (task && rec.physics && !rec.physics.done) {
        if (task.next().done) {
          rec.physics.done = true;
          rec.physics.task = null;
          this.checkReady();
        }
        if (performance.now() > deadline) return;
      }
    }
    if (this.propsDirty && performance.now() < deadline) this.rebuildProps();
  }

  private buildMesh(rec: ChunkRecord, detail: ChunkDetail): void {
    const src = rec.source!;
    const { minX, minZ } = rec.meta.bounds;
    if (!rec.group) {
      rec.group = new Group();
      rec.group.name = `chunk ${rec.key}`;
      rec.group.position.set(minX, 0, minZ);
      rec.group.matrixAutoUpdate = false;
      rec.group.updateMatrix();
      const water = src.parts.get("water");
      if (water) {
        rec.water = makeChunkMesh(water, getWaterMaterial(), false);
        rec.water.receiveShadow = false;
        rec.group.add(rec.water);
      }
      this.root.add(rec.group);
      this.propsDirty = true;
    }
    const geometry = mergeChunkGeometry(src.parts, detail);
    if (rec.surface) {
      rec.group.remove(rec.surface);
      rec.surface.geometry.dispose();
      rec.surface = null;
    }
    if (geometry) {
      rec.surface = makeChunkMesh(geometry, this.surfaceMaterial, this.opts.quality.shadows && detail === "full");
      rec.group.add(rec.surface);
    }
    rec.detail = detail;
    this.opts.farField?.setCovered(rec.meta.cx, rec.meta.cz, true);
  }

  private startPhysics(rec: ChunkRecord): void {
    const src = rec.source!;
    const { minX, minZ } = rec.meta.bounds;
    const out = { body: null as RapierRigidBody | null };
    const task = buildChunkPhysics(
      this.opts.world,
      this.opts.rapier,
      {
        originX: minX,
        originZ: minZ,
        size: this.manifest.chunkSize,
        heights: src.heights,
        samples: this.manifest.heightfield.samples,
        roads: roadTriangles(src.parts),
        buildings: src.json.buildings ?? [],
        props: src.json.props ?? [],
      },
      out,
    );
    rec.physics = { out, task, done: false };
  }

  private dropPhysics(rec: ChunkRecord): void {
    if (!this.physicsReleased) removeChunkPhysics(this.opts.world, rec.physics?.out.body ?? null);
    rec.physics = null;
  }

  /**
   * Remove every collider while the Rapier world is still alive. Call this
   * before <Physics> frees its world: removing a body from a freed world
   * panics inside Rapier's WASM and poisons the module for the rest of the
   * page ("recursive use of an object detected…").
   */
  releasePhysics(): void {
    for (const rec of this.chunks.values()) if (rec.physics) this.dropPhysics(rec);
    this.physicsReleased = true;
  }

  /** Undo releasePhysics() (StrictMode re-runs effects); colliders rebuild over the next frames. */
  resumePhysics(): void {
    this.physicsReleased = false;
  }

  /** Ready once every existing chunk in the 3×3 around the focus has finished its colliders. */
  private checkReady(): void {
    if (this.ready) return;
    for (let dz = -REQUIRED_RINGS; dz <= REQUIRED_RINGS; dz++) {
      for (let dx = -REQUIRED_RINGS; dx <= REQUIRED_RINGS; dx++) {
        const key = keyOf(this.focusCx + dx, this.focusCz + dz);
        if (!this.metas.has(key)) continue;
        const rec = this.chunks.get(key);
        if (!rec || rec.state === "failed") continue;
        if (!rec.physics?.done) return;
      }
    }
    this.ready = true;
    this.opts.onReady?.();
  }

  private rebuildProps(): void {
    const props: Prop[] = [];
    for (const rec of this.chunks.values()) {
      if (rec.group && rec.ring <= this.opts.quality.propRings && rec.source?.json.props) props.push(...rec.source.json.props);
    }
    this.props.rebuild(props);
    this.propsDirty = false;
  }

  private unload(rec: ChunkRecord): void {
    rec.abort.abort();
    this.chunks.delete(rec.key);
    if (rec.physics) this.dropPhysics(rec);
    if (rec.group) {
      this.root.remove(rec.group);
      // Materials are shared (atlas, water); only geometry belongs to the chunk.
      rec.surface?.geometry.dispose();
      rec.group = rec.surface = rec.water = null;
      this.propsDirty = true;
    }
    if (rec.source) disposeSource(rec.source);
    rec.source = null;
    this.opts.farField?.setCovered(rec.meta.cx, rec.meta.cz, false);
  }

  /** Loaded chunk data, for debug tools. */
  loadedChunks(): ChunkJson[] {
    return [...this.chunks.values()].flatMap((r) => (r.source ? [r.source.json] : []));
  }

  dispose(): void {
    this.disposed = true;
    for (const rec of [...this.chunks.values()]) this.unload(rec);
    this.props.dispose();
    this.opts.farField?.dispose();
    this.root.clear();
  }
}

function disposeSource(src: ChunkSource): void {
  for (const g of src.parts.values()) g.dispose();
  src.parts.clear();
}

/** Parts that get a trimesh collider: the carriageway, plus the raised drains so cars can't drive through their walls. */
const COLLIDER_MATERIALS = [...ROAD_MATERIALS, "drain"];

/**
 * Drain walls are 0.3 m of concrete, and the Micra's body collider starts
 * 0.2 m up, so on its own a wall only offers a 10 cm edge that the body rides
 * up and over, leaving the car high-centred on the drain. In physics only,
 * every near-vertical drain face gets a copy stacked this far above it: a
 * solid barrier the body meets flat on. Wheel rays point down and ignore it.
 */
const DRAIN_BARRIER_LIFT = 0.35;
/** Faces whose normal's vertical part is below this count as wall. */
const WALL_NORMAL_Y = 0.35;

/** Road ribbons, junction patches and drains as one chunk-local triangle soup for a trimesh collider. */
function roadTriangles(parts: Map<string, BufferGeometry>): { positions: Float32Array; indices: Uint32Array } | null {
  const geoms = COLLIDER_MATERIALS.map((n) => parts.get(n)).filter((g): g is BufferGeometry => !!g);
  if (!geoms.length) return null;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const g of geoms) {
    const src = g.attributes.position.array as Float32Array;
    const vo = pos.length / 3;
    for (let i = 0; i < src.length; i++) pos.push(src[i]);
    const tri = g.index ? g.index.array : null;
    const n = tri ? tri.length : g.attributes.position.count;
    const at = (i: number) => (tri ? tri[i] : i);
    const drain = g === parts.get("drain");
    for (let i = 0; i + 2 < n; i += 3) {
      const a = at(i), b = at(i + 1), c = at(i + 2);
      idx.push(a + vo, b + vo, c + vo);
      if (!drain) continue;
      // Face normal's vertical share.
      const ux = src[b * 3] - src[a * 3], uy = src[b * 3 + 1] - src[a * 3 + 1], uz = src[b * 3 + 2] - src[a * 3 + 2];
      const wx = src[c * 3] - src[a * 3], wy = src[c * 3 + 1] - src[a * 3 + 1], wz = src[c * 3 + 2] - src[a * 3 + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9 || Math.abs(ny) / len > WALL_NORMAL_Y) continue;
      const base = pos.length / 3;
      for (const v of [a, b, c]) pos.push(src[v * 3], src[v * 3 + 1] + DRAIN_BARRIER_LIFT, src[v * 3 + 2]);
      idx.push(base, base + 1, base + 2);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
