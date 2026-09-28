// Gamepads (round 14), the pure half: the standard-mapping button table, the RadRun layout, stick shaping and
// the edge / repeat trackers. padRuntime.ts polls the Gamepad API and feeds the result into the same InputLatch
// the keyboard, mouse and touch write, so a pad plays the same quantised input word (ghost format 4, share links
// v6, runner packs v3 and the online rollback are untouched): the left stick is the camera-space move (like the
// touch stick), the right stick turns the same camera yaw / pitch the mouse turns, and the buttons are the same
// presses and holds. Nothing here touches the DOM (Node tests import it).
import type { InputLatch } from "./input.ts";

/** Button / glyph family: PlayStation (Cross, Circle, L1...) or Xbox (A, B, LB...). Unknown pads get Xbox glyphs. */
export type PadKind = "ps" | "xbox";

/** W3C "standard" mapping button indices (Chrome / Firefox map DualSense, DualShock and Xbox pads to it). */
export const PB = {
  SOUTH: 0, EAST: 1, WEST: 2, NORTH: 3, L1: 4, R1: 5, L2: 6, R2: 7, SELECT: 8, START: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16, PAD: 17,
} as const;
export type PadButton = keyof typeof PB;
/** Virtual buttons past the real ones: the left stick pushed past the navigation threshold. */
export const LS_UP = 20, LS_DOWN = 21, LS_LEFT = 22, LS_RIGHT = 23;
const N_BUTTONS = 18;

/** Pick the glyph family from the pad's id string (Chrome: "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c ...)"). */
export function padKind(id: string): PadKind {
  if (/xbox|xinput|045e|microsoft/i.test(id)) return "xbox";
  return /054c|sony|dualsense|dualshock|playstation|wireless controller/i.test(id) ? "ps" : "xbox";
}

/** Player settings (pause -> Settings -> controller; stored with the other settings). */
export type PadSettings = {
  /** Right-stick look speed multiplier (1 = PAD.lookYaw rad/s at full tilt). */
  sens: number;
  invertY: boolean;
  /** Radial dead zone of both sticks (0..0.4 of the stick's reach). */
  dead: number;
  /** Rumble on webs, landings, bonks and catches (where the pad supports dual-rumble). */
  rumble: boolean;
};
export const PAD_DEFAULTS: PadSettings = { sens: 1, invertY: false, dead: 0.12, rumble: true };
export const PAD_SENS = { min: 0.3, max: 2.5 } as const;
export const PAD_DEAD = { min: 0.04, max: 0.35 } as const;

export const PAD = {
  /** Look speed at full tilt (rad/s): yaw, pitch. */
  lookYaw: 3.6,
  lookPitch: 2.2,
  /** Look response curve (tilt^exp: fine aim near the centre, full speed at the rim). */
  lookExp: 1.8,
  /** Held at the rim this long (s), the turn speeds up to lookBoost x over boostRamp s (quick about-face). */
  boostAfter: 0.3,
  boostRamp: 0.35,
  lookBoost: 1.6,
  /** Move: full speed from this much tilt (the stick's rim is never quite 1 on every pad). */
  moveFull: 0.92,
  /** Triggers: pressed above trigOn, released below trigOff (hysteresis; the web is a hold). */
  trigOn: 0.35,
  trigOff: 0.2,
  /** Menus: the left stick counts as a d-pad press past navOn, released under navOff. */
  navOn: 0.55,
  navOff: 0.35,
  /** Menus: a held direction repeats after repeatDelay s, then every repeatEvery s. */
  repeatDelay: 0.38,
  repeatEvery: 0.11,
} as const;

/** What a RadRun action is bound to (the prompts and the controls lists read this table too). */
export type PadAction = "jump" | "web" | "zip" | "slide" | "glide" | "face" | "retry" | "pause" | "mute";
export const LAYOUT: Record<PadAction, readonly PadButton[]> = {
  jump: ["SOUTH"],
  web: ["R2"],
  zip: ["R1", "L2"],
  slide: ["EAST"],
  glide: ["L1"],
  face: ["R3"],
  retry: ["NORTH"],
  pause: ["START"],
  mute: ["SELECT"],
};

/** A pad's state as the Gamepad API reports it (a real Gamepad fits; tests pass plain objects). */
export type PadSnap = {
  id: string;
  index: number;
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
};

export const bit = (b: PadButton | number): number => 1 << (typeof b === "number" ? b : PB[b]);
export const any = (mask: number, bs: readonly PadButton[]): boolean => bs.some(b => (mask & bit(b)) !== 0);

/**
 * Radial dead zone + response curve: inside `dead` nothing; past it the length is rescaled from dead..full to
 * 0..1 (the direction kept, so diagonals are not squashed the way per-axis dead zones squash them), then raised to
 * `exp`. Recording side only: the result is quantised into the input word before the sim sees it.
 */
export function radial(x: number, y: number, dead: number, exp = 1, full = 1): [number, number] {
  const l = Math.sqrt(x * x + y * y);
  if (!(l > dead)) return [0, 0];
  let m = (l - dead) / Math.max(1e-6, full - dead);
  if (m > 1) m = 1;
  if (exp !== 1) m = Math.pow(m, exp);
  return [(x / l) * m, (y / l) * m];
}

