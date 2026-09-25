// Every sim constant plus the PLAYER / RUNNER presets. Values are literals so the sim stays deterministic;
// public/levels/tuning.json can override PLAYER fields at startup with more literals (applyTuningJson).
// Derived constants are literals too (AIM_COS etc.): the sim never calls trig, angles are stored as cosines.
// Round 9 (docs/specs/2026-09-25-round9-movement.md §8): building-anchored pendulum swing + parkour keys.

export type Tuning = {
  dt: number;
  gravity: number;
  /** One speed cap (|v|, m/s) for every state; 0 = no cap. Ground speed is still set by runSpeed / carryDecay. */
  speedCap: number;
  runSpeed: number;
  groundAccel: number;
  groundBrake: number;
  carryDecay: number;
  airAccel: number;
  jumpSpeed: number;
  coyoteTime: number;
  jumpBuffer: number;
  /** Aim cone (cosine of the half angle) for anchors and Yoink. */
  aimCos: number;
  /** Round 10: falling with nothing in the aim cone, anchors are searched in this wider cone (cosine; >= aimCos = off). */
  aimCosFall: number;
  /** Ring stickiness: the ringed building's score is this many metres better. */
  hysteresis: number;
  /** Rope steering (m/s^2): only across the swing plane (never along the arc). */
  ropeSteer: number;
  /**
   * Swing heading (round 10, 1/s): on the rope the horizontal velocity turns toward the stick's direction at
   * this rate, speed kept (the sideways part of the swing dies out: a swing goes where you push, it does not
   * drift into the walls). 0 = a free pendulum (round 9).
   */
  swingAlign: number;
  /** Let go: + releaseBoost along the velocity and + releaseUp (while v.y > -4). */
  releaseBoost: number;
  releaseUp: number;
  autoRelease: boolean;
  /** Auto-release (fling) once the body rises above the pivot minus this (m). */
  autoReleaseBelow: number;
  bonk: boolean;
  bonkMinSpeed: number;
  bonkRatio: number;
  bonkLock: number;
  halfWidth: number;
  halfHeight: number;
  /** Web must be held this long before the rope fires (0 = two-button, 0.12 = easy grab). */
  holdDelay: number;
  /** Grounded web press with a ringed anchor = jump + grab. */
  zip: boolean;
  yoink: boolean;
  yoinkRange: number;
  // ---- anchor search (§2.1) ----
  /** Rope length limits (m, body -> anchor). */
  ropeMin: number;
  ropeMax: number;
  /** An anchor sits at least this far above the body centre (m). */
  anchorMinAbove: number;
  /** Ideal anchor point: anchorAhead + anchorAheadPerSpeed x |v_xz| ahead, anchorUp up. */
  anchorAhead: number;
  anchorAheadPerSpeed: number;
  anchorUp: number;
  /** Forward = aim + anchorVelBias x velocity direction (full weight at runSpeed). */
  anchorVelBias: number;
  /** Score bonuses (m): rim / corner anchors, and a penalty for the building let go of in the last second. */
  anchorRimBonus: number;
  anchorAlternate: number;
  // ---- pendulum (§2.2-2.4) ----
  /**
   * Physics pivot pushed off the face into the open air in front of it: swingOutFree x that gap (0.5 = the
   * middle of the street), at least swingOutMin (never past the middle), at most swingOut (m). Round 10: a web
   * to a side building swings you down the middle of the street, not into its wall (round 9: 2.5-5 m off).
   */
  swingOut: number;
  swingOutFree: number;
  swingOutMin: number;
  /** The arc's bottom stays this far above the floor under the pivot (reel to a shorter rope if needed). */
  swingFloorClear: number;
  swingReel: number;
  /** Gravity factor on the rope. */
  swingGravity: number;
  /** Pump (m/s^2) along the swing while below the pivot and descending. */
  swingPump: number;
  /** First taut step: speed kept, at most this factor of the speed after the radial cut. */
  swingKeepSpeed: number;
  /** Auto-release when past this cosine from straight down, rising, on the forward side. */
  swingReleaseCos: number;
  /** A held web re-attaches this long after a release (s). */
  swingRehook: number;
  /** Line-of-sight check to the anchor every this many steps (the web snaps when blocked). */
  losSteps: number;
  // ---- wall run / run-up / wall jump (§3.2-3.3) ----
  wallRun: boolean;
  wallRunReach: number;
  wallRunMinSpeed: number;
  wallRunRatio: number;
  wallRunMinBelowTop: number;
  wallRunFallMax: number;
  wallRunTime: number;
  wallRunSpeed: number;
  wallRunAccel: number;
  wallRunGravity: number;
  wallRunKick: number;
  wallRunCooldown: number;
  wallClimbSpeed: number;
  wallClimbTime: number;
  /** Run-up keeps momentum: it starts at max(wallClimbSpeed, wallClimbKeep x the speed you hit the wall at), easing down under light gravity. */
  wallClimbKeep: number;
  wallJumpOut: number;
  wallJumpUp: number;
  wallJumpKeep: number;
  wallJumpGrace: number;
  // ---- ledge grab + climb (§3.4) ----
  ledgeGrab: boolean;
  ledgeLow: number;
  ledgeHigh: number;
  ledgeMaxVy: number;
  ledgeHang: number;
  ledgeClimbTime: number;
  ledgeExitSpeed: number;
  ledgeJumpUp: number;
  // ---- vault (§3.5) ----
  vault: boolean;
  vaultMax: number;
  vaultLook: number;
  vaultMinSpeed: number;
  vaultClear: number;
  // ---- slide (§3.6; player only) ----
  slide: boolean;
  slideMinSpeed: number;
  slideTime: number;
  slideDecay: number;
  slideSteer: number;
  slideJumpFwd: number;
  slideBuffer: number;
  // ---- landing roll / stumble (§3.7) ----
  rollMinVy: number;
  rollTime: number;
  stumbleVy: number;
  stumbleKeep: number;
  stumbleLock: number;
  /** Falling: feet below this height (m above the street) = a fall (§3.9). */
  failFloor: number;
  /** Double jump: extra jumps while airborne (not on the rope), recharged on landing / rope attach / wall run / ledge; 0 = off. */
  airJumps: number;
  /** Double jump: v.y = max(v.y, doubleJumpSpeed). */
  doubleJumpSpeed: number;
  /** Easy grab: an airborne jump press only double-jumps when nothing is ringed (the same press grabs). */
  airJumpNoRing: boolean;
  /** Web zip (ZIP key): a straight pull to the ringed anchor or a roof ledge under the aim. */
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
  /** Facade zip release (too slow for a wall run): added forward (horizontal) and up, m/s. */
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
 * Touch play (spec §4 "Touch"): the wider aim cone above, Yoink range + yoinkBonus m, anchor picking
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
  speedCap: 32,
  runSpeed: 9,
  groundAccel: 60,
  groundBrake: 40,
  carryDecay: 8,
  airAccel: 6,
  jumpSpeed: 9,
  coyoteTime: 0.1,
  jumpBuffer: 0.1,
  aimCos: AIM_COS,
  aimCosFall: -0.2,
  hysteresis: 4,
  ropeSteer: 4,
  swingAlign: 2.5,
  releaseBoost: 2,
  releaseUp: 3,
  autoRelease: true,
  autoReleaseBelow: 2.5,
  bonk: true,
  bonkMinSpeed: 14,
  bonkRatio: 0.85,
  bonkLock: 0.35,
  halfWidth: 0.35,
  halfHeight: 0.9,
  holdDelay: 0,
  zip: true,
  yoink: true,
  yoinkRange: 5,
  ropeMin: 8,
  ropeMax: 42,
  anchorMinAbove: 5,
  anchorAhead: 10,
  anchorAheadPerSpeed: 0.5,
  anchorUp: 24,
  anchorVelBias: 0.6,
  anchorRimBonus: 2,
  anchorAlternate: 3,
  swingOut: 12,
  swingOutFree: 0.5,
  swingOutMin: 4,
  swingFloorClear: 6,
  swingReel: 10,
  swingGravity: 1.35,
  swingPump: 5,
  swingKeepSpeed: 1.6,
  swingReleaseCos: 0.64,
  swingRehook: 0.18,
  losSteps: 12,
  wallRun: true,
  wallRunReach: 0.6,
  wallRunMinSpeed: 5,
  wallRunRatio: 1,
  wallRunMinBelowTop: 1.5,
  wallRunFallMax: -12,
  wallRunTime: 1.4,
  wallRunSpeed: 11,
  wallRunAccel: 10,
  wallRunGravity: 0.2,
  wallRunKick: 3,
  wallRunCooldown: 0.25,
  wallClimbSpeed: 9,
  wallClimbTime: 0.6,
  wallClimbKeep: 0.55,
  wallJumpOut: 7,
  wallJumpUp: 9.5,
  wallJumpKeep: 0.9,
  wallJumpGrace: 0.15,
  ledgeGrab: true,
  ledgeLow: 0.4,
  ledgeHigh: 2.3,
  ledgeMaxVy: 4,
  ledgeHang: 0.2,
  ledgeClimbTime: 0.35,
  ledgeExitSpeed: 6,
  ledgeJumpUp: 7,
  vault: true,
  vaultMax: 1.5,
  vaultLook: 0.8,
  vaultMinSpeed: 5,
  vaultClear: 0.35,
  slide: true,
  slideMinSpeed: 6,
  slideTime: 0.8,
  slideDecay: 3,
  slideSteer: 6,
  slideJumpFwd: 2.5,
  slideBuffer: 0.25,
  rollMinVy: -15,
  rollTime: 0.45,
  stumbleVy: -24,
  stumbleKeep: 0.4,
  stumbleLock: 0.35,
  failFloor: 2,
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

/** The player-only moves (double jump + web zip + slide); the runner and old ghosts run without them. */
export const MOVES_OFF = { airJumps: 0, webZip: false, slide: false } as const satisfies Partial<Tuning>;
/** Keys that exist only for those moves (left out of the runner bake's tuning hash while they are off). */
export const MOVE_KEYS: readonly (keyof Tuning)[] = [
  "airJumps", "doubleJumpSpeed", "airJumpNoRing", "webZip", "zipSpeed", "zipPull", "zipRange", "zipRise", "zipDrop", "zipCooldown",
  "zipRelease", "zipMaxTime", "zipFlingFwd", "zipFlingUp", "zipLedgeSpeed", "zipLedgeUp",
  "slide", "slideMinSpeed", "slideTime", "slideDecay", "slideSteer", "slideJumpFwd", "slideBuffer",
];
/** Format-2 ghosts (made before round 9): no slide input existed, so slide is off for their replay. */
export const SLIDE_OFF = { slide: false } as const satisfies Partial<Tuning>;

/**
 * Runner bake preset: no air control, no rope steer, no Yoink, no double jump / slide. Web zip stays on: his
 * baked zip-up hops (route/graph.ts) press it with a forced rim anchor, and nothing else ever does.
 */
export function runnerFrom(player: Readonly<Tuning>): Tuning {
  return { ...player, airAccel: 0, ropeSteer: 0, yoink: false, airJumps: 0, slide: false, webZip: true };
}
/** Player-only keys the runner never uses (double jump + slide): left out of the bake's tuning hash. */
export const RUNNER_UNUSED_KEYS: readonly (keyof Tuning)[] = [
  "airJumps", "doubleJumpSpeed", "airJumpNoRing", "slide", "slideMinSpeed", "slideTime", "slideDecay", "slideSteer", "slideJumpFwd", "slideBuffer",
];
export const RUNNER: Readonly<Tuning> = Object.freeze(runnerFrom(PLAYER));

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
  /** Round 9 snapping webs mutator: every web snaps after this long on the rope (s). */
  snapTime: 1.6,
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

/** Fields tuning.json may override (numbers and booleans only; dt / body size are fixed). */
export const TUNABLE_KEYS = [
  "gravity", "speedCap", "runSpeed", "groundAccel", "groundBrake", "carryDecay", "airAccel", "jumpSpeed",
  "coyoteTime", "jumpBuffer", "aimCos", "aimCosFall", "hysteresis", "ropeSteer", "swingAlign", "releaseBoost", "releaseUp", "autoRelease", "autoReleaseBelow", "bonk",
  "bonkMinSpeed", "bonkRatio", "bonkLock", "holdDelay", "zip", "yoinkRange",
  "ropeMin", "ropeMax", "anchorMinAbove", "anchorAhead", "anchorAheadPerSpeed", "anchorUp", "anchorVelBias", "anchorRimBonus", "anchorAlternate",
  "swingOut", "swingOutFree", "swingOutMin", "swingFloorClear", "swingReel", "swingGravity", "swingPump", "swingKeepSpeed", "swingReleaseCos", "swingRehook", "losSteps",
  "wallRun", "wallRunReach", "wallRunMinSpeed", "wallRunRatio", "wallRunMinBelowTop", "wallRunFallMax", "wallRunTime", "wallRunSpeed",
  "wallRunAccel", "wallRunGravity", "wallRunKick", "wallRunCooldown", "wallClimbSpeed", "wallClimbTime", "wallClimbKeep", "wallJumpOut", "wallJumpUp",
  "wallJumpKeep", "wallJumpGrace",
  "ledgeGrab", "ledgeLow", "ledgeHigh", "ledgeMaxVy", "ledgeHang", "ledgeClimbTime", "ledgeExitSpeed", "ledgeJumpUp",
  "vault", "vaultMax", "vaultLook", "vaultMinSpeed", "vaultClear",
  "slide", "slideMinSpeed", "slideTime", "slideDecay", "slideSteer", "slideJumpFwd", "slideBuffer",
  "rollMinVy", "rollTime", "stumbleVy", "stumbleKeep", "stumbleLock", "failFloor",
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
  /** Arm length while wall-running (round 9). */
  armWall: number;
  armBlend: number;
  shoulder: number;
  /** Fraction of the way the look target leans toward the pivot on the rope, capped at ropeBiasMax m. */
  ropeBias: number;
  ropeBiasMax: number;
  fovBoost: number;
  /** FOV boost maps speed fovSpeedLo -> fovSpeedHi (m/s) onto 0 -> fovBoost. */
  fovSpeedLo: number;
  fovSpeedHi: number;
  fovEase: number;
  reducedMotion: boolean;
  easyGrab: boolean;
  /** Round 10: next to a facade (wall run, and nearWallFor s after leaving one) the look point sits this far (m) off it. */
  wallAway: number;
  nearWallFor: number;
};

export const CAMERA: Readonly<CameraTuning> = Object.freeze({
  fov: 62,
  sensitivity: 0.0022,
  invertY: false,
  armGround: 6,
  armAir: 7,
  armRope: 9,
  armWall: 6.5,
  armBlend: 4,
  shoulder: 0.6,
  ropeBias: 0.25,
  ropeBiasMax: 3,
  fovBoost: 16,
  fovSpeedLo: 10,
  fovSpeedHi: 28,
  fovEase: 3,
  reducedMotion: false,
  easyGrab: false,
  wallAway: 1.2,
  nearWallFor: 0.7,
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
