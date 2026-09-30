import { TRAFFIC_TUNING as T } from "@/game/config/trafficTuning";
import type { Manifest } from "@/game/world/chunks/types";
import { WORLD_ORIGIN } from "@/game/world/projection";
import { type DirEdge, edgeIdOf, highwayRank, type RoadGraph } from "@/game/world/RoadGraph";

/**
 * How each junction is run. Real OSM roundabouts (Mokola, Old Bodija …) and
 * Dugbe are roundabouts; some junctions of two busy roads get signals, which
 * are often dead (no power) and often ignored; everything else is negotiated
 * by aggression and the horn. Some junctions are marked as OYRTMA posts for
 * the enforcement system.
 */

export type JunctionControl = "signal" | "roundabout" | "uncontrolled";

export type SignalState = "green" | "amber" | "red";

export type Junction = {
  node: number;
  x: number;
  y: number;
  z: number;
  control: JunctionControl;
  name: string | null;
  /** Signal with no power: drivers treat it as uncontrolled. */
  dead: boolean;
  /** Signal phase group (0/1) of each arriving directed edge. */
  axis: Map<DirEdge, number>;
  /** Signal cycle offset, s. */
  offset: number;
  /** Highest road class rank among the arms. */
  rank: number;
  /** An OYRTMA officer post (for the enforcement system, later). */
  oyrtma: boolean;
  /** Vehicle ids given the right to cross (in the box or committed). */
  occupants: Set<number>;
};

export type OyrtmaPoint = { node: number; x: number; y: number; z: number; reason: string };

/** Integer hash of an OSM id, 0–1. Deterministic across sessions. */
export function hash01(id: number, salt = 0): number {
  let h = (Math.floor(id % 2147483647) ^ (salt * 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const cycleLength = () => 2 * (T.junction.green + T.junction.amber + T.junction.allRed);

export class Junctions {
  private readonly byNode = new Map<number, Junction>();

  constructor(graph: RoadGraph, manifest: Manifest) {
    const heading = { x: 0, z: 0 };
    const busySpots = [...(manifest.garages ?? []), ...(manifest.pois ?? []).filter((p) => p.type === "market")];
    for (const [id, node] of graph.nodes) {
      const arriving = graph.in(id);
      const leaving = graph.out(id);
      const edgeIds = new Set<number>([...arriving, ...leaving].map(edgeIdOf));
      const ring = [...edgeIds].some((e) => graph.edges[e].roundabout);
      if (node.degree < 3 && !ring) continue;
      const ranks = [...edgeIds].map((e) => highwayRank(graph.edges[e].highway));
      const rank = Math.max(...ranks);
      const major = ranks.filter((r) => r >= 3).length;

      let control: JunctionControl = "uncontrolled";
      let name: string | null = null;
      if (id === WORLD_ORIGIN.osmNodeId) {
        control = "roundabout";
        name = "Dugbe";
      } else if (ring) {
        control = "roundabout";
        name = [...edgeIds].map((e) => graph.edges[e]).find((e) => e.roundabout && e.name)?.name ?? null;
      } else if (major >= 2 && node.degree >= 4 && hash01(id, 1) < T.junction.signalShare) {
        control = "signal";
      }

      // Signal groups: the busiest arm and the arm most opposite it share a phase.
      const axis = new Map<DirEdge, number>();
      if (control === "signal") {
        const arms = arriving.map((de) => {
          graph.heading(de, true, heading);
          return { de, x: heading.x, z: heading.z, rank: highwayRank(graph.edge(de).highway) };
        });
        arms.sort((a, b) => b.rank - a.rank);
        const main = arms[0];
        for (const a of arms) axis.set(a.de, Math.abs(a.x * main.x + a.z * main.z) > 0.7 ? 0 : 1);
      }

      const nearBusy = busySpots.some((p) => Math.hypot(p.x - node.x, p.z - node.z) < 150);
      // OYRTMA stand at the signals, Dugbe, some roundabouts and busy junctions near garages and markets.
      const oyrtma =
        control === "signal" ||
        name === "Dugbe" ||
        (control === "roundabout" && hash01(id, 2) < 0.2) ||
        (major >= 2 && node.degree >= 3 && (nearBusy || hash01(id, 3) < 0.03));

      this.byNode.set(id, {
        node: id,
        x: node.x,
        y: node.y,
        z: node.z,
        control,
        name,
        dead: control === "signal" && hash01(id, 4) < T.junction.deadSignalShare,
        axis,
        offset: hash01(id, 5) * cycleLength(),
        rank,
        oyrtma,
        occupants: new Set(),
      });
    }
  }

  get(node: number): Junction | undefined {
    return this.byNode.get(node);
  }

  all(): IterableIterator<Junction> {
    return this.byNode.values();
  }

  /** Light facing traffic arriving on `de` at game time `t` (seconds). Dead signals read green. */
  signal(j: Junction, de: DirEdge, t: number): SignalState {
    if (j.control !== "signal" || j.dead) return "green";
    const g = T.junction.green;
    const a = T.junction.amber;
    const half = g + a + T.junction.allRed;
    const phase = (((t + j.offset) % (2 * half)) + 2 * half) % (2 * half);
    const local = (j.axis.get(de) ?? 0) === 0 ? phase : (phase + half) % (2 * half);
    return local < g ? "green" : local < g + a ? "amber" : "red";
  }

  /** Junctions marked as OYRTMA posts, for the enforcement system. */
  oyrtmaPoints(): OyrtmaPoint[] {
    const out: OyrtmaPoint[] = [];
    for (const j of this.byNode.values()) {
      if (!j.oyrtma) continue;
      const reason = j.name ? `${j.name} ${j.control}` : j.control === "signal" ? "signalised junction" : j.control === "roundabout" ? "roundabout" : "busy junction";
      out.push({ node: j.node, x: j.x, y: j.y, z: j.z, reason });
    }
    return out;
  }

  /** Counts by control type, for the debug overlay and the report. */
  stats(): Record<string, number> {
    const s: Record<string, number> = { signal: 0, deadSignal: 0, roundabout: 0, uncontrolled: 0, oyrtma: 0 };
    for (const j of this.byNode.values()) {
      s[j.control]++;
      if (j.dead) s.deadSignal++;
      if (j.oyrtma) s.oyrtma++;
    }
    return s;
  }
}

const cache = new WeakMap<RoadGraph, Junctions>();

/** Junction controls for a road graph, built once. */
export function getJunctions(graph: RoadGraph, manifest: Manifest): Junctions {
  let j = cache.get(graph);
  if (!j) cache.set(graph, (j = new Junctions(graph, manifest)));
  return j;
}
