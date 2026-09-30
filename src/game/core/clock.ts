/**
 * Game clock. Mutable, non-React state advanced once per frame by GameLoop.
 * Read it directly (gameClock.elapsed) from systems; never mirror it into
 * React state.
 */

/** Real seconds per in-game day. 24 real minutes = 1 Ibadan day. */
export const SECONDS_PER_GAME_DAY = 24 * 60;

/** In-game hour a session starts at by default: mid-morning, sun well up. */
export const DAY_START_HOUR = 10;

/** Clamp frame delta so a backgrounded tab doesn't explode the simulation. */
const MAX_DELTA = 0.1;

export const gameClock = {
  /** Scaled seconds since the session started. */
  elapsed: 0,
  /** Scaled delta of the last tick. */
  delta: 0,
  /** 0 pauses, 1 is normal speed. */
  timeScale: 1,
  paused: false,
  /** In-game hour at elapsed = 0. */
  startHour: DAY_START_HOUR,

  tick(rawDelta: number): number {
    const dt = this.paused ? 0 : Math.min(rawDelta, MAX_DELTA) * this.timeScale;
    this.delta = dt;
    this.elapsed += dt;
    return dt;
  },

  /** In-game hour of day, 0–24. */
  get hourOfDay(): number {
    return (this.startHour + (this.elapsed / SECONDS_PER_GAME_DAY) * 24) % 24;
  },

  reset(startHour = DAY_START_HOUR): void {
    this.startHour = startHour;
    this.elapsed = 0;
    this.delta = 0;
    this.timeScale = 1;
    this.paused = false;
  },
};
