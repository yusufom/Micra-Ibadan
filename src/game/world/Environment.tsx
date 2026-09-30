"use client";

import { Sky } from "@react-three/drei";

/** Sun direction for a mid-morning sun over Ibadan (east-ish, high). */
const SUN_POSITION: [number, number, number] = [80, 120, 40];
const SHADOW_EXTENT = 60;

export function Environment() {
  return (
    <>
      <Sky sunPosition={SUN_POSITION} turbidity={8} rayleigh={1.5} mieCoefficient={0.01} />
      <hemisphereLight args={["#cfe3ff", "#6b4a32", 0.6]} />
      <directionalLight
        position={SUN_POSITION}
        intensity={2.5}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
        shadow-camera-near={1}
        shadow-camera-far={400}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
      />
    </>
  );
}
