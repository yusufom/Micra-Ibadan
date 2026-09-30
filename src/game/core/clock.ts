/**
 * Game clock. Mutable, non-React state advanced once per frame by GameLoop.
 * Read it directly (gameClock.elapsed) from systems; never mirror it into
 * React state.
 */

/** Real seconds per in-game day. 24 real minutes = 1 Ibadan day. */
export const SECONDS_PER_GAME_DAY = 24 * 60;

/** In-game hour the day starts at (early morning load at the garage). */
export const DAY_START_HOUR = 5.5;

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

  tick(rawDelta: number): number {
    const dt = this.paused ? 0 : Math.min(rawDelta, MAX_DELTA) * this.timeScale;
    this.delta = dt;
    this.elapsed += dt;
    return dt;
  },

  /** In-game hour of day, 0–24. */
  get hourOfDay(): number {
    return (DAY_START_HOUR + (this.elapsed / SECONDS_PER_GAME_DAY) * 24) % 24;
  },

  reset(): void {
    this.elapsed = 0;
    this.delta = 0;
    this.timeScale = 1;
    this.paused = false;
  },
};
