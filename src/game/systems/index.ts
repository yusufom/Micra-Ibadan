import { startEconomySystem } from "./economy/economySystem";
import { startEnforcementSystem } from "./enforcement/enforcementSystem";
import { startPassengerSystem } from "./passengers/passengerSystem";

/** Start every gameplay system. Returns one teardown for all of them. */
export function startGameSystems(): () => void {
  const stops = [startEconomySystem(), startPassengerSystem(), startEnforcementSystem()];
  return () => stops.forEach((stop) => stop());
}
