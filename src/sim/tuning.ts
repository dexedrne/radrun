// Every sim constant (spec §5.5) plus the PLAYER / RUNNER / PROTOTYPE presets. Values are literals so
// the sim stays deterministic; public/levels/tuning.json can override PLAYER fields at startup with
// more literals (applyTuningJson). Derived constants are literals too (AIM_COS etc.).

export type Targeting = "cone" | "prototype";

export type Tuning = {
  dt: number;
  gravity: number;
  /** 0 = no cap (PROTOTYPE). */
  speedCap: number;
  runSpeed: number;
  /** PROTOTYPE: ground velocity is set to move * runSpeed every grounded step (no accel/brake/carry). */
  instantGround: boolean;
  groundAccel: number;
  groundBrake: number;
  carryDecay: number;
  airAccel: number;
  jumpSpeed: number;
  coyoteTime: number;
  jumpBuffer: number;
  targeting: Targeting;
  aimRadius: number;
  aimCos: number;
  hookMinAbove: number;
  scoreAhead: number;
  scoreUp: number;
  hysteresis: number;
  ropeScale: number;
  reelSpeed: number;
  ropeSteer: number;
  releaseBoost: number;
  autoRelease: boolean;
  autoReleaseBelow: number;
  bonk: boolean;
  bonkMinSpeed: number;
  bonkRatio: number;
  bonkLock: number;
  halfWidth: number;
  halfHeight: number;
  /** Web must be held this long before the rope fires (0 = two-button, 0.12 = easy grab / prototype). */
  holdDelay: number;
  /** Grounded web press with a ringed hook = jump + grab. */
  zip: boolean;
  yoink: boolean;
  yoinkRange: number;
  failBelowLowestRoof: number;
};

export const DT = 1 / 120;
export const MAX_FRAME_DELTA = 0.25;
export const MAX_STEPS_PER_FRAME = 30;
export const AIM_COS = 0.3420201433256687; // cos(70°)
export const AIM_COS_TOUCH = 0.08715574274765817; // cos(85°), post-v1 touch
export const M_SMOOTH = 1 / 48;
export const HOLD_DELAY_EASY = 0.12;

export const PLAYER: Readonly<Tuning> = Object.freeze({
  dt: DT,
  gravity: 25,
  speedCap: 28,
  runSpeed: 9,
  instantGround: false,
  groundAccel: 60,
  groundBrake: 40,
  carryDecay: 12,
  airAccel: 6,
  jumpSpeed: 9,
  coyoteTime: 0.1,
  jumpBuffer: 0.1,
  targeting: "cone",
  aimRadius: 17,
  aimCos: AIM_COS,
  hookMinAbove: 1.0,
  scoreAhead: 7,
  scoreUp: 9,
  hysteresis: 3,
  ropeScale: 0.75,
  reelSpeed: 6,
  ropeSteer: 5,
  releaseBoost: 3,
  autoRelease: true,
  autoReleaseBelow: 1.0,
  bonk: true,
  bonkMinSpeed: 10,
  bonkRatio: 0.7,
  bonkLock: 0.35,
  halfWidth: 0.35,
  halfHeight: 0.9,
  holdDelay: 0,
  zip: true,
  yoink: true,
  yoinkRange: 5,
  failBelowLowestRoof: 8,
});

/** Runner bake preset: no air control, no rope steer, no Yoink. */
export function runnerFrom(player: Readonly<Tuning>): Tuning {
  return { ...player, airAccel: 0, ropeSteer: 0, yoink: false };
}
export const RUNNER: Readonly<Tuning> = Object.freeze(runnerFrom(PLAYER));

/** Test-only preset that reduces stepBody to the verified 2D prototype (spec §5.6). */
export const PROTOTYPE: Readonly<Tuning> = Object.freeze({
  ...PLAYER,
  speedCap: 0,
  instantGround: true,
  airAccel: 0,
  jumpBuffer: 0,
  targeting: "prototype",
  aimRadius: 14,
  hysteresis: 0,
  ropeSteer: 0,
  autoRelease: false,
  bonk: false,
  holdDelay: HOLD_DELAY_EASY,
  zip: false,
  yoink: false,
});

