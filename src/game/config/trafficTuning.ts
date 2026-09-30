/**
 * Every constant that shapes AI traffic: how many vehicles, where and when
 * they appear, how junctions run, and how drivers behave. Per-type vehicle
 * specs (size, power, speed) live in src/game/npc/traffic/vehicleTypes.ts.
 * Units are SI (m, s, m/s) unless the name says otherwise.
 */
export const TRAFFIC_TUNING = {
  /** Vehicles are only simulated within this distance of the player, metres. */
  simRadius: 400,
  /** Despawn a little further out than we spawn, so vehicles don't flicker at the edge. */
  despawnRadius: 430,
  /** Once the world is running, new vehicles appear at least this far away, out of view (the first fill can be closer). */
  spawnMinDistance: 45,
  /** ...and never inside the camera view closer than this. */
  spawnVisibleMinDistance: 330,
  /** No spawn this close to another vehicle, metres. */
  spawnClearance: 14,
  /** Active vehicles at the busiest time of day, by quality tier. */
  maxActive: { high: 60, low: 30 },
  /** Spawns per frame at most, and despawns of surplus vehicles per second. */
  spawnsPerFrame: 2,
  /** Share of the target count spawned as parked (kerbside, hazards on). */
  parkedShare: 0.1,

  /** Vehicles closer than this to the player get a kinematic Rapier body, metres. */
  physicsRadius: 70,
  /** A vehicle stuck this long, out of sight and this far away, is recycled (keeps gridlock from freezing the city). */
  stuckRecycleSeconds: 25,
  stuckRecycleDistance: 120,

  /** Spawn weight per metre of road by class rank (see highwayRank). Busy roads carry most of the traffic. */
  roadWeight: { motorway: 5, trunk: 6, primary: 5, secondary: 4, tertiary: 2.5, unclassified: 0.7, residential: 0.35, other: 0.2 } as Record<string, number>,
  /** Spawn weight falls off with distance from the player: w /= 1 + (d / falloff)². Keeps the bubble busiest where you are. */
  spawnFalloff: 140,
  /** Hidden vehicles further than this and driving away are recycled nearer (per second chance), so the traffic stays around you. */
  recycleAwayDistance: 220,
  recycleAwayRate: 0.3,
  /** Roads where trucks and trailers are common (name match). Iwo Road and the Ring Road join here when their areas are built. */
  truckCorridors: /iwo road|ring road|expressway|bypass|oyo road|old ife road/i,
  truckCorridorBoost: 4,

  /** Traffic volume by hour on a weekday, 0–1 (fraction of maxActive). Linear between points. */
  weekdayProfile: [
    [0, 0.08], [4.5, 0.08], [5.5, 0.3], [6.5, 0.75], [7.25, 1], [8.75, 1], [9.75, 0.7],
    [12, 0.62], [13.5, 0.7], [15, 0.72], [16.5, 0.95], [17.5, 1], [19.25, 1], [20.25, 0.65],
    [21.5, 0.4], [22.5, 0.22], [24, 0.08],
  ] as [number, number][],
  /** Weekends: no school or office peaks, a busy Saturday afternoon (markets, parties). */
  weekendProfile: [
    [0, 0.1], [5, 0.1], [7, 0.4], [10, 0.62], [13, 0.72], [17, 0.8], [20, 0.6], [22.5, 0.25], [24, 0.1],
  ] as [number, number][],

  /** School runs (weekdays), hours: ramps up over `ramp` either side. */
  schoolRuns: [
    { from: 6.75, to: 8.25, strength: 1 },
    { from: 13.5, to: 15.5, strength: 0.8 },
  ],
  schoolRamp: 0.4,
  /** Traffic within this distance of a school is multiplied by 1 + schoolBoost × run strength. */
  schoolRadius: 320,
  schoolBoost: 2.5,
  /** University of Ibadan: its faculties count as one big school zone. */
  campusRadius: 600,

  /** Markets trade between these hours; on a market day traffic near them is heavier. */
  marketHours: [7, 19] as [number, number],
  marketRadius: 320,
  /** Multiplier on an ordinary trading day, and on a market day, at the market's peak. */
  marketTradeBoost: 1,
  marketDayBoost: 3.5,
  /** Traditional Yoruba markets turn on a 5-day cycle (ọjọ́ ọjà). Saturday is busy everywhere. */
  marketCycleDays: 5,
  /** Parked share × (1 + market activity × this): lorries offloading, cars half in the road. */
  marketParkedGain: 1.2,

  /**
   * Oyo State Executive Order 002 of 2026: okada and keke may only run 05:30–22:30.
   * Outside those hours they are rare, and the ones out are fleeing OYRTMA.
   */
  okadaHours: [5.5, 22.5] as [number, number],
  /** Share of normal okada / keke numbers still out at night. */
  okadaNightShare: 0.15,

  driver: {
    /** IDM exponent and hard braking limit, m/s². */
    delta: 4,
    maxBrake: 8.5,
    /** Desired speed multiplier on the speed limit: timid … aggressive. */
    speedFactor: [0.8, 1.3] as [number, number],
    /** Time headway, s: timid … aggressive. */
    headway: [1.7, 0.7] as [number, number],
    /** Standstill gap, m: timid … aggressive (okada use a third of it). */
    minGap: [2.6, 1.0] as [number, number],
    /** Sideways acceleration drivers accept in bends, m/s²: timid … aggressive. */
    lateralAccel: [2.4, 4.2] as [number, number],
    /** Downhill, aggressive drivers let it run: v0 × (1 + min(max, -grade × gain)). */
    downhillGain: 2.5,
    downhillMax: 0.35,
    /** Lateral swerve speed, m/s: timid … aggressive. */
    swerveRate: [0.8, 2.6] as [number, number],
    /** Seconds stuck behind something slow before thinking about overtaking: patient … impatient. */
    overtakeAfter: [7, 0.8] as [number, number],
    /** Seconds blocked before the first horn: horn-shy … horn-happy. */
    hornAfter: [12, 1.5] as [number, number],
    /** Seconds between one driver's horns (horn-happy drivers go again sooner). */
    hornCooldown: 5,
  },

  junction: {
    /** Gap (seconds before a crossing vehicle arrives) a driver accepts at an uncontrolled junction: timid … aggressive. */
    gapAccept: [4.5, 1.2] as [number, number],
    /** Waiting longer than this (patient … impatient, s) halves the gap they need and starts the horn. */
    patienceWait: [16, 4] as [number, number],
    /** Waiting longer than this forces the way in whatever the rules. */
    forceAfter: [30, 10] as [number, number],
    /** Signal timing, s. */
    green: 22,
    amber: 3,
    allRed: 2,
    /** Chance a signal is dead (no power) at load, and chance a driver runs a red light: timid … aggressive. */
    deadSignalShare: 0.3,
    runRed: [0.03, 0.55] as [number, number],
    /** Extra red-running chance at night (22:00–05:00). */
    runRedNight: 0.35,
    /** Share of major crossroads with signals (four or more arms, two or more of them secondary or bigger). Ibadan has few. */
    signalShare: 0.3,
    /** Roundabout entries yield to circulating vehicles closer than this, m. */
    roundaboutYield: 18,
  },

  rivals: {
    /** Rival Micras (and keke, okada) spot people waving this far ahead, m. */
    hailSight: 90,
    /** Stop dwell to load or drop someone, s. */
    dwell: [3, 9] as [number, number],
    /** Share of rival stops made right in the lane instead of at the kerb. */
    stopInLane: 0.35,
    /** Random drop-offs per km with passengers aboard. */
    dropsPerKm: 1.6,
    /** Extra desired speed while racing you to a passenger. */
    stealSpeedBoost: 1.35,
    /** Rivals race you to a passenger when you are within this distance of it, m. */
    stealRange: 90,
  },

  horn: {
    /** The player's horn reaches vehicles this far ahead, m. */
    reach: 40,
    /** How far slow vehicles move aside, m, and for how long, s. */
    nudge: 1.0,
    nudgeTime: 4,
    /** Aggression above which a driver honks back instead of moving. */
    honkBackAggression: 0.6,
  },

  hailers: {
    /** People waving for a taxi near the player at the busiest time. */
    max: 18,
    /** Spawn ring around the player, m. */
    spawnRange: [40, 240] as [number, number],
    despawnDistance: 300,
    /** Distance from the kerb they stand, m. */
    kerbGap: 0.6,
    /** You have to stop within this distance of someone for them to count you as picking them up, m. */
    reach: 5,
  },
} as const;
