import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { DAY_START_HOUR } from "@/game/core/clock";

/**
 * Session state that changes at gameplay speed (fares, cash), not per frame.
 * Per-frame values (speed, position) belong in refs or transient updates via
 * useGameStore.setState + useGameStore.subscribe, never in React state.
 */
export type GameState = {
  /** Naira in the driver's pocket today. */
  cash: number;
  /** Daily delivery owed to the oga. */
  dailyDelivery: number;
  faresCollected: number;
  passengersOnBoard: number;
  /** Luggage in the hatch, kg. Weighs the car down. */
  luggageKg: number;
  /** Speed in m/s. Written transiently every frame; don't select it in React. */
  speed: number;
  /** In-game hour of day (0–24), mirrored from gameClock once per in-game minute. */
  hourOfDay: number;

  addFare: (amount: number) => void;
  setPassengers: (count: number) => void;
  setLuggage: (kg: number) => void;
  reset: () => void;
};

const initial = {
  cash: 0,
  dailyDelivery: 12000,
  faresCollected: 0,
  passengersOnBoard: 0,
  luggageKg: 0,
  speed: 0,
  hourOfDay: DAY_START_HOUR,
};

export const useGameStore = create<GameState>()(
  subscribeWithSelector((set) => ({
    ...initial,
    addFare: (amount) => set((s) => ({ cash: s.cash + amount, faresCollected: s.faresCollected + 1 })),
    setPassengers: (count) => set({ passengersOnBoard: count }),
    setLuggage: (kg) => set({ luggageKg: Math.max(0, kg) }),
    reset: () => set(initial),
  })),
);
