/**
 * Ibadan Micra shared taxi (Nissan Micra K11) facts shared by the vehicle,
 * passenger system and HUD. Colours are in src/game/config/livery.ts and
 * driving feel in src/game/config/micraTuning.ts.
 */

/**
 * Seats passengers can occupy, in boarding order. Nigeria drives on the
 * right, so the driver sits on the left (-X) and the front passenger seat on
 * the right takes two, squeezed. `at` is the hip point in the car's local
 * frame (metres, origin on the ground under the middle of the car, -Z forward).
 */
export const MICRA_SEATS = [
  { id: "front-left", row: "front", at: [0.1, 0.56, -0.27] },
  { id: "front-right", row: "front", at: [0.45, 0.56, -0.15] },
  { id: "back-left", row: "back", at: [-0.47, 0.55, 0.68] },
  { id: "back-middle", row: "back", at: [0, 0.57, 0.68] },
  { id: "back-right", row: "back", at: [0.47, 0.55, 0.68] },
] as const;

/** Driver's hip point (left-hand drive). */
export const MICRA_DRIVER_SEAT: readonly [number, number, number] = [-0.36, 0.56, -0.1];

/** Cockpit camera: just behind the driver's eyes, so the squeezed front passenger is in view. */
export const MICRA_DRIVER_EYE: readonly [number, number, number] = [-0.36, 1.17, 0.1];

/** Luggage rides in the hatch, behind the back seat. */
export const MICRA_LUGGAGE_AT: readonly [number, number, number] = [0, 0.6, 1.45];

/** Paying passengers per trip: 2 in front beside the driver, 3 at the back. */
export const MICRA_PASSENGER_CAPACITY = MICRA_SEATS.length;
