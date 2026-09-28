// The radbro.fun portal bridge. radbro.fun plays hosted games in an iframe; framed there
// (window.parent !== window), the game tells the portal what it is and how each run went:
// - radbro:game-ready on load (and again whenever the portal sends radbro:game-ready-request): the slug,
//   title, objective, a tip, the controls and the native viewport;
// - radbro:game-result for a run: "run" when the chase starts, "clear" on a catch (score: the catch time
//   in seconds, or the stars a campaign level's run earned), "gameover" when he escapes.
// Framed, the first click also focuses the frame (so the keys reach the game) and unlocks the audio.
// Opened on its own (not framed), none of this does anything.
import { RADRUN_PAD_GUIDE } from "../ui/padPrompts.ts";

export type GameInfo = {
  game: string;
  title: string;
  objective: string;
  hint: string;
  controls: string[];
  viewport: { width: number; height: number };
};
export type ResultStatus = "run" | "clear" | "gameover";
export type ReadyMessage = { type: "radbro:game-ready" } & GameInfo;
export type ResultMessage = { type: "radbro:game-result"; game: string; status: ResultStatus; score?: number };

/** The parts of `window` the bridge uses (a fake one in the tests). */
export type BridgeWindow = {
  parent: unknown;
  addEventListener(type: string, fn: (e: never) => void, opts?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, fn: (e: never) => void, opts?: EventListenerOptions | boolean): void;
  focus?(): void;
};
type Target = { postMessage(message: unknown, targetOrigin: string): void };

export const RADRUN: GameInfo = {
  game: "radrun",
  title: "RadRun",
  objective: "He swiped your bag. Web-swing across the rooftops and tag him or YOINK him before the 90 seconds run out.",
  hint: "Let go of the web near the top of the swing for a perfect release · dive (C in the air) and web out of it to swing faster.",
  // One control per entry, no commas inside one (the portal's play guide takes a comma-separated list).
  controls: [
    "Mouse: look / aim",
    "WASD: run",
    "Space: jump (again in the air: double jump)",
    "Hold left button: web swing (let go near the top: perfect release)",
    "Steer into a cross street while swinging: swing round the corner",
    "E / Shift: zip straight where you look (on the red dashed ring: yank him)",
    "C: tap to slide / hold to charge a leap / in the air to dive head first (web out of it: a fast swing)",
    "Space at a wall: wall kick / at the end of a zip: zip pop",
    "Left button on the red ring: YOINK",
    "R: retry",
    "Esc: pause",
    // Round 14: a gamepad (DualSense / Xbox; the menus work on it too).
    ...RADRUN_PAD_GUIDE,
  ],
  viewport: { width: 1280, height: 720 },
};

/** Framed by another page (the portal's iframe). */
export function isFramed(win: BridgeWindow | undefined = typeof window === "undefined" ? undefined : (window as unknown as BridgeWindow)): boolean {
  try {
    return !!win && win.parent != null && win.parent !== win;
  } catch {
    return true; // reading parent threw: some other page holds this one
  }
}

export function readyMessage(info: GameInfo): ReadyMessage {
  return { type: "radbro:game-ready", ...info, controls: [...info.controls], viewport: { ...info.viewport } };
}

/** A result message; a score that is not a finite number is left out, others keep 2 decimals. */
export function resultMessage(game: string, status: ResultStatus, score?: number | null): ResultMessage {
  const m: ResultMessage = { type: "radbro:game-result", game, status };
  if (typeof score === "number" && Number.isFinite(score)) m.score = Math.round(score * 100) / 100;
  return m;
}

export type Bridge = {
  /** True only when framed (every call below is a no-op otherwise). */
  readonly active: boolean;
  ready(): void;
  result(status: ResultStatus, score?: number | null): void;
  dispose(): void;
};

const INERT: Bridge = { active: false, ready() {}, result() {}, dispose() {} };

/**
 * Start the bridge: posts radbro:game-ready right away and answers radbro:game-ready-request from the
 * parent. `onFirstGesture` runs once, on the first pointer press in the frame (unlock the audio there).
 */
export function createBridge(info: GameInfo, win?: BridgeWindow, opts: { onFirstGesture?: () => void } = {}): Bridge {
  const w = win ?? (typeof window === "undefined" ? undefined : (window as unknown as BridgeWindow));
  if (!w || !isFramed(w)) return INERT;
  const parent = w.parent as Target;
  const post = (m: ReadyMessage | ResultMessage) => { try { parent.postMessage(m, "*"); } catch { /* parent gone */ } };
  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: unknown } | null;
    if (e.source === w.parent && d && typeof d === "object" && d.type === "radbro:game-ready-request") post(readyMessage(info));
  };
  const onFirst = () => {
    try { w.focus?.(); } catch { /* fine */ }
    try { opts.onFirstGesture?.(); } catch { /* fine */ }
  };
  w.addEventListener("message", onMessage as (e: never) => void);
  w.addEventListener("pointerdown", onFirst as (e: never) => void, { capture: true, once: true });
  post(readyMessage(info));
  return {
    active: true,
    ready: () => post(readyMessage(info)),
    result: (status, score) => post(resultMessage(info.game, status, score)),
    dispose: () => {
      w.removeEventListener("message", onMessage as (e: never) => void);
      w.removeEventListener("pointerdown", onFirst as (e: never) => void, { capture: true });
    },
  };
}

let current: Bridge = INERT;
/** The page's bridge (main.tsx starts it once). */
export function startBridge(opts: { onFirstGesture?: () => void } = {}): Bridge {
  current.dispose();
  current = createBridge(RADRUN, undefined, opts);
  return current;
}
export const bridge = (): Bridge => current;

/**
 * The portal result for a finished chase: a catch is a "clear" (score: a campaign run's stars, else the
 * catch time in seconds), an escape a "gameover".
 */
export function chaseResult(r: { caught: boolean; time: number; campaign: { got: boolean[] } | null }): { status: ResultStatus; score?: number } {
  if (!r.caught) return { status: "gameover" };
  return { status: "clear", score: r.campaign ? r.campaign.got.filter(Boolean).length : r.time };
}

/** requestPointerLock that never throws or leaves a rejected promise (a frame without the permission). */
export function requestLock(el: Element | null | undefined): void {
  try {
    const p = (el as (Element & { requestPointerLock?: () => unknown }) | null | undefined)?.requestPointerLock?.();
    if (p && typeof (p as Promise<void>).catch === "function") void (p as Promise<void>).catch(() => undefined);
  } catch {
    /* refused: a click on the canvas asks again */
  }
}
