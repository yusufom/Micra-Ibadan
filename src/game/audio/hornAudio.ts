import { gameEvents, type GameEvents } from "@/game/core/events";
import { playerVehicle } from "@/game/vehicles/playerVehicle";

/**
 * Horns from HORN events, synthesised with Web Audio (two detuned square
 * waves through a low-pass, like a cheap twin-tone horn) until recorded
 * samples arrive. Traffic horns fade with distance from the Micra and pan
 * left/right. The audio context starts on the first key or tap.
 */

type Voice = { freqs: [number, number]; gain: number };

const VOICES: Record<string, Voice> = {
  player: { freqs: [415, 520], gain: 0.22 },
  micra: { freqs: [400, 505], gain: 0.3 },
  car: { freqs: [440, 554], gain: 0.28 },
  peugeot: { freqs: [370, 466], gain: 0.3 },
  keke: { freqs: [720, 760], gain: 0.22 },
  okada: { freqs: [880, 930], gain: 0.2 },
  bus: { freqs: [330, 415], gain: 0.34 },
  truck: { freqs: [196, 247], gain: 0.42 },
  trailer: { freqs: [165, 208], gain: 0.45 },
};

/** Tap patterns (seconds on) by reason. */
const PATTERNS: Record<string, number[]> = {
  press: [0.35],
  honkBack: [0.18, 0.5],
  impatient: [0.25, 0.25, 0.6],
  warning: [0.15, 0.15],
  angry: [1.1],
};

const MAX_VOICES = 6;
const HEARING = 140;

export function startHornAudio(): () => void {
  let ctx: AudioContext | null = null;
  let playing = 0;

  const unlock = () => {
    try {
      ctx ??= new AudioContext();
      if (ctx.state === "suspended") void ctx.resume();
    } catch {
      // No audio on this device.
    }
  };

  const play = (e: GameEvents["HORN"]) => {
    if (!ctx || ctx.state !== "running" || playing >= MAX_VOICES) return;
    const isPlayer = !e.vehicleKind;
    const voice = VOICES[e.vehicleKind ?? "player"] ?? VOICES.car;
    const p = playerVehicle;
    let gain = voice.gain;
    let pan = 0;
    if (!isPlayer && p.active) {
      const dx = e.position[0] - p.x;
      const dz = e.position[2] - p.z;
      const d = Math.hypot(dx, dz);
      if (d > HEARING) return;
      gain /= 1 + (d / 14) ** 2;
      // Right of the Micra's heading pans right.
      pan = Math.max(-0.8, Math.min(0.8, (dx * -p.fz + dz * p.fx) / Math.max(d, 1)));
    }
    if (gain < 0.004) return;

    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2400;
    out.connect(lp).connect(panner).connect(ctx.destination);
    const oscs = voice.freqs.map((f, i) => {
      const o = ctx!.createOscillator();
      o.type = "square";
      o.frequency.value = f * (1 + (Math.random() - 0.5) * 0.02);
      o.detune.value = i ? 6 : -6;
      o.connect(out);
      return o;
    });
    let t = t0;
    for (const on of PATTERNS[e.reason ?? "press"] ?? PATTERNS.press) {
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(gain, t + 0.015);
      out.gain.setValueAtTime(gain, t + on);
      out.gain.linearRampToValueAtTime(0, t + on + 0.03);
      t += on + 0.09;
    }
    playing++;
    for (const o of oscs) {
      o.start(t0);
      o.stop(t);
    }
    oscs[0].onended = () => {
      playing--;
      out.disconnect();
    };
  };

  window.addEventListener("keydown", unlock);
  window.addEventListener("pointerdown", unlock);
  const off = gameEvents.on("HORN", play);
  return () => {
    off();
    window.removeEventListener("keydown", unlock);
    window.removeEventListener("pointerdown", unlock);
    void ctx?.close();
  };
}
