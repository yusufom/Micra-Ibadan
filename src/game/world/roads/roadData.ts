import type { Manifest } from "../chunks/types";
import { RoadGraph } from "../RoadGraph";
import { PotholeField } from "./potholes";
import { RoadIndex } from "./roadIndex";

export type RoadData = { index: RoadIndex; potholes: PotholeField; graph: RoadGraph };

const cache = new WeakMap<Manifest, RoadData>();

/** Road lookups built from the manifest's road graph, once per manifest. */
export function getRoadData(manifest: Manifest): RoadData {
  let data = cache.get(manifest);
  if (!data) {
    const edges = manifest.roadGraph.edges;
    const index = new RoadIndex(edges);
    data = { index, potholes: new PotholeField(edges), graph: new RoadGraph(manifest, index) };
    cache.set(manifest, data);
  }
  return data;
}
