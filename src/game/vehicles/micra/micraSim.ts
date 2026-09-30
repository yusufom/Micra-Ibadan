import type { RapierRigidBody, useRapier } from "@react-three/rapier";
import { MICRA_TUNING as T } from "@/game/config/micraTuning";
import { MICRA_DRIVER_SEAT, MICRA_LUGGAGE_AT, MICRA_PASSENGER_CAPACITY, MICRA_SEATS } from "../micraSpec";

type RapierContext = ReturnType<typeof useRapier>;
type RapierApi = RapierContext["rapier"];
type RapierWorld = RapierContext["world"];
type VehicleController = ReturnType<RapierWorld["createVehicleController"]>;

/**
 * The Micra's drivetrain and damage model on top of Rapier's raycast vehicle
 * controller. Rapier does suspension and tyre impulses; this class decides
 * engine, gearbox, clutch, brakes and steering each physics step, and tracks
 * load, condition, heat, stalls, potholes and burst tyres.
 *
 * Framework-free (no React, no three.js) so it can run headless for tuning.
 * All feel constants come from src/game/config/micraTuning.ts.
 *
 * Local frame: -Z forward, +X right, +Y up, origin on the ground under the
 * middle of the car. Wheels: 0 front-left, 1 front-right, 2 rear-left, 3 rear-right.
 */

/** Collision groups: car colliders are in group 2, AI traffic in group 3; wheel rays and the camera skip both. */
export const CAR_COLLISION_GROUPS = (0x0002 << 16) | 0xffff;
export const WHEEL_RAY_GROUPS = (0x0001 << 16) | (0xffff & ~0x0002 & ~0x0004);

export type MicraControls = {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
};

export type Pothole = { id: number; x: number; z: number; radius: number; depth: number; severity: number };

export type MicraEnv = {
  /** Uphill grade (fraction) of the road under (x, z) along heading (hx, hz), or null when off the road graph. */
  roadGrade?: (x: number, z: number, hx: number, hz: number) => number | null;
  /** The pothole whose rim contains (x, z), if any. */
  potholeAt?: (x: number, z: number) => Pothole | null;
  random?: () => number;
};

export type MicraSimEvents = {
  onPothole?: (p: Pothole, wheel: number, speed: number, damage: number, jolt: number) => void;
  onBurst?: (wheel: number) => void;
  onStall?: (reason: "hill" | "lugging" | "overheat") => void;
  onCrash?: (deltaV: number, damage: number) => void;
  onMessage?: (text: string) => void;
};

export type GearboxMode = "auto" | "manual";
export type SimTask = { kind: "pourWater" | "changeTyre"; time: number; duration: number } | null;

const G = 9.81;
const RPM_PER_RADS = 60 / (2 * Math.PI);
const WHEELS = 4;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Engine torque as a fraction of peak at rpm, from the tuning curve. */
export function torqueFraction(rpm: number): number {
  const c = T.engine.torqueCurve;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) {
      const [r0, t0] = c[i - 1];
      const [r1, t1] = c[i];
      return lerp(t0, t1, (rpm - r0) / (r1 - r0));
    }
  }
  return c[c.length - 1][1];
}

/** Peak engine power (W) from the torque curve. */
export function peakEnginePower(): number {
  let best = 0;
  for (let rpm = T.engine.idleRpm; rpm <= T.engine.redlineRpm; rpm += 50) {
    best = Math.max(best, T.engine.peakTorqueNm * torqueFraction(rpm) * (rpm / RPM_PER_RADS));
  }
  return best;
}

export class MicraSim {
  readonly controller: VehicleController;
  private readonly world: RapierWorld;
  private readonly body: RapierRigidBody;
  private readonly env: MicraEnv;
  events: MicraSimEvents = {};

