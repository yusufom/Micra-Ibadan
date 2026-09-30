"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useAfterPhysicsStep, useBeforePhysicsStep, useRapier } from "@react-three/rapier";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Frustum, Matrix4, Sphere, Vector3 } from "three";
import { TRAFFIC_TUNING } from "@/game/config/trafficTuning";
import { gameClock } from "@/game/core/clock";
import { playerVehicle } from "@/game/vehicles/playerVehicle";
import type { Manifest } from "@/game/world/chunks/types";
import { getQuality } from "@/game/world/quality";
import type { RoadData } from "@/game/world/roads/roadData";
import { TrafficPhysics } from "./TrafficPhysics";
import { TrafficRenderer } from "./TrafficRenderer";
import { type TrafficContext, TrafficSim } from "./TrafficSim";
import { trafficStats } from "./trafficStats";

type Props = {
  roads: RoadData;
  manifest: Manifest;
};

/** ?traffic=N overrides the active vehicle cap (0 turns traffic off). */
function maxActiveFromUrl(): number {
  const tier = getQuality().tier;
  const raw = new URLSearchParams(window.location.search).get("traffic");
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(200, Math.round(n)) : TRAFFIC_TUNING.maxActive[tier];
}

const frustum = new Frustum();
const projView = new Matrix4();
const sphere = new Sphere();
const centre = new Vector3();

/**
 * AI traffic in the scene. Must sit inside <Physics>: vehicles near the
 * player get kinematic bodies. The sim runs on the game clock, so it pauses
 * with it; it keeps running in free fly, centred on the camera.
 */
export function TrafficLayer({ roads, manifest }: Props) {
  const { world, rapier } = useRapier();
  const camera = useThree((s) => s.camera);
  const maxActive = useMemo(() => maxActiveFromUrl(), []);
  const sim = useMemo(() => new TrafficSim(roads.graph, manifest, maxActive), [roads, manifest, maxActive]);
  const renderer = useMemo(() => new TrafficRenderer(Math.max(1, maxActive)), [maxActive]);
  const physics = useMemo(() => new TrafficPhysics(world, rapier, sim), [world, rapier, sim]);

  // Free bodies in the commit phase, before <Physics> frees the world on unmount.
  useLayoutEffect(() => {
    physics.resume();
    return () => physics.dispose();
  }, [physics]);
  useEffect(() => {
    const stop = sim.start();
    return () => {
      stop();
      trafficStats.enabled = false;
    };
  }, [sim]);
  useEffect(() => () => renderer.dispose(), [renderer]);

  useBeforePhysicsStep((w) => physics.beforeStep(w.timestep));
  useAfterPhysicsStep(() => physics.afterStep());

  const ctx = useRef<TrafficContext>({
    focusX: 0,
    focusZ: 0,
    player: null,
    time: 0,
    hour: 0,
    weekday: 0,
    day: 0,
    isVisible: (x, y, z, r) => {
      sphere.set(centre.set(x, y, z), r);
      return frustum.intersectsSphere(sphere);
    },
  });
  const timing = useRef({ ms: 0, max: 0, frames: 0, next: 0 });

  useFrame(() => {
    if (maxActive === 0) return;
    const t0 = performance.now();
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    const c = ctx.current;
    const p = playerVehicle;
    const onFoot = !p.active || camera.position.distanceToSquared(centre.set(p.x, p.y, p.z)) > 150 * 150;
    // Centre on the Micra; in free fly (camera far from it) on the camera.
    c.focusX = onFoot ? camera.position.x : p.x;
    c.focusZ = onFoot ? camera.position.z : p.z;
    c.player = p.active ? p : null;
    c.time = gameClock.elapsed;
    c.hour = gameClock.hourOfDay;
    c.weekday = gameClock.weekday;
    c.day = gameClock.day;
    const dt = gameClock.delta;
    sim.update(dt, c);
    physics.sync();
    renderer.update(sim, roads.graph, sim.junctions, c.time, c.hour, dt, c.focusX, c.focusZ);

    const tm = timing.current;
    const spent = performance.now() - t0;
    tm.ms += spent;
    tm.max = Math.max(tm.max, spent);
    tm.frames++;
    if (t0 > tm.next) {
      const st = sim.stats;
      Object.assign(trafficStats, {
        enabled: true,
        active: st.active,
        target: st.target,
        parked: st.parked,
        physics: physics.count,
        hailers: st.hailers,
        stolen: st.stolen,
        horns: st.horns,
        collisions: st.collisions,
        ms: tm.ms / Math.max(1, tm.frames),
        maxMs: tm.max,
        byKind: { ...st.byKind },
      });
      if (!Object.keys(trafficStats.junctions).length) trafficStats.junctions = sim.junctions.stats();
      tm.ms = 0;
      tm.max = 0;
      tm.frames = 0;
      tm.next = t0 + 500;
    }
  });

  // Dev handle for poking at the sim from the console.
  useEffect(() => {
    if (process.env.NODE_ENV !== "development" && !new URLSearchParams(window.location.search).has("debug")) return;
    Object.assign(window, { __traffic: sim, __trafficStats: trafficStats, __trafficGroup: renderer.group, __player: playerVehicle });
  }, [sim, renderer]);

  return <primitive object={renderer.group} />;
}
