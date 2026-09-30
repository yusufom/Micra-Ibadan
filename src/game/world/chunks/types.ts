/**
 * Chunk data written by pipeline/ (see pipeline/README.md for the format).
 * Only the fields the game reads are typed.
 */

export type Bounds = { minX: number; minZ: number; maxX: number; maxZ: number };

export type Attribution = { source: string; text: string; url: string };

export type ChunkMeta = {
  cx: number;
  cz: number;
  bounds: Bounds;
  minY: number;
  maxY: number;
  files: { glb: string; json: string; heightfield: string };
};

export type RoadEdge = {
  id: number;
  u: number;
  v: number;
  name: string | null;
  ref: string | null;
  highway: string;
  /** Total lanes (both directions on two-way roads). */
  lanes: number;
  oneway: boolean;
  speedLimitKph: number;
  surface: "paved" | "unpaved";
  bridge: boolean;
  /** Carriageway width, m. */
  width: number;
  /** Raised drains beside the kerb. */
  drains: boolean;
  /** Part of a roundabout ring (OSM junction=roundabout). Missing in chunks built before it was added. */
  roundabout?: boolean;
  length: number;
  /** Average grade from u to v, %. */
  grade: number;
  /** Steepest 20 m stretch, %. */
  maxGrade: number;
  /** [x, y, z] points. */
  polyline: [number, number, number][];
};

export type RoadNode = { id: number; x: number; y: number; z: number; degree: number };

/** Where a stop, garage or POI meets the road graph. `side` is relative to the edge's u → v direction. */
export type RoadRef = { edgeId: number; s: number; side: "left" | "right"; distance: number };

export type Garage = { name: string; type: string; id: string; x: number; y: number; z: number; road?: RoadRef };

export type Stop = { type: string; id: string; name: string; x: number; y: number; z: number; road?: RoadRef };

export type Poi = {
  type: "landmark" | "market" | "fuel" | "police" | "school";
  kind?: string;
  id: string;
  name?: string;
  x: number;
  y: number;
  z: number;
  road?: RoadRef;
};

export type FarFieldMeta = {
  heightfield: string;
  colorMap: string;
  spacing: number;
  rows: number;
  cols: number;
};

export type Manifest = {
  version: number;
  area: { key: string; name: string };
  chunkSize: number;
  chunkRange: { cx: [number, number]; cz: [number, number] };
  extent: Bounds;
  heightfield: { samples: number; spacing: number };
  chunks: ChunkMeta[];
  roadGraph: { nodes: RoadNode[]; edges: RoadEdge[] };
  stops: Stop[];
  garages: Garage[];
  pois: Poi[];
  attribution: Attribution[];
  /** Added in format version 2. */
  farField?: FarFieldMeta;
};

export type BuildingCollider =
  | { shape: "box"; x: number; z: number; hx: number; hz: number; yaw: number; y0: number; y1: number }
  | { shape: "hull"; pts: [number, number][]; y0: number; y1: number };

export type PropType = "pole" | "kiosk" | "mechanic_shed" | "garage_shelter" | "garage_board";

export type Prop = {
  type: PropType;
  x: number;
  y: number;
  z: number;
  /** About +Y, 0 = north; local -Z faces the road. */
  yaw: number;
  variant?: number;
  /** Poles: the next pole on the same run, for wires. */
  next?: [number, number, number];
  /** Garage boards. */
  name?: string;
};

export type ChunkJson = {
  version: number;
  cx: number;
  cz: number;
  bounds: Bounds;
  roads: RoadEdge[];
  garages: Garage[];
  /** Format version 2+. */
  buildings?: BuildingCollider[];
  props?: Prop[];
};
