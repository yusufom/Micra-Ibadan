import { TRAFFIC_TUNING as T } from "@/game/config/trafficTuning";
import type { Manifest } from "@/game/world/chunks/types";

/**
 * How busy the roads are, from the game clock: morning and evening peaks,
 * school runs near schools and UI, market days that pull traffic around
 * markets, and the okada/keke curfew. Pure functions of (hour, weekday, day)
 * plus zones read once from the manifest.
 */

export type Zone = { name: string; x: number; z: number; radius: number; kind: "school" | "market"; /** Market cycle offset. */ phase: number };

/**
 * Markets OSM doesn't have (it only knows Bodija Market and Tolulope Plaza here).
 * Positions are approximate, from the projection origin at Dugbe junction.
 */
const CURATED_MARKETS: Omit<Zone, "radius" | "kind" | "phase">[] = [
  { name: "Dugbe Market", x: 880, z: 380 },
  { name: "Mokola Market", x: 1150, z: -1120 },
];

const isWeekend = (weekday: number) => weekday === 0 || weekday === 6;

function interp(points: readonly (readonly [number, number])[], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
    }
  }
  return points[points.length - 1][1];
}

/** City-wide traffic volume, 0–1 of the maximum. */
export function timeProfile(hour: number, weekday: number): number {
  return interp(isWeekend(weekday) ? T.weekendProfile : T.weekdayProfile, hour);
}

/** School-run strength 0–1 (weekdays only). */
export function schoolRun(hour: number, weekday: number): number {
  if (isWeekend(weekday)) return 0;
  let best = 0;
  for (const r of T.schoolRuns) {
    const ramp = T.schoolRamp;
    const up = Math.min(1, Math.max(0, (hour - (r.from - ramp)) / ramp));
    const down = Math.min(1, Math.max(0, (r.to + ramp - hour) / ramp));
    best = Math.max(best, Math.min(up, down) * r.strength);
  }
  return best;
}

/** Whether it's market day at this market (5-day cycle, plus every Saturday). `?marketday=1` forces it. */
export function isMarketDay(zone: Zone, day: number, weekday: number): boolean {
  if (forceMarketDay) return true;
  return weekday === 6 || (day + zone.phase) % T.marketCycleDays === 0;
}

/** Market activity 0–1 through the trading day, ramping over an hour at opening and closing. */
export function marketTrading(hour: number): number {
  const [open, close] = T.marketHours;
  return Math.max(0, Math.min(1, hour - open + 0.5, close + 0.5 - hour));
}

/** Okada and keke may run now (05:30–22:30). */
export function okadaHours(hour: number): boolean {
  const [from, to] = T.okadaHours;
  return hour >= from && hour < to;
}

/** Night hours when red lights mean even less. */
export const isNight = (hour: number) => hour >= 22 || hour < 5;

let forceMarketDay = false;
/** Client only: reads ?marketday=1 once. */
export function readDensityOverrides(): void {
  forceMarketDay = new URLSearchParams(window.location.search).get("marketday") === "1";
}

/** School and market zones from the manifest (OSM), plus curated markets and the UI campus. */
export function buildZones(manifest: Manifest): Zone[] {
  const zones: Zone[] = [];
  let seed = 0;
  const phase = () => (seed = (seed * 7 + 3) % T.marketCycleDays);
  for (const p of manifest.pois ?? []) {
    if (p.type === "school") zones.push({ name: p.name ?? "School", x: p.x, z: p.z, radius: T.schoolRadius, kind: "school", phase: 0 });
    else if (p.type === "market") zones.push({ name: p.name ?? "Market", x: p.x, z: p.z, radius: T.marketRadius, kind: "market", phase: phase() });
  }
  for (const m of CURATED_MARKETS) {
    if (!zones.some((z) => z.kind === "market" && Math.hypot(z.x - m.x, z.z - m.z) < 300)) {
      zones.push({ ...m, radius: T.marketRadius, kind: "market", phase: phase() });
    }
  }
  // UI: every faculty POI is tagged amenity=university; one zone at their middle.
  const campus = (manifest.pois ?? []).filter((p) => p.type === "landmark" && p.kind === "amenity=university");
  if (campus.length) {
    const x = campus.reduce((a, p) => a + p.x, 0) / campus.length;
    const z = campus.reduce((a, p) => a + p.z, 0) / campus.length;
    zones.push({ name: "University of Ibadan", x, z, radius: T.campusRadius, kind: "school", phase: 0 });
  }
  return zones;
}

export type DensityNow = {
  hour: number;
  weekday: number;
  day: number;
  /** City-wide 0–1. */
  profile: number;
  school: number;
  okadaAllowed: boolean;
  night: boolean;
};

export function densityNow(hour: number, weekday: number, day: number): DensityNow {
  return { hour, weekday, day, profile: timeProfile(hour, weekday), school: schoolRun(hour, weekday), okadaAllowed: okadaHours(hour), night: isNight(hour) };
}

/** Multiplier (≥ 1) on traffic at (x, z) from nearby schools and markets. */
export function zoneBoost(zones: readonly Zone[], now: DensityNow, x: number, z: number): { total: number; school: number; market: number } {
  let school = 0;
  let market = 0;
  const trading = marketTrading(now.hour);
  for (const zone of zones) {
    const d = Math.hypot(zone.x - x, zone.z - z);
    if (d > zone.radius) continue;
    const fall = 1 - (d / zone.radius) ** 2;
    if (zone.kind === "school") school = Math.max(school, now.school * fall);
    else if (trading > 0) {
      const boost = isMarketDay(zone, now.day, now.weekday) ? T.marketDayBoost : T.marketTradeBoost;
      market = Math.max(market, trading * fall * boost);
    }
  }
  return { total: 1 + school * T.schoolBoost + market, school, market };
}
