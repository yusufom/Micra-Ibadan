import type { Manifest } from "../chunks/types";
import { PotholeField } from "./potholes";
import { RoadIndex } from "./roadIndex";

export type RoadData = { index: RoadIndex; potholes: PotholeField };

const cache = new WeakMap<Manifest, RoadData>();

/** Road lookups built from the manifest's road graph, once per manifest. */
export function getRoadData(manifest: Manifest): RoadData {
  let data = cache.get(manifest);
  if (!data) {
    const edges = manifest.roadGraph.edges;
    data = { index: new RoadIndex(edges), potholes: new PotholeField(edges) };
    cache.set(manifest, data);
  }
  return data;
}
