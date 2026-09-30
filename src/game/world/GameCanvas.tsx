"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { lazy, Suspense, useSyncExternalStore } from "react";
import { GameLoop } from "@/game/core/GameLoop";
import { Hud } from "@/game/ui/Hud";
import { Micra } from "@/game/vehicles/Micra";
import { Environment } from "./Environment";
import { Ground } from "./Ground";

const isDev = process.env.NODE_ENV === "development";

// Statically false in production builds, so r3f-perf is dropped from the bundle.
const Perf = isDev ? lazy(() => import("r3f-perf").then((m) => ({ default: m.Perf }))) : null;

/** ?debug in the URL draws Rapier colliders (dev only). */
function usePhysicsDebug(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => isDev && new URLSearchParams(window.location.search).has("debug"),
    () => false,
  );
}

/** Client-only game root. Only ever load through next/dynamic with ssr: false. */
export default function GameCanvas() {
  const physicsDebug = usePhysicsDebug();

  return (
    <div className="fixed inset-0 bg-black">
      <Canvas shadows="percentage" camera={{ position: [7, 4, 9], fov: 50, near: 0.1, far: 2000 }}>
        <Suspense fallback={null}>
          <Environment />
          <Physics gravity={[0, -9.81, 0]} debug={physicsDebug}>
            <Ground />
            <Micra position={[0, 1, 0]} />
          </Physics>
          <GameLoop />
        </Suspense>
        <OrbitControls target={[0, 0.8, 0]} maxPolarAngle={Math.PI / 2 - 0.05} makeDefault />
        {Perf && (
          <Suspense fallback={null}>
            <Perf position="bottom-left" />
          </Suspense>
        )}
      </Canvas>
      <Hud />
    </div>
  );
}
