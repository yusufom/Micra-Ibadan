"use client";

import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { lazy, Suspense, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Object3D } from "three";
import { MICRA_TUNING } from "@/game/config/micraTuning";
import { GameLoop } from "@/game/core/GameLoop";
import { TrafficLayer } from "@/game/npc/traffic/TrafficLayer";
import { useWorldStore } from "@/game/store/worldStore";
import { Attribution } from "@/game/ui/Attribution";
import { Hud } from "@/game/ui/Hud";
import { TouchControls } from "@/game/ui/TouchControls";
import { WorldOverlay } from "@/game/ui/WorldOverlay";
import { Micra } from "@/game/vehicles/Micra";
import { FALLBACK_SPAWN, findGarageSpawn } from "@/game/vehicles/spawn";
import { ChunkWorld } from "./ChunkWorld";
import { FreeFlyCamera } from "./debug/FreeFlyCamera";
import { useDebugKeys, useDebugToolsEnabled } from "./debug/useDebugKeys";
import { Environment } from "./Environment";
import { Ground } from "./Ground";
import { getQuality } from "./quality";
import { getRoadData } from "./roads/roadData";
import { PotholeLayer } from "./roads/PotholeLayer";

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
  const debugTools = useDebugToolsEnabled();
  useDebugKeys(debugTools);
  const quality = getQuality();
  const status = useWorldStore((s) => s.status);
  const freeFly = useWorldStore((s) => s.freeFly);
  const manifest = useWorldStore((s) => s.manifest);

  // Dugbe garage, facing Mokola along the road graph. Chunks stream around `focus`,
  // which the Micra keeps at its position; it starts at the spawn so the first
  // chunks load under the car.
  const spawn = useMemo(() => (manifest ? findGarageSpawn(manifest) : status === "missing" ? FALLBACK_SPAWN : null), [manifest, status]);
  const roads = useMemo(() => (manifest ? getRoadData(manifest) : null), [manifest]);
  const [focus] = useState(() => new Object3D());
  useLayoutEffect(() => {
    if (spawn) focus.position.set(...spawn.position);
  }, [spawn, focus]);
  // Free fly streams around the camera instead.
  const streamFocus = freeFly && debugTools ? null : focus;

  return (
    <div className="fixed inset-0 bg-black">
      <Canvas
        shadows={quality.shadows ? "percentage" : false}
        dpr={[1, quality.maxDpr]}
        gl={{ antialias: quality.tier === "high", powerPreference: "high-performance" }}
        camera={{ position: [8, 5, 10], fov: MICRA_TUNING.camera.fov, near: 0.3, far: quality.viewDistance }}
      >
        <Suspense fallback={null}>
          <Environment focus={streamFocus} />
          {/* Hold the simulation until the chunks under the car have colliders. Free fly also
              pauses it: flying off would unload the ground under the car. Physics runs before
              the default frame callbacks so the camera sees this frame's car. */}
          <Physics gravity={[0, -9.81, 0]} debug={physicsDebug} paused={status === "loading" || freeFly} updatePriority={-0.5}>
            <ChunkWorld area="dugbe-ui" focus={streamFocus} />
            {status === "missing" && <Ground />}
            {spawn && <Micra spawn={spawn} roads={roads} focus={focus} camera={!(freeFly && debugTools)} debugKeys={debugTools} />}
            {roads && <PotholeLayer field={roads.potholes} focus={streamFocus ?? undefined} />}
            {roads && manifest && status === "ready" && <TrafficLayer roads={roads} manifest={manifest} />}
          </Physics>
          <GameLoop />
        </Suspense>
        {freeFly && debugTools && <FreeFlyCamera />}
        {Perf && (
          <Suspense fallback={null}>
            <Perf position="bottom-left" />
          </Suspense>
        )}
      </Canvas>
      <Hud />
      <TouchControls />
      <WorldOverlay debugTools={debugTools} />
      <Attribution />
    </div>
  );
}
