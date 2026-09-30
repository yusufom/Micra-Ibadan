"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Object3D, Vector3 } from "three";
import { useWorldStore } from "@/game/store/worldStore";
import { ChunkManager } from "./ChunkManager";
import type { Manifest } from "./chunks/types";
import { GradeOverlay } from "./debug/GradeOverlay";
import { getQuality } from "./quality";
import { FarField } from "./terrain/FarField";

type Props = {
  /** Area key from pipeline/areas.yaml; chunks are served from /chunks/{area}/. */
  area?: string;
  /** What to stream around. Defaults to the camera; pass the Micra later. */
  focus?: RefObject<Object3D | null>;
};

/** Velocity smoothing per frame, so preloading doesn't flip on camera jitter. */
const VELOCITY_BLEND = 0.1;

/**
 * Streams the real Ibadan map into the scene and physics world. Must sit
 * inside <Physics>. Sets useWorldStore status to "ready" once the chunks
 * around the focus have colliders, or "missing" if the area was never built.
 */
export function ChunkWorld({ area = "dugbe-ui", focus }: Props) {
  const { world, rapier } = useRapier();
  const camera = useThree((s) => s.camera);
  const [manager, setManager] = useState<ChunkManager | null>(null);
  const showGrades = useWorldStore((s) => s.showGrades);

  useEffect(() => {
    const ctrl = new AbortController();
    const baseUrl = `/chunks/${area}`;
    const quality = getQuality();
    const store = useWorldStore.getState();
    let mgr: ChunkManager | null = null;
    store.setStatus("loading");

    (async () => {
      const res = await fetch(`${baseUrl}/manifest.json`, { signal: ctrl.signal });
      if (!res.ok) {
        store.setStatus("missing");
        return;
      }
      const manifest = (await res.json()) as Manifest;
      store.setAttribution(manifest.attribution);
      const far = await FarField.load(manifest, baseUrl, quality.tier === "low" ? 2 : 1, ctrl.signal).catch((err: unknown) => {
        if (!ctrl.signal.aborted) console.warn("far field unavailable", err);
        return null;
      });
      if (ctrl.signal.aborted) {
        far?.dispose();
        return;
      }
      mgr = new ChunkManager({
        baseUrl,
        manifest,
        quality,
        world,
        rapier,
        farField: far,
        onReady: () => useWorldStore.getState().setStatus("ready"),
        onLoadedCount: (n) => useWorldStore.getState().setLoadedChunks(n),
      });
      setManager(mgr);
    })().catch((err: unknown) => {
      if (ctrl.signal.aborted) return;
      console.error("map failed to load", err);
      store.setStatus("missing");
    });

    return () => {
      ctrl.abort();
      mgr?.dispose();
      setManager(null);
    };
  }, [area, world, rapier]);

  // Layout-effect cleanups run in the commit phase, before any passive-effect
  // cleanup, so this always runs before <Physics> frees the Rapier world on
  // unmount (the passive dispose above would be too late).
  useLayoutEffect(() => {
    if (!manager) return;
    manager.resumePhysics();
    return () => manager.releasePhysics();
  }, [manager]);

  const last = useRef(new Vector3(Number.NaN, 0, 0));
  const velocity = useRef(new Vector3());
  const step = useRef(new Vector3());

  useFrame((_, dt) => {
    if (!manager) return;
    const p = focus?.current?.position ?? camera.position;
    if (!Number.isNaN(last.current.x) && dt > 0) {
      step.current.subVectors(p, last.current).divideScalar(dt);
      velocity.current.lerp(step.current, VELOCITY_BLEND);
    }
    last.current.copy(p);
    manager.update(p, velocity.current);
  });

  if (!manager) return null;
  return (
    <>
      <primitive object={manager.root} />
      {showGrades && <GradeOverlay edges={manager.manifest.roadGraph.edges} />}
    </>
  );
}
