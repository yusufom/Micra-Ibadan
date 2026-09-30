"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect } from "react";
import { startGameSystems } from "@/game/systems";
import { gameClock } from "./clock";
import { runSystems } from "./loop";

/** Mount once inside <Canvas>. Starts gameplay systems and ticks the clock. */
export function GameLoop() {
  useEffect(() => {
    gameClock.reset();
    return startGameSystems();
  }, []);

  // Negative priority runs before other useFrame callbacks without taking over rendering.
  useFrame((_, delta) => {
    const dt = gameClock.tick(delta);
    runSystems(dt, gameClock.elapsed);
  }, -1);

  return null;
}
