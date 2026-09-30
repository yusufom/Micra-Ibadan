/**
 * Ibadan Micra taxi livery.
 *
 * PLACEHOLDER: these colours are a first guess at the Oyo shared-taxi scheme
 * (wine/maroon body, cream roof and pillars, black bumpers) and still need
 * confirming against photos of real Ibadan Micras. Everything the procedural
 * model paints comes from here, so a later .glb can use the same values.
 */
export const MICRA_LIVERY = {
  body: "#86283a",
  roof: "#efe6c8",
  bumper: "#141414",
  trim: "#1a1a1a",
  glass: "#1c2530",
  wheel: "#151515",
  rim: "#2a2a2a",
  tailLight: "#8a1010",
  /** Tail lights while braking. */
  brakeLight: "#ff2a1a",
  headLight: "#d9d4c0",
  indicator: "#e08a1c",
  /** The replacement rear door off another car, never repainted. */
  mismatchedPanel: "#5f6f78",
  /** Hand-painted fleet number and route on the front doors. */
  signwriting: "#f4ecd2",
  /** Seat covers: faded woven cloth with a darker band. */
  seatCover: "#b8913f",
  seatCoverBand: "#6e2a22",
  interior: "#2a2622",
  dashboard: "#1e1d1c",
} as const;

/** Fleet number and route painted on the front doors, e.g. "1542 AKINYELE". */
export const MICRA_SIGNWRITING = {
  fleetNumber: "1542",
  route: "AKINYELE",
  /** Small garage badge above the number. */
  garage: "DUGBE GARAGE",
} as const;

/** Oyo State plate: white with dark blue lettering. */
export const MICRA_PLATE = {
  state: "OYO STATE",
  number: "AKN 542 XA",
  slogan: "PACE SETTER",
  background: "#f3f1ea",
  text: "#1d3a8a",
} as const;

/** Default sticker in the back-window slot. Stickers will be customisable later. */
export const MICRA_DEFAULT_STICKER = "NO FOOD FOR LAZY MAN";
