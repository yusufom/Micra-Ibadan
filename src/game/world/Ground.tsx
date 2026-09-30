"use client";

import { CuboidCollider, RigidBody } from "@react-three/rapier";

/** Fallback ground when no map chunks have been built (public/chunks is gitignored): a 500 m square with a gentle slope. */
export const GROUND_SIZE = 500;
/** Rise towards the north (-Z), in radians. ~2° is a mild Ibadan street. */
export const GROUND_SLOPE = (2 * Math.PI) / 180;

const HALF = GROUND_SIZE / 2;
const COLLIDER_HALF_THICKNESS = 0.5;

export function Ground() {
  return (
    <RigidBody type="fixed" colliders={false} rotation={[GROUND_SLOPE, 0, 0]} friction={1}>
      <CuboidCollider args={[HALF, COLLIDER_HALF_THICKNESS, HALF]} position={[0, -COLLIDER_HALF_THICKNESS, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[GROUND_SIZE, GROUND_SIZE]} />
        {/* Laterite red-brown, the colour of Ibadan's unpaved roadsides. */}
        <meshStandardMaterial color="#9c5a3c" roughness={0.95} />
      </mesh>
    </RigidBody>
  );
}