export type Difficulty = "chill" | "normal";
export const DIFFICULTY = {
  chill: { base: 0.9, gStar: 20, mMin: 0.7, mMax: 1.1, panicBudget: 8, sigma: 0.6, yoinkRange: 6.5, taunt: 1.8 },
  normal: { base: 1.0, gStar: 24, mMin: 0.8, mMax: 1.2, panicBudget: 15, sigma: 0.15, yoinkRange: 5, taunt: 1.4 },
} as const;

export const MEDALS = {
  normal: { rad: 25, gold: 40, silver: 60 },
  chill: { rad: 35, gold: 55, silver: 75 },
} as const;

export const ROUND = {
  seconds: 90,
  tagRadius: 1.5,
  tagDy: 1.8,
  respawnPenalty: 3,
  respawnInset: 1,
} as const;

/** Fields tuning.json may override (numbers and booleans only; presets/targeting are fixed). */
export const TUNABLE_KEYS = [
  "gravity", "speedCap", "runSpeed", "groundAccel", "groundBrake", "carryDecay", "airAccel", "jumpSpeed",
  "coyoteTime", "jumpBuffer", "aimRadius", "aimCos", "hookMinAbove", "scoreAhead", "scoreUp", "hysteresis",
  "ropeScale", "reelSpeed", "ropeSteer", "releaseBoost", "autoRelease", "autoReleaseBelow", "bonk",
  "bonkMinSpeed", "bonkRatio", "bonkLock", "holdDelay", "zip", "yoinkRange", "failBelowLowestRoof",
] as const satisfies readonly (keyof Tuning)[];

export type CameraTuning = {
  fov: number;
  sensitivity: number;
  invertY: boolean;
  armGround: number;
  armAir: number;
  armRope: number;
  armBlend: number;
  shoulder: number;
  ropeBias: number;
  fovBoost: number;
  fovEase: number;
  reducedMotion: boolean;
  easyGrab: boolean;
};

export const CAMERA: Readonly<CameraTuning> = Object.freeze({
  fov: 62,
  sensitivity: 0.0022,
  invertY: false,
  armGround: 6,
  armAir: 7,
  armRope: 8,
  armBlend: 4,
  shoulder: 0.6,
  ropeBias: 0.25,
  fovBoost: 16,
  fovEase: 3,
  reducedMotion: false,
  easyGrab: false,
});

export type TuningJson = { player?: Partial<Record<string, number | boolean>>; camera?: Partial<Record<string, number | boolean>> };

/** Merge tuning.json over the PLAYER preset and camera defaults. Unknown keys are ignored (warned). */
export function applyTuningJson(json: TuningJson | null | undefined, warn: (m: string) => void = () => {}): {
  player: Tuning;
  camera: CameraTuning;
} {
  const player: Tuning = { ...PLAYER };
  const camera: CameraTuning = { ...CAMERA };
  const p = json?.player ?? {};
  for (const [k, v] of Object.entries(p)) {
    if (!(TUNABLE_KEYS as readonly string[]).includes(k)) { warn(`tuning.json: unknown player key ${k}`); continue; }
    if (typeof v !== typeof (PLAYER as Record<string, unknown>)[k]) { warn(`tuning.json: bad type for ${k}`); continue; }
    (player as Record<string, unknown>)[k] = v;
  }
  const c = json?.camera ?? {};
  for (const [k, v] of Object.entries(c)) {
    if (!(k in CAMERA)) { warn(`tuning.json: unknown camera key ${k}`); continue; }
    if (typeof v !== typeof (CAMERA as Record<string, unknown>)[k]) { warn(`tuning.json: bad type for ${k}`); continue; }
    (camera as Record<string, unknown>)[k] = v;
  }
  return { player, camera };
}

/** The JSON written by `?tune` Save and by tools: only the tunable fields. */
export function tuningToJson(player: Tuning, camera: CameraTuning): TuningJson {
  const out: TuningJson = { player: {}, camera: {} };
  for (const k of TUNABLE_KEYS) out.player![k] = player[k] as number | boolean;
  for (const k of Object.keys(CAMERA) as (keyof CameraTuning)[]) out.camera![k] = camera[k];
  return out;
}
