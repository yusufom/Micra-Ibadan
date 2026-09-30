/**
 * Ibadan Micra shared taxi (Nissan Micra K11) facts shared by the vehicle,
 * passenger system and HUD.
 */

/** Seats passengers can occupy. The front passenger seat takes two, squeezed. */
export const MICRA_SEATS = [
  { id: "front-left", row: "front" },
  { id: "front-right", row: "front" },
  { id: "back-left", row: "back" },
  { id: "back-middle", row: "back" },
  { id: "back-right", row: "back" },
] as const;

/** Paying passengers per trip: 2 in front beside the driver, 3 at the back. */
export const MICRA_PASSENGER_CAPACITY = MICRA_SEATS.length;

/** Ibadan taxi livery: wine/maroon body, cream roof and pillars, black bumpers. */
export const MICRA_LIVERY = {
  body: "#86283a",
  roof: "#efe6c8",
  bumper: "#141414",
  trim: "#1a1a1a",
  glass: "#1c2530",
  wheel: "#151515",
  rim: "#2a2a2a",
  tailLight: "#8a1010",
  headLight: "#d9d4c0",
} as const;
