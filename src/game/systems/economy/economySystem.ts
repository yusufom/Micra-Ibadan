import { gameEvents } from "@/game/core/events";
import { useGameStore } from "@/game/store/gameStore";

/**
 * Economy system: turns FARE_PAID events into cash. It never imports the
 * passenger or enforcement systems; it only listens on the bus.
 * Returns a teardown function.
 */
export function startEconomySystem(): () => void {
  return gameEvents.on("FARE_PAID", ({ amount }) => {
    useGameStore.getState().addFare(amount);
  });
}
