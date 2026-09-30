import type { TrafficVehicleKind } from "@/game/core/events";

/**
 * AI vehicle types. Sizes are the real vehicles'; power figures are what an
 * Ibadan example has left after heat, wear and a slipping clutch, per kg,
 * which is what decides how they crawl up hills (see TrafficSim.desiredSpeed).
 */
export type VehicleSpec = {
  kind: TrafficVehicleKind;
  label: string;
  length: number;
  width: number;
  height: number;
  /** Axle spacing, for pose along the lane (front and rear sampled this far apart). */
  wheelbase: number;
  /** Top speed on the flat, m/s. */
  maxSpeed: number;
  /** Comfortable acceleration and braking, m/s². */
  accel: number;
  brake: number;
  /** Sustained power at the wheels per kg, empty and loaded, W/kg. */
  powerEmpty: number;
  powerLoaded: number;
  loadedChance: number;
  /** Mass empty and loaded, kg (collisions). */
  massEmpty: number;
  massLoaded: number;
  /** Driver personality: mean aggression and horn happiness, 0–1. */
  aggression: number;
  horn: number;
  /** Lowest road class rank it will use (see highwayRank); lower-ranked roads cost `minorCost` × in routing. */
  minRank: number;
  minorCost: number;
  /** Chance it stops for someone waving (0 = never). */
  takesHails: number;
  /** Seats for passengers drawn on board, and the usual load. */
  seats: number;
  passengers: [number, number];
  /** Downhill: 1 lets it run like everyone else; below 1 holds back (heavy trucks). */
  downhill: number;
  /** Spawn weight in the mix, before road and time rules. */
  weight: number;
  /** Restricted to okada/keke hours (Executive Order 002 of 2026). */
  restrictedHours: boolean;
  /** Articulated: a trailer hitched `hitch` m behind the tractor's centre, `length` long, axle `axle` m behind the hitch. */
  trailer?: { length: number; hitch: number; axle: number };
};

const KMH = 1 / 3.6;

export const VEHICLE_SPECS: Record<TrafficVehicleKind, VehicleSpec> = {
  micra: {
    kind: "micra", label: "Micra taxi",
    length: 3.7, width: 1.58, height: 1.42, wheelbase: 2.3,
    maxSpeed: 100 * KMH, accel: 1.7, brake: 3.6,
    powerEmpty: 20, powerLoaded: 9, loadedChance: 0.6,
    massEmpty: 900, massLoaded: 1265,
    aggression: 0.68, horn: 0.75,
    minRank: -1, minorCost: 1,
    takesHails: 1, seats: 5, passengers: [0, 5],
    downhill: 1, weight: 34, restrictedHours: false,
  },
  car: {
    kind: "car", label: "Private car",
    length: 4.6, width: 1.78, height: 1.46, wheelbase: 2.7,
    maxSpeed: 120 * KMH, accel: 2.3, brake: 4,
    powerEmpty: 45, powerLoaded: 36, loadedChance: 0.3,
    massEmpty: 1400, massLoaded: 1650,
    aggression: 0.42, horn: 0.4,
    minRank: -1, minorCost: 1,
    takesHails: 0, seats: 3, passengers: [0, 2],
    downhill: 1, weight: 20, restrictedHours: false,
  },
  peugeot: {
    kind: "peugeot", label: "Peugeot 504/505",
    length: 4.5, width: 1.69, height: 1.45, wheelbase: 2.74,
    maxSpeed: 95 * KMH, accel: 1.2, brake: 3,
    powerEmpty: 13, powerLoaded: 8, loadedChance: 0.55,
    massEmpty: 1250, massLoaded: 1700,
    aggression: 0.45, horn: 0.55,
    minRank: -1, minorCost: 1,
    takesHails: 0.3, seats: 4, passengers: [0, 4],
    downhill: 1, weight: 4, restrictedHours: false,
  },
  keke: {
    kind: "keke", label: "Keke",
    length: 2.65, width: 1.3, height: 1.75, wheelbase: 2.0,
    maxSpeed: 55 * KMH, accel: 1.3, brake: 3,
    powerEmpty: 12, powerLoaded: 7.5, loadedChance: 0.6,
    massEmpty: 450, massLoaded: 750,
    aggression: 0.55, horn: 0.55,
    minRank: -1, minorCost: 1,
    takesHails: 0.55, seats: 4, passengers: [0, 4],
    downhill: 1, weight: 12, restrictedHours: true,
  },
  okada: {
    kind: "okada", label: "Okada",
    length: 2.0, width: 0.75, height: 1.6, wheelbase: 1.3,
    maxSpeed: 80 * KMH, accel: 2.2, brake: 4.2,
    powerEmpty: 28, powerLoaded: 14, loadedChance: 0.5,
    massEmpty: 190, massLoaded: 330,
    aggression: 0.72, horn: 0.6,
    minRank: -1, minorCost: 1,
    takesHails: 0.45, seats: 2, passengers: [0, 2],
    downhill: 1, weight: 15, restrictedHours: true,
  },
  bus: {
    kind: "bus", label: "Commuter bus",
    length: 5.0, width: 1.9, height: 2.2, wheelbase: 2.9,
    maxSpeed: 95 * KMH, accel: 1.4, brake: 3.4,
    powerEmpty: 22, powerLoaded: 11, loadedChance: 0.7,
    massEmpty: 2000, massLoaded: 3300,
    aggression: 0.65, horn: 0.85,
    minRank: 0, minorCost: 3,
    takesHails: 0.7, seats: 0, passengers: [0, 0],
    downhill: 1, weight: 7, restrictedHours: false,
  },
  truck: {
    kind: "truck", label: "Truck",
    length: 8.5, width: 2.5, height: 3.2, wheelbase: 4.8,
    maxSpeed: 75 * KMH, accel: 0.7, brake: 2.6,
    powerEmpty: 12, powerLoaded: 5.2, loadedChance: 0.7,
    massEmpty: 10000, massLoaded: 25000,
    aggression: 0.35, horn: 0.55,
    minRank: 2, minorCost: 8,
    takesHails: 0, seats: 0, passengers: [0, 0],
    downhill: 0.8, weight: 5, restrictedHours: false,
  },
  trailer: {
    kind: "trailer", label: "Articulated truck",
    length: 6.2, width: 2.5, height: 3.4, wheelbase: 3.6,
    maxSpeed: 70 * KMH, accel: 0.5, brake: 2.2,
    powerEmpty: 10, powerLoaded: 4.4, loadedChance: 0.75,
    massEmpty: 15000, massLoaded: 38000,
    aggression: 0.25, horn: 0.5,
    minRank: 3, minorCost: 20,
    takesHails: 0, seats: 0, passengers: [0, 0],
    downhill: 0.7, weight: 2, restrictedHours: false,
    trailer: { length: 12.5, hitch: 1.6, axle: 9.5 },
  },
};

export const VEHICLE_KINDS = Object.keys(VEHICLE_SPECS) as TrafficVehicleKind[];