const axis = (s: PadSnap, i: number): number => {
  const v = s.axes[i];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};
const value = (s: PadSnap, i: number): number => {
  const b = s.buttons[i];
  if (!b) return 0;
  return typeof b.value === "number" && b.value > 0 ? b.value : b.pressed ? 1 : 0;
};

/**
 * Held buttons with hysteresis (analog triggers press at trigOn and let go under trigOff; the left stick adds
 * LS_* bits for menus) and the edges since the last update.
 */
export class PadButtons {
  down = 0;
  pressed = 0;
  released = 0;
  update(s: PadSnap | null): void {
    const prev = this.down;
    let now = 0;
    if (s) {
      for (let i = 0; i < N_BUTTONS; i++) {
        const v = value(s, i);
        const held = (prev >> i) & 1;
        const analog = i === PB.L2 || i === PB.R2;
        if (analog ? v >= (held ? PAD.trigOff : PAD.trigOn) : v >= 0.5) now |= 1 << i;
      }
      const lx = axis(s, 0), ly = axis(s, 1);
      const on = (b: number, v: number) => { if (v >= ((prev >> b) & 1 ? PAD.navOff : PAD.navOn)) now |= 1 << b; };
      on(LS_UP, -ly); on(LS_DOWN, ly); on(LS_LEFT, -lx); on(LS_RIGHT, lx);
    }
    this.pressed = now & ~prev;
    this.released = prev & ~now;
    this.down = now;
  }
  /** Any real button pressed this update (not the stick bits): the pad was just used. */
  get fresh(): boolean {
    return (this.pressed & ((1 << N_BUTTONS) - 1)) !== 0;
  }
}

export type NavDir = "up" | "down" | "left" | "right";
const NAV_BITS: Record<NavDir, number> = {
  up: bit("UP") | (1 << LS_UP), down: bit("DOWN") | (1 << LS_DOWN), left: bit("LEFT") | (1 << LS_LEFT), right: bit("RIGHT") | (1 << LS_RIGHT),
};

/** Menu direction from the d-pad or the left stick: one move on the press, then repeats while held. */
export class NavRepeat {
  private dir: NavDir | null = null;
  private t = 0;
  next(down: number, dt: number): NavDir | null {
    let cur: NavDir | null = null;
    for (const d of ["up", "down", "left", "right"] as const) if (down & NAV_BITS[d]) { cur = d; break; }
    if (cur !== this.dir) { this.dir = cur; this.t = 0; return cur; }
    if (!cur) return null;
    this.t += dt;
    if (this.t >= PAD.repeatDelay) { this.t -= PAD.repeatEvery; return cur; }
    return null;
  }
}

/** The right stick's look since the last poll, in radians (x = yaw right, y = pitch down; the frame applies it). */
export class LookShaper {
  private rimT = 0;
  step(rx: number, ry: number, set: PadSettings, dt: number): [number, number] {
    const [x, y] = radial(rx, ry, set.dead, PAD.lookExp);
    const l = Math.sqrt(x * x + y * y);
    this.rimT = l > 0.97 ? this.rimT + dt : 0;
    const boost = this.rimT > PAD.boostAfter ? 1 + (PAD.lookBoost - 1) * Math.min(1, (this.rimT - PAD.boostAfter) / PAD.boostRamp) : 1;
    const k = set.sens * dt;
    return [x * PAD.lookYaw * k * boost, (set.invertY ? -y : y) * PAD.lookPitch * k];
  }
  reset(): void {
    this.rimT = 0;
  }
}

/**
 * One poll's pad state into the latch (in play): sticks and holds are levels (re-applied every poll, so a window
 * blur that cleared the latch heals on the next frame), presses are edges (latched until a step consumes them).
 */
export function padToLatch(l: InputLatch, s: PadSnap, b: PadButtons, look: LookShaper, set: PadSettings, dt: number): void {
  let [mx, my] = radial(axis(s, 0), axis(s, 1), set.dead, 1, PAD.moveFull);
  // At the rim, out to the square (the frame normalises it): full tilt is exactly full speed in any direction,
  // like W / W+D, instead of a quantised diagonal a hair under it.
  const rim = Math.max(Math.abs(mx), Math.abs(my));
  if (mx * mx + my * my >= 0.999999 && rim > 0) { mx /= rim; my /= rim; }
  l.padX = mx;
  l.padY = -my;
  const [lx, ly] = look.step(axis(s, 2), axis(s, 3), set, dt);
  l.padLookX += lx;
  l.padLookY += ly;
  const held = b.down, pressed = b.pressed;
  l.padJumpHeld = any(held, LAYOUT.jump);
  l.padWeb = any(held, LAYOUT.web);
  l.padSlideHeld = any(held, LAYOUT.slide);
  l.padGlideHeld = any(held, LAYOUT.glide);
  l.padFace = any(held, LAYOUT.face);
  // Edges only on the pad's own transitions (a latch cleared by a blur or a new round never re-presses a held button).
  if (any(pressed, LAYOUT.jump)) l.padPress("jump");
  if (any(pressed, LAYOUT.web)) l.padPress("web");
  if (any(pressed, LAYOUT.zip)) l.padPress("zip");
  if (any(pressed, LAYOUT.slide)) l.padPress("slide");
}
