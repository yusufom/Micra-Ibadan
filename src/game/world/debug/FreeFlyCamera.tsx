"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Euler, Quaternion, Vector3 } from "three";

const BASE_SPEED = 30;
const FAST_MULTIPLIER = 6;
const LOOK_SPEED = 0.0028;

/** Set after the first rendered frame, so StrictMode's double effect run still applies the pose. */
let usedStartPose = false;

/** ?cam=x,y,z[,yaw,pitch] opens the session in free fly at that pose (radians). Once per page load. */
function startPose(): number[] | null {
  if (usedStartPose) return null;
  const v = new URLSearchParams(window.location.search).get("cam")?.split(",").map(Number);
  return v && v.length >= 3 && v.every(Number.isFinite) ? v : null;
}

/**
 * Debug free-fly camera (toggle with F). Drag to look; WASD or arrows to
 * move, E/Space up, Q/C down, Shift for speed, mouse wheel scales speed.
 * Restores the previous camera pose when switched off.
 */
export function FreeFlyCamera() {
  const camera = useThree((s) => s.camera);
  const dom = useThree((s) => s.gl.domElement);
  const keys = useRef(new Set<string>());
  const speedScale = useRef(1);
  const euler = useRef(new Euler(0, 0, 0, "YXZ"));

  useEffect(() => {
    const savedPos = camera.position.clone();
    const savedQuat = camera.quaternion.clone();
    const start = startPose();
    if (start) {
      camera.position.fromArray(start.slice(0, 3));
      camera.quaternion.setFromEuler(new Euler(start[4] ?? -0.25, start[3] ?? 0, 0, "YXZ"));
    }
    euler.current.setFromQuaternion(camera.quaternion, "YXZ");
    let dragging = false;

    const down = (e: PointerEvent) => {
      dragging = true;
      dom.setPointerCapture(e.pointerId);
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const eu = euler.current;
      eu.y -= e.movementX * LOOK_SPEED;
      eu.x = Math.max(-1.55, Math.min(1.55, eu.x - e.movementY * LOOK_SPEED));
      camera.quaternion.setFromEuler(eu);
    };
    const wheel = (e: WheelEvent) => {
      speedScale.current = Math.max(0.1, Math.min(20, speedScale.current * (e.deltaY > 0 ? 0.85 : 1.18)));
    };
    const kd = (e: KeyboardEvent) => keys.current.add(e.code);
    const ku = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();

    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointerup", up);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("wheel", wheel, { passive: true });
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    return () => {
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointerup", up);
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
      camera.position.copy(savedPos);
      camera.quaternion.copy(savedQuat);
    };
  }, [camera, dom]);

  const tmp = useRef({ v: new Vector3(), q: new Quaternion() });
  useFrame((_, dt) => {
    usedStartPose = true;
    const k = keys.current;
    const v = tmp.current.v.set(0, 0, 0);
    if (k.has("KeyW") || k.has("ArrowUp")) v.z -= 1;
    if (k.has("KeyS") || k.has("ArrowDown")) v.z += 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) v.x -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) v.x += 1;
    if (k.has("KeyE") || k.has("Space")) v.y += 1;
    if (k.has("KeyQ") || k.has("KeyC")) v.y -= 1;
    if (v.lengthSq() === 0) return;
    const fast = k.has("ShiftLeft") || k.has("ShiftRight") ? FAST_MULTIPLIER : 1;
    v.normalize().multiplyScalar(BASE_SPEED * fast * speedScale.current * Math.min(dt, 0.1));
    // Move relative to where the camera looks, but keep up/down world-vertical.
    const vertical = v.y;
    v.y = 0;
    v.applyQuaternion(camera.quaternion);
    v.y += vertical;
    camera.position.add(v);
  });

  return null;
}
