"use client";

import { useFrame } from "@react-three/fiber";
import { CuboidCollider, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { useRef } from "react";
import { gameEvents } from "@/game/core/events";
import { useGameStore } from "@/game/store/gameStore";
import { MICRA_LIVERY as C } from "./micraSpec";

/** Nissan Micra K11 approx: 3.7 m long, 1.58 m wide, 1.44 m tall, ~850 kg. */
const LENGTH = 3.7;
const WIDTH = 1.58;
const BODY_BOTTOM = 0.25;
/** Beltline: where the maroon body stops and the cream glasshouse starts. */
const BELTLINE = 0.87;
const ROOF = 1.44;
const MASS = 850;
const WHEEL_RADIUS = 0.28;
const WHEEL_WIDTH = 0.18;

/** Glasshouse runs from the windscreen base to the near-vertical hatch. */
const CABIN_FRONT = -0.8;
const CABIN_REAR = LENGTH / 2 - 0.1;
const CABIN_LENGTH = CABIN_REAR - CABIN_FRONT;
const CABIN_Z = (CABIN_FRONT + CABIN_REAR) / 2;
const CABIN_HEIGHT = ROOF - BELTLINE;
const CABIN_WIDTH = WIDTH - 0.12;
const WINDOW_HEIGHT = 0.36;
const WINDOW_Y = BELTLINE + 0.06 + WINDOW_HEIGHT / 2;

/** Below this speed (m/s) the car counts as stopped. */
const STOP_THRESHOLD = 0.15;
const MOVE_THRESHOLD = 0.5;

const WHEELS: [number, number, number][] = [
  [WIDTH / 2 - 0.08, WHEEL_RADIUS, -LENGTH / 2 + 0.65],
  [-WIDTH / 2 + 0.08, WHEEL_RADIUS, -LENGTH / 2 + 0.65],
  [WIDTH / 2 - 0.08, WHEEL_RADIUS, LENGTH / 2 - 0.6],
  [-WIDTH / 2 + 0.08, WHEEL_RADIUS, LENGTH / 2 - 0.6],
];

type MicraProps = {
  id?: string;
  position?: [number, number, number];
};

/**
 * Placeholder Ibadan Micra taxi built from boxes in the city's livery:
 * maroon body, cream roof and pillars, black bumpers and rub strip.
 * Forward is -Z. Origin is at ground contact; the collider spans from the
 * ground to the beltline so the car rests on it.
 */
export function Micra({ id = "player", position = [0, 1, 0] }: MicraProps) {
  const body = useRef<RapierRigidBody>(null);
  const moving = useRef(false);

  useFrame(() => {
    const rb = body.current;
    if (!rb) return;
    const v = rb.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);

    // Transient store write: HUD reads this via subscribe, no React re-render.
    useGameStore.setState({ speed });

    if (!moving.current && speed > MOVE_THRESHOLD) moving.current = true;
    else if (moving.current && speed < STOP_THRESHOLD) {
      moving.current = false;
      const p = rb.translation();
      gameEvents.emit("VEHICLE_STOPPED", { vehicleId: id, position: [p.x, p.y, p.z] });
    }
  });

  const bodyHeight = BELTLINE - BODY_BOTTOM;

  return (
    <RigidBody ref={body} position={position} colliders={false} friction={1} linearDamping={0.05} angularDamping={0.3}>
      <CuboidCollider args={[WIDTH / 2, BELTLINE / 2, LENGTH / 2]} position={[0, BELTLINE / 2, 0]} mass={MASS} />

      {/* Maroon lower body. */}
      <mesh position={[0, BODY_BOTTOM + bodyHeight / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[WIDTH, bodyHeight, LENGTH]} />
        <meshStandardMaterial color={C.body} roughness={0.6} metalness={0.15} />
      </mesh>

      {/* Black side rub strip along the doors. */}
      <mesh position={[0, BODY_BOTTOM + 0.3, -0.05]}>
        <boxGeometry args={[WIDTH + 0.02, 0.06, 2.3]} />
        <meshStandardMaterial color={C.trim} roughness={0.8} />
      </mesh>

      {/* Black bumpers; the rear one wraps up higher, as on the K11. */}
      <mesh position={[0, BODY_BOTTOM + 0.1, -LENGTH / 2 - 0.04]} castShadow>
        <boxGeometry args={[WIDTH + 0.02, 0.22, 0.12]} />
        <meshStandardMaterial color={C.bumper} roughness={0.85} />
      </mesh>
      <mesh position={[0, BODY_BOTTOM + 0.14, LENGTH / 2 + 0.04]} castShadow>
        <boxGeometry args={[WIDTH + 0.02, 0.3, 0.12]} />
        <meshStandardMaterial color={C.bumper} roughness={0.85} />
      </mesh>

      {/* Head and tail lights. */}
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[side * (WIDTH / 2 - 0.25), BELTLINE - 0.15, -LENGTH / 2 - 0.005]}>
            <boxGeometry args={[0.3, 0.14, 0.02]} />
            <meshStandardMaterial color={C.headLight} roughness={0.3} />
          </mesh>
          <mesh position={[side * (WIDTH / 2 - 0.15), BELTLINE - 0.12, LENGTH / 2 + 0.005]}>
            <boxGeometry args={[0.2, 0.3, 0.02]} />
            <meshStandardMaterial color={C.tailLight} roughness={0.3} />
          </mesh>
        </group>
      ))}

      {/* Cream glasshouse: roof and pillars. */}
      <mesh position={[0, BELTLINE + CABIN_HEIGHT / 2, CABIN_Z]} castShadow>
        <boxGeometry args={[CABIN_WIDTH, CABIN_HEIGHT, CABIN_LENGTH]} />
        <meshStandardMaterial color={C.roof} roughness={0.55} />
      </mesh>

      {/* Side windows (front door, rear door) split by the B-pillar; thick cream C-pillar behind. */}
      <mesh position={[0, WINDOW_Y, CABIN_FRONT + 0.1 + 0.55]}>
        <boxGeometry args={[CABIN_WIDTH + 0.02, WINDOW_HEIGHT, 1.1]} />
        <meshStandardMaterial color={C.glass} roughness={0.1} metalness={0.3} />
      </mesh>
      <mesh position={[0, WINDOW_Y, CABIN_FRONT + 1.3 + 0.45]}>
        <boxGeometry args={[CABIN_WIDTH + 0.02, WINDOW_HEIGHT, 0.9]} />
        <meshStandardMaterial color={C.glass} roughness={0.1} metalness={0.3} />
      </mesh>

      {/* Windscreen and hatch glass. */}
      <mesh position={[0, WINDOW_Y + 0.02, CABIN_FRONT - 0.01]}>
        <boxGeometry args={[CABIN_WIDTH - 0.16, WINDOW_HEIGHT + 0.04, 0.02]} />
        <meshStandardMaterial color={C.glass} roughness={0.1} metalness={0.3} />
      </mesh>
      <mesh position={[0, WINDOW_Y + 0.02, CABIN_REAR + 0.01]}>
        <boxGeometry args={[CABIN_WIDTH - 0.2, WINDOW_HEIGHT, 0.02]} />
        <meshStandardMaterial color={C.glass} roughness={0.1} metalness={0.3} />
      </mesh>

      {/* Steel wheels. */}
      {WHEELS.map((p, i) => (
        <group key={i} position={p} rotation={[0, 0, Math.PI / 2]}>
          <mesh castShadow>
            <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 20]} />
            <meshStandardMaterial color={C.wheel} roughness={0.9} />
          </mesh>
          <mesh>
            <cylinderGeometry args={[WHEEL_RADIUS * 0.6, WHEEL_RADIUS * 0.6, WHEEL_WIDTH + 0.01, 16]} />
            <meshStandardMaterial color={C.rim} roughness={0.6} metalness={0.4} />
          </mesh>
        </group>
      ))}
    </RigidBody>
  );
}