  // Driver-visible state.
  gearbox: GearboxMode = "auto";
  /** -1 reverse, 0 neutral, 1–4. */
  gear = 1;
  rpm: number = T.engine.idleRpm;
  engineOn = true;
  cranking = false;
  overheated = false;
  temperature: number = T.cooling.start;
  condition: number = T.condition.start;
  readonly flat = [false, false, false, false];
  spareTyres = 1;
  /** Signed speed along the car's nose, m/s. */
  forwardSpeed = 0;
  /** Smoothed forward acceleration, m/s². */
  accel = 0;
  /** Uphill grade along the heading, fraction. */
  grade = 0;
  steerAngle = 0;
  throttle = 0;
  clutch = 0;
  rollingBack = false;
  /** Service brake pedal is down (brake lights). */
  braking = false;
  task: SimTask = null;
  /** Park (P): handbrake up, drive disengaged, engine idling. The car starts parked at the garage. */
  parked = true;
  private parkNagged = false;
  /** Latest pothole or crash jolt for camera shake, 0–1; decays. */
  jolt = 0;

  // Load.
  passengers = 0;
  luggageKg = 0;
  mass = 0;
  private loadFraction = 0;

  private readonly peakPower = peakEnginePower();
  private readonly random: () => number;
  /** Auto: +1 drive, -1 reverse. */
  private direction = 1;
  private shiftTimer = 0;
  private gearTime = 0;
  private crankTimer = 0;
  private throttleWasReleased = true;
  private armedBrake = false;
  private armedGas = false;
  private readonly lastPothole = [-1, -1, -1, -1];
  private readonly lastVel = { x: 0, y: 0, z: 0 };
  private hasLastVel = false;
  /** Steps left in which checkCrash skips damage, because a vehicle impact was already charged. */
  private impactGrace = 0;
  private readonly filterFlags: number;

  constructor(world: RapierWorld, rapier: RapierApi, body: RapierRigidBody, env: MicraEnv = {}) {
    this.world = world;
    this.body = body;
    this.env = env;
    this.random = env.random ?? Math.random;
    this.filterFlags = rapier.QueryFilterFlags.EXCLUDE_SENSORS;

    const c = world.createVehicleController(body);
    c.indexUpAxis = 1;
    // The d.ts names this setter oddly; it sets the chassis forward axis (2 = Z).
    c.setIndexForwardAxis = 2;
    const s = T.suspension;
    for (let i = 0; i < WHEELS; i++) {
      const x = i % 2 === 0 ? -s.halfTrack : s.halfTrack;
      const z = i < 2 ? s.frontAxleZ : s.rearAxleZ;
      // Axle +X makes the controller's wheel-forward -Z, the car's nose.
      c.addWheel({ x, y: s.hardPointY, z }, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, s.restLength, T.tyres.radius);
      c.setWheelMaxSuspensionTravel(i, s.maxTravel);
      c.setWheelMaxSuspensionForce(i, s.maxForceN);
    }
    this.controller = c;
    this.setLoad(0, 0);
  }

  dispose(): void {
    this.world.removeVehicleController(this.controller);
  }

  /** Passengers (0–5) and luggage change mass, balance, springs and grip. */
  setLoad(passengers: number, luggageKg: number): void {
    const n = clamp(Math.round(passengers), 0, MICRA_PASSENGER_CAPACITY);
    const lug = clamp(luggageKg, 0, T.mass.maxLuggageKg);
    this.passengers = n;
    this.luggageKg = lug;

    const m = T.mass;
    let mass = m.chassisKg + m.driverKg;
    let cx = m.centerOfMass[0] * m.chassisKg + MICRA_DRIVER_SEAT[0] * m.driverKg;
    let cy = m.centerOfMass[1] * m.chassisKg + MICRA_DRIVER_SEAT[1] * m.driverKg;
    let cz = m.centerOfMass[2] * m.chassisKg + MICRA_DRIVER_SEAT[2] * m.driverKg;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = MICRA_SEATS[i].at;
      mass += m.passengerKg;
      cx += x * m.passengerKg;
      cy += y * m.passengerKg;
      cz += z * m.passengerKg;
    }
    mass += lug;
    cx += MICRA_LUGGAGE_AT[0] * lug;
    cy += MICRA_LUGGAGE_AT[1] * lug;
    cz += MICRA_LUGGAGE_AT[2] * lug;
    this.mass = mass;
    this.loadFraction = (n * m.passengerKg + lug) / (MICRA_PASSENGER_CAPACITY * m.passengerKg + m.maxLuggageKg);

