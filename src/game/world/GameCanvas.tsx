"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { lazy, Suspense, useSyncExternalStore } from "react";
import { GameLoop } from "@/game/core/GameLoop";
import { useWorldStore } from "@/game/store/worldStore";
import { Attribution } from "@/game/ui/Attribution";
import { Hud } from "@/game/ui/Hud";
import { WorldOverlay } from "@/game/ui/WorldOverlay";
import { Micra } from "@/game/vehicles/Micra";
import { ChunkWorld } from "./ChunkWorld";
import { FreeFlyCamera } from "./debug/FreeFlyCamera";
import { useDebugKeys, useDebugToolsEnabled } from "./debug/useDebugKeys";
import { Environment } from "./Environment";
import { Ground } from "./Ground";
import { getQuality } from "./quality";

const isDev = process.env.NODE_ENV === "development";

// Statically false in production builds, so r3f-perf is dropped from the bundle.
const Perf = isDev ? lazy(() => import("r3f-perf").then((m) => ({ default: m.Perf }))) : null;

/** Dugbe junction, the projection origin. Road surface is ~0.4 m above origin height here. */
const SPAWN: [number, number, number] = [0, 1.5, 0];

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
  const debugTools = useDebugToolsEnabled();
  useDebugKeys(debugTools);
  const quality = getQuality();
  const status = useWorldStore((s) => s.status);
  const freeFly = useWorldStore((s) => s.freeFly);

  return (
    <div className="fixed inset-0 bg-black">
      <Canvas
        shadows={quality.shadows ? "percentage" : false}
        dpr={[1, quality.maxDpr]}
        gl={{ antialias: quality.tier === "high", powerPreference: "high-performance" }}
        camera={{ position: [SPAWN[0] + 7, SPAWN[1] + 4, SPAWN[2] + 9], fov: 50, near: 0.3, far: quality.viewDistance }}
      >
        <Suspense fallback={null}>
          <Environment />
          {/* Hold the simulation until the chunks under the car have colliders. Chunks stream
              around the camera for now, so free fly also pauses it: flying off would unload the
              ground under the car. */}
          <Physics gravity={[0, -9.81, 0]} debug={physicsDebug} paused={status === "loading" || freeFly}>
            <ChunkWorld area="dugbe-ui" />
            {status === "missing" && <Ground />}
            <Micra position={SPAWN} />
          </Physics>
          <GameLoop />
        </Suspense>
        {freeFly && debugTools ? (
          <FreeFlyCamera />
        ) : (
          <OrbitControls target={[SPAWN[0], SPAWN[1], SPAWN[2]]} maxPolarAngle={Math.PI / 2 - 0.05} makeDefault />
        )}
        {Perf && (
          <Suspense fallback={null}>
            <Perf position="bottom-left" />
          </Suspense>
        )}
      </Canvas>
      <Hud />
      <WorldOverlay debugTools={debugTools} />
      <Attribution />
    </div>
  );
}
