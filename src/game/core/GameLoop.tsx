"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { useGameStore } from "@/game/store/gameStore";
import { startGameSystems } from "@/game/systems";
import { DAY_START_HOUR, gameClock } from "./clock";
import { runSystems } from "./loop";

/** ?hour=17.5 starts the day at another time (lighting checks). */
function startHourFromUrl(): number {
  const h = Number(new URLSearchParams(window.location.search).get("hour"));
  return Number.isFinite(h) && h > 0 && h < 24 ? h : DAY_START_HOUR;
}

/** Mount once inside <Canvas>. Starts gameplay systems and ticks the clock. */
export function GameLoop() {
  const lastMinute = useRef(-1);

  useEffect(() => {
    gameClock.reset(startHourFromUrl());
    return startGameSystems();
  }, []);

  // Negative priority runs before other useFrame callbacks without taking over rendering.
  useFrame((_, delta) => {
    const dt = gameClock.tick(delta);
    runSystems(dt, gameClock.elapsed);

    // Mirror the hour into the store at in-game minute resolution (about once a real second).
    const hour = gameClock.hourOfDay;
    const minute = Math.floor(hour * 60);
    if (minute !== lastMinute.current) {
      lastMinute.current = minute;
      useGameStore.setState({ hourOfDay: hour });
    }
  }, -1);

  return null;
}
