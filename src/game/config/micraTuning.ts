/**
 * Every constant that shapes how the Micra drives. Units are SI (kg, m, s, N,
 * rad) unless the name says otherwise. MicraSim reads these every physics step.
 *
 * Measured headless (flat plane or constant grade, condition 72, auto box;
 * "full" = 5 passengers + 40 kg luggage, 1,265 kg vs 865 kg empty):
 *   flat:   empty 0–60 8.4 s, 0–100 22 s, top 112 km/h (4th-gear limiter)
 *           full  0–60 21 s, top 89 km/h
 *   60–0:   empty 21 m, full 31 m
 *   climb from rest, full throttle, after 40 s:
 *           8%  empty 81 km/h, full 38 km/h (2nd)
 *           12% empty 70 km/h, full 28 km/h (1st)
 *           16% empty ~47 km/h, full 22 km/h (1st)
 *           20% full 18 km/h; 25% full can't climb (stalls or rolls back)
 *   heat:   full on 12% boils over after ~170 s; idling full in traffic 0.45 → 0.89 in 400 s
 *   hill start 15% full: gas straight after the brake rolls back 0.2 m, a 0.8 s gap 1.2 m, handbrake 0
 *   stalls crawling a 15% hill full: ~12/min at condition 20, ~1–4/min at 72, none at 100
 *   grip: empty ~0.85 g, full ~0.68 g
 */
