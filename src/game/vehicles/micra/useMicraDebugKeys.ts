"use client";

import { type RefObject, useEffect } from "react";
import { MICRA_TUNING } from "@/game/config/micraTuning";
import { useGameStore } from "@/game/store/gameStore";
import { useVehicleStore } from "@/game/store/vehicleStore";
import { MICRA_PASSENGER_CAPACITY } from "../micraSpec";
import type { MicraSim } from "./micraSim";

/**
 * Debug keys for tuning the Micra (dev, or ?debug):
 * [ / ] passengers −/+, L luggage +20 kg (wraps), B burst a tyre,
 * N condition −20 (wraps to 100), O heat the engine to the edge of boiling.
 */
export function useMicraDebugKeys(enabled: boolean, sim: RefObject<MicraSim | null>): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = sim.current;
      const game = useGameStore.getState();
      const say = useVehicleStore.getState().setMessage;
      switch (e.code) {
        case "BracketRight":
        case "BracketLeft": {
          const n = Math.max(0, Math.min(MICRA_PASSENGER_CAPACITY, game.passengersOnBoard + (e.code === "BracketRight" ? 1 : -1)));
          game.setPassengers(n);
          say(`Debug: ${n} passengers`);
          break;
        }
        case "KeyL": {
          const kg = game.luggageKg + 20 > MICRA_TUNING.mass.maxLuggageKg ? 0 : game.luggageKg + 20;
          game.setLuggage(kg);
          say(`Debug: ${kg} kg luggage`);
          break;
        }
        case "KeyB":
          if (s) {
            const i = s.flat.indexOf(false);
            if (i >= 0) s.burst(i);
          }
          break;
        case "KeyN":
          if (s) {
            s.condition = s.condition <= 20 ? 100 : s.condition - 20;
            say(`Debug: condition ${Math.round(s.condition)}`);
          }
          break;
        case "KeyO":
          if (s) s.temperature = 0.97;
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, sim]);
}
