"use client";

import { useEffect, useRef } from "react";
import { useGameStore } from "@/game/store/gameStore";
import { MICRA_PASSENGER_CAPACITY } from "@/game/vehicles/micraSpec";

const naira = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 });

/** DOM overlay above the Canvas. */
export function Hud() {
  const cash = useGameStore((s) => s.cash);
  const dailyDelivery = useGameStore((s) => s.dailyDelivery);
  const passengers = useGameStore((s) => s.passengersOnBoard);
  const speedEl = useRef<HTMLSpanElement>(null);

  // Speed changes every frame: write straight to the DOM, bypassing React.
  useEffect(
    () =>
      useGameStore.subscribe(
        (s) => Math.round(s.speed * 3.6),
        (kmh) => {
          if (speedEl.current) speedEl.current.textContent = String(kmh);
        },
      ),
    [],
  );

  return (
    <div className="pointer-events-none absolute inset-0 flex items-start justify-between p-4 font-mono text-sm text-white">
      <div className="rounded bg-black/60 px-3 py-2">
        <div>
          Cash: {naira.format(cash)} / {naira.format(dailyDelivery)}
        </div>
        <div>
          Passengers: {passengers}/{MICRA_PASSENGER_CAPACITY}
        </div>
      </div>
      <div className="rounded bg-black/60 px-3 py-2">
        <span ref={speedEl}>0</span> km/h
      </div>
    </div>
  );
}
