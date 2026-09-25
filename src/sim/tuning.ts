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
  /** Double jump: extra jumps while airborne (not on the rope), recharged on landing / rope attach; 0 = off. */
  airJumps: number;
  /** Double jump: v.y = max(v.y, doubleJumpSpeed). */
  doubleJumpSpeed: number;
  /** Easy grab: an airborne jump press only double-jumps when no balloon is ringed (the same press grabs). */
  airJumpNoRing: boolean;
  /** Web zip (ZIP key): a straight pull to the ringed balloon or a roof ledge under the aim. */
  webZip: boolean;
  /** Pull speed (m/s; the speed cap still applies) and how fast the velocity turns onto the line (1/s). */
  zipSpeed: number;
  zipPull: number;
  /** Ledge search range (horizontal m along the aim) and how far above / below you a ledge may be. */
  zipRange: number;
  zipRise: number;
  zipDrop: number;
  /** Seconds after a zip ends before the next one. */
  zipCooldown: number;
  /** Auto-release this close to the anchor (m), or after zipMaxTime s. */
  zipRelease: number;
  zipMaxTime: number;
  /** Balloon zip release fling: added forward (horizontal) and up, m/s. */
  zipFlingFwd: number;
  zipFlingUp: number;
  /** Ledge zip release: onto the roof at this horizontal speed with this hop (m/s). */
  zipLedgeSpeed: number;
  zipLedgeUp: number;
};

export const DT = 1 / 120;
export const MAX_FRAME_DELTA = 0.25;
export const MAX_STEPS_PER_FRAME = 30;
export const AIM_COS = 0.3420201433256687; // cos(70°)
export const AIM_COS_TOUCH = 0.08715574274765817; // cos(85°), touch
/**
 * Touch play (spec §4 "Touch"): the wider aim cone above, Yoink range + yoinkBonus m, hook picking
 * biased toward your velocity (aim_xz + velBias * v_xz/|v_xz|, full weight at runSpeed; applied to
 * the InputFrame's aim, so the sim is unchanged), and right-half drag look = lookScale x the mouse
 * sensitivity per px.
 */
export const TOUCH = { yoinkBonus: 1, velBias: 0.5, lookScale: 2.5 } as const;
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
  airJumps: 1,
  doubleJumpSpeed: 7.5,
  airJumpNoRing: false,
  webZip: true,
  zipSpeed: 26,
  zipPull: 14,
  zipRange: 24,
  zipRise: 10,
  zipDrop: 14,
  zipCooldown: 1.5,
  zipRelease: 1.4,
  zipMaxTime: 1.6,
  zipFlingFwd: 4,
  zipFlingUp: 6,
  zipLedgeSpeed: 7,
  zipLedgeUp: 4,
});

/** The player-only moves (double jump + web zip); the runner, the prototype and old ghosts run without them. */
export const MOVES_OFF = { airJumps: 0, webZip: false } as const satisfies Partial<Tuning>;
/** Keys that exist only for those moves (left out of the runner bake's tuning hash while they are off). */
export const MOVE_KEYS: readonly (keyof Tuning)[] = [
  "airJumps", "doubleJumpSpeed", "airJumpNoRing", "webZip", "zipSpeed", "zipPull", "zipRange", "zipRise", "zipDrop", "zipCooldown",
  "zipRelease", "zipMaxTime", "zipFlingFwd", "zipFlingUp", "zipLedgeSpeed", "zipLedgeUp",
];

/** Runner bake preset: no air control, no rope steer, no Yoink, no double jump / web zip. */
export function runnerFrom(player: Readonly<Tuning>): Tuning {
  return { ...player, airAccel: 0, ropeSteer: 0, yoink: false, ...MOVES_OFF };
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
  ...MOVES_OFF,
});

export type Difficulty = "chill" | "normal" | "degen";
export const DIFFICULTIES: readonly Difficulty[] = ["chill", "normal", "degen"];
export type DifficultyParams = {
  base: number; gStar: number; mMin: number; mMax: number; panicBudget: number; sigma: number; yoinkRange: number; taunt: number;
  /** Airborne playback-rate clamp (spec 0.9-1.1). */
  airMin: number; airMax: number;
};
export type DifficultyTable = Record<Difficulty, DifficultyParams>;
/** Spec §7 defaults; public/levels/tuning.json "difficulty" overrides them (set from tools/balance). */
export const DIFFICULTY: Readonly<DifficultyTable> = Object.freeze({
  chill: { base: 0.9, gStar: 20, mMin: 0.7, mMax: 1.1, panicBudget: 8, sigma: 0.6, yoinkRange: 6.5, taunt: 1.8, airMin: 0.9, airMax: 1.1 },
  normal: { base: 1.0, gStar: 24, mMin: 0.8, mMax: 1.2, panicBudget: 15, sigma: 0.15, yoinkRange: 5, taunt: 1.4, airMin: 0.9, airMax: 1.1 },
  /** Round 3: faster, smarter, shorter taunts, 4 m Yoink (tuned against the swinging bot, tools/balance). */
  degen: { base: 1.2, gStar: 50, mMin: 0.85, mMax: 2.0, panicBudget: 30, sigma: 0.08, yoinkRange: 4, taunt: 0.9, airMin: 0.9, airMax: 2.0 },
});

export const MEDALS = {
  normal: { rad: 25, gold: 40, silver: 60 },
  chill: { rad: 35, gold: 55, silver: 75 },
  degen: { rad: 30, gold: 45, silver: 65 },
} as const;