    // Box inertia for a 3.6 × 1.1 × 1.56 m car.
    const L = 3.6;
    const H = 1.1;
    const W = 1.56;
    const k = mass / 12;
    const [sx, sy, sz] = m.inertiaScale;
    this.body.setAdditionalMassProperties(
      mass,
      { x: cx / mass, y: cy / mass, z: cz / mass },
      { x: k * (H * H + L * L) * sx, y: k * (W * W + L * L) * sy, z: k * (W * W + H * H) * sz },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    // Rapier scales suspension force by chassis mass, so divide the real
    // rates by it: sag then grows with load like real springs.
    const s = T.suspension;
    for (let i = 0; i < WHEELS; i++) {
      this.controller.setWheelSuspensionStiffness(i, (i < 2 ? s.frontSpringNpm : s.rearSpringNpm) / mass);
      this.controller.setWheelSuspensionCompression(i, s.compressionDamping / mass);
      this.controller.setWheelSuspensionRelaxation(i, s.reboundDamping / mass);
    }
  }

  setGearbox(mode: GearboxMode): void {
    if (mode === this.gearbox) return;
    this.gearbox = mode;
    if (mode === "auto") {
      this.direction = this.gear < 0 ? -1 : 1;
      this.gear = this.gear < 0 ? -1 : Math.max(1, this.gear);
    }
    this.shiftTimer = T.gearbox.manualShiftTime;
  }

  /** P: park or unpark. Only at (nearly) a standstill. Returns the new state. */
  togglePark(): boolean {
    if (!this.parked && Math.abs(this.forwardSpeed) > 1) {
      this.events.onMessage?.("Stop before parking");
      return false;
    }
    this.parked = !this.parked;
    if (!this.parked && this.gearbox === "auto") {
      this.direction = 1;
      this.changeGear(1);
    }
    this.events.onMessage?.(this.parked ? "Parked" : this.gearbox === "auto" ? "Drive" : "Handbrake off");
    return this.parked;
  }

  /** Manual only: Z. N → 1 → 4, R → N. */
  shiftUp(): void {
    if (this.gearbox !== "manual" || this.gear >= T.gearbox.ratios.length) return;
    this.changeGear(this.gear + 1);
  }

  /** Manual only: Q. 4 → 1 → N → R. Refused if it would over-rev, or into R while rolling forward. */
  shiftDown(): void {
    if (this.gearbox !== "manual" || this.gear <= -1) return;
    const next = this.gear - 1;
    if (next === -1 && this.forwardSpeed > 1.5) {
      this.events.onMessage?.("Stop before selecting reverse");
      return;
    }
    if (next > 0 && this.wheelRpm(next) > T.engine.redlineRpm * T.gearbox.overRevLimit) {
      this.events.onMessage?.("Too fast for that gear");
      return;
    }
    this.changeGear(next);
  }

  /** Starts a stopped-car job. Returns false (with a message) if it can't be done now. */
  startTask(kind: "pourWater" | "changeTyre"): boolean {
    if (this.task) return false;
    if (Math.abs(this.forwardSpeed) > 0.5) {
      this.events.onMessage?.("Stop the car first");
      return false;
    }
    if (kind === "pourWater") {
      if (this.temperature < T.cooling.pourAbove) return false;
      this.engineOn = false;
      this.cranking = false;
      this.task = { kind, time: 0, duration: T.cooling.pourTime };
      return true;
    }
    if (!this.flat.some(Boolean)) return false;
    if (this.spareTyres <= 0) {
      this.events.onMessage?.("No spare tyre left");
      return false;
    }
    this.task = { kind, time: 0, duration: T.tyreChangeTime };
    return true;
  }

  /** Engine rpm the wheels would drive in `gear` at the current speed. */
  wheelRpm(gear = this.gear): number {
    const ratio = this.gearRatio(gear);
    return (Math.abs(this.forwardSpeed) / T.tyres.radius) * ratio * T.gearbox.finalDrive * RPM_PER_RADS;
  }

