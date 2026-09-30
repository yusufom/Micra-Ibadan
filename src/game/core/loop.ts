/**
 * Fixed-order system registry. Systems register an update function; GameLoop
 * (inside the Canvas) calls runSystems once per frame after advancing the
 * clock. Keep per-frame work here or in useFrame, never in React state.
 */

export type SystemUpdate = (dt: number, elapsed: number) => void;

type SystemEntry = { name: string; order: number; update: SystemUpdate };

const systems: SystemEntry[] = [];

/** Register a per-frame system. Lower order runs first. Returns an unregister function. */
export function registerSystem(name: string, update: SystemUpdate, order = 0): () => void {
  const entry: SystemEntry = { name, order, update };
  systems.push(entry);
  systems.sort((a, b) => a.order - b.order);
  return () => {
    const i = systems.indexOf(entry);
    if (i !== -1) systems.splice(i, 1);
  };
}

export function runSystems(dt: number, elapsed: number): void {
  for (let i = 0; i < systems.length; i++) systems[i].update(dt, elapsed);
}
