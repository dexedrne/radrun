import { getPads, isPhone } from "../phone.ts";
// Round 14: the Gamepad API side. One poll per frame (a rAF loop, and the game drivers poll first thing in their
// frame so a press reaches the very next step): the most recently used pad drives either the Radbro (while the page
// says a round is live: its InputLatch) or the menus (padNav.ts). Hot-plug works through navigator.getGamepads();
// the last device used decides the prompts (useUi.pad: a pad kind, or null after a key, a click, a real mouse move
// or a touch). Rumble goes to that pad when the player wants it.
import type { InputLatch } from "./input.ts";
import { LAYOUT, LookShaper, NavRepeat, PAD_DEFAULTS, PadButtons, any, padKind, padToLatch, type PadButton, type PadSettings, type PadSnap } from "./gamepad.ts";
import { MenuNav, installPadCss, usePadKeyboard } from "../ui/padNav.ts";
import { useUi } from "../ui/store.ts";

/** What the page tells the pad (PlayPage / TagPage register these). */
export type PadHooks = {
  /** The latch a live round reads (countdown / chase / practice / match, not paused), else null = menus. */
  latch(): InputLatch | null;
  /** Options / Menu in play. */
  pause?(): void;
  /** Triangle / Y held (true) / let go (false) in play: hold to retry. */
  retry?(held: boolean): void;
  /** Create / View anywhere. */
  mute?(): void;
};

let hooks: PadHooks | null = null;
let settings: PadSettings = { ...PAD_DEFAULTS };
const trackers = new Map<number, PadButtons>();
let primary = -1;
const look = new LookShaper();
const repeat = new NavRepeat();
const nav = new MenuNav();
let lastT = 0;
let started = false;
let playLatch: InputLatch | null = null;
let menu = false;
/** The menus are what the pad drives right now (the legend shows). */
export const padMenuActive = (): boolean => menu && useUi.getState().pad !== null;

export function setPadHooks(h: PadHooks | null): () => void {
  hooks = h;
  return () => { if (hooks === h) hooks = null; };
}
export function setPadSettings(s: Partial<PadSettings>): void {
  settings = { ...settings, ...s };
}
export const padSettings = (): PadSettings => settings;
/** The pad is the last device used (PLAY and Resume then skip the pointer lock: a pad press can't grant it). */
export const padActive = (): boolean => useUi.getState().pad !== null;

function claim(gp: PadSnap): void {
  const kind = padKind(gp.id);
  const s = useUi.getState();
  if (s.pad !== kind || !s.padSeen) useUi.setState({ pad: kind, padSeen: true });
}
function drop(): void {
  if (useUi.getState().pad === null) return;
  useUi.setState({ pad: null });
  nav.release();
  leavePlay();
}
function leavePlay(): void {
  if (playLatch) playLatch.padRelease();
  playLatch = null;
  look.reset();
}

const readPads = (): (Gamepad | null)[] => {
  try {
    return getPads();
  } catch {
    return []; // no permission (a frame without "gamepad"), or no API
  }
};