  private gearRatio(gear: number): number {
    if (gear > 0) return T.gearbox.ratios[gear - 1];
    return gear < 0 ? T.gearbox.reverseRatio : 0;
  }

  private changeGear(gear: number): void {
    this.gear = gear;
    this.gearTime = 0;
    this.shiftTimer = this.gearbox === "auto" ? T.gearbox.autoShiftTime : T.gearbox.manualShiftTime;
  }

  private stall(reason: "hill" | "lugging" | "overheat"): void {
    if (!this.engineOn) return;
    this.engineOn = false;
    this.cranking = false;
    this.clutch = 0;
    this.throttleWasReleased = false;
    this.events.onStall?.(reason);
  }

  /** One physics step. Call before world.step() with the fixed timestep. */
  step(dt: number, input: MicraControls): void {
    const body = this.body;
    const c = this.controller;
    const q = body.rotation();
    // Basis vectors of the chassis rotation.
    const fx = -2 * (q.x * q.z + q.w * q.y);
    const fy = -2 * (q.y * q.z - q.w * q.x);
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const v = body.linvel();
    const p = body.translation();
    const forward = v.x * fx + v.y * fy + v.z * fz;
    this.accel += ((forward - this.forwardSpeed) / dt - this.accel) * (1 - Math.exp(-dt / 0.3));
    this.forwardSpeed = forward;
    const speed = Math.hypot(v.x, v.y, v.z);
    const absF = Math.abs(this.forwardSpeed);

    const flatLen = Math.hypot(fx, fz) || 1;
    const road = this.env.roadGrade?.(p.x, p.z, fx / flatLen, fz / flatLen);
    this.grade = road ?? fy / flatLen;

    // Jobs outside the car: hands off, handbrake on.
    let controls = input;
    if (this.task) {
      controls = { throttle: 0, brake: 0, steer: 0, handbrake: true };
      this.task.time += dt;
      if (this.task.time >= this.task.duration) this.finishTask();
    }

    this.updateSteering(dt, controls.steer, absF);
    const { gas, pedal } = this.updateDirection(controls, absF);
    if (this.parked && gas > 0.5 && !this.parkNagged) {
      this.parkNagged = true;
      this.events.onMessage?.("In park. Press P to drive");
    }
    if (gas < 0.1) this.parkNagged = false;
    const handbrake = controls.handbrake || this.parked;
    this.updateStarter(dt, gas);
    if (this.gearbox === "auto") this.autoShift();
    this.gearTime += dt;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);

    // Throttle lag.
    const tau = gas > this.throttle ? T.engine.throttleRise : T.engine.throttleFall;
    this.throttle += (gas - this.throttle) * (1 - Math.exp(-dt / tau));
    const drive = this.engineForce(dt, absF, pedal);
    this.braking = pedal > 0.1;

    // Brakes (impulses per step). Rapier ignores brake on a wheel that has engine force.
    const service = pedal * T.brakes.maxForceN;
    const front = (service * T.brakes.frontBias) / 2;
    const rear = (service * (1 - T.brakes.frontBias)) / 2 + (handbrake ? T.brakes.handbrakeForceN / 2 : 0);
    const frontDrive = pedal > 0.1 ? 0 : drive.force / 2;
    for (let i = 0; i < WHEELS; i++) {
      const isFront = i < 2;
      c.setWheelEngineForce(i, isFront ? frontDrive : 0);
      c.setWheelBrake(i, (isFront ? front : rear) * dt);
    }

    // Grip: load and burst tyres.
    const grip = 1 - T.load.fullLoadGripLoss * this.loadFraction;
    for (let i = 0; i < WHEELS; i++) {
      const flat = this.flat[i] ? T.tyres.flatGrip : 1;
      c.setWheelFrictionSlip(i, T.tyres.frictionSlip * grip * flat);
      c.setWheelSideFrictionStiffness(i, T.tyres.sideStiffness * grip * flat * (i < 2 ? 1 : T.tyres.rearSideFactor));
    }

