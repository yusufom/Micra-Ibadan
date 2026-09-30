import type { RapierRigidBody } from "@react-three/rapier";

/**
 * The player's Micra as other systems see it: written by Micra.tsx every
 * frame, read by traffic and roadside NPCs. Plain mutable module state, never
 * React state.
 */
export const playerVehicle = {
  /** False until the Micra exists (and while it's unmounted). */
  active: false,
  id: "player",
  x: 0,
  y: 0,
  z: 0,
  /** Velocity, m/s. */
  vx: 0,
  vy: 0,
  vz: 0,
  speed: 0,
  /** Unit heading in the ground plane (the nose, -Z local). */
  fx: 0,
  fz: -1,
  /** Half extents of the body, m. */
  halfWidth: 0.79,
  halfLength: 1.86,
  mass: 865,
  /** The Rapier body, for contact checks. */
  body: null as RapierRigidBody | null,
};

export type PlayerVehicle = typeof playerVehicle;
