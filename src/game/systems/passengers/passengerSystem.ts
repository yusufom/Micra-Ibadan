import { gameEvents } from "@/game/core/events";
import { useGameStore } from "@/game/store/gameStore";
import { MICRA_PASSENGER_CAPACITY } from "@/game/vehicles/micraSpec";

/**
 * Passenger system stub: tracks who is on board from PASSENGER_BOARDED.
 * Loading, drop-off and fare haggling come later. Returns a teardown function.
 */
export function startPassengerSystem(): () => void {
  const onBoard = new Set<string>();

  const offBoarded = gameEvents.on("PASSENGER_BOARDED", ({ passengerId }) => {
    if (onBoard.size >= MICRA_PASSENGER_CAPACITY) return;
    onBoard.add(passengerId);
    useGameStore.getState().setPassengers(onBoard.size);
  });

  return () => {
    offBoarded();
    onBoard.clear();
  };
}
