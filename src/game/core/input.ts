/**
 * One normalised driving input, merged from keyboard, touch and gamepad.
 * Everything reads `input` (analogue state) and `wasPressed()` (buttons
 * pressed since the last frame); nothing else should listen to devices.
 *
 * Call startInput() once on the client and pollInput() once per frame,
 * before anything reads it (GameLoop does both).
 *
 * Keyboard: WASD / arrows drive, Space handbrake, H horn, E interact,
 * C camera, Q / Z shift down / up (manual), M auto/manual gearbox, P park.
 * Gamepad (standard mapping): left stick steer, RT gas, LT brake, A handbrake,
 * B horn, X interact, Y camera, LB / RB shift down / up, View/Back gearbox, Start park.
 * Touch: see src/game/ui/TouchControls.tsx, which writes `touchInput`.
 */

export type InputSource = "keyboard" | "touch" | "gamepad";

export type InputAction = "interact" | "camera" | "shiftUp" | "shiftDown" | "gearbox" | "park";

export type InputState = {
  /** 0–1. */
  throttle: number;
  /** 0–1. */
  brake: number;
  /** -1 (full left) to 1 (full right). Raw: the vehicle applies its own steering rate. */
  steer: number;
  handbrake: boolean;
  horn: boolean;
  /** Device that last produced input, for UI hints. */
  source: InputSource;
};

export const input: InputState = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  horn: false,
  source: "keyboard",
};

/** Written by the touch overlay. */
export const touchInput = {
  active: false,
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: false,
  horn: false,
};

const KEY_ACTIONS: Record<string, InputAction> = {
  KeyE: "interact",
  KeyC: "camera",
  KeyZ: "shiftUp",
  KeyQ: "shiftDown",
  KeyM: "gearbox",
  KeyP: "park",
};

const PAD_ACTIONS: [button: number, action: InputAction][] = [
  [2, "interact"],
  [3, "camera"],
  [5, "shiftUp"],
  [4, "shiftDown"],
  [8, "gearbox"],
  [9, "park"],
];

const PAD_DEADZONE = 0.15;
const PAD_TRIGGER_DEADZONE = 0.05;

const keys = new Set<string>();
/** Presses collected from events since the last poll. */
let pending = new Set<InputAction>();
/** Presses visible to readers during this frame. */
let current = new Set<InputAction>();
const padHeld = new Set<number>();
let started = 0;

function onKeyDown(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  keys.add(e.code);
  input.source = "keyboard";
  const action = KEY_ACTIONS[e.code];
  if (action && !e.repeat) pending.add(action);
  // Keep Space and arrows from scrolling the page.
  if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
}

function onKeyUp(e: KeyboardEvent): void {
  keys.delete(e.code);
}

function onBlur(): void {
  keys.clear();
}

/** Attach device listeners. Returns a teardown; safe to call more than once. */
export function startInput(): () => void {
  if (started++ === 0) {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
  }
  return () => {
    if (--started > 0) return;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    keys.clear();
    pending.clear();
    current.clear();
  };
}

/** Queue a button press from outside the keyboard/gamepad path (touch buttons). */
export function pressAction(action: InputAction): void {
  pending.add(action);
  input.source = "touch";
}

/** True during the one frame after the action's button went down. */
export function wasPressed(action: InputAction): boolean {
  return current.has(action);
}

const deadzone = (v: number, dz: number) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));

function firstGamepad(): Gamepad | null {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
  for (const p of navigator.getGamepads()) if (p && p.connected) return p;
  return null;
}

/** Merge all devices into `input` and publish this frame's presses. */
export function pollInput(): void {
  const k = (code: string) => keys.has(code);
  let throttle = k("KeyW") || k("ArrowUp") ? 1 : 0;
  let brake = k("KeyS") || k("ArrowDown") ? 1 : 0;
  let steer = (k("KeyD") || k("ArrowRight") ? 1 : 0) - (k("KeyA") || k("ArrowLeft") ? 1 : 0);
  let handbrake = k("Space");
  let horn = k("KeyH");

  if (touchInput.active) {
    throttle = Math.max(throttle, touchInput.throttle);
    brake = Math.max(brake, touchInput.brake);
    if (touchInput.steer !== 0) steer = touchInput.steer;
    handbrake ||= touchInput.handbrake;
    horn ||= touchInput.horn;
    if (touchInput.throttle || touchInput.brake || touchInput.steer || touchInput.horn) input.source = "touch";
  }

  const pad = firstGamepad();
  if (pad) {
    const b = (i: number) => pad.buttons[i];
    const trigger = (i: number) => deadzone(b(i)?.value ?? 0, PAD_TRIGGER_DEADZONE);
    const padSteer = deadzone(pad.axes[0] ?? 0, PAD_DEADZONE);
    const padThrottle = trigger(7);
    const padBrake = trigger(6);
    if (padSteer || padThrottle || padBrake || pad.buttons.some((x) => x.pressed)) input.source = "gamepad";
    throttle = Math.max(throttle, padThrottle);
    brake = Math.max(brake, padBrake);
    if (padSteer !== 0) steer = padSteer;
    handbrake ||= !!b(0)?.pressed;
    horn ||= !!b(1)?.pressed;
    for (const [i, action] of PAD_ACTIONS) {
      const down = !!b(i)?.pressed;
      if (down && !padHeld.has(i)) pending.add(action);
      if (down) padHeld.add(i);
      else padHeld.delete(i);
    }
  }

  input.throttle = Math.min(1, throttle);
  input.brake = Math.min(1, brake);
  input.steer = Math.max(-1, Math.min(1, steer));
  input.handbrake = handbrake;
  input.horn = horn;

  const swap = current;
  current = pending;
  pending = swap;
  pending.clear();
}
