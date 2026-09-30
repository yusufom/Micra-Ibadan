"use client";

import { useFrame } from "@react-three/fiber";
import { CuboidCollider, RigidBody, type RapierRigidBody, useBeforePhysicsStep, useRapier } from "@react-three/rapier";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { type Group, type Object3D, Quaternion, Vector3 } from "three";
import { MICRA_TUNING as T } from "@/game/config/micraTuning";
import { gameEvents } from "@/game/core/events";
import { input, wasPressed } from "@/game/core/input";
import { useGameStore } from "@/game/store/gameStore";
import { useVehicleStore } from "@/game/store/vehicleStore";
import type { RoadData } from "@/game/world/roads/roadData";
import { MicraCamera } from "./micra/MicraCamera";
import { type MicraRig, MicraModel } from "./micra/MicraModel";
import { CAR_COLLISION_GROUPS, MicraSim } from "./micra/micraSim";
import { useMicraDebugKeys } from "./micra/useMicraDebugKeys";
import { MICRA_PASSENGER_CAPACITY } from "./micraSpec";
import type { Spawn } from "./spawn";

/** Below this speed (m/s) the car counts as stopped. */
const STOP_THRESHOLD = 0.15;
const MOVE_THRESHOLD = 0.5;
const G = 9.81;

type MicraProps = {
  id?: string;
  spawn: Spawn;
  /** Road lookups for grade and potholes; null before the map loads (or with no map). */
  roads: RoadData | null;
  /** Kept at the car's position every frame, for chunk streaming and the shadow box. */
  focus?: Object3D;
  /** Drive the camera (off while the debug free-fly camera is active). */
  camera?: boolean;
  debugKeys?: boolean;
};

const tmpQ = new Quaternion();
const tmpV = new Vector3();

/**
 * The player's Micra: a Rapier raycast vehicle driven by MicraSim, drawn
 * with MicraModel. Reads the normalised input from core/input, publishes
 * HUD state to useVehicleStore, and emits HORN / POTHOLE_HIT / TYRE_BURST /
 * ENGINE_STALLED / VEHICLE_STOPPED on the event bus.
 */