/** Poll the pads once (idempotent within a frame). */
export function pollPads(now = performance.now()): void {
  if (!started || now - lastT < 4) return;
  const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
  lastT = now;
  const pads = readPads();
  const first = pads.find(gp => gp?.connected && !/motion sensor|accelerometer|gyroscope/i.test(gp.id));
  const connected = !!first;
  if (connected !== useUi.getState().padConnected) useUi.setState({ padConnected: connected, touchRequested: false });
  if (!connected) { primary = -1; drop(); trackers.clear(); }
  let firstTouch = false;
  if (isPhone() && first && (!pads[primary]?.connected || useUi.getState().pad === null)) {
    primary = first.index; claim(first); firstTouch = true;
  }
  for (const gp of pads) {
    if (!gp || !gp.connected) continue;
    let t = trackers.get(gp.index);
    if (!t) { t = new PadButtons(); trackers.set(gp.index, t); }
    t.update(gp);
    // Only the standard mapping's four stick axes (other mappings may park triggers at -1 on an axis).
    const moved = gp.mapping === "standard" && gp.axes.slice(0, 4).some(a => Math.abs(a) > 0.5);
    if (isPhone() && useUi.getState().touchRequested && (t.fresh || moved)) useUi.setState({ touchRequested: false });
    if (t.fresh || (moved && (primary !== gp.index || useUi.getState().pad === null))) {
      if (useUi.getState().pad === null) firstTouch = true;
      primary = gp.index;
      claim(gp);
    }
  }
  const gp = primary >= 0 ? pads[primary] ?? null : null;
  const b = trackers.get(primary);
  if (!gp || !gp.connected || !b || useUi.getState().pad === null) { if (playLatch) leavePlay(); return; }
  const latch = hooks?.latch() ?? null;
  if (latch) {
    if (menu) { menu = false; nav.release(); }
    if (latch !== playLatch) { leavePlay(); playLatch = latch; }
    padToLatch(latch, gp, b, look, settings, dt);
    if (any(b.pressed, LAYOUT.pause)) hooks?.pause?.();
    if (any(b.pressed, LAYOUT.retry)) hooks?.retry?.(true);
    if (any(b.released, LAYOUT.retry)) hooks?.retry?.(false);
  } else {
    if (playLatch) { hooks?.retry?.(false); leavePlay(); }
    menu = true;
    nav.ensure();
    // The press that switched the prompts over to the pad only shows the focus (it never starts a round by surprise).
    if (!firstTouch) {
      const dir = repeat.next(b.down, dt);
      if (dir) nav.move(dir);
      for (const btn of ["SOUTH", "EAST", "WEST", "NORTH", "START", "L1", "R1"] as PadButton[]) {
        if (any(b.pressed, [btn])) nav.press(btn);
      }
    } else repeat.next(b.down, dt);
  }
  if (any(b.pressed, LAYOUT.mute) && !usePadKeyboard.getState().el) hooks?.mute?.();
}

/** A short dual-rumble on the pad in use (vibration on in Settings; silently nothing where unsupported). */
export function padRumble(strong: number, weak: number, ms: number): void {
  if (!settings.rumble || primary < 0 || useUi.getState().pad === null) return;
  try {
    const gp = getPads()[primary] as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | null;
    const p = gp?.vibrationActuator?.playEffect?.("dual-rumble", { startDelay: 0, duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) });
    if (p && typeof p.catch === "function") void p.catch(() => undefined);
  } catch {
    /* no haptics */
  }
}

/** The game's rumbles (light: webs, zips, landings; firmer: bonks, tags, catches, falls). */
export const rumble = {
  web: () => padRumble(0, 0.3, 45),
  zip: () => padRumble(0.1, 0.35, 70),
  jump: () => padRumble(0, 0.15, 30),
  land: (impact: number) => { if (impact > 7) padRumble(Math.min(0.6, (impact - 7) / 18), Math.min(0.5, impact / 30), 90); },
  bonk: () => padRumble(0.45, 0.3, 120),
  hit: () => padRumble(0.7, 0.5, 200),
  big: () => padRumble(0.9, 0.7, 350),
};

/** Start polling (main.tsx, once). Keyboard / mouse / touch input hands the prompts back. */
export function startPads(): void {
  if (started || typeof window === "undefined" || typeof navigator === "undefined") return;
  started = true;
  installPadCss();
  addEventListener("gamepadconnected", () => { if (!useUi.getState().padSeen) useUi.setState({ padSeen: true }); });
  addEventListener("gamepaddisconnected", e => {
    const i = (e as GamepadEvent).gamepad.index;
    trackers.delete(i);
    if (i === primary) { primary = -1; drop(); }
  });
  const other = (e: Event) => { if (e.isTrusted && !(isPhone() && useUi.getState().padConnected)) drop(); };
  addEventListener("keydown", other, true);
  addEventListener("mousedown", other, true);
  addEventListener("touchstart", other, { capture: true, passive: true });
  addEventListener("wheel", other, { capture: true, passive: true });
  let moved = 0;
  addEventListener("mousemove", e => {
    if (!e.isTrusted || useUi.getState().pad === null) { moved = 0; return; }
    moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (moved > 60) { moved = 0; drop(); }
  }, { passive: true });
  const loop = () => { pollPads(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
