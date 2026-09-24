// George's asset switch. Set GEORGE_GLB to "" to fall back to the procedural placeholder cat
// (GeorgeView draws it). The GLB is written by `npm run assets -- --george <dir>`, together with
// src/generated/george_clips.json (clip speeds, root bone, jump times).
// The render scale and the follow values in GEORGE are live: `?tune` has sliders for them and
// tuning.json's optional "george" section overrides them at boot (applyGeorgeJson).
import GEORGE_CLIPS from "../generated/george_clips.json";
import { GEORGE, GEORGE_DEFAULTS, GEORGE_TUNABLE, setGeorge, type ClipSpeeds, type GeorgeTunable } from "../sidekick/george.ts";

export const GEORGE_GLB: string = "/models/george.glb";

/**
 * Render scale default. The asset's withers sit at 0.31 m; 1.16 puts them at the spec's ~0.36 m next to
 * the 1.7-1.9 m Radbros (george_clips.json's slide-free speed bands are computed at this scale).
 */
export const GEORGE_SCALE_DEFAULT = GEORGE_GLB ? 1.16 : 1;

/** Live render scale (GeorgeView reads it every frame). Change it with setGeorgeScale. */
export const GEORGE_RENDER = { scale: GEORGE_SCALE_DEFAULT };

/** Root bone the Animator pins (george_clips.json `rootBone`). */
export const GEORGE_ROOT_BONE: string = GEORGE_CLIPS.rootBone;

/**
 * Ground speed (m/s at playback rate 1) of each gait at the render scale. One shared object: the
 * George follow model keeps this reference, so setGeorgeScale updates it in place.
 */
export const GEORGE_SPEEDS: ClipSpeeds = { Walk: 1.0, Trot: 2.6, Run: 6.5 };

function refreshSpeeds(): void {
  if (!GEORGE_GLB) return; // placeholder cat: fixed speeds
  const s = GEORGE_RENDER.scale;
  GEORGE_SPEEDS.Walk = GEORGE_CLIPS.groundSpeeds.Walk * s;
  GEORGE_SPEEDS.Trot = GEORGE_CLIPS.groundSpeeds.Trot * s;
  GEORGE_SPEEDS.Run = GEORGE_CLIPS.groundSpeeds.Run * s;
}
refreshSpeeds();

export function setGeorgeScale(s: number): void {
  GEORGE_RENDER.scale = s;
  refreshSpeeds();
}

/** Back to the built-in follow values and render scale. */
export function resetGeorge(): void {
  for (const k of GEORGE_TUNABLE) setGeorge(k, GEORGE_DEFAULTS[k]);
  setGeorgeScale(GEORGE_SCALE_DEFAULT);
}

/** tuning.json "george": { scale, maxTrail, delay, side, idleBelow, walkBelow, trotBelow, rate* }. */
export function applyGeorgeJson(json: Partial<Record<string, number>> | null | undefined, warn: (m: string) => void = () => {}): void {
  for (const [k, v] of Object.entries(json ?? {})) {
    if (typeof v !== "number" || !isFinite(v)) { warn(`tuning.json: bad george.${k}`); continue; }
    if (k === "scale") setGeorgeScale(v);
    else if ((GEORGE_TUNABLE as readonly string[]).includes(k)) setGeorge(k as GeorgeTunable, v);
    else warn(`tuning.json: unknown george key ${k}`);
  }
}

/** The "george" section `?tune` Save writes. */
export function georgeToJson(): Record<string, number> {
  const out: Record<string, number> = { scale: GEORGE_RENDER.scale };
  for (const k of GEORGE_TUNABLE) out[k] = GEORGE[k];
  return out;
}

/** Jump: start at the takeoff frame and leave for Leap_Air before the fore legs reach for the ground. */
export const GEORGE_JUMP = {
  startAt: GEORGE_CLIPS.clips.Jump.chainToLeapAir.startAt,
  leaveAfter: GEORGE_CLIPS.clips.Jump.chainToLeapAir.crossfadeToLeapAirBy - GEORGE_CLIPS.clips.Jump.chainToLeapAir.startAt,
} as const;
