/**
 * Traffic numbers for the debug overlay, written by TrafficLayer about twice
 * a second. Plain module state: read it on a timer, never per frame in React.
 */
export const trafficStats = {
  enabled: false,
  active: 0,
  target: 0,
  parked: 0,
  physics: 0,
  hailers: 0,
  stolen: 0,
  horns: 0,
  collisions: 0,
  /** Mean and worst sim + render update time per frame over the last half second, ms. */
  ms: 0,
  maxMs: 0,
  byKind: {} as Record<string, number>,
  junctions: {} as Record<string, number>,
};
