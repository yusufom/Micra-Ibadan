"use client";

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useSyncExternalStore } from "react";
import { type InputAction, pressAction, touchInput } from "@/game/core/input";

/** Horizontal drag (px) from the touch-down point for full lock. */
const STEER_RANGE = 70;

const coarseQuery = "(pointer: coarse)";

function subscribeCoarse(cb: () => void): () => void {
  const mq = window.matchMedia(coarseQuery);
  mq.addEventListener("change", cb);
  window.addEventListener("touchstart", cb, { once: true, passive: true });
  return () => {
    mq.removeEventListener("change", cb);
    window.removeEventListener("touchstart", cb);
  };
}

let touched = false;
function isTouchDevice(): boolean {
  return touched || window.matchMedia(coarseQuery).matches;
}

/**
 * On-screen controls for phones: drag anywhere on the left half to steer,
 * gas and brake on the right, horn, plus handbrake, interact (E) and camera
 * (C). Writes core/input's touchInput; nothing else reads these events.
 */
export function TouchControls() {
  const visible = useSyncExternalStore(
    (cb) =>
      subscribeCoarse(() => {
        touched = true;
        cb();
      }),
    isTouchDevice,
    () => false,
  );
  const steer = useRef<{ id: number; x0: number } | null>(null);
  const knob = useRef<HTMLDivElement>(null);

  useEffect(() => {
    touchInput.active = visible;
    return () => {
      touchInput.active = false;
    };
  }, [visible]);

  if (!visible) return null;

  const setKnob = (v: number) => {
    if (knob.current) knob.current.style.transform = `translateX(${v * 40}px)`;
  };
  const onSteerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    steer.current = { id: e.pointerId, x0: e.clientX };
  };
  const onSteerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = steer.current;
    if (!s || s.id !== e.pointerId) return;
    touchInput.steer = Math.max(-1, Math.min(1, (e.clientX - s.x0) / STEER_RANGE));
    setKnob(touchInput.steer);
  };
  const onSteerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (steer.current?.id !== e.pointerId) return;
    steer.current = null;
    touchInput.steer = 0;
    setKnob(0);
  };

  /** Pedal-style button held with a finger. */
  const hold = (key: "throttle" | "brake" | "horn" | "handbrake") => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      if (key === "horn" || key === "handbrake") touchInput[key] = true;
      else touchInput[key] = 1;
    },
    onPointerUp: () => {
      if (key === "horn" || key === "handbrake") touchInput[key] = false;
      else touchInput[key] = 0;
    },
    onPointerCancel: () => {
      if (key === "horn" || key === "handbrake") touchInput[key] = false;
      else touchInput[key] = 0;
    },
  });
  const tap = (action: InputAction) => ({ onPointerDown: () => pressAction(action) });

  const btn = "pointer-events-auto touch-none select-none rounded-full border border-white/30 bg-black/45 font-mono font-bold text-white active:bg-white/30";

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      <div
        className="pointer-events-auto absolute bottom-0 left-0 h-3/5 w-1/2 touch-none"
        onPointerDown={onSteerDown}
        onPointerMove={onSteerMove}
        onPointerUp={onSteerUp}
        onPointerCancel={onSteerUp}
      >
        <div className="absolute bottom-10 left-10 flex h-14 w-32 items-center justify-center rounded-full border border-white/25 bg-black/30">
          <div ref={knob} className="h-10 w-10 rounded-full bg-white/60" />
        </div>
      </div>
      <div className="absolute right-4 bottom-8 flex flex-col items-end gap-3">
        <div className="flex gap-2">
          <button type="button" className={`${btn} h-11 w-11 text-xs`} {...tap("park")}>
            P
          </button>
          <button type="button" className={`${btn} h-11 w-11 text-xs`} {...tap("camera")}>
            C
          </button>
          <button type="button" className={`${btn} h-11 w-11 text-xs`} {...tap("interact")}>
            E
          </button>
          <button type="button" className={`${btn} h-11 w-11 text-[10px]`} {...hold("handbrake")}>
            HB
          </button>
        </div>
        <div className="flex items-end gap-3">
          <button type="button" className={`${btn} h-14 w-14 text-xs`} {...hold("horn")}>
            HORN
          </button>
          <button type="button" className={`${btn} h-16 w-16 text-xs`} {...hold("brake")}>
            BRAKE
          </button>
          <button type="button" className={`${btn} h-24 w-20 rounded-2xl text-sm`} {...hold("throttle")}>
            GAS
          </button>
        </div>
      </div>
    </div>
  );
}
