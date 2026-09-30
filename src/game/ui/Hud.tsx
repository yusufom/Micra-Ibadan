"use client";

import { useEffect, useRef, useState } from "react";
import { MICRA_TUNING } from "@/game/config/micraTuning";
import { useGameStore } from "@/game/store/gameStore";
import { useVehicleStore } from "@/game/store/vehicleStore";
import { MICRA_PASSENGER_CAPACITY } from "@/game/vehicles/micraSpec";

const naira = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 });

/** How long a status message stays up (ms). */
const MESSAGE_MS = 3500;
const REDLINE = MICRA_TUNING.engine.redlineRpm;
const COOL = MICRA_TUNING.cooling;

const TASK_LABEL = { pourWater: "Pouring water in the radiator…", changeTyre: "Changing the tyre…" } as const;

function Warning({ on, children, tone = "amber" }: { on: boolean; children: React.ReactNode; tone?: "amber" | "red" }) {
  if (!on) return null;
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${tone === "red" ? "bg-red-600/90" : "bg-amber-500/90 text-black"}`}>{children}</span>;
}

/** DOM overlay above the Canvas. */
export function Hud() {
  const cash = useGameStore((s) => s.cash);
  const dailyDelivery = useGameStore((s) => s.dailyDelivery);
  const passengers = useGameStore((s) => s.passengersOnBoard);
  const luggage = useGameStore((s) => s.luggageKg);
  const condition = useVehicleStore((s) => s.condition);
  const engineOn = useVehicleStore((s) => s.engineOn);
  const cranking = useVehicleStore((s) => s.cranking);
  const overheated = useVehicleStore((s) => s.overheated);
  const flats = useVehicleStore((s) => s.flatTyres.length);
  const spare = useVehicleStore((s) => s.spareTyres);
  const handbrake = useVehicleStore((s) => s.handbrake);
  const gearbox = useVehicleStore((s) => s.gearbox);
  const task = useVehicleStore((s) => s.task);
  const message = useVehicleStore((s) => s.message);

  const speedEl = useRef<HTMLSpanElement>(null);
  const gearEl = useRef<HTMLSpanElement>(null);
  const rpmEl = useRef<HTMLDivElement>(null);
  const tempEl = useRef<HTMLDivElement>(null);
  const gradeEl = useRef<HTMLSpanElement>(null);
  const rollbackEl = useRef<HTMLSpanElement>(null);

  // Per-frame values: write straight to the DOM, bypassing React.
  useEffect(() => {
    const offSpeed = useGameStore.subscribe(
      (s) => Math.round(s.speed * 3.6),
      (kmh) => {
        if (speedEl.current) speedEl.current.textContent = String(kmh);
      },
    );
    const offVehicle = useVehicleStore.subscribe((s) => {
      if (gearEl.current && gearEl.current.textContent !== s.gear) gearEl.current.textContent = s.gear;
      if (rpmEl.current) {
        const f = Math.min(1, s.rpm / REDLINE);
        rpmEl.current.style.width = `${f * 100}%`;
        rpmEl.current.style.background = f > 0.9 ? "#ef4444" : f > 0.75 ? "#f59e0b" : "#e5e7eb";
      }
      if (tempEl.current) {
        const f = Math.max(0, Math.min(1, (s.temperature - COOL.ambient) / (1 - COOL.ambient)));
        tempEl.current.style.width = `${f * 100}%`;
        tempEl.current.style.background = s.temperature > COOL.hotAt ? "#ef4444" : s.temperature > 0.7 ? "#f59e0b" : "#38bdf8";
      }
      if (gradeEl.current) gradeEl.current.textContent = `${s.grade >= 0 ? "▲" : "▼"} ${Math.abs(s.grade * 100).toFixed(0)}%`;
      if (rollbackEl.current) rollbackEl.current.style.display = s.rollingBack ? "inline" : "none";
    });
    return () => {
      offSpeed();
      offVehicle();
    };
  }, []);

  // Hide each message after a while (keyed by when it was set).
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setExpired(message.at), MESSAGE_MS);
    return () => clearTimeout(t);
  }, [message]);
  const showMessage = message && expired !== message.at;

  return (
    <div className="pointer-events-none absolute inset-0 font-mono text-sm text-white">
      <div className="absolute top-4 left-4 rounded bg-black/60 px-3 py-2">
        <div>
          Cash: {naira.format(cash)} / {naira.format(dailyDelivery)}
        </div>
        <div>
          Passengers: {passengers}/{MICRA_PASSENGER_CAPACITY}
          {luggage > 0 && <span className="text-white/60"> · {luggage} kg load</span>}
        </div>
      </div>

      {showMessage && (
        <div className="absolute inset-x-0 top-24 flex justify-center px-4">
          <div className="rounded bg-black/70 px-3 py-1.5 text-center">{message.text}</div>
        </div>
      )}

      {task && (
        <div className="absolute inset-x-0 top-1/3 flex justify-center px-4">
          <div className="w-64 rounded bg-black/70 px-3 py-2 text-center">
            <div>{TASK_LABEL[task.kind]}</div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-white/20">
              <div className="h-full bg-white" style={{ width: `${Math.round(task.progress * 100)}%` }} />
            </div>
          </div>
        </div>
      )}

      <div className="absolute top-4 right-4 w-52 rounded bg-black/60 px-3 py-2">
        <div className="flex items-baseline justify-between">
          <span>
            <span ref={speedEl} className="text-3xl font-bold tabular-nums">
              0
            </span>{" "}
            km/h
          </span>
          <span ref={gearEl} className="text-2xl font-bold">
            D1
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded bg-white/15">
          <div ref={rpmEl} className="h-full" style={{ width: "0%" }} />
        </div>
        <div className="mt-2 flex items-center gap-2 text-[11px]">
          <span className="w-9 text-white/70">TEMP</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded bg-white/15">
            <div ref={tempEl} className="h-full" style={{ width: "0%" }} />
          </div>
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-white/80">
          <span>Condition {condition}%</span>
          <span ref={gradeEl}>▲ 0%</span>
        </div>
        <div className="mt-1 text-[11px] text-white/60">
          {gearbox === "auto" ? "AUTO" : "MANUAL"} · spare {spare}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <Warning on={handbrake}>HANDBRAKE</Warning>
          <Warning on={!engineOn && !overheated} tone="red">
            {cranking ? "CRANKING…" : "STALLED"}
          </Warning>
          <Warning on={overheated} tone="red">
            OVERHEATED
          </Warning>
          <Warning on={flats > 0} tone="red">
            FLAT TYRE
          </Warning>
          <span ref={rollbackEl} style={{ display: "none" }}>
            <Warning on>ROLLING BACK</Warning>
          </span>
        </div>
      </div>
    </div>
  );
}
