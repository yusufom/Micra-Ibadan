import { gameEvents } from "@/game/core/events";

/**
 * Enforcement system stub (touts, OYRTMA, VIO, FRSC, police). For now it only
 * logs triggers in dev; checkpoints and fines come later.
 * Returns a teardown function.
 */
export function startEnforcementSystem(): () => void {
  return gameEvents.on("ENFORCEMENT_TRIGGERED", ({ agency, reason }) => {
    if (process.env.NODE_ENV === "development") {
      console.debug(`[enforcement] ${agency}: ${reason}`);
    }
  });
}