export const MICRA_TUNING = {
  mass: {
    /** Tired K10/K11 with a full tank and a spare. */
    chassisKg: 790,
    driverKg: 75,
    passengerKg: 72,
    /** Luggage above this is ignored. */
    maxLuggageKg: 80,
    /** Empty centre of mass, local metres. Origin is ground level under the car's middle; -Z is the nose. */
    centerOfMass: [0, 0.5, -0.18] as [number, number, number],
    /** Scales the box-shaped inertia estimate. Below 1 = quicker to rotate = twitchier. */
    inertiaScale: [1, 0.8, 1] as [number, number, number],
  },

  load: {
    /**
     * Fraction of peak power lost at full load (5 passengers + max luggage),
     * on top of the extra mass: slipping clutch, soft tyres, a tired engine.
     * It caps power, not low-speed torque, so a full car still crawls up hills in 1st.
     */
    fullLoadPowerLoss: 0.55,
    /** Fraction of tyre grip lost at full load (overloaded, underinflated tyres). */
    fullLoadGripLoss: 0.22,
  },

  engine: {
    idleRpm: 850,
    redlineRpm: 5800,
    peakTorqueNm: 82,
    /** Torque as a fraction of peak, [rpm, fraction]. Linear between points. */
    torqueCurve: [
      [800, 0.55],
      [1500, 0.72],
      [2500, 0.9],
      [3500, 1.0],
      [4600, 0.94],
      [5400, 0.8],
      [6000, 0.6],
    ] as [number, number][],
    /** Engine braking torque at redline with the throttle shut, scaled down with rpm. */
    engineBrakeNm: 22,
    /** Throttle response time constants (s). A lazy carburettor. */
    throttleRise: 0.22,
    throttleFall: 0.08,
    /** Clutch slip holds the engine at up to this rpm when pulling away. */
    launchRpm: 3000,
    /** Time for the clutch to bite from a standstill (s). Pull away too soon on a hill and you roll back. */
    clutchBiteTime: 0.55,
    /** Auto gearbox creep force at idle in D (N). Loses to gravity on steep grades. */
    creepForceN: 360,
  },

  gearbox: {
    /**
     * 1st to 4th. Short: 4th hits the rev limiter at about 111 km/h, which is
     * what sets the empty top speed (the engine screams on the expressway).
     */
    ratios: [3.5, 2.25, 1.62, 1.23],
    reverseRatio: 3.3,
    finalDrive: 4.3,
    /** Share of engine torque that reaches the wheels. */
    efficiency: 0.85,
    /** Torque is cut for this long while changing gear (s). */
    autoShiftTime: 0.42,
    manualShiftTime: 0.25,
    /** Auto upshifts at [light, full] throttle rpm, downshifts at [light, full] (kickdown). */
    autoUpshiftRpm: [2600, 5300] as [number, number],
    autoDownshiftRpm: [1300, 2900] as [number, number],
    /** Full-throttle kickdown when losing speed faster than this (m/s²), e.g. on a hill. */
    kickdownDecel: 0.25,
    /** Auto won't shift again for this long (s). */
    autoMinGearTime: 0.9,
    reverseMaxSpeed: 6,
    /** A manual downshift that would push the engine past this fraction of redline is refused. */
    overRevLimit: 1.12,
  },

  resistance: {
    /** Rolling resistance coefficient (worn tyres on rough tar). */
    rolling: 0.022,
    /** Aero drag N per (m/s)². High: boxy, windows down, bent panels. */
    drag: 0.42,
  },

  brakes: {
    /** Total service brake force (N). Heavier car, same brakes, longer stops. */
    maxForceN: 5400,
    frontBias: 0.65,
    /** Handbrake on the rear wheels (N total). Enough to hold a full car on ~20%. */
    handbrakeForceN: 3400,
  },

  steering: {
    /** Front wheel lock at a standstill and at speed (rad). */
    maxAngleLow: 0.62,
    maxAngleHigh: 0.12,
    /** Speed (m/s) at which lock has faded to maxAngleHigh. */
    fadeSpeed: 30,
    /** How fast the wheels turn towards the input and back to centre (rad/s). Fast = twitchy. */
    rate: 3.2,
    returnRate: 4.5,
  },

  suspension: {
    /** Wheel centre hard points, local. x = half track, z per axle. */
    halfTrack: 0.67,
    frontAxleZ: -1.16,
    rearAxleZ: 1.14,
    /** Height of the hard points above the ground plane of the model. */
    hardPointY: 0.44,
    restLength: 0.24,
    maxTravel: 0.18,
    /** Real spring rates per wheel (N/m). Tired rear springs make the rear sag under load. */
    frontSpringNpm: 34000,
    rearSpringNpm: 23000,
    /** Damper rates per wheel (N·s/m). Worn shocks: bouncy. */
    compressionDamping: 1500,
    reboundDamping: 2100,
    maxForceN: 60000,
  },

  tyres: {
    radius: 0.27,
    width: 0.165,
    /** Grip: max friction impulse over suspension impulse. */
    frictionSlip: 0.95,
    sideStiffness: 0.9,
    /** Rear side grip relative to front. Below 1 = a tail that steps out. */
    rearSideFactor: 0.92,
    /** Burst tyre: rolling radius and grip multipliers. */
    flatRadius: 0.2,
    flatGrip: 0.45,
    /** Extra drag per flat tyre (N) and steering pull towards it (rad, front only). */
    flatDragN: 350,
    flatPullRad: 0.05,
  },

  condition: {
    /** 0–100. The car you get from the oga is not new. */
    start: 72,
    /** Power multiplier at condition 0 (1 at 100). */
    powerAtZero: 0.55,
    /** Steering pull at condition 0 (rad, + pulls right towards the kerb). */
    maxPullRad: 0.03,
    /** Horizontal speed change in one physics step that counts as a crash (m/s). */
    crashThreshold: 1.6,
    /** Condition lost per m/s of crash speed change above the threshold. */
    crashDamage: 2.2,
    /** Hitting traffic: closing speeds below this (m/s) are a scrape and cost nothing. */
    vehicleHitMinSpeed: 1,
    /** Condition lost per m/s of closing speed above vehicleHitMinSpeed, against a car of the Micra's mass. */
    vehicleHitDamage: 1.6,
    /** The other vehicle's mass scales damage by (mass / Micra mass)^0.5, clamped to this range (okada … trailer). */
    vehicleHitMassScale: [0.35, 2.2] as [number, number],
    /** Most condition one hit can cost. */
    vehicleHitMaxDamage: 25,
  },

  stall: {
    /** Hills: stall risk only above this grade (fraction) and below this speed (m/s). */
    minGrade: 0.06,
    maxSpeed: 4,
    /** Stalls per second at condition 0 on a 12% grade under throttle. Scales with (1 - condition)². */
    hillRate: 0.45,
    /** Manual in 3rd/4th, crawling under throttle: stalls per second. */
    lugRate: 0.8,
    /** Engine rpm below which a manual in a high gear lugs. */
    lugRpm: 1100,
    /** Cranking time (s) and start chance at condition 100 / 0. */
    crankTime: 0.8,
    startChance: [0.95, 0.55] as [number, number],
  },

  cooling: {
    /** Normalised temperature: 0 = ambient, ~0.5 = normal, 1 = boiling over. */
    ambient: 0.3,
    start: 0.45,
    /** Heat added per second at full power; idleHeat is the share at idle. */
    heatRate: 0.0042,
    idleHeat: 0.24,
    /** Extra heat per unit load fraction. */
    loadHeat: 0.5,
    /** Cooling per second per unit of (temp - ambient), at full airflow. */
    coolRate: 0.0048,
    /** Cooling share from the (weak) fan when crawling, the rest comes from airflow. */
    fanShare: 0.22,
    /** Speed (m/s) for full radiator airflow. */
    airflowSpeed: 15,
    /** Radiator efficiency at condition 0 (1 at 100): a leaky, silted radiator. */
    radiatorAtZero: 0.55,
    /** Power starts fading above this temperature. */
    hotAt: 0.88,
    /** Engine cuts at 1 and won't restart until below this, or until water is poured. */
    restartBelow: 0.8,
    /** Pouring water: time (s) and the temperature it leaves. */
    pourTime: 4,
    pourTo: 0.4,
    /** You can pour once the needle is above this. */
    pourAbove: 0.55,
  },

  potholes: {
    /** Downward speed kick at the wheel (m/s) per metre of depth per m/s of speed, capped. */
    joltPerDepthSpeed: 0.9,
    maxJolt: 1.6,
    /** Condition lost per hit: this × severity × speed factor (speed/15, 0.2–2). */
    damage: 1.6,
    /** Potholes above this severity can burst a tyre. */
    burstSeverity: 0.7,
    /** Burst chance at severity 1 and ≥ burstFullSpeed; zero below burstMinSpeed (m/s). */
    burstChance: 0.3,
    burstMinSpeed: 7,
    burstFullSpeed: 18,
  },

  /** Changing a burst tyre for the spare (s). One spare. */
  tyreChangeTime: 8,

  /**
   * Visual body lean on top of the physics (Rapier's raycast vehicle barely
   * rolls). Radians per g of lateral / longitudinal acceleration.
   */
  lean: {
    rollPerG: 0.075,
    pitchPerG: 0.045,
    /** Extra lean at full load (fraction). */
    loadGain: 0.5,
    /** Smoothing time constant (s). */
    smoothing: 0.12,
    max: 0.12,
  },

  camera: {
    /** Chase: distance behind, height above the car, and where it looks (ahead of / above the car). */
    distance: 5.6,
    height: 1.7,
    lookAhead: 2,
    lookHeight: 1.0,
    /** How fast the chase camera swings to follow heading and terrain pitch (1/s). */
    headingFollow: 3,
    pitchFollow: 2,
    positionFollow: 9,
    /** Keep this far from walls and terrain (m). */
    clearance: 0.3,
    fov: 55,
    cockpitFov: 68,
    /** Cockpit view looks down (rad) to show the dash, and a little right (negative yaw) towards the passenger and mirror. */
    cockpitPitch: -0.1,
    cockpitYaw: -0.15,
    /** Pothole / crash shake amplitude (m) at jolt 1. */
    shake: 0.08,
  },
} as const;

export type MicraTuning = typeof MICRA_TUNING;
