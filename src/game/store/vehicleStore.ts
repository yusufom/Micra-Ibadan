import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { MICRA_TUNING } from "@/game/config/micraTuning";

export type GearboxMode = "auto" | "manual";
export type CameraMode = "chase" | "cockpit";

/** What the driver is doing with their hands, if anything (radiator, spare tyre). */
export type VehicleTask = { kind: "pourWater" | "changeTyre"; progress: number } | null;

/**
 * Player vehicle state for the HUD and camera.
 *
 * Transient (written every frame with setState; read with subscribe or
 * getState, never selected in React): rpm, temperature, grade, gear,
 * rollingBack, jolt.
 * Gameplay-speed (fine to select): condition, stalled, overheated,
 * flatTyres, gearbox, camera, task, message.
 */
export type VehicleState = {
  rpm: number;
  /** Normalised coolant temperature, see MICRA_TUNING.cooling. */
  temperature: number;
  /** Road grade under the car along its heading, fraction (0.1 = 10% uphill). */
  grade: number;
  /** "R", "N", "1".."4". */
  gear: string;
  rollingBack: boolean;
  /** Camera shake: strength 0–1 and game time it happened. */
  jolt: { strength: number; at: number };

  condition: number;
  engineOn: boolean;
  cranking: boolean;
  overheated: boolean;
  /** Burst tyres, by wheel index (0 FL, 1 FR, 2 RL, 3 RR). */
  flatTyres: number[];
  spareTyres: number;
  handbrake: boolean;
  gearbox: GearboxMode;
  camera: CameraMode;
  task: VehicleTask;
  /** Short status line for the HUD, with the time it was set (performance.now ms). */
  message: { text: string; at: number } | null;

  setMessage: (text: string) => void;
};

export const useVehicleStore = create<VehicleState>()(
  subscribeWithSelector((set) => ({
    rpm: 0,
    temperature: MICRA_TUNING.cooling.start,
    grade: 0,
    gear: "N",
    rollingBack: false,
    jolt: { strength: 0, at: -1 },

    condition: MICRA_TUNING.condition.start,
    engineOn: true,
    cranking: false,
    overheated: false,
    flatTyres: [],
    spareTyres: 1,
    handbrake: false,
    gearbox: "auto",
    camera: "chase",
    task: null,
    message: null,

    setMessage: (text) => set({ message: { text, at: performance.now() } }),
  })),
);