/**
 * Round 4 mechanics (docs/specs/2026-09-24-round4-depth.md §2). Mutable so tuning.json "mechanics" can
 * override them at startup (same file for the page, Node tools and ghost replays, so replays match).
 */
export const MECH = {
  /** Share of balloons that are fragile under the pops mutator (integer hash of seed + hook id). */
  popShare: 0.55,
  /** Seconds a popped balloon stays gone. */
  popRespawn: 6,
  /** Wind gust: peak horizontal acceleration (m/s^2), length, ramp and the gap between gusts (s). */
  windMax: 7,
  windGust: 2.4,
  windRamp: 0.4,
  windGapMin: 9,
  windGapMax: 16,
  /** Warning before a gust (HUD arrow), seconds. */
  windWarn: 1,
  /** Low-gravity mutator: player gravity factor. */
  lowGravity: 0.65,
  /** Sixty mutator: round clock in seconds. */
  sixtyClock: 60,
};
export type MechTuning = typeof MECH;

export const ROUND = {
  seconds: 90,
  tagRadius: 1.5,
  tagDy: 1.8,
  respawnPenalty: 3,
  respawnInset: 1,
  /** Round 7 (Vertigo spawn): keep this far (horizontal m) from his first edge's route. */
  spawnClearRoute: 16,
} as const;

/** Fields tuning.json may override (numbers and booleans only; presets/targeting are fixed). */
export const TUNABLE_KEYS = [
  "gravity", "speedCap", "runSpeed", "groundAccel", "groundBrake", "carryDecay", "airAccel", "jumpSpeed",
  "coyoteTime", "jumpBuffer", "aimRadius", "aimCos", "hookMinAbove", "scoreAhead", "scoreUp", "hysteresis",
  "ropeScale", "reelSpeed", "ropeSteer", "releaseBoost", "autoRelease", "autoReleaseBelow", "bonk",
  "bonkMinSpeed", "bonkRatio", "bonkLock", "holdDelay", "zip", "yoinkRange", "failBelowLowestRoof",
  "airJumps", "doubleJumpSpeed", "webZip", "zipSpeed", "zipPull", "zipRange", "zipRise", "zipDrop", "zipCooldown", "zipRelease",
  "zipMaxTime", "zipFlingFwd", "zipFlingUp", "zipLedgeSpeed", "zipLedgeUp",
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

export type TuningJson = {
  player?: Partial<Record<string, number | boolean>>;
  camera?: Partial<Record<string, number | boolean>>;
  difficulty?: Partial<Record<Difficulty, Partial<Record<string, number>>>>;
  /** George's follow values + render scale (visual only; app/george.config.ts applies it). */
  george?: Partial<Record<string, number>>;
  /** Round 4 mechanics (MECH). */
  mechanics?: Partial<Record<string, number>>;
};

/** Merge tuning.json over the PLAYER preset and camera defaults. Unknown keys are ignored (warned). */
export function applyTuningJson(json: TuningJson | null | undefined, warn: (m: string) => void = () => {}): {
  player: Tuning;
  camera: CameraTuning;
  difficulty: DifficultyTable;
} {
  const player: Tuning = { ...PLAYER };
  const camera: CameraTuning = { ...CAMERA };
  const difficulty: DifficultyTable = { chill: { ...DIFFICULTY.chill }, normal: { ...DIFFICULTY.normal }, degen: { ...DIFFICULTY.degen } };
  for (const d of DIFFICULTIES) {
    for (const [k, v] of Object.entries(json?.difficulty?.[d] ?? {})) {
      if (!(k in DIFFICULTY[d]) || typeof v !== "number") { warn(`tuning.json: bad difficulty.${d}.${k}`); continue; }
      (difficulty[d] as Record<string, number>)[k] = v;
    }
  }
  const p = json?.player ?? {};
  for (const [k, v] of Object.entries(p)) {
    if (!(TUNABLE_KEYS as readonly string[]).includes(k)) { warn(`tuning.json: unknown player key ${k}`); continue; }
    if (typeof v !== typeof (PLAYER as Record<string, unknown>)[k]) { warn(`tuning.json: bad type for ${k}`); continue; }
    (player as Record<string, unknown>)[k] = v;
  }
  for (const [k, v] of Object.entries(json?.mechanics ?? {})) {
    if (!(k in MECH) || typeof v !== "number") { warn(`tuning.json: bad mechanics.${k}`); continue; }
    (MECH as Record<string, number>)[k] = v;
  }
  const c = json?.camera ?? {};
  for (const [k, v] of Object.entries(c)) {
    if (!(k in CAMERA)) { warn(`tuning.json: unknown camera key ${k}`); continue; }
    if (typeof v !== typeof (CAMERA as Record<string, unknown>)[k]) { warn(`tuning.json: bad type for ${k}`); continue; }
    (camera as Record<string, unknown>)[k] = v;
  }
  return { player, camera, difficulty };
}

/** The JSON written by `?tune` Save and by tools: only the tunable fields. */
export function tuningToJson(player: Tuning, camera: CameraTuning, difficulty: DifficultyTable = DIFFICULTY): TuningJson {
  const out: TuningJson = { player: {}, camera: {}, difficulty: { chill: { ...difficulty.chill }, normal: { ...difficulty.normal }, degen: { ...difficulty.degen } } };
  for (const k of TUNABLE_KEYS) out.player![k] = player[k] as number | boolean;
  for (const k of Object.keys(CAMERA) as (keyof CameraTuning)[]) out.camera![k] = camera[k];
  out.mechanics = { ...MECH };
  return out;
}
