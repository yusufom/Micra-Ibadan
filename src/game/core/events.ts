/**
 * Typed game event bus. Gameplay systems talk through this instead of
 * importing each other. Dispatch is synchronous and allocation-free apart
 * from the payload object, so it is safe to emit from inside useFrame.
 */

export type Vec3Tuple = [x: number, y: number, z: number];

export type EnforcementAgency = "OYRTMA" | "VIO" | "FRSC" | "POLICE" | "TOUT";

/** AI traffic vehicle types (src/game/npc/traffic/vehicleTypes.ts). */
export type TrafficVehicleKind = "micra" | "car" | "keke" | "okada" | "truck" | "trailer" | "bus" | "peugeot";

export type GameEvents = {
  PASSENGER_BOARDED: {
    passengerId: string;
    seat: number;
    /** Agreed fare in naira. */
    fare: number;
    /** Game clock time in seconds when boarding completed. */
    at: number;
  };
  FARE_PAID: {
    passengerId: string;
    /** Amount in naira. */
    amount: number;
  };
  VEHICLE_STOPPED: {
    vehicleId: string;
    /** World position in metres. */
    position: Vec3Tuple;
  };
  ENFORCEMENT_TRIGGERED: {
    agency: EnforcementAgency;
    reason: string;
    position: Vec3Tuple;
  };
  /** Horn pressed (once per press, not per frame held). Traffic horns carry their vehicle type and why. */
  HORN: {
    vehicleId: string;
    position: Vec3Tuple;
    vehicleKind?: TrafficVehicleKind;
    reason?: "honkBack" | "impatient" | "warning" | "angry";
  };
  /** The player's Micra hit an AI vehicle. */
  COLLISION: {
    vehicleId: string;
    otherId: string;
    otherKind: TrafficVehicleKind;
    position: Vec3Tuple;
    /** Closing speed at impact, m/s. */
    relativeSpeed: number;
    /** Condition points the Micra loses. */
    damage: number;
  };
  /** Someone waving on the roadside was picked up by a rival Micra. */
  PASSENGER_STOLEN: {
    hailId: number;
    vehicleId: string;
    position: Vec3Tuple;
  };
  /** The player stopped beside someone waving for a taxi. Boarding is up to the passenger system. */
  HAIL_REACHED: {
    hailId: number;
    vehicleId: string;
    position: Vec3Tuple;
  };
  POTHOLE_HIT: {
    vehicleId: string;
    position: Vec3Tuple;
    /** 0–1. */
    severity: number;
    /** Speed at impact, m/s. */
    speed: number;
    /** Condition points lost. */
    damage: number;
  };
  TYRE_BURST: {
    vehicleId: string;
    /** 0 front-left, 1 front-right, 2 rear-left, 3 rear-right. */
    wheel: number;
    position: Vec3Tuple;
  };
  ENGINE_STALLED: {
    vehicleId: string;
    reason: "hill" | "lugging" | "overheat";
    position: Vec3Tuple;
  };
};

export type GameEventName = keyof GameEvents;
export type GameEventHandler<K extends GameEventName> = (payload: GameEvents[K]) => void;

type HandlerSet = Set<(payload: never) => void>;

export class EventBus<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, HandlerSet>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof Events>(name: K, handler: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (payload: never) => void);
    return () => this.off(name, handler);
  }

  /** Subscribe for a single emission. Returns an unsubscribe function. */
  once<K extends keyof Events>(name: K, handler: (payload: Events[K]) => void): () => void {
    const off = this.on(name, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof Events>(name: K, handler: (payload: Events[K]) => void): void {
    this.handlers.get(name)?.delete(handler as (payload: never) => void);
  }

  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    // Copy so handlers may unsubscribe (e.g. once) during dispatch.
    for (const handler of [...set]) {
      (handler as (payload: Events[K]) => void)(payload);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** The single game-wide bus. */
export const gameEvents = new EventBus<GameEvents>();