    // Rolling resistance and drag, as impulses.
    const flats = this.flat.filter(Boolean).length;
    const rolling = (T.resistance.rolling * this.mass * G + flats * T.tyres.flatDragN) * clamp(absF / 0.5, 0, 1);
    const rollSign = this.forwardSpeed > 0 ? -1 : 1;
    const drag = T.resistance.drag * speed;
    body.applyImpulse(
      {
        x: (fx * rolling * rollSign - v.x * drag) * dt,
        y: (fy * rolling * rollSign - v.y * drag) * dt,
        z: (fz * rolling * rollSign - v.z * drag) * dt,
      },
      true,
    );

    c.updateVehicle(dt, this.filterFlags, WHEEL_RAY_GROUPS);

    this.checkPotholes(absF);
    this.checkCrash(v);
    this.updateHeat(dt, drive.enginePower, speed);
    this.checkStalls(dt, gas, absF);

    this.rollingBack = this.engineOn && ((this.gear > 0 && this.forwardSpeed < -0.5) || (this.gear < 0 && this.forwardSpeed > 0.5));
    this.jolt = Math.max(0, this.jolt - dt * 2.5);
  }

  private updateSteering(dt: number, steer: number, absF: number): void {
    const s = T.steering;
    const lock = lerp(s.maxAngleLow, s.maxAngleHigh, Math.min(1, absF / s.fadeSpeed));
    const target = steer * lock;
    const returning = Math.abs(target) < Math.abs(this.steerAngle) || Math.sign(target) !== Math.sign(this.steerAngle);
    const rate = (returning ? s.returnRate : s.rate) * dt;
    this.steerAngle += clamp(target - this.steerAngle, -rate, rate);

    // Tired steering pulls right (towards the kerb); a flat front pulls to its side.
    // Scaled like the lock, so the pull feels the same at any speed.
    let pull = (1 - this.condition / 100) * T.condition.maxPullRad * (lock / s.maxAngleLow);
    if (this.flat[0]) pull -= T.tyres.flatPullRad;
    if (this.flat[1]) pull += T.tyres.flatPullRad;
    // Rapier steers left for positive angles.
    const angle = -(this.steerAngle + pull);
    this.controller.setWheelSteering(0, angle);
    this.controller.setWheelSteering(1, angle);
  }

  /**
   * Maps pedals to gas and brake. Auto: at a standstill, a fresh press of the
   * brake selects R and a fresh press of the gas selects D; in R the pedals swap.
   */
  private updateDirection(controls: MicraControls, absF: number): { gas: number; pedal: number } {
    if (this.gearbox === "manual" || this.parked) return { gas: controls.throttle, pedal: controls.brake };
    const stopped = absF < 0.6;
    if (!stopped) {
      this.armedBrake = this.armedGas = false;
    } else {
      if (controls.brake < 0.1) this.armedBrake = true;
      if (controls.throttle < 0.1) this.armedGas = true;
      if (this.direction > 0 && this.armedBrake && controls.brake > 0.5 && controls.throttle < 0.1) {
        this.direction = -1;
        this.armedGas = false;
        this.changeGear(-1);
      } else if (this.direction < 0 && this.armedGas && controls.throttle > 0.5 && controls.brake < 0.1) {
        this.direction = 1;
        this.armedBrake = false;
        this.changeGear(1);
      }
    }
    return this.direction > 0 ? { gas: controls.throttle, pedal: controls.brake } : { gas: controls.brake, pedal: controls.throttle };
  }

  /** Stalled: release then press the gas to crank. */
  private updateStarter(dt: number, gas: number): void {
    if (this.engineOn) return;
    if (gas < 0.05) this.throttleWasReleased = true;
    if (this.cranking) {
      this.crankTimer -= dt;
      if (this.crankTimer > 0) return;
      this.cranking = false;
      const hot = this.temperature > T.cooling.hotAt ? 0.5 : 1;
      const chance = lerp(T.stall.startChance[1], T.stall.startChance[0], this.condition / 100) * hot;
      if (this.random() < chance) {
        this.engineOn = true;
        this.rpm = T.engine.idleRpm;
      } else this.events.onMessage?.("Won't start. Try again");
      return;
    }
    if (this.task || !this.throttleWasReleased || gas < 0.3) return;
    this.throttleWasReleased = false;
    if (this.overheated) {
      this.events.onMessage?.("Engine too hot. Stop and pour water (E)");
      return;
    }
    this.cranking = true;
    this.crankTimer = T.stall.crankTime;
  }

  private autoShift(): void {
    const g = T.gearbox;
    if (this.parked) return;
    if (this.direction < 0) {
      if (this.gear !== -1) this.changeGear(-1);
      return;
    }
    if (this.gear < 1) this.changeGear(1);
    if (Math.abs(this.forwardSpeed) < 1 && this.gear > 1) {
      this.changeGear(1);
      return;
    }
    if (this.shiftTimer > 0 || this.gearTime < g.autoMinGearTime) return;
    const up = lerp(g.autoUpshiftRpm[0], g.autoUpshiftRpm[1], this.throttle);
    const down = lerp(g.autoDownshiftRpm[0], g.autoDownshiftRpm[1], this.throttle);
    const rpm = this.wheelRpm();
    const redline = T.engine.redlineRpm;
    // Upshift only if the next gear can still pull (or at the limiter), so hills don't make it hunt.
    const lostAccel = (this.gearForce(this.gear) - this.gearForce(this.gear + 1)) / this.mass;
    const canPull = this.accel - lostAccel > -0.15 || rpm > redline * 0.98;
    const lowerRpm = this.gear > 1 ? this.wheelRpm(this.gear - 1) : Infinity;
    const bogging =
      this.throttle > 0.8 && this.accel < -g.kickdownDecel && lowerRpm < redline * 0.85 && this.gearTime > g.autoMinGearTime + 1.5;
    if (this.gear < g.ratios.length && rpm > up && canPull) this.changeGear(this.gear + 1);
    else if (this.gear > 1 && (rpm < down || bogging) && lowerRpm < redline * 0.95) this.changeGear(this.gear - 1);
  }

  /** Wheel force the engine would give in `gear` at this speed and throttle, clutch engaged (N). */
  private gearForce(gear: number): number {
    if (gear < 1 || gear > T.gearbox.ratios.length) return 0;
    const rpm = Math.max(T.engine.idleRpm, this.wheelRpm(gear));
    if (rpm >= T.engine.redlineRpm) return 0;
    const ratio = this.gearRatio(gear) * T.gearbox.finalDrive;
    const force = (T.engine.peakTorqueNm * torqueFraction(rpm) * this.throttle * ratio * T.gearbox.efficiency) / T.tyres.radius;
    return Math.min(force * this.conditionFactor(), this.powerCeiling() / Math.max(Math.abs(this.forwardSpeed), 2));
  }

  private conditionFactor(): number {
    return lerp(T.condition.powerAtZero, 1, this.condition / 100);
  }

  private heatFactor(): number {
    const k = T.cooling;
    return this.temperature > k.hotAt ? 1 - ((this.temperature - k.hotAt) / (1 - k.hotAt)) * 0.6 : 1;
  }

  /** Max power at the wheels (W). Load caps power, not torque: a full car still crawls up in 1st. */
  private powerCeiling(): number {
    return this.peakPower * T.gearbox.efficiency * this.conditionFactor() * this.heatFactor() * (1 - T.load.fullLoadPowerLoss * this.loadFraction);
  }

  /** Signed drive force along the nose (N) for both front wheels, and engine power output (W). */
  private engineForce(dt: number, absF: number, pedal: number): { force: number; enginePower: number } {
    const e = T.engine;
    const gas = this.throttle;
    const dirSign = this.gear < 0 ? -1 : 1;
    const inGear = this.gear !== 0 && this.shiftTimer <= 0 && !this.parked;

    if (!this.engineOn) {
      this.rpm = this.cranking ? 250 : Math.max(0, this.rpm - 3000 * dt);
      this.clutch = 0;
      return { force: 0, enginePower: 0 };
    }

    // Auto-clutch: engages when you give it gas or once rolling; bites over clutchBiteTime.
    const wantClutch = inGear && (gas > 0.02 || absF > 2);
    this.clutch = wantClutch ? Math.min(1, this.clutch + dt / e.clutchBiteTime) : 0;

    const freeRpm = e.idleRpm + gas * (e.redlineRpm * 0.92 - e.idleRpm);
    if (!inGear || this.clutch === 0) {
      this.rpm += (freeRpm - this.rpm) * (1 - Math.exp(-dt / 0.25));
      const creep = this.gearbox === "auto" && inGear && pedal < 0.1 ? this.creepForce(absF) : 0;
      return { force: creep * dirSign, enginePower: 0 };
    }

    const ratio = this.gearRatio(this.gear) * T.gearbox.finalDrive;
    // Rolling the wrong way counts as zero wheel rpm: the clutch just slips.
    const movingRight = this.forwardSpeed * dirSign > 0;
    const coupled = movingRight ? this.wheelRpm() : 0;
    const slipRpm = e.idleRpm + gas * (e.launchRpm - e.idleRpm);
    const slipping = coupled < slipRpm;
    const target = slipping ? lerp(this.rpm, slipRpm, this.clutch) : coupled;
    this.rpm = Math.min(e.redlineRpm + 150, slipping ? this.rpm + (target - this.rpm) * (1 - Math.exp(-dt / 0.15)) : target);

    let torque = e.peakTorqueNm * torqueFraction(this.rpm) * gas;
    if (coupled >= e.redlineRpm) torque = 0;
    if (gas < 0.05 && !slipping) torque = -e.engineBrakeNm * clamp((coupled - e.idleRpm) / (e.redlineRpm - e.idleRpm), 0, 1);
    // Manual in a tall gear at crawling speed: the engine bogs.
    if (this.gearbox === "manual" && this.gear >= 3 && coupled < T.stall.lugRpm && gas > 0.2) torque *= 0.35;

    torque *= this.conditionFactor() * this.heatFactor();
    const enginePower = Math.max(0, torque) * (this.rpm / RPM_PER_RADS);

    let force = (torque * ratio * T.gearbox.efficiency * this.clutch) / T.tyres.radius;
    if (force > 0) {
      force = Math.min(force, this.powerCeiling() / Math.max(absF, 2));
      if (this.gear < 0 && absF > T.gearbox.reverseMaxSpeed) force = 0;
    }
    if (this.gearbox === "auto" && pedal < 0.1) force = Math.max(force, this.creepForce(absF));
    return { force: force * dirSign, enginePower };
  }

  private creepForce(absF: number): number {
    return T.engine.creepForceN * clamp(1 - absF / 2.5, 0, 1);
  }

  private checkPotholes(absF: number): void {
    const find = this.env.potholeAt;
    if (!find) return;
    const c = this.controller;
    const P = T.potholes;
    for (let i = 0; i < WHEELS; i++) {
      const cp = c.wheelIsInContact(i) ? c.wheelContactPoint(i) : null;
      const hole = cp ? find(cp.x, cp.z) : null;
      if (!hole) {
        this.lastPothole[i] = -1;
        continue;
      }
      if (hole.id === this.lastPothole[i]) continue;
      this.lastPothole[i] = hole.id;
      if (absF < 1.5 || !cp) continue;

      const jolt = Math.min(P.maxJolt, P.joltPerDepthSpeed * hole.depth * absF);
      const quarter = this.mass / 4;
      this.body.applyImpulseAtPoint({ x: 0, y: -quarter * jolt, z: 0 }, cp, true);
      const damage = P.damage * hole.severity * clamp(absF / 15, 0.2, 2);
      this.condition = Math.max(0, this.condition - damage);
      this.jolt = Math.max(this.jolt, jolt / P.maxJolt);
      this.events.onPothole?.(hole, i, absF, damage, jolt);

      if (hole.severity > P.burstSeverity && !this.flat[i]) {
        const sev = (hole.severity - P.burstSeverity) / (1 - P.burstSeverity);
        const fast = clamp((absF - P.burstMinSpeed) / (P.burstFullSpeed - P.burstMinSpeed), 0, 1);
        const worn = 1 + (1 - this.condition / 100) * 0.5;
        if (this.random() < P.burstChance * sev * fast * worn) this.burst(i);
      }
    }
  }

  /** Burst tyre `i`. Exposed for debug keys. */
  burst(i: number): void {
    if (this.flat[i]) return;
    this.flat[i] = true;
    this.controller.setWheelRadius(i, T.tyres.flatRadius);
    this.events.onBurst?.(i);
  }

  private finishTask(): void {
    const task = this.task!;
    this.task = null;
    if (task.kind === "pourWater") {
      this.temperature = T.cooling.pourTo;
      this.overheated = false;
      this.events.onMessage?.("Radiator topped up");
      return;
    }
    const i = this.flat.indexOf(true);
    if (i < 0) return;
    this.flat[i] = false;
    this.spareTyres--;
    this.controller.setWheelRadius(i, T.tyres.radius);
    this.events.onMessage?.("Spare tyre on");
  }

  /**
   * Hit another vehicle: the traffic system worked out the damage from the
   * closing speed and the other vehicle's mass. The speed change it causes is
   * not charged again as a crash.
   */
  applyImpact(damage: number, jolt: number): void {
    this.condition = Math.max(0, this.condition - damage);
    this.jolt = Math.max(this.jolt, Math.min(1, jolt));
    this.impactGrace = 6;
  }

  /** A sudden horizontal speed change between steps is a crash. */
  private checkCrash(v: { x: number; y: number; z: number }): void {
    if (this.impactGrace > 0) this.impactGrace--;
    else if (this.hasLastVel) {
      const dv = Math.hypot(v.x - this.lastVel.x, v.z - this.lastVel.z);
      if (dv > T.condition.crashThreshold) {
        const damage = (dv - T.condition.crashThreshold) * T.condition.crashDamage;
        this.condition = Math.max(0, this.condition - damage);
        this.jolt = Math.max(this.jolt, clamp(dv / 8, 0.3, 1));
        this.events.onCrash?.(dv, damage);
      }
    }
    this.lastVel.x = v.x;
    this.lastVel.y = v.y;
    this.lastVel.z = v.z;
    this.hasLastVel = true;
  }

  private updateHeat(dt: number, enginePower: number, speed: number): void {
    const k = T.cooling;
    const powerFrac = Math.min(1, enginePower / this.peakPower);
    const heat = this.engineOn ? k.heatRate * (k.idleHeat + (1 - k.idleHeat) * powerFrac) * (1 + k.loadHeat * this.loadFraction) : 0;
    const airflow = Math.min(1, speed / k.airflowSpeed);
    const fan = this.engineOn ? k.fanShare : k.fanShare * 0.4;
    const radiator = lerp(k.radiatorAtZero, 1, this.condition / 100);
    const cool = k.coolRate * (fan + (1 - k.fanShare) * airflow) * Math.max(0, this.temperature - k.ambient) * radiator;
    this.temperature = clamp(this.temperature + (heat - cool) * dt, k.ambient, 1);

    if (this.temperature >= 1 && this.engineOn) {
      this.overheated = true;
      this.stall("overheat");
    }
    if (this.overheated && this.temperature < k.restartBelow) this.overheated = false;
  }

  private checkStalls(dt: number, gas: number, absF: number): void {
    if (!this.engineOn || this.parked || this.gear <= 0 || this.shiftTimer > 0) return;
    const s = T.stall;
    const uphill = this.grade;
    let rate = 0;
    if (gas > 0.3 && uphill > s.minGrade && absF < s.maxSpeed) {
      const worn = 1 - this.condition / 100;
      rate += s.hillRate * worn * worn * (uphill / 0.12) * (1 + this.loadFraction);
    }
    if (this.gearbox === "manual" && this.gear >= 3 && gas > 0.2 && this.wheelRpm() < s.lugRpm) rate += s.lugRate;
    if (rate > 0 && this.random() < rate * dt) this.stall(this.gearbox === "manual" && this.gear >= 3 && this.wheelRpm() < s.lugRpm ? "lugging" : "hill");
  }
}