export function Micra({ id = "player", spawn, roads, focus, camera = true, debugKeys = false }: MicraProps) {
  const { world, rapier } = useRapier();
  const body = useRef<RapierRigidBody>(null);
  const chassis = useRef<Group>(null);
  const rig = useRef<MicraRig>(null);
  const sim = useRef<MicraSim | null>(null);
  const roadsRef = useRef(roads);
  useEffect(() => {
    roadsRef.current = roads;
  }, [roads]);

  const passengers = useGameStore((s) => Math.min(s.passengersOnBoard, MICRA_PASSENGER_CAPACITY));
  const luggageKg = useGameStore((s) => s.luggageKg);
  const cameraMode = useVehicleStore((s) => s.camera);
  const load = useRef({ passengers, luggageKg });
  useLayoutEffect(() => {
    load.current = { passengers, luggageKg };
    sim.current?.setLoad(passengers, luggageKg);
  }, [passengers, luggageKg]);

  // The rigid body is created in RigidBody's passive effect, so build the sim in one too.
  useEffect(() => {
    const rb = body.current;
    if (!rb) return;
    const at = (): [number, number, number] => {
      const p = rb.translation();
      return [p.x, p.y, p.z];
    };
    const s = new MicraSim(world, rapier, rb, {
      roadGrade: (x, z, hx, hz) => roadsRef.current?.index.gradeAlong(x, z, hx, hz) ?? null,
      potholeAt: (x, z) => roadsRef.current?.potholes.at(x, z) ?? null,
    });
    const store = useVehicleStore.getState();
    s.condition = store.condition;
    s.temperature = store.temperature;
    s.setGearbox(store.gearbox);
    s.setLoad(load.current.passengers, load.current.luggageKg);
    const say = (text: string) => useVehicleStore.getState().setMessage(text);
    s.events = {
      onPothole: (hole, _wheel, speed, damage) => {
        gameEvents.emit("POTHOLE_HIT", { vehicleId: id, position: [hole.x, at()[1], hole.z], severity: hole.severity, speed, damage });
      },
      onBurst: (wheel) => {
        say("Tyre burst! Stop and change it (E)");
        gameEvents.emit("TYRE_BURST", { vehicleId: id, wheel, position: at() });
      },
      onStall: (reason) => {
        say(reason === "overheat" ? "Overheated! Stop and pour water (E)" : "Stalled. Release and press gas to restart");
        gameEvents.emit("ENGINE_STALLED", { vehicleId: id, reason, position: at() });
      },
      onMessage: say,
    };
    sim.current = s;
  }, [world, rapier, id]);

  // Remove the controller in the commit phase, before <Physics> frees the world on unmount.
  useLayoutEffect(
    () => () => {
      sim.current?.dispose();
      sim.current = null;
    },
    [world],
  );

  useBeforePhysicsStep((w) => {
    sim.current?.step(w.timestep, input);
  });

  useMicraDebugKeys(debugKeys, sim);

  // Frame state that isn't physics.
  const f = useRef({
    moving: false,
    hornDown: false,
    spin: [0, 0, 0, 0],
    lastVel: new Vector3(),
    accel: new Vector3(),
    roll: 0,
    pitch: 0,
  });

  useFrame((_, dt) => {
    const s = sim.current;
    const rb = body.current;
    const r = rig.current;
    if (!s || !rb) return;
    const st = f.current;
    const vehicle = useVehicleStore.getState();

    // Buttons.
    if (wasPressed("camera")) useVehicleStore.setState({ camera: vehicle.camera === "chase" ? "cockpit" : "chase" });
    if (wasPressed("gearbox")) {
      const mode = s.gearbox === "auto" ? "manual" : "auto";
      s.setGearbox(mode);
      useVehicleStore.setState({ gearbox: mode });
      vehicle.setMessage(mode === "manual" ? "Manual: Q down, Z up" : "Automatic");
    }
    if (wasPressed("park")) s.togglePark();
    if (wasPressed("shiftUp")) s.shiftUp();
    if (wasPressed("shiftDown")) s.shiftDown();
    if (wasPressed("interact")) {
      if (s.temperature >= T.cooling.pourAbove && (s.overheated || s.temperature > T.cooling.hotAt)) s.startTask("pourWater");
      else if (s.flat.some(Boolean)) s.startTask("changeTyre");
    }
    const p = rb.translation();
    if (input.horn && !st.hornDown) gameEvents.emit("HORN", { vehicleId: id, position: [p.x, p.y, p.z] });
    st.hornDown = input.horn;

    // Stopped / moving, as before.
    const v = rb.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    if (!st.moving && speed > MOVE_THRESHOLD) st.moving = true;
    else if (st.moving && speed < STOP_THRESHOLD) {
      st.moving = false;
      gameEvents.emit("VEHICLE_STOPPED", { vehicleId: id, position: [p.x, p.y, p.z] });
    }

    const c = s.controller;
    if (r && dt > 0) {
      // Wheels: suspension travel, steering, rolling, flat tyres.
      for (let i = 0; i < 4; i++) {
        const w = r.wheels[i];
        const len = c.wheelSuspensionLength(i) ?? T.suspension.restLength;
        const radius = s.flat[i] ? T.tyres.flatRadius : T.tyres.radius;
        w.pivot.position.y = w.hardPoint[1] - len - (T.tyres.radius - radius);
        w.pivot.rotation.y = c.wheelSteering(i) ?? 0;
        st.spin[i] = (st.spin[i] + (s.forwardSpeed / T.tyres.radius) * dt) % (Math.PI * 2);
        w.spin.rotation.x = i % 2 === 0 ? st.spin[i] : -st.spin[i];
        const sq = s.flat[i] ? radius / T.tyres.radius : 1;
        w.squash.scale.set(1, sq, 1);
        w.squash.position.y = -(1 - sq) * T.tyres.radius * 0.5;
      }
      r.steeringWheel.rotation.z = -s.steerAngle * 14;
      r.speedoNeedle.rotation.z = 2.36 - Math.min(1, (Math.abs(s.forwardSpeed) * 3.6) / 160) * 4.72;
      r.brakeLights.emissiveIntensity = s.braking ? 2.2 : 0.1;

      // Visual lean from acceleration in the car's frame.
      tmpQ.set(rb.rotation().x, rb.rotation().y, rb.rotation().z, rb.rotation().w).invert();
      tmpV.set(v.x, v.y, v.z).sub(st.lastVel).divideScalar(dt).applyQuaternion(tmpQ);
      st.lastVel.set(v.x, v.y, v.z);
      const k = 1 - Math.exp(-dt / T.lean.smoothing);
      st.accel.lerp(tmpV, k);
      const gain = 1 + T.lean.loadGain * (s.passengers / MICRA_PASSENGER_CAPACITY);
      const clamp = (x: number) => Math.max(-T.lean.max, Math.min(T.lean.max, x));
      // +X accel (turning right) rolls the body left; -Z accel (speeding up) squats the tail.
      r.lean.rotation.z = clamp((st.accel.x / G) * T.lean.rollPerG * gain);
      r.lean.rotation.x = clamp((-st.accel.z / G) * T.lean.pitchPerG * gain);
    }

    focus?.position.set(p.x, p.y, p.z);

    // HUD. Transient values every frame; the rest only when they change.
    useGameStore.setState({ speed });
    const gear = s.parked ? "P" : s.gear < 0 ? "R" : s.gear === 0 ? "N" : s.gearbox === "auto" ? `D${s.gear}` : String(s.gear);
    useVehicleStore.setState({ rpm: s.rpm, temperature: s.temperature, grade: s.grade, gear, rollingBack: s.rollingBack });
    if (s.jolt > 0.05 && s.jolt > vehicle.jolt.strength * 0.5) useVehicleStore.setState({ jolt: { strength: s.jolt, at: performance.now() } });
    const condition = Math.round(s.condition);
    const flats = s.flat.flatMap((x, i) => (x ? [i] : []));
    const task = s.task ? { kind: s.task.kind, progress: s.task.time / s.task.duration } : null;
    if (
      condition !== vehicle.condition ||
      s.engineOn !== vehicle.engineOn ||
      s.cranking !== vehicle.cranking ||
      s.overheated !== vehicle.overheated ||
      flats.length !== vehicle.flatTyres.length ||
      s.spareTyres !== vehicle.spareTyres ||
      input.handbrake !== vehicle.handbrake ||
      (task?.kind ?? null) !== (vehicle.task?.kind ?? null) ||
      (task && vehicle.task && Math.floor(task.progress * 20) !== Math.floor(vehicle.task.progress * 20))
    ) {
      useVehicleStore.setState({
        condition,
        engineOn: s.engineOn,
        cranking: s.cranking,
        overheated: s.overheated,
        flatTyres: flats,
        spareTyres: s.spareTyres,
        handbrake: input.handbrake,
        task,
      });
    }
  });

  const [x, y, z] = spawn.position;
  // Yaw then pitch (nose up along the road).
  const q = useMemo(
    () => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), spawn.yaw).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), spawn.pitch)),
    [spawn],
  );

  return (
    <>
      <RigidBody ref={body} position={[x, y, z]} quaternion={[q.x, q.y, q.z, q.w]} colliders={false} canSleep={false} ccd linearDamping={0} angularDamping={0.05}>
        {/* Body shells for collisions only; mass comes from MicraSim.setLoad. */}
        {/* Lower box reaches 0.2 m off the ground so kerbs and drain walls stop the car instead of the raycast wheels hopping onto them. */}
        <CuboidCollider args={[0.78, 0.35, 1.86]} position={[0, 0.55, 0]} density={0} friction={0.4} collisionGroups={CAR_COLLISION_GROUPS} />
        <CuboidCollider args={[0.66, 0.22, 0.95]} position={[0, 1.12, 0.42]} density={0} friction={0.4} collisionGroups={CAR_COLLISION_GROUPS} />
        <group ref={chassis}>
          <MicraModel ref={rig} passengers={passengers} luggageKg={luggageKg} showDriver={cameraMode !== "cockpit" || !camera} />
        </group>
      </RigidBody>
      {camera && <MicraCamera chassis={chassis} body={body} rig={rig} sim={sim} mode={cameraMode} />}
    </>
  );
}
