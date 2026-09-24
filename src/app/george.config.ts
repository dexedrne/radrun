// George's asset switch. Set GEORGE_GLB to "" to fall back to the procedural placeholder cat
// (GeorgeView draws it). The GLB is written by `npm run assets -- --george <dir>`, together with
// src/generated/george_clips.json (clip speeds, root bone, jump times).
import GEORGE_CLIPS from "../generated/george_clips.json";
import type { ClipSpeeds } from "../sidekick/george.ts";

export const GEORGE_GLB: string = "/models/george.glb";

/**
 * Render scale. The asset's withers sit at 0.31 m; 1.16 puts them at the spec's ~0.36 m next to the
 * 1.7-1.9 m Radbros (george_clips.json's slide-free speed bands are computed at this scale).
 */
export const GEORGE_SCALE = GEORGE_GLB ? 1.16 : 1;

/** Root bone the Animator pins (george_clips.json `rootBone`). */
export const GEORGE_ROOT_BONE: string = GEORGE_CLIPS.rootBone;

/** Ground speed (m/s at playback rate 1) of each gait at the render scale. */
export const GEORGE_SPEEDS: ClipSpeeds = GEORGE_GLB
  ? {
      Walk: GEORGE_CLIPS.groundSpeeds.Walk * GEORGE_SCALE,
      Trot: GEORGE_CLIPS.groundSpeeds.Trot * GEORGE_SCALE,
      Run: GEORGE_CLIPS.groundSpeeds.Run * GEORGE_SCALE,
    }
  : { Walk: 1.0, Trot: 2.6, Run: 6.5 };

/** Jump: start at the takeoff frame and leave for Leap_Air before the fore legs reach for the ground. */
export const GEORGE_JUMP = {
  startAt: GEORGE_CLIPS.clips.Jump.chainToLeapAir.startAt,
  leaveAfter: GEORGE_CLIPS.clips.Jump.chainToLeapAir.crossfadeToLeapAirBy - GEORGE_CLIPS.clips.Jump.chainToLeapAir.startAt,
} as const;
