// stepBody(): the pure 3D kinematic body sim. Round 9 (docs/specs/2026-09-25-round9-movement.md): webs
// stick to buildings (rims, corners, facades) found at run time by findAnchor, a real pendulum does the
// work (speed-keeping taut, pump through the bottom, sideways-only steering, fling past 50 deg), and between
// swings you wall-run, wall-jump, grab ledges, vault, slide and roll. Player and runner share this sim.
// Determinism rule: only + - * /, Math.sqrt, min/max/abs/floor; fixed iteration order; no allocation
// in the hot path.
import { Fnv1a, type Vec3 } from "./math.ts";
import type { Tuning } from "./tuning.ts";
import { RIG0, type CityIndex } from "../world/cityModel.ts";
import { anchorVisible, copyAnchor, emptyAnchor, emptyFace, faceCoord, findAnchor, ledgeAt, obstacleAhead, segmentFace, wallProbe, type AnchorHit, type FaceHit } from "../world/cityQuery.ts";

export const RING_NONE = -1;
export const RING_RUNNER = -2;

/** One latched input sample, consumed by exactly one fixed step. */
export type InputFrame = {
  /** World-space horizontal move vector, |move| <= 1. */
  moveX: number;
  moveZ: number;
  /**
   * Aim = the camera's horizontal forward (aimX, aimZ; the sim normalises it) and, round 12, the camera pitch as a
   * sine in aimY (read only by the straight zip; ghost records carry it quantised).
   */
  aimX: number;
  aimY: number;
  aimZ: number;
  jumpPressed: boolean;
  webHeld: boolean;
  webPressed: boolean;
  /** Web zip press (E / Shift / touch ZIP). */
  zipPressed: boolean;
  /** Round 9: slide press (C / touch SLIDE). */
  slidePressed: boolean;
  /** Round 12: C / SLIDE held (tap = slide, hold = charge, release = launch; in the air a fresh press dives). */
  slideHeld: boolean;
};

export const emptyInput = (): InputFrame => ({
  moveX: 0, moveZ: 0, aimX: 1, aimY: 0, aimZ: 0, jumpPressed: false, webHeld: false, webPressed: false, zipPressed: false, slidePressed: false, slideHeld: false,
});

// Per-step event bits (Body.events is reset at the start of every step).
export const EV_JUMP = 1;
export const EV_ATTACH = 2;
export const EV_RELEASE = 4;
export const EV_LAND = 8;
export const EV_BONK = 16;
export const EV_FALL = 32;
export const EV_WALL = 64;
export const EV_AUTORELEASE = 128;
/** Round 9: the web snapped (blocked line of sight, or the snapping-webs mutator). Released without boost. */
export const EV_SNAP = 256;
/** Moves (player only): a web zip started / ended (release fling or landing), a double jump. */
export const EV_ZIP = 512;
export const EV_ZIP_END = 1024;
export const EV_DJUMP = 2048;
/** Round 9 parkour. */
export const EV_WALLRUN = 4096;
export const EV_WALLJUMP = 8192;
export const EV_LEDGE = 16384;
export const EV_CLIMB = 32768;
export const EV_VAULT = 65536;
export const EV_SLIDE = 131072;
export const EV_ROLL = 262144;
export const EV_BIGLAND = 524288;
/** A web press with nothing ringed (the view plays a soft "no"). Round 12: also a ZIP press with nothing to zip to. */
export const EV_NOANCHOR = 1048576;
/** Round 12 (docs/specs/2026-09-26-round12-spider-tag.md): perfect release, zip pop, charge launch, rebound kick, dive,
 *  yank start / whiff, a flow pip, the charge starting (the whine). */
export const EV_PERFECT = 1 << 21;
export const EV_POP = 1 << 22;
export const EV_CHARGE = 1 << 23;
export const EV_REBOUND = 1 << 24;
export const EV_DIVE = 1 << 25;
export const EV_YANK = 1 << 26;
export const EV_YANK_END = 1 << 27;
export const EV_FLOW = 1 << 28;
export const EV_CHARGE_START = 1 << 29;
/** The web-slinger swing: a corner swing started (a web on a building corner). Its end is an EV_RELEASE. */
export const EV_CORNER = 1 << 30;

/** wallMode values. */
export const WALL_RUN = 1;
export const WALL_UP = 2;
/** ledgeMode values: hang, climb, climb-jump (the climb then a jump off the rim). */
export const LEDGE_HANG_MODE = 1;
export const LEDGE_CLIMB = 2;
export const LEDGE_CLIMBJUMP = 3;

export type Body = {
  /** Body centre (feet = p.y - halfHeight). */
  p: Vec3;
  v: Vec3;
  grounded: boolean;
  roofId: number;
  /** Rope: the anchor's solid id or -1; visual anchor (web line) and physics pivot. */
  ropeSolid: number;
  ropeA: Vec3;
  ropeP: Vec3;
  ropeLen: number;
  ropeTarget: number;
  /** The first taut step after attach has happened (speed-keeping taut). */
  ropeTaut: boolean;
  /** Steps on this rope (line checks, snapping webs). */
  ropeSteps: number;
  /** Past the bottom of this arc, rising away from the pivot (the forward-apex release). */
  ropeUp: boolean;
  heldFor: number;
  coyote: number;
  jumpBuf: number;
  bonkT: number;
  lastSafeRoof: number;
  lastSafe: Vec3;
  /** Solid id, RING_RUNNER or RING_NONE; updated only inside stepBody. ringA / ringP / ringN / ringRim = its anchor. */
  ringId: number;
  ringA: Vec3;
  ringP: Vec3;
  ringNx: number;
  ringNz: number;
  ringRim: boolean;
  chainCount: number;
  step: number;
  t: number;
  events: number;
  /** v.y at the most recent landing (animation / FX). */
  landVy: number;
  /** Double jumps left this airtime. */
  airJumps: number;
  /** Seconds since the last rope release and the solid let go of (left-right rhythm, re-hook delay). */
  relT: number;
  lastRope: number;
  /** Web zip: active, seconds in, cooldown left (s), the anchor solid (-1 = a plain ledge zip), ledge roof or facade solid, target, inward dir. */
  zipOn: boolean;
  zipT: number;
  zipCd: number;
  zipSolid: number;
  zipRoof: number;
  zipWall: number;
  zipP: Vec3;
  zipDx: number;
  zipDz: number;
  /** Wall run (1) / run-up (2): seconds in, the solid, its outward normal and the face span along the tangent. */
  wallMode: number;
  wallT: number;
  wallSolid: number;
  wallNx: number;
  wallNz: number;
  wallLo: number;
  wallHi: number;
  /** The wall last left and seconds since (wall-run cooldown / ledge re-grab). */
  lastWall: number;
  lastWallT: number;
  /** The facade last touched in the air, seconds since, its normal (wall-kick grace) and the solid last kicked off. */
  touchWall: number;
  touchT: number;
  touchNx: number;
  touchNz: number;
  kickSolid: number;
  /** Ledge: mode (1 hang / 2 climb / 3 climb-jump), seconds in, the solid, hang point and the face normal. */
  ledgeMode: number;
  ledgeT: number;
  ledgeSolid: number;
  ledgeX: number;
  ledgeY: number;
  ledgeZ: number;
  ledgeNx: number;
  ledgeNz: number;
  /** Slide time left, roll time left, buffered slide press (s). */
  slideT: number;
  rollT: number;
  slideBuf: number;
  /** Parkour moves done (wall runs, wall jumps, ledge climbs, vaults, slides) - round stats. */
  parkour: number;
  /** Round 11: a web from a roof is reeling you up off it (the rope pulls you in until it is short enough to clear the edge). */
  liftOn: boolean;
  /** Round 11: a run-up topped out short of the rim: the kick off the wall comes as soon as you start falling. */
  upKick: boolean;
  // ---- round 12 ----
  /** Straight zip: target kind (ZIP_*), the aim direction it started along, jump-press buffer for the pop, zips left this airtime. */
  zipKind: number;
  zipAx: number;
  zipAy: number;
  zipAz: number;
  popBuf: number;
  zipLeft: number;
  /** The roof a zip started from (it drags you across it instead of landing you back on it), or -1. */
  zipFrom: number;
  /** Web-yank: he is in yank range (the red dashed ring; updated only inside stepBody), yanking, seconds in, cooldown left. */
  yankOk: boolean;
  yankOn: boolean;
  yankT: number;
  yankCd: number;
  /** Charge: seconds C held in a chargeable state (0 = not charging) and seconds carried into the air. */
  chargeT: number;
  chargeAirT: number;
  /** Dive (C held from a fresh press in the air). */
  diveOn: boolean;
  /** Wall kicks chained without touching the ground or the rope. */
  kicks: number;
  /** Rebound: seconds since the last bonk, the speed into the face and its normal. */
  rebT: number;
  rebVin: number;
  rebNx: number;
  rebNz: number;
  /** Tech moves this round (perfect releases, zip pops, rebounds, 3rd chained kicks, full-charge launches). */
  tech: number;
  /** Flow pips (0-3) and seconds since the last one. */
  flow: number;
  flowT: number;
  // ---- the web-slinger swing ----
  /** Speed allowed over the cap (m/s): a dive's extra speed, wearing off after it (the dive-into-swing). */
  capX: number;
  /** Seconds since the last dive ended (0 while diving) and whether this rope started out of one. */
  diveT: number;
  ropeDive: boolean;
  /** Corner swing: on, the solid, the corner post (x, z) and the web's height on it, the orbit radius, seconds in, the start heading. */
  cornerOn: boolean;
  cornerSolid: number;
  cornerX: number;
  cornerY: number;
  cornerZ: number;
  cornerR: number;
  cornerT: number;
  cornerDx: number;
  cornerDz: number;
};

/** What stepBody needs from the world. */
export type SimWorld = {
  index: CityIndex;
  /** @deprecated unused since round 9 (falls = feet below failFloor). */
  lowestRoof?: number;
  /** Runner body point + the roof he stands on (-1 airborne), or null (sandbox). */
  runner: { p: Vec3; roofId: number } | null;
  /** Bake only: when set, the ring is this anchor (null = nothing) instead of findAnchor. */
  forceAnchor?: AnchorHit | null;
  /** Snapping webs mutator (player only): every web snaps after this many steps on the rope. */
  snapSteps?: number;
  /** Wind mutator: the horizontal acceleration (m/s^2) applied while airborne this step. */
  wind?: { x: number; z: number };
};

export function createBody(x: number, y: number, z: number, roofId: number): Body {
  return {
    p: { x, y, z },
    v: { x: 0, y: 0, z: 0 },
    grounded: roofId >= 0,
    roofId,
    ropeSolid: -1,
    ropeA: { x: 0, y: 0, z: 0 },
    ropeP: { x: 0, y: 0, z: 0 },
    ropeLen: 0,
    ropeTarget: 0,
    ropeTaut: false,
    ropeSteps: 0,
    ropeUp: false,
    heldFor: 0,
    coyote: 0,
    jumpBuf: 0,
    bonkT: 0,
    lastSafeRoof: roofId,
    lastSafe: { x, y, z },
    ringId: RING_NONE,
    ringA: { x: 0, y: 0, z: 0 },
    ringP: { x: 0, y: 0, z: 0 },
    ringNx: 0,
    ringNz: 0,
    ringRim: false,
    chainCount: 0,
    step: 0,
    t: 0,
    events: 0,
    landVy: 0,
    airJumps: 0,
    relT: 1e3,
    lastRope: -1,
    zipOn: false,
    zipT: 0,
    zipCd: 0,
    zipSolid: -1,
    zipRoof: -1,
    zipWall: -1,
    zipP: { x: 0, y: 0, z: 0 },
    zipDx: 0,
    zipDz: 0,
    wallMode: 0,
    wallT: 0,
    wallSolid: -1,
    wallNx: 0,
    wallNz: 0,
    wallLo: 0,
    wallHi: 0,
    lastWall: -1,
    lastWallT: 1e3,
    touchWall: -1,
    touchT: 1e3,
    touchNx: 0,
    touchNz: 0,
    kickSolid: -1,
    ledgeMode: 0,
    ledgeT: 0,
    ledgeSolid: -1,
    ledgeX: 0,
    ledgeY: 0,
    ledgeZ: 0,
    ledgeNx: 0,
    ledgeNz: 0,
    slideT: 0,
    rollT: 0,
    slideBuf: 0,
    parkour: 0,
    liftOn: false,
    upKick: false,
    zipKind: 0,
    zipAx: 0,
    zipAy: 0,
    zipAz: 0,
    popBuf: 0,
    zipLeft: ZIP_FULL,
    zipFrom: -1,
    yankOk: false,
    yankOn: false,
    yankT: 0,
    yankCd: 0,
    chargeT: 0,
    chargeAirT: 0,
    diveOn: false,
    kicks: 0,
    rebT: 1e3,
    rebVin: 0,
    rebNx: 0,
    rebNz: 0,
    tech: 0,
    flow: 0,
    flowT: 0,
    capX: 0,
    diveT: 1e3,
    ropeDive: false,
    cornerOn: false,
    cornerSolid: -1,
    cornerX: 0,
    cornerY: 0,
    cornerZ: 0,
    cornerR: 0,
    cornerT: 0,
    cornerDx: 0,
    cornerDz: 0,
  };
}

/**
 * View helper: the point the body hangs from this step - the rope's anchor on the building, or a corner swing's web on
 * the corner post - into `out`, or null (no web). Never read by the sim.
 */
export function hangPoint(b: Body, out: Vec3): Vec3 | null {
  if (b.ropeSolid >= 0) { out.x = b.ropeA.x; out.y = b.ropeA.y; out.z = b.ropeA.z; return out; }
  if (b.cornerOn) { out.x = b.cornerX; out.y = b.cornerY; out.z = b.cornerZ; return out; }
  return null;
}

/** A new body's zips left: "full" (clamped to the tuning's zipCharges at the first zip). */
export const ZIP_FULL = 99;

const cp = (d: Vec3, s: Vec3) => { d.x = s.x; d.y = s.y; d.z = s.z; };

export function copyBody(dst: Body, src: Body): Body {
  cp(dst.p, src.p); cp(dst.v, src.v);
  dst.grounded = src.grounded;
  dst.roofId = src.roofId;
  dst.ropeSolid = src.ropeSolid;
  cp(dst.ropeA, src.ropeA); cp(dst.ropeP, src.ropeP);
  dst.ropeLen = src.ropeLen;
  dst.ropeTarget = src.ropeTarget;
  dst.ropeTaut = src.ropeTaut;
  dst.ropeSteps = src.ropeSteps;
  dst.ropeUp = src.ropeUp;
  dst.heldFor = src.heldFor;
  dst.coyote = src.coyote;
  dst.jumpBuf = src.jumpBuf;
  dst.bonkT = src.bonkT;
  dst.lastSafeRoof = src.lastSafeRoof;
  cp(dst.lastSafe, src.lastSafe);
  dst.ringId = src.ringId;
  cp(dst.ringA, src.ringA); cp(dst.ringP, src.ringP);
  dst.ringNx = src.ringNx; dst.ringNz = src.ringNz; dst.ringRim = src.ringRim;
  dst.chainCount = src.chainCount;
  dst.step = src.step;
  dst.t = src.t;
  dst.events = src.events;
  dst.landVy = src.landVy;
  dst.airJumps = src.airJumps;
  dst.relT = src.relT;
  dst.lastRope = src.lastRope;
  dst.zipOn = src.zipOn;
  dst.zipT = src.zipT;
  dst.zipCd = src.zipCd;
  dst.zipSolid = src.zipSolid;
  dst.zipRoof = src.zipRoof;
  dst.zipWall = src.zipWall;
  cp(dst.zipP, src.zipP);
  dst.zipDx = src.zipDx;
  dst.zipDz = src.zipDz;
  dst.wallMode = src.wallMode; dst.wallT = src.wallT; dst.wallSolid = src.wallSolid;
  dst.wallNx = src.wallNx; dst.wallNz = src.wallNz; dst.wallLo = src.wallLo; dst.wallHi = src.wallHi;
  dst.lastWall = src.lastWall; dst.lastWallT = src.lastWallT;
  dst.touchWall = src.touchWall; dst.touchT = src.touchT; dst.touchNx = src.touchNx; dst.touchNz = src.touchNz;
  dst.kickSolid = src.kickSolid;
  dst.ledgeMode = src.ledgeMode; dst.ledgeT = src.ledgeT; dst.ledgeSolid = src.ledgeSolid;
  dst.ledgeX = src.ledgeX; dst.ledgeY = src.ledgeY; dst.ledgeZ = src.ledgeZ; dst.ledgeNx = src.ledgeNx; dst.ledgeNz = src.ledgeNz;
  dst.slideT = src.slideT; dst.rollT = src.rollT; dst.slideBuf = src.slideBuf;
  dst.parkour = src.parkour;
  dst.liftOn = src.liftOn;
  dst.upKick = src.upKick;
  dst.zipKind = src.zipKind; dst.zipAx = src.zipAx; dst.zipAy = src.zipAy; dst.zipAz = src.zipAz; dst.popBuf = src.popBuf; dst.zipLeft = src.zipLeft; dst.zipFrom = src.zipFrom;
  dst.yankOk = src.yankOk; dst.yankOn = src.yankOn; dst.yankT = src.yankT; dst.yankCd = src.yankCd;
  dst.chargeT = src.chargeT; dst.chargeAirT = src.chargeAirT; dst.diveOn = src.diveOn; dst.kicks = src.kicks;
  dst.rebT = src.rebT; dst.rebVin = src.rebVin; dst.rebNx = src.rebNx; dst.rebNz = src.rebNz;
  dst.tech = src.tech; dst.flow = src.flow; dst.flowT = src.flowT;
  dst.capX = src.capX; dst.diveT = src.diveT; dst.ropeDive = src.ropeDive;
  dst.cornerOn = src.cornerOn; dst.cornerSolid = src.cornerSolid; dst.cornerX = src.cornerX; dst.cornerY = src.cornerY; dst.cornerZ = src.cornerZ;
  dst.cornerR = src.cornerR; dst.cornerT = src.cornerT; dst.cornerDx = src.cornerDx; dst.cornerDz = src.cornerDz;
  return dst;
}

export const cloneBody = (b: Body): Body => copyBody(createBody(0, 0, 0, -1), b);

/** Clear every move state (rope, zip, wall, ledge, slide, roll, timers) after a respawn. */
export function resetMoves(b: Body): void {
  b.ropeSolid = -1;
  b.ropeTaut = b.ropeUp = false;
  b.heldFor = b.coyote = b.jumpBuf = b.bonkT = 0;
  b.zipOn = false;
  b.zipT = b.zipCd = 0;
  b.chainCount = 0;
  b.wallMode = 0;
  b.ledgeMode = 0;
  b.slideT = b.rollT = b.slideBuf = 0;
  b.relT = b.lastWallT = b.touchT = 1e3;
  b.lastRope = b.lastWall = b.touchWall = b.kickSolid = -1;
  b.liftOn = b.upKick = false;
  b.zipKind = 0; b.popBuf = 0; b.zipLeft = ZIP_FULL;
  b.yankOk = b.yankOn = false; b.yankT = b.yankCd = 0;
  b.chargeT = b.chargeAirT = 0; b.diveOn = false; b.kicks = 0; b.rebT = 1e3;
  b.flow = 0; b.flowT = 0;
  b.capX = 0; b.diveT = 1e3; b.ropeDive = false; b.cornerOn = false; b.cornerSolid = -1; b.cornerT = 0;
}

/** FNV-1a over the full sim state (ringId included), round 9 fields after the older ones. */
export function hashBody(b: Body, h: Fnv1a = new Fnv1a()): Fnv1a {
  h.f64(b.p.x).f64(b.p.y).f64(b.p.z).f64(b.v.x).f64(b.v.y).f64(b.v.z);
  h.i32(b.grounded ? 1 : 0).i32(b.roofId).i32(b.ropeSolid).f64(b.ropeLen).f64(b.ropeTarget);
  h.f64(b.heldFor).f64(b.coyote).f64(b.jumpBuf).f64(b.bonkT);
  h.i32(b.lastSafeRoof).f64(b.lastSafe.x).f64(b.lastSafe.y).f64(b.lastSafe.z);
  h.i32(b.ringId).i32(b.chainCount).i32(b.step);
  h.i32(b.airJumps).i32(b.zipOn ? 1 : 0).f64(b.zipT).f64(b.zipCd).i32(b.zipSolid).i32(b.zipRoof);
  h.f64(b.zipP.x).f64(b.zipP.y).f64(b.zipP.z).f64(b.zipDx).f64(b.zipDz);
  h.f64(b.ropeA.x).f64(b.ropeA.y).f64(b.ropeA.z).f64(b.ropeP.x).f64(b.ropeP.y).f64(b.ropeP.z).i32(b.ropeTaut ? 1 : 0).i32(b.ropeSteps).i32(b.ropeUp ? 1 : 0);
  h.f64(b.relT).i32(b.lastRope).i32(b.zipWall);
  h.i32(b.wallMode).f64(b.wallT).i32(b.wallSolid).f64(b.wallNx).f64(b.wallNz).f64(b.wallLo).f64(b.wallHi).i32(b.lastWall).f64(b.lastWallT);
  h.i32(b.touchWall).f64(b.touchT).f64(b.touchNx).f64(b.touchNz).i32(b.kickSolid);
  h.i32(b.ledgeMode).f64(b.ledgeT).i32(b.ledgeSolid).f64(b.ledgeX).f64(b.ledgeY).f64(b.ledgeZ).f64(b.ledgeNx).f64(b.ledgeNz);
  h.f64(b.slideT).f64(b.rollT).f64(b.slideBuf).i32(b.parkour);
  h.i32(b.liftOn ? 1 : 0).i32(b.upKick ? 1 : 0);
  h.i32(b.zipKind).f64(b.zipAx).f64(b.zipAy).f64(b.zipAz).f64(b.popBuf).i32(b.zipLeft).i32(b.zipFrom);
  h.i32(b.yankOk ? 1 : 0).i32(b.yankOn ? 1 : 0).f64(b.yankT).f64(b.yankCd);
  h.f64(b.chargeT).f64(b.chargeAirT).i32(b.diveOn ? 1 : 0).i32(b.kicks).f64(b.rebT).f64(b.rebVin).f64(b.rebNx).f64(b.rebNz);
  h.i32(b.tech).i32(b.flow).f64(b.flowT);
  h.f64(b.capX).f64(b.diveT).i32(b.ropeDive ? 1 : 0).i32(b.cornerOn ? 1 : 0).i32(b.cornerSolid);
  h.f64(b.cornerX).f64(b.cornerY).f64(b.cornerZ).f64(b.cornerR).f64(b.cornerT).f64(b.cornerDx).f64(b.cornerDz);
  return h;
}

// ---- targeting -----------------------------------------------------------------------------------

/** d (§5.3): chase distance with vertical differences counted at half weight. */
export function chaseDist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = (a.y - b.y) * 0.5, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Seconds after a release during which that building scores anchorAlternate worse. */
export const ALTERNATE_FOR = 1;

/**
 * The ring this step's latched aim gets: the runner (Yoink, red ring) beats every anchor; else the bake's
 * forced anchor; else findAnchor along forward = aim + anchorVelBias x velocity direction. Pure (reads
 * b.ringId for hysteresis); fills `out` with the anchor (out.solid = -1 when there is none).
 */
export function pickRing(b: Body, inp: InputFrame, k: Tuning, w: SimWorld, out: AnchorHit): number {
  out.solid = -1;
  const p = b.p;
  let ax = inp.aimX, az = inp.aimZ;
  const al = Math.sqrt(ax * ax + az * az);
  if (al > 1e-9) { ax /= al; az /= al; } else { ax = 0; az = 0; }
  const r = w.runner;
  if (k.yoink && r) {
    const d = chaseDist(p, r.p);
    if (d <= k.yoinkRange) {
      const dx = r.p.x - p.x, dz = r.p.z - p.z;
      const hl = Math.sqrt(dx * dx + dz * dz);
      if (hl <= 1e-6 || dx * ax + dz * az >= k.aimCos * hl) {
        const skipA = b.grounded ? b.roofId : -1;
        if (!w.index.segmentBlocked(p.x, p.y + 0.3, p.z, r.p.x, r.p.y + 0.3, r.p.z, skipA, r.roofId)) return RING_RUNNER;
      }
    }
  }
  const fa = w.forceAnchor;
  if (fa !== undefined) {
    if (fa === null || fa.solid < 0) return RING_NONE;
    copyAnchor(out, fa);
    return out.solid;
  }
  const vx = b.v.x, vz = b.v.z;
  const vl = Math.sqrt(vx * vx + vz * vz);
  let fx = ax, fz = az;
  if (vl > 1e-6) {
    const wv = (k.anchorVelBias * Math.min(1, vl / k.runSpeed)) / vl;
    fx += vx * wv;
    fz += vz * wv;
  }
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl < 1e-9) return RING_NONE;
  const last = b.relT < ALTERNATE_FOR ? b.lastRope : -1;
  const ring = b.ringId >= 0 ? b.ringId : -1;
  // Web length from your height: high over the ground below, the ideal point goes up and ahead (a longer rope).
  let up = 0, ah = 0;
  if (k.anchorHeightGain > 0 || k.anchorHeightAhead > 0) {
    const h = p.y - k.halfHeight - w.index.groundBelow(p.x, p.z, p.y) - k.anchorHeightFree;
    if (h > 0) { up = Math.min(k.anchorHeightGain * h, Math.max(0, k.anchorUpMax - k.anchorUp)); ah = k.anchorHeightAhead * h; }
  }
  // Round 11: the swing look-ahead runs from your velocity (a web from a roof: the lift's).
  if (findAnchor(w.index, p.x, p.y, p.z, fx / fl, fz / fl, vl, k, ring, last, b.grounded ? b.roofId : -1, out, k.aimCos, b.v, up, ah)) return out.solid;
  // Round 10: falling with nothing in the aim cone (the end of an avenue, a crossing): the wider fall cone.
  if (!b.grounded && b.v.y < 0 && k.aimCosFall < k.aimCos &&
    findAnchor(w.index, p.x, p.y, p.z, fx / fl, fz / fl, vl, k, ring, last, -1, out, k.aimCosFall, b.v, up, ah)) return out.solid;
  return RING_NONE;
}

// ---- web zip target ------------------------------------------------------------------------------

/** Ledge anchors: feet this far above the roof, this far inside its edge; the pre-point just outside. */
export const LEDGE_UP = 1.0;
export const LEDGE_IN = 0.4;
export const LEDGE_OUT = 0.8;
/** Ledge hang: body centre this far under the rim; the climb ends this far (+ half width) inside it. */
export const LEDGE_HANG = 1.0;
export const CLIMB_IN = 0.6;
/** A facade zip ends this close (m) to its point just off the wall. */
const WALL_ZIP_END = 0.45;
/** Vault: feet clear the obstacle's front edge by this much; the probe looks this many seconds ahead. */
const VAULT_EDGE = 0.1;
const VAULT_LOOK_T = 0.3;
/** Side hits with at most this much overlap on the other axis slide past the corner instead of stopping. */
export const CORNER_SLIP = 0.4;
/** Round 11: a wall run turns an inside corner this many seconds (of run speed) before it; the stick stops pressing
 * you into a facade for this long after touching it. */
const CORNER_LOOK = 0.12;
const WALL_HUG = 0.25;

/** Round 12 straight-zip target kinds (§4.4): a roof rim, a facade, a cable, a top face, a floating solid's underside. */
export const ZIP_NONE = 0;
export const ZIP_RIM = 2;
export const ZIP_FACE = 3;
export const ZIP_CABLE = 4;
export const ZIP_TOP = 5;
export const ZIP_UNDER = 6;

/**
 * A straight-zip target: kind, the solid (or RIG0 + rig index), the final point the pull ends at (x, y, z), the hit
 * point (hx, hy, hz; the HUD's diamond), the face's outward normal (nx, nz; 0 for a cable / top / underside), the
 * aim direction the zip goes along (dx, dy, dz, unit) and, for a rim, the roof's top.
 */
export type ZipAim = {
  kind: number; solid: number; x: number; y: number; z: number; hx: number; hy: number; hz: number;
  nx: number; nz: number; dx: number; dy: number; dz: number; top: number;
};
export const emptyZipAim = (): ZipAim => ({ kind: 0, solid: -1, x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, nx: 0, nz: 0, dx: 0, dy: 0, dz: 0, top: 0 });

/** The body's chest (the zip ray's start) sits this far above its centre. */
export const CHEST = 0.3;
/** Cable pieces for the zip's closest-approach test (the sag as a polyline). */
const RIG_PIECES = 2;

/** Fill a zip target on the anchor `a` (the bake's forced rim, or the ringed anchor the aim assist picks). */
function zipOnAnchor(b: Body, a: AnchorHit, k: Tuning, w: SimWorld, out: ZipAim): number {
  out.solid = a.solid; out.hx = a.ax; out.hy = a.ay; out.hz = a.az; out.nx = a.nx; out.nz = a.nz; out.top = 0;
  if (a.solid >= RIG0) {
    out.kind = ZIP_CABLE; out.x = a.ax; out.y = a.ay; out.z = a.az; out.nx = out.nz = 0;
  } else {
    const s = w.index.solids[a.solid];
    if (a.rim && s.landable) return zipRim(b, s.id, a.ax, s.top, a.az, a.nx, a.nz, k, out);
    if (a.nx === 0 && a.nz === 0) { out.kind = ZIP_UNDER; out.x = a.ax; out.y = a.ay - k.halfHeight - 0.2; out.z = a.az; }
    else zipFace(a.ax, a.ay, a.az, a.nx, a.nz, k, out);
  }
  zipDir(b, out);
  return out.kind;
}

/** A rim target: the final point just inside the rim above the roof (the pull first rises just outside it). */
function zipRim(b: Body, solid: number, rx: number, top: number, rz: number, nx: number, nz: number, k: Tuning, out: ZipAim): number {
  out.kind = ZIP_RIM; out.solid = solid; out.top = top; out.nx = nx; out.nz = nz;
  out.hx = rx; out.hy = top; out.hz = rz;
  out.x = rx - nx * LEDGE_IN; out.y = top + k.halfHeight + LEDGE_UP; out.z = rz - nz * LEDGE_IN;
  zipDir(b, out);
  return ZIP_RIM;
}

/** A facade target: the body stops just off the wall at the hit's height. */
function zipFace(hx: number, hy: number, hz: number, nx: number, nz: number, k: Tuning, out: ZipAim): void {
  const off = k.halfWidth + 0.1;
  out.kind = ZIP_FACE; out.nx = nx; out.nz = nz;
  out.x = hx + nx * off; out.y = hy - CHEST; out.z = hz + nz * off;
}

/** The unit direction from the chest to the zip's first point (a rim's: the point just outside it). */
function zipDir(b: Body, out: ZipAim): void {
  let tx = out.x, ty = out.y, tz = out.z;
  if (out.kind === ZIP_RIM) { tx += out.nx * (LEDGE_IN + LEDGE_OUT); tz += out.nz * (LEDGE_IN + LEDGE_OUT); }
  const dx = tx - b.p.x, dy = ty - b.p.y, dz = tz - b.p.z, l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l > 1e-9) { out.dx = dx / l; out.dy = dy / l; out.dz = dz / l; }
}

/**
 * Round 12 straight zip (§4.1-4.2): where a zip from `b` goes this step. The aim = the camera's horizontal forward
 * pitched up by zipLift (a sine; the pitch is inp.aimY, clamped to [zipAimMin, zipAimMax]); the target = the first
 * thing on the ray from the chest within zipReach: a solid's face or top (floating solids included), or a cable
 * passing within zipRigAssist of the ray; with nothing hit, the ringed anchor `a` when it lies within zipAssistCos of
 * the aim. The bake's forced anchor (w.forceAnchor) is the target when set. Pure (the HUD previews it every frame);
 * returns out.kind (ZIP_NONE: no zip - nothing ever attaches to open sky). Trig-free: sines and square roots.
 */
export function zipAim(b: Body, a: AnchorHit | null, aimX: number, aimY: number, aimZ: number, k: Tuning, w: SimWorld, out: ZipAim): number {
  out.kind = ZIP_NONE; out.solid = -1;
  const fa = w.forceAnchor;
  if (fa !== undefined) return fa !== null && fa.solid >= 0 ? zipOnAnchor(b, fa, k, w, out) : ZIP_NONE;
  const p = b.p;
  let ax = aimX, az = aimZ;
  const al = Math.sqrt(ax * ax + az * az);
  if (al < 1e-9) return ZIP_NONE;
  ax /= al; az /= al;
  // Pitch + lift as sines: sin(a + b) = sin a cos b + cos a sin b.
  const s0 = aimY < -1 ? -1 : aimY > 1 ? 1 : aimY, c0 = Math.sqrt(1 - s0 * s0);
  const sl = k.zipLift, cl = Math.sqrt(Math.max(0, 1 - sl * sl));
  let sy = s0 * cl + c0 * sl;
  if (sy < k.zipAimMin) sy = k.zipAimMin; else if (sy > k.zipAimMax) sy = k.zipAimMax;
  const cy = Math.sqrt(Math.max(0, 1 - sy * sy));
  const dx = ax * cy, dy = sy, dz = az * cy;
  const cx0 = p.x, cy0 = p.y + CHEST, cz0 = p.z;
  if (zipRay(b, cx0, cy0, cz0, dx, dy, dz, k, w, out) < Infinity) return zipFinish(b, out);
  if (a !== null && a.solid >= 0) {
    // Aim assist: the ringed anchor, when it lies within zipAssistCos of the aim.
    const vx = a.ax - cx0, vy = a.ay - cy0, vz = a.az - cz0, vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (vl > 1e-6 && vl <= k.zipReach && (vx * dx + vy * dy + vz * dz) >= k.zipAssistCos * vl) return zipOnAnchor(b, a, k, w, out);
  }
  // Round 12 fix, the zip fan: nothing on the ray and nothing ringed near it (falling in a canyon while looking at him,
  // say) - the same ray cast at half and then the full zipFanCos angle off the aim, 8 ways round (up first, then the
  // upper diagonals, the sides, the lower ones, down); the first ring with a hit takes its first hit in that order.
  // Still never open sky. Basis: r = the horizontal right of the aim, u = up across it (both unit, both _|_ d).
  if (k.zipFanCos >= 1 || k.zipFanCos <= 0) return ZIP_NONE;
  const fs = Math.sqrt(Math.max(0, 1 - k.zipFanCos * k.zipFanCos));
  const rx = -az, rz = ax, ux = -ax * dy, uy = cy, uz = -az * dy;
  for (let ring = 0; ring < 2; ring++) {
    // tan of the half angle, then of the full one (trig-free: tan(t / 2) = sin t / (1 + cos t)).
    const tn = ring === 0 ? fs / (1 + k.zipFanCos) : fs / k.zipFanCos, inv = 1 / Math.sqrt(1 + tn * tn);
    for (let i = 0; i < 8; i++) {
      const cu = FAN_U[i], cr = FAN_R[i];
      const ex = (dx + tn * (cu * ux + cr * rx)) * inv, ey = (dy + tn * cu * uy) * inv, ez = (dz + tn * (cu * uz + cr * rz)) * inv;
      if (zipRay(b, cx0, cy0, cz0, ex, ey, ez, k, w, out) < Infinity) return zipFinish(b, out);
    }
  }
  out.kind = ZIP_NONE; out.solid = -1;
  return ZIP_NONE;
}

/** The zip fan's 8 ways round the aim (up / right components): up, the upper diagonals, the sides, the lower ones, down. */
const FAN_U = [1, 0.7071067811865476, 0.7071067811865476, 0, 0, -0.7071067811865476, -0.7071067811865476, -1];
const FAN_R = [0, 0.7071067811865476, -0.7071067811865476, 1, -1, 0.7071067811865476, -0.7071067811865476, 0];

/** A rim target needs no more; a face / cable / top point: straight at it from the body. */
function zipFinish(b: Body, out: ZipAim): number {
  if (out.kind === ZIP_RIM) return ZIP_RIM;
  zipDir(b, out);
  return out.kind;
}

/**
 * One zip ray from the chest (cx0, cy0, cz0) along unit (dx, dy, dz) within zipReach: the first solid face or top on it
 * (floating solids included; the roof stood on is skipped), or the first cable passing within zipRigAssist of it,
 * whichever is nearer. Fills `out` (kind, solid, points, normal; not the direction) and returns the hit's parameter
 * along the ray (0..1), Infinity when nothing is hit.
 */
function zipRay(b: Body, cx0: number, cy0: number, cz0: number, dx: number, dy: number, dz: number, k: Tuning, w: SimWorld, out: ZipAim): number {
  const idx = w.index, R = k.zipReach;
  const ex = cx0 + dx * R, ey = cy0 + dy * R, ez = cz0 + dz * R;
  const skip = b.grounded ? b.roofId : -1;
  let ts = Infinity;
  if (segmentFace(idx, cx0, cy0, cz0, ex, ey, ez, skip, FH)) ts = FH.dist;
  // The first cable within zipRigAssist of the ray (closest approach against the sagging cable's pieces).
  let tr = Infinity, rq = -1, qx = 0, qy = 0, qz = 0;
  const as = k.zipRigAssist;
  const nr = idx.nearbyRigs(Math.min(cx0, ex) - as, Math.min(cz0, ez) - as, Math.max(cx0, ex) + as, Math.max(cz0, ez) + as);
  for (let i = 0; i < nr; i++) {
    const gi = idx.rout[i], g = idx.rigs[gi];
    const gx = g.bx - g.ax, gy = g.by - g.ay, gz = g.bz - g.az, gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (gl < 1e-6) continue;
    const tin = k.rigEndInset / gl;
    for (let j = 0; j < RIG_PIECES; j++) {
      const u0 = j / RIG_PIECES, u1 = (j + 1) / RIG_PIECES;
      const p0x = g.ax + gx * u0, p0y = g.ay + gy * u0 - 4 * g.sag * u0 * (1 - u0), p0z = g.az + gz * u0;
      const p1x = g.ax + gx * u1, p1y = g.ay + gy * u1 - 4 * g.sag * u1 * (1 - u1), p1z = g.az + gz * u1;
      // Closest points between the ray segment (t in [0, 1]) and the piece (u in [0, 1]).
      const e1x = ex - cx0, e1y = ey - cy0, e1z = ez - cz0, e2x = p1x - p0x, e2y = p1y - p0y, e2z = p1z - p0z;
      const rx = cx0 - p0x, ry = cy0 - p0y, rz = cz0 - p0z;
      const A = e1x * e1x + e1y * e1y + e1z * e1z, E = e2x * e2x + e2y * e2y + e2z * e2z, F = e2x * rx + e2y * ry + e2z * rz;
      const Bq = e1x * e2x + e1y * e2y + e1z * e2z, C = e1x * rx + e1y * ry + e1z * rz, den = A * E - Bq * Bq;
      let t = den > 1e-9 ? (Bq * F - C * E) / den : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      let u = (Bq * t + F) / E;
      if (u < 0) { u = 0; t = -C / A; } else if (u > 1) { u = 1; t = (Bq - C) / A; }
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const uu = u0 + (u1 - u0) * u;
      if (uu < tin || uu > 1 - tin) continue;
      const hx = cx0 + e1x * t, hy = cy0 + e1y * t, hz = cz0 + e1z * t;
      const px = p0x + e2x * u, py = p0y + e2y * u, pz = p0z + e2z * u;
      const ddx = hx - px, ddy = hy - py, ddz = hz - pz;
      if (ddx * ddx + ddy * ddy + ddz * ddz > as * as || t >= tr) continue;
      tr = t; rq = gi; qx = px; qy = py; qz = pz;
    }
  }
  if (rq >= 0 && tr < ts) {
    out.kind = ZIP_CABLE; out.solid = RIG0 + rq; out.x = out.hx = qx; out.y = out.hy = qy; out.z = out.hz = qz; out.nx = out.nz = 0; out.top = 0;
    return tr;
  }
  if (ts === Infinity) return Infinity;
  const hx = cx0 + (ex - cx0) * ts, hy = cy0 + (ey - cy0) * ts, hz = cz0 + (ez - cz0) * ts;
  const s = idx.solids[FH.solid];
  out.solid = s.id; out.hx = hx; out.hy = hy; out.hz = hz; out.top = 0;
  if (FH.ny > 0) { out.kind = ZIP_TOP; out.x = hx; out.y = hy + k.halfHeight + 0.05; out.z = hz; out.nx = out.nz = 0; }
  else if (FH.ny < 0) { out.kind = ZIP_UNDER; out.x = hx; out.y = hy - k.halfHeight - 0.2; out.z = hz; out.nx = out.nz = 0; }
  else if (s.landable && s.top - hy <= k.zipRimReach) { zipRim(b, s.id, hx, s.top, hz, FH.nx, FH.nz, k, out); out.hy = hy; }
  else zipFace(hx, hy, hz, FH.nx, FH.nz, k, out);
  return ts;
}

// Module scratch (the hot path never allocates).
const ZA = emptyZipAim();
const AH = emptyAnchor();
const FH = emptyFace();

// ---- helpers -----------------------------------------------------------------------------------

function capSpeed(v: Vec3, cap: number): void {
  if (cap <= 0) return;
  const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (sp > cap) { const f = cap / sp; v.x *= f; v.y *= f; v.z *= f; }
}

function setRing(b: Body, a: AnchorHit): void {
  b.ringA.x = a.ax; b.ringA.y = a.ay; b.ringA.z = a.az;
  b.ringP.x = a.px; b.ringP.y = a.py; b.ringP.z = a.pz;
  b.ringNx = a.nx; b.ringNz = a.nz; b.ringRim = a.rim;
}

/** §2.2: rope on the anchor; the floor clamp picks the target length (reeled in at swingReel). */
function attach(b: Body, a: AnchorHit, k: Tuning, w: SimWorld): void {
  const p = b.p;
  const dx = a.px - p.x, dy = a.py - p.y, dz = a.pz - p.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  b.ropeSolid = a.solid;
  b.ropeA.x = a.ax; b.ropeA.y = a.ay; b.ropeA.z = a.az;
  b.ropeP.x = a.px; b.ropeP.y = a.py; b.ropeP.z = a.pz;
  b.ropeLen = d;
  const floor = w.index.groundBelow(a.px, a.pz, a.py);
  // Floor clamp: reel to keep the arc's bottom swingFloorClear above the floor (never below ropeMin, never
  // longer than the rope is now).
  b.ropeTarget = Math.min(d, Math.max(k.ropeMin, a.py - floor - k.swingFloorClear - k.halfHeight));
  b.ropeTaut = false;
  b.ropeSteps = 0;
  b.ropeUp = false;
  b.liftOn = false;
  // A web out of a dive (or just after one) keeps the dive's speed when it goes taut.
  b.ropeDive = k.diveSwingT > 0 && b.diveT <= k.diveSwingT;
  b.cornerOn = false;
  b.wallMode = 0;
  b.ledgeMode = 0;
  b.slideT = 0;
  b.chainCount++;
  b.airJumps = k.airJumps;
  b.kickSolid = -1;
  b.kicks = 0;
  b.diveOn = false;
  b.zipLeft = k.zipCharges;
  b.events |= EV_ATTACH;
}

/**
 * Round 11 web from a roof (just attached, still over the roof stood on): the rope a pendulum from here needs to
 * clear that roof's edge (webLiftClear above it where the arc crosses the edge, or over the roof if the pivot is
 * above it) becomes the target, and the rope reels you in to it at webLift m/s - a yank up and off the edge into
 * the swing, instead of a hop back onto the roof on a loose web.
 */
function liftStart(b: Body, k: Tuning, w: SimWorld): void {
  if (k.webLift <= 0 || b.ropeSolid < 0) return;
  const s = w.index.solids[b.roofId];
  if (s === undefined) return;
  const p = b.p, P = b.ropeP;
  let dx = P.x - p.x, dz = P.z - p.z;
  const D = Math.sqrt(dx * dx + dz * dz);
  const top = s.top + k.halfHeight + k.webLiftClear;
  let L: number;
  if (P.x > s.x0 && P.x < s.x1 && P.z > s.z0 && P.z < s.z1) L = P.y - top; // the arc's bottom is over the roof
  else if (D > 1e-6) {
    dx /= D; dz /= D;
    // Where the body -> pivot line leaves the roof, and how far that is from under the pivot.
    let t = Infinity;
    if (dx > 1e-9) t = Math.min(t, (s.x1 - p.x) / dx); else if (dx < -1e-9) t = Math.min(t, (s.x0 - p.x) / dx);
    if (dz > 1e-9) t = Math.min(t, (s.z1 - p.z) / dz); else if (dz < -1e-9) t = Math.min(t, (s.z0 - p.z) / dz);
    const De = D - (t > 0 ? t : 0);
    const h = P.y - top;
    L = h > 0 ? Math.sqrt(h * h + De * De) : 0;
  } else L = P.y - top;
  const target = Math.max(k.ropeMin, L);
  if (target < b.ropeTarget) b.ropeTarget = target;
  b.liftOn = b.ropeLen > b.ropeTarget + LIFT_DONE;
}

/** The lift is over this close (m) to its rope length. */
const LIFT_DONE = 0.05;

/** Let go: boost along the velocity + a little up (boost = false: a snap / bonk / wall contact drop). */
function release(b: Body, k: Tuning, boost: boolean, up: number = k.releaseUp): void {
  const v = b.v;
  if (boost) {
    const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
    v.x += (v.x / sp) * k.releaseBoost;
    v.y += (v.y / sp) * k.releaseBoost;
    v.z += (v.z / sp) * k.releaseBoost;
    if (v.y > -4) v.y += up;
  }
  b.lastRope = b.ropeSolid;
  b.relT = 0;
  b.ropeSolid = -1;
  b.liftOn = false;
  b.events |= EV_RELEASE;
}

function startZip(b: Body, a: ZipAim, k: Tuning): void {
  b.zipOn = true;
  b.zipT = 0;
  b.zipKind = a.kind;
  b.zipSolid = a.solid;
  b.zipRoof = a.kind === ZIP_RIM ? a.solid : -1;
  b.zipWall = a.kind === ZIP_FACE ? a.solid : -1;
  b.zipP.x = a.x; b.zipP.y = a.y; b.zipP.z = a.z;
  b.zipDx = -a.nx; b.zipDz = -a.nz;
  b.zipAx = a.dx; b.zipAy = a.dy; b.zipAz = a.dz;
  b.zipLeft = Math.min(b.zipLeft, k.zipCharges) - 1;
  b.popBuf = 0;
  b.zipFrom = b.grounded ? b.roofId : -1;
  if (b.ropeSolid >= 0) release(b, k, false);
  b.cornerOn = false;
  b.wallMode = 0;
  b.ledgeMode = 0;
  b.slideT = 0;
  b.diveOn = false;
  b.grounded = false;
  b.coyote = 0;
  b.jumpBuf = 0;
  b.airJumps = k.airJumps;
  if (a.solid >= 0) b.chainCount++;
  b.events |= EV_ZIP;
}

/** How a zip ends: at its target, early (a second ZIP / web press, zipMaxTime, a wall in the way), or on a landing. */
const ZIP_ARRIVE = 0;
const ZIP_EARLY = 1;
const ZIP_LANDED = 2;

/**
 * End a zip (§4.3-4.4). Arriving: a rim = the ledge pop onto the roof; a facade = a wall run along the aim's side
 * (fast enough), else a run-up (wall above), else a push off; a cable = attach to it with web held (the swing keeps the
 * zip's speed), else a fling along the zip; a zip pop (Jump in the last zipPopWindow s or on arrival) instead at a
 * rim or a facade. Early: zipKeep x the speed. Landed: nothing more.
 */
function endZip(b: Body, k: Tuning, w: SimWorld, how: number, inp: InputFrame): void {
  b.zipOn = false;
  b.zipCd = k.zipCooldown;
  b.events |= EV_ZIP_END;
  const v = b.v;
  if (how === ZIP_LANDED) return;
  if (how === ZIP_EARLY || b.zipKind === ZIP_UNDER) {
    v.x *= k.zipKeep; v.y *= k.zipKeep; v.z *= k.zipKeep;
    return;
  }
  const pop = k.zipPopWindow > 0 && (b.popBuf > 0 || inp.jumpPressed);
  // The aim's horizontal (pop / fling direction), without any part into the face.
  let hx = b.zipAx, hz = b.zipAz;
  const nx = -b.zipDx, nz = -b.zipDz;
  const into = hx * nx + hz * nz;
  if (into < 0 && b.zipKind === ZIP_FACE) { hx -= into * nx; hz -= into * nz; }
  const hl = Math.sqrt(hx * hx + hz * hz);
  if (hl > 1e-6) { hx /= hl; hz /= hl; }
  if (b.zipKind === ZIP_RIM) {
    v.x = b.zipDx * k.zipLedgeSpeed;
    v.z = b.zipDz * k.zipLedgeSpeed;
    v.y = k.zipLedgeUp;
    if (pop) { v.x += hx * k.zipPopFwd; v.z += hz * k.zipPopFwd; v.y = k.zipPopUp; b.tech++; b.events |= EV_POP; flowPip(b, k); }
  } else if (b.zipKind === ZIP_FACE) {
    const s = w.index.solids[b.zipWall], feet = b.p.y - k.halfHeight;
    const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const tx = -nz, tz = nx;
    const along = b.zipAx * tx + b.zipAz * tz;
    const corner = nx !== 0 && nz !== 0;
    if (pop) {
      v.x = hx * k.zipPopFwd; v.z = hz * k.zipPopFwd; v.y = k.zipPopUp;
      b.tech++; b.events |= EV_POP; flowPip(b, k);
    } else if (k.wallRun && !corner && s !== undefined && (along > 0.3 || along < -0.3) && sp >= k.wallRunMinSpeed && s.top - feet >= k.wallRunMinBelowTop) {
      const va0 = v.x * tx + v.z * tz;
      const va = (along < 0 ? -1 : 1) * Math.max(k.wallRunSpeed, va0 < 0 ? -va0 : va0);
      v.x = tx * va; v.z = tz * va; v.y = v.y > 0 ? v.y : 0;
      startWall(b, k, w, b.zipWall, nx, nz, WALL_RUN);
    } else if (k.wallRun && !corner && s !== undefined && s.top - feet >= k.wallRunMinBelowTop) {
      startWall(b, k, w, b.zipWall, nx, nz, WALL_UP, sp);
    } else {
      v.x = nx * k.wallPushOff; v.z = nz * k.wallPushOff; v.y = Math.max(v.y, 0);
    }
  } else if (b.zipKind === ZIP_CABLE) {
    if (inp.webHeld && b.zipSolid >= RIG0) {
      // Zip-to-swing: the rope on the cable point, the zip's speed kept.
      AH.solid = b.zipSolid; AH.ax = AH.px = b.zipP.x; AH.ay = AH.py = b.zipP.y; AH.az = AH.pz = b.zipP.z;
      AH.nx = AH.nz = 0; AH.rim = false; AH.score = 0;
      attach(b, AH, k, w);
    } else {
      const sp = Math.min(k.zipSpeed, k.speedCap > 0 ? k.speedCap : k.zipSpeed) * k.zipKeep;
      v.x = b.zipAx * sp; v.y = b.zipAy * sp + k.zipFlingUp; v.z = b.zipAz * sp;
    }
  }
  capSpeed(v, k.speedCap);
}

// ---- round 12: yank, charge, tech ----------------------------------------------------------------

/**
 * §6.6: he is within yankRange (chase distance), inside the aim cone and in sight, and the yank is ready: a ZIP
 * press now is a homing zip on him.
 */
function yankable(b: Body, inp: InputFrame, k: Tuning, w: SimWorld): boolean {
  const r = w.runner;
  if (k.yankRange <= 0 || r === null || b.yankCd > 0 || b.zipOn || b.yankOn || b.ledgeMode > 0) return false;
  const p = b.p;
  if (chaseDist(p, r.p) > k.yankRange) return false;
  let ax = inp.aimX, az = inp.aimZ;
  const al = Math.sqrt(ax * ax + az * az);
  if (al < 1e-9) return false;
  ax /= al; az /= al;
  const dx = r.p.x - p.x, dz = r.p.z - p.z, hl = Math.sqrt(dx * dx + dz * dz);
  if (hl > 1e-6 && dx * ax + dz * az < k.aimCos * hl) return false;
  return !w.index.segmentBlocked(p.x, p.y + CHEST, p.z, r.p.x, r.p.y + CHEST, r.p.z, b.grounded ? b.roofId : -1, r.roofId);
}

function startYank(b: Body, k: Tuning): void {
  if (b.ropeSolid >= 0) release(b, k, false);
  b.cornerOn = false;
  b.yankOn = true;
  b.yankT = 0;
  b.yankOk = false;
  b.wallMode = 0;
  b.ledgeMode = 0;
  b.slideT = 0;
  b.diveOn = false;
  b.chargeT = 0;
  b.grounded = false;
  b.coyote = 0;
  b.events |= EV_YANK;
}

/** A yank that ran out of time or lost sight of him: ends with its momentum, the cooldown starts. */
function endYank(b: Body, k: Tuning): void {
  b.yankOn = false;
  b.yankCd = k.yankCooldown;
  b.events |= EV_YANK_END;
}

/** Charge level (§5): 0 at chargeMin s of holding, 1 after chargeMin + chargeTime. */
export function chargeLevel(t: number, k: Tuning): number {
  if (t <= 0 || k.chargeTime <= 0) return t > k.chargeMin ? 1 : 0;
  const c = (t - k.chargeMin) / k.chargeTime;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/** A charged launch: zips and the double jump refill; a full charge is a tech move. */
function launched(b: Body, k: Tuning, c: number): void {
  b.chargeT = 0;
  b.chargeAirT = 0;
  b.airJumps = k.airJumps;
  b.zipLeft = k.zipCharges;
  b.events |= EV_CHARGE;
  if (c >= 1) { b.tech++; flowPip(b, k); }
}

/** Charged jump from a roof (or the coyote time after walking off it). */
function groundLaunch(b: Body, k: Tuning, c: number, mx: number, mz: number, aimX: number, aimZ: number): void {
  const v = b.v;
  let hx = mx, hz = mz, hl = Math.sqrt(hx * hx + hz * hz);
  if (hl < 0.1) { hx = aimX; hz = aimZ; hl = Math.sqrt(hx * hx + hz * hz); }
  if (hl > 1e-9) { v.x += (hx / hl) * c * k.chargeFwd; v.z += (hz / hl) * c * k.chargeFwd; }
  v.y = k.jumpSpeed + c * k.chargeUp;
  b.grounded = false;
  b.coyote = 0;
  b.jumpBuf = 0;
  b.slideT = 0;
  b.events |= EV_JUMP;
  launched(b, k, c);
}

/** §6.8 flow: a pip (at most 3), its drain clock reset. */
function flowPip(b: Body, k: Tuning): void {
  if (k.flowCap <= 0) return;
  if (b.flow < 3) b.flow++;
  b.flowT = 0;
  b.events |= EV_FLOW;
}

/**
 * Round 11: on the rope, taut, past the bottom on the forward side (moving away from under the pivot), rising and
 * past swingSweetCos from straight down: a release here is well timed.
 */
function sweetSpot(b: Body, k: Tuning, cos: number = k.swingSweetCos): boolean {
  const p = b.p, P = b.ropeP, v = b.v;
  if (!b.ropeTaut || v.y <= 0) return false;
  const rx = p.x - P.x, ry = p.y - P.y, rz = p.z - P.z;
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz), rh = Math.sqrt(rx * rx + rz * rz), vh = Math.sqrt(v.x * v.x + v.z * v.z);
  return rl > 1e-6 && rh > 1e-6 && vh > 1 && rx * v.x + rz * v.z > 0.5 * rh * vh && -ry / rl <= cos;
}

/**
 * Letting go of the rope yourself (web up, or the C slingshot): round 11's timed lift past swingSweetCos, and round 12's
 * perfect release (§6.1) past swingPerfectCos (the window up to the auto-release) - releasePerfect more along the
 * velocity, EV_PERFECT (the web flashes, a ding).
 */
function ropeRelease(b: Body, k: Tuning): void {
  const sweet = k.releaseSweet > 0 && sweetSpot(b, k);
  const perfect = k.releasePerfect > 0 && sweetSpot(b, k, k.swingPerfectCos);
  release(b, k, true);
  const v = b.v;
  if (sweet) v.y += k.releaseSweet;
  if (perfect) {
    const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
    v.x += (v.x / sp) * k.releasePerfect; v.y += (v.y / sp) * k.releasePerfect; v.z += (v.z / sp) * k.releasePerfect;
    if (k.releasePerfectUp > 0) v.y += k.releasePerfectUp;
    b.tech++;
    b.events |= EV_PERFECT;
    flowPip(b, k);
  }
}

/** §6.3: the head-on hit becomes a kick off the facade (normal nx, nz; vin = the speed into it). */
function rebound(b: Body, k: Tuning, nx: number, nz: number, vin: number): void {
  const v = b.v;
  v.x = nx * vin * k.reboundKeep; v.z = nz * vin * k.reboundKeep; v.y = k.wallJumpUp;
  b.bonkT = 0;
  b.jumpBuf = 0;
  b.rebT = 1e3;
  b.kicks++;
  b.tech++;
  b.parkour++;
  b.events |= EV_REBOUND;
  flowPip(b, k);
}

/** wallAhead's target heading (horizontal unit). */
const AV = { x: 0, z: 0 };

/**
 * Round 11 wall avoidance: the facade the horizontal velocity meets within swingAvoidT s (a wall, not a low ledge),
 * when the meeting is head-on (more speed into it than along it, or too little along it for a wall run). Returns
 * the turn rate (1/s; 0 = nothing to avoid) and puts the heading along the facade in AV: the side the velocity
 * already leans to, else the stick's, else the rope pivot's side.
 */
function wallAhead(b: Body, k: Tuning, w: SimWorld, mx: number, mz: number): number {
  const v = b.v;
  const hs = Math.sqrt(v.x * v.x + v.z * v.z);
  if (k.swingAvoid <= 0 || hs < 3) return 0;
  const ux = v.x / hs, uz = v.z / hs, feet = b.p.y - k.halfHeight;
  if (!obstacleAhead(w.index, b.p.x, feet, b.p.z, ux, uz, hs * k.swingAvoidT, k.halfWidth, FH)) return 0;
  if (FH.top - feet < k.wallRunMinBelowTop) return 0;
  const tx = -FH.nz, tz = FH.nx;
  const vin = -(v.x * FH.nx + v.z * FH.nz), va = v.x * tx + v.z * tz, aa = va < 0 ? -va : va;
  if (vin <= aa && aa >= k.wallRunMinSpeed) return 0;
  let sg = va > 0.5 ? 1 : va < -0.5 ? -1 : 0;
  if (sg === 0) { const st = mx * tx + mz * tz; sg = st > 0.1 ? 1 : st < -0.1 ? -1 : 0; }
  if (sg === 0 && b.ropeSolid >= 0) sg = (b.ropeP.x - b.p.x) * tx + (b.ropeP.z - b.p.z) * tz < 0 ? -1 : 1;
  if (sg === 0) sg = 1;
  AV.x = tx * sg; AV.z = tz * sg;
  return k.swingAvoid;
}

/** Round 12 air carve: the stick turns the flight when within ~100 deg of it (cos 100 deg). */
const CARVE_COS = -0.17364817766693033;

/** Round 11 city edge: the heading bends this much inward (per unit along the edge). */
const EDGE_IN = 0.25;

/**
 * Round 11 city edge: airborne with the horizontal velocity crossing the city's bounds (less edgeMargin) within
 * swingAvoidT s, the flight / swing bends along the edge, a little inward (inward at a corner). Returns the turn
 * rate (1/s; 0 = nothing to avoid) and the heading in AV (the side the velocity leans to, else the stick's, else
 * toward the middle). Player only (the runner's tuning has edgeAvoid 0).
 */
function edgeAhead(b: Body, k: Tuning, w: SimWorld, mx: number, mz: number): number {
  const B = w.index.model.bounds;
  if (k.edgeAvoid <= 0 || B === undefined) return 0;
  const v = b.v, hs = Math.sqrt(v.x * v.x + v.z * v.z);
  if (hs < 3) return 0;
  const m = k.edgeMargin, T = k.swingAvoidT;
  const px = b.p.x, pz = b.p.z, fx = px + v.x * T, fz = pz + v.z * T;
  // Heading out past an edge soon (or already out past it and not heading back in).
  const ox = (v.x > 0 && fx > B.x1 - m) || (px > B.x1 && v.x > -1) ? 1 : (v.x < 0 && fx < B.x0 + m) || (px < B.x0 && v.x < 1) ? -1 : 0;
  const oz = (v.z > 0 && fz > B.z1 - m) || (pz > B.z1 && v.z > -1) ? 1 : (v.z < 0 && fz < B.z0 + m) || (pz < B.z0 && v.z < 1) ? -1 : 0;
  if (ox === 0 && oz === 0) return 0;
  let hx: number, hz: number;
  if (ox !== 0 && oz !== 0) { hx = -ox; hz = -oz; }
  else if (ox !== 0) {
    // Along the edge: the way the velocity (else the stick) leans, unless that runs into the corner.
    let sg = v.z > 0.5 ? 1 : v.z < -0.5 ? -1 : mz > 0.1 ? 1 : mz < -0.1 ? -1 : 0;
    if (sg === 0 || (sg > 0 && pz > B.z1 - m) || (sg < 0 && pz < B.z0 + m)) sg = pz < (B.z0 + B.z1) / 2 ? 1 : -1;
    hx = -ox * EDGE_IN; hz = sg;
  } else {
    let sg = v.x > 0.5 ? 1 : v.x < -0.5 ? -1 : mx > 0.1 ? 1 : mx < -0.1 ? -1 : 0;
    if (sg === 0 || (sg > 0 && px > B.x1 - m) || (sg < 0 && px < B.x0 + m)) sg = px < (B.x0 + B.x1) / 2 ? 1 : -1;
    hx = sg; hz = -oz * EDGE_IN;
  }
  const hl = Math.sqrt(hx * hx + hz * hz);
  AV.x = hx / hl; AV.z = hz / hl;
  return k.edgeAvoid;
}

/** Round 11: in the air off the rope - a facade just after a fling (swingAvoidAir s), else the city edge. */
function airAvoid(b: Body, k: Tuning, w: SimWorld, mx: number, mz: number): number {
  const a = b.relT < k.swingAvoidAir ? wallAhead(b, k, w, mx, mz) : 0;
  return a > 0 ? a : edgeAhead(b, k, w, mx, mz);
}

/** Turn the horizontal velocity toward the unit heading (hx, hz) by about `a` rad, speed kept. */
function turnToward(v: Vec3, hx: number, hz: number, a: number): void {
  const hs = Math.sqrt(v.x * v.x + v.z * v.z);
  if (hs < 1e-6) return;
  let ux = v.x / hs + hx * a, uz = v.z / hs + hz * a;
  const ul = Math.sqrt(ux * ux + uz * uz);
  if (ul < 1e-9) return;
  ux /= ul; uz /= ul;
  v.x = ux * hs; v.z = uz * hs;
}

function groundMove(b: Body, mx: number, mz: number, k: Tuning, dt: number, cap = k.runSpeed): void {
  const v = b.v;
  const s = Math.sqrt(v.x * v.x + v.z * v.z);
  const ml = Math.sqrt(mx * mx + mz * mz);
  // Momentum carry: speed above runSpeed is kept and decays at carryDecay (not at all while rolling). Round 12:
  // charging crouch-walks (cap = chargeWalk, no carry).
  const top = cap < k.runSpeed ? cap : s > k.runSpeed ? (b.rollT > 0 ? s : Math.max(k.runSpeed, s - k.carryDecay * dt)) : k.runSpeed;
  const tx = mx * top, tz = mz * top;
  const rate = ml > 0.01 ? k.groundAccel : k.groundBrake;
  const dx = tx - v.x, dz = tz - v.z;
  const dl = Math.sqrt(dx * dx + dz * dz);
  const maxd = rate * dt;
  if (dl <= maxd) { v.x = tx; v.z = tz; } else { v.x += (dx / dl) * maxd; v.z += (dz / dl) * maxd; }
}

/** Slide: speed decays at slideDecay, only the sideways part of the stick steers. */
function slideMove(b: Body, mx: number, mz: number, k: Tuning, dt: number, decay = k.slideDecay): void {
  const v = b.v;
  const s = Math.sqrt(v.x * v.x + v.z * v.z);
  if (s < 1e-6) return;
  const dx = v.x / s, dz = v.z / s;
  const s1 = Math.max(0, s - decay * dt);
  const along = mx * dx + mz * dz;
  const a = k.slideSteer * dt;
  let nx = dx * s1 + (mx - along * dx) * a, nz = dz * s1 + (mz - along * dz) * a;
  const nl = Math.sqrt(nx * nx + nz * nz);
  if (nl > 1e-9) { nx *= s1 / nl; nz *= s1 / nl; }
  v.x = nx; v.z = nz;
}

function startSlide(b: Body, k: Tuning): void {
  b.slideT = k.slideTime;
  b.slideBuf = 0;
  b.parkour++;
  b.events |= EV_SLIDE;
}

/**
 * Flush against the face of `solid` with outward normal (nx, nz); mode 1 = wall run, 2 = run-up (hitSpeed = the
 * horizontal speed it hit the wall at: round 10's run-up keeps momentum, a swing into a facade runs up it fast).
 */
function startWall(b: Body, k: Tuning, w: SimWorld, solid: number, nx: number, nz: number, mode: number, hitSpeed = 0): void {
  const s = w.index.solids[solid], p = b.p, v = b.v;
  const hit = mode === WALL_UP ? k.wallClimbKeep * hitSpeed : 0;
  const f = faceCoord(s, nx, nz);
  if (nx !== 0) p.x = f + nx * k.halfWidth; else p.z = f + nz * k.halfWidth;
  const vn = v.x * nx + v.z * nz;
  if (vn < 0) { v.x -= vn * nx; v.z -= vn * nz; }
  if (b.ropeSolid >= 0) release(b, k, false);
  b.wallMode = mode;
  b.wallT = 0;
  b.wallSolid = solid;
  b.wallNx = nx;
  b.wallNz = nz;
  if (nx !== 0) { b.wallLo = s.z0; b.wallHi = s.z1; } else { b.wallLo = s.x0; b.wallHi = s.x1; }
  b.touchWall = solid; b.touchT = 0; b.touchNx = nx; b.touchNz = nz;
  b.airJumps = k.airJumps;
  b.zipLeft = k.zipCharges;
  b.diveOn = false;
  b.slideT = 0;
  if (mode === WALL_UP) { v.x = 0; v.z = 0; v.y = Math.max(k.wallClimbSpeed, hit, v.y); } else if (v.y < k.wallRunKick) v.y = k.wallRunKick;
  b.parkour++;
  b.events |= EV_WALLRUN;
}

function endWall(b: Body, push: number): void {
  if (push > 0) { b.v.x += b.wallNx * push; b.v.z += b.wallNz * push; }
  b.lastWall = b.wallSolid;
  b.lastWallT = 0;
  b.touchWall = b.wallSolid; b.touchT = 0; b.touchNx = b.wallNx; b.touchNz = b.wallNz;
  b.wallMode = 0;
}

/** §3.3: kick off the facade (normal nx, nz): out + up, keeping most of the along-face speed. */
function wallJump(b: Body, k: Tuning, solid: number, nx: number, nz: number): void {
  const v = b.v;
  const tx = -nz, tz = nx;
  const va = (v.x * tx + v.z * tz) * k.wallJumpKeep;
  v.x = nx * k.wallJumpOut + tx * va;
  v.z = nz * k.wallJumpOut + tz * va;
  // Round 12 kick chains (§6.4): each kick without touching the ground or the rope kicks higher (at most 3 times).
  v.y = k.wallJumpUp + Math.min(b.kicks, 3) * k.kickChainUp;
  if (k.kickChainUp > 0 && b.kicks === 2) { b.tech++; flowPip(b, k); }
  b.kicks++;
  if (b.wallMode > 0) endWall(b, 0);
  b.kickSolid = solid;
  b.touchT = 1e3;
  b.jumpBuf = 0;
  b.parkour++;
  b.events |= EV_WALLJUMP;
}

/** Wall-run start rule (§3.2) for a face of `solid` (normal nx, nz, top) with horizontal velocity (vx, vz). */
function wallRunOk(b: Body, k: Tuning, solid: number, nx: number, nz: number, top: number, vx: number, vz: number, feet: number, ratio: number): boolean {
  if (!k.wallRun || (nx !== 0 && nz !== 0)) return false;
  if (top - feet < k.wallRunMinBelowTop || b.v.y <= k.wallRunFallMax) return false;
  if (solid === b.lastWall && b.lastWallT < k.wallRunCooldown) return false;
  const va0 = vx * -nz + vz * nx, va = va0 < 0 ? -va0 : va0;
  const vi0 = -(vx * nx + vz * nz), vi = vi0 > 0 ? vi0 : 0;
  return va >= k.wallRunMinSpeed && va >= ratio * vi;
}

/** §3.4 grab: flush under the rim, velocity 0. */
function grabLedge(b: Body, k: Tuning, w: SimWorld, f: FaceHit): void {
  const s = w.index.solids[f.solid], p = b.p;
  const c = faceCoord(s, f.nx, f.nz);
  if (f.nx !== 0) p.x = c + f.nx * k.halfWidth; else p.z = c + f.nz * k.halfWidth;
  p.y = s.top - LEDGE_HANG;
  b.v.x = b.v.y = b.v.z = 0;
  b.wallMode = 0;
  b.slideT = 0;
  b.ledgeMode = LEDGE_HANG_MODE;
  b.ledgeT = 0;
  b.ledgeSolid = f.solid;
  b.ledgeX = p.x; b.ledgeY = p.y; b.ledgeZ = p.z;
  b.ledgeNx = f.nx; b.ledgeNz = f.nz;
  b.airJumps = k.airJumps;
  b.zipLeft = k.zipCharges;
  b.diveOn = false;
  b.events |= EV_LEDGE;
}

/** Try a ledge grab in front of the body: faces the velocity or the stick points into (dot > 0.3). */
function tryLedge(b: Body, k: Tuning, w: SimWorld, mx: number, mz: number, force: boolean): boolean {
  if (!k.ledgeGrab || (!force && b.v.y > k.ledgeMaxVy)) return false;
  const p = b.p, v = b.v;
  const hs = Math.sqrt(v.x * v.x + v.z * v.z);
  const vx = hs > 1e-6 ? v.x / hs : 0, vz = hs > 1e-6 ? v.z / hs : 0;
  const feet = p.y - k.halfHeight;
  for (let i = 0; i < 4; i++) {
    const nx = i === 0 ? -1 : i === 1 ? 1 : 0, nz = i === 2 ? -1 : i === 3 ? 1 : 0;
    if (!(-(vx * nx + vz * nz) > 0.3 || -(mx * nx + mz * nz) > 0.3 || (force && nx === b.wallNx && nz === b.wallNz))) continue;
    if (!ledgeAt(w.index, p.x, feet, p.z, k.halfWidth, nx, nz, k.ledgeLow, k.ledgeHigh, FH)) continue;
    if (FH.solid === b.lastWall && b.lastWallT < k.wallRunCooldown && b.wallMode === 0) continue;
    grabLedge(b, k, w, FH);
    return true;
  }
  return false;
}

/** Hang / climb / climb-jump: a scripted path (up to the rim, then CLIMB_IN inward), no physics. */
function ledgeStep(b: Body, k: Tuning, w: SimWorld, charging: boolean): void {
  const s = w.index.solids[b.ledgeSolid], p = b.p, v = b.v, dt = k.dt, hh = k.halfHeight;
  b.ledgeT += dt;
  if (b.ledgeMode === LEDGE_HANG_MODE) {
    v.x = v.y = v.z = 0;
    // Round 12: the climb waits while C charges (up to chargeHangMax s).
    if (b.ledgeT >= k.ledgeHang && !(charging && b.ledgeT < k.chargeHangMax)) { b.ledgeMode = LEDGE_CLIMB; b.ledgeT = 0; }
    return;
  }
  const up = Math.max(0, s.top + hh + 0.01 - b.ledgeY);
  const inn = b.ledgeMode === LEDGE_CLIMBJUMP ? 0 : k.halfWidth + CLIMB_IN;
  const T = b.ledgeMode === LEDGE_CLIMBJUMP ? k.ledgeClimbTime * 0.5 : k.ledgeClimbTime;
  const f = T > 1e-6 ? Math.min(1, b.ledgeT / T) : 1;
  const d = f * (up + inn);
  let x = b.ledgeX, y = b.ledgeY, z = b.ledgeZ;
  if (d <= up) y += d; else { y += up; x -= b.ledgeNx * (d - up); z -= b.ledgeNz * (d - up); }
  v.x = (x - p.x) / dt; v.y = (y - p.y) / dt; v.z = (z - p.z) / dt;
  p.x = x; p.y = y; p.z = z;
  if (f < 1) return;
  const nx = b.ledgeNx, nz = b.ledgeNz;
  if (b.ledgeMode === LEDGE_CLIMBJUMP) {
    // Off the rim: inward + up (airborne).
    v.x = -nx * k.ledgeExitSpeed; v.z = -nz * k.ledgeExitSpeed; v.y = k.ledgeJumpUp;
    b.events |= EV_JUMP;
  } else {
    p.y = s.top + hh;
    v.x = -nx * k.ledgeExitSpeed; v.z = -nz * k.ledgeExitSpeed; v.y = 0;
    b.grounded = true;
    b.roofId = s.id;
  }
  b.ledgeMode = 0;
  b.parkour++;
  b.events |= EV_CLIMB;
}

// ---- the web-slinger swing: corners -------------------------------------------------------------

/** A corner orbit never gets tighter than this (m); a corner swing may start this far (m) past being abreast of it. */
const CORNER_MIN_R = 2.5;
const CORNER_LATE = 2.5;
const CORNER_EARLY = 1;
/** The web goes this far (m) up the corner post above you (at most its top). */
const CORNER_UP = 4;
/** A corner let go of is not taken again for this long (s). */
const CORNER_AGAIN = 0.5;
/** A corner swing starts only this far (m) over the ground below, and holds you up: v.y eases to 0 at this rate (1/s). */
const CORNER_CLEAR = 5;
const CORNER_HOLD = 4;

/**
 * The corner a corner swing would take this step (fills b.corner* without starting it), or false: flying (or on the
 * rope) at cornerMinSpeed+ with the stick turned at least cornerStick (sine) off the way you are going, a grounded
 * building's vertical corner on that side, abreast of you (up to CORNER_EARLY m ahead, CORNER_LATE m behind) and
 * within cornerReach m, with the building behind the corner on that side (so the orbit runs round its outside, into
 * the street past it), standing over you and in clear sight. The nearest wins. Allocation-free.
 */
function cornerFind(b: Body, k: Tuning, w: SimWorld, mx: number, mz: number): boolean {
  const v = b.v, p = b.p;
  const hs = Math.sqrt(v.x * v.x + v.z * v.z), ml = Math.sqrt(mx * mx + mz * mz);
  if (hs < k.cornerMinSpeed || ml < 0.5) return false;
  const fx = v.x / hs, fz = v.z / hs, ux = mx / ml, uz = mz / ml;
  const side = fx * uz - fz * ux, along = fx * ux + fz * uz;
  if ((side < 0 ? -side : side) < k.cornerStick || along < -0.5) return false;
  if (p.y - k.halfHeight - w.index.groundBelow(p.x, p.z, p.y) < CORNER_CLEAR) return false;
  // n: across the way you go, toward the stick.
  const nx = side > 0 ? -fz : fz, nz = side > 0 ? fx : -fx;
  const idx = w.index, R = k.cornerReach, hw = k.halfWidth;
  const n = idx.nearbySolids(p.x - R, p.z - R, p.x + R, p.z + R);
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const s = idx.solids[idx.out[i]];
    if ((s.y0 ?? 0) > 0 || s.top < p.y + 1.5) continue;
    if (s.id === b.lastRope && b.relT < CORNER_AGAIN) continue;
    if (p.x > s.x0 - hw && p.x < s.x1 + hw && p.z > s.z0 - hw && p.z < s.z1 + hw) continue;
    for (let c = 0; c < 4; c++) {
      const cx = c & 1 ? s.x1 : s.x0, cz = c & 2 ? s.z1 : s.z0;
      const bx = c & 1 ? -1 : 1, bz = c & 2 ? -1 : 1;
      // The building lies on the stick's side of the corner and behind it.
      if (bx * nx + bz * nz <= 0.2 || bx * fx + bz * fz >= -0.2) continue;
      const dx = cx - p.x, dz = cz - p.z;
      const al = dx * fx + dz * fz, lat = dx * nx + dz * nz;
      if (al > CORNER_EARLY || al < -CORNER_LATE || lat < CORNER_MIN_R || lat > R) continue;
      const sc = lat + (al < 0 ? -al : al);
      if (sc >= best) continue;
      const cy = Math.min(s.top, p.y + CORNER_UP);
      if (idx.segmentBlocked(p.x, p.y, p.z, cx - bx * 0.1, cy, cz - bz * 0.1, s.id, -1)) continue;
      best = sc;
      b.cornerSolid = s.id; b.cornerX = cx; b.cornerY = cy; b.cornerZ = cz;
      b.cornerR = Math.max(CORNER_MIN_R, Math.sqrt(dx * dx + dz * dz));
    }
  }
  return best < Infinity;
}

/** Start the corner swing cornerFind picked: off the rope (no fling), a web on the corner post. */
function cornerStart(b: Body, k: Tuning): void {
  if (b.ropeSolid >= 0) { b.lastRope = b.ropeSolid; b.relT = 0; b.ropeSolid = -1; b.liftOn = false; }
  const hs = Math.sqrt(b.v.x * b.v.x + b.v.z * b.v.z) || 1;
  b.cornerOn = true;
  b.cornerT = 0;
  b.cornerDx = b.v.x / hs; b.cornerDz = b.v.z / hs;
  b.chainCount++;
  b.airJumps = k.airJumps;
  b.zipLeft = k.zipCharges;
  b.kickSolid = -1;
  b.kicks = 0;
  b.events |= EV_CORNER | EV_ATTACH;
}

/** End a corner swing (boost: + cornerBoost m/s along the way you now go); the web lets go. */
function cornerEnd(b: Body, k: Tuning, boost: boolean): void {
  b.cornerOn = false;
  const v = b.v, hs = Math.sqrt(v.x * v.x + v.z * v.z);
  if (boost && k.cornerBoost > 0 && hs > 1e-6) { v.x += (v.x / hs) * k.cornerBoost; v.z += (v.z / hs) * k.cornerBoost; }
  b.lastRope = b.cornerSolid;
  b.relT = 0;
  b.events |= EV_RELEASE;
}

// ---- the step ------------------------------------------------------------------------------------

export function stepBody(b: Body, inp: InputFrame, k: Tuning, w: SimWorld): void {
  const dt = k.dt;
  const p = b.p, v = b.v, idx = w.index;
  const hw = k.halfWidth, hh = k.halfHeight;
  b.events = 0;
  b.step++;
  b.t += dt;
  const held = inp.webHeld;
  b.heldFor = held ? b.heldFor + dt : 0;
  b.coyote = Math.max(0, b.coyote - dt);
  b.jumpBuf = inp.jumpPressed ? k.jumpBuffer : Math.max(0, b.jumpBuf - dt);
  let locked = b.bonkT > 0;
  b.bonkT = Math.max(0, b.bonkT - dt);
  if (!b.zipOn) b.zipCd = Math.max(0, b.zipCd - dt);
  if (!b.yankOn) b.yankCd = Math.max(0, b.yankCd - dt);
  b.relT += dt;
  b.lastWallT += dt;
  b.touchT += dt;
  b.rebT += dt;
  b.rollT = Math.max(0, b.rollT - dt);
  b.slideBuf = Math.max(0, b.slideBuf - dt);
  b.popBuf = Math.max(0, b.popBuf - dt);
  b.diveT = b.diveOn ? 0 : b.diveT + dt;
  if (b.zipOn && inp.jumpPressed) b.popBuf = k.zipPopWindow;
  if (k.slide && inp.slidePressed && !locked) b.slideBuf = k.slideBuffer;
  // §6.8 flow: one pip drains every flowDecay s without a new one.
  if (b.flow > 0) { b.flowT += dt; if (b.flowT >= k.flowDecay) { b.flow--; b.flowT = 0; } }

  let mx = locked ? 0 : inp.moveX, mz = locked ? 0 : inp.moveZ;
  const ml = Math.sqrt(mx * mx + mz * mz);
  if (ml > 1) { mx /= ml; mz /= ml; }

  const px = p.x, pz = p.z, feetBefore = p.y - hh;

  // §6.3 rebound kick: a Jump press within reboundWindow after a head-on bonk kicks you off the facade instead.
  if (locked && inp.jumpPressed && k.reboundWindow > 0 && b.rebT <= k.reboundWindow && !b.grounded) {
    rebound(b, k, b.rebNx, b.rebNz, b.rebVin);
    locked = false;
    mx = inp.moveX; mz = inp.moveZ;
  }

  // A second ZIP press or a web press ends a zip early (zipKeep x the speed; a web press can grab right away).
  // The same presses end a yank early (its momentum kept).
  let zipUsed = false;
  if (b.zipOn && (inp.zipPressed || inp.webPressed)) { endZip(b, k, w, ZIP_EARLY, inp); zipUsed = inp.zipPressed; }
  if (b.yankOn && (inp.zipPressed || inp.webPressed)) { endYank(b, k); zipUsed = zipUsed || inp.zipPressed; }

  // Ring from this step's latched aim. On the rope it stays on the rope's anchor.
  const A = AH;
  if (b.ropeSolid >= 0) {
    b.ringId = b.ropeSolid;
    A.solid = -1;
  } else if (b.zipOn || b.yankOn || b.ledgeMode >= LEDGE_CLIMB || b.cornerOn) {
    b.ringId = RING_NONE;
    A.solid = -1;
  } else {
    b.ringId = pickRing(b, inp, k, w, A);
    if (b.ringId >= 0) setRing(b, A);
  }
  b.yankOk = yankable(b, inp, k, w);

  // §5 charge (hold C): grows while chargeable (on a roof, the coyote time after it, a wall, a ledge hang, the rope);
  // carried into the air it lasts chargeAir s. Letting go of C (or Jump while charging) launches at the charge level.
  let launch = -1;
  if (k.charge) {
    const chargeable = b.grounded || b.coyote > 0 || b.wallMode > 0 || b.ledgeMode === LEDGE_HANG_MODE || b.ropeSolid >= 0;
    if (inp.slideHeld && !locked && !b.diveOn && !b.zipOn && !b.yankOn && b.ledgeMode < LEDGE_CLIMB) {
      if (chargeable) {
        if (b.chargeT === 0) b.events |= EV_CHARGE_START;
        b.chargeT += dt;
        b.chargeAirT = 0;
      } else if (b.chargeT > 0) {
        b.chargeAirT += dt;
        if (b.chargeAirT > k.chargeAir) b.chargeT = b.chargeAirT = 0;
      }
      if (inp.jumpPressed && b.chargeT > 0) { const c = chargeLevel(b.chargeT, k); if (c > 0 && chargeable) launch = c; }
    } else if (b.chargeT > 0) {
      const c = chargeLevel(b.chargeT, k);
      if (!inp.slideHeld && c > 0 && chargeable) launch = c;
      b.chargeT = b.chargeAirT = 0;
    }
  }

  // ZIP press (E / Shift / touch ZIP): a yank when he is in yank range, else the straight zip (§4). Nothing to zip to,
  // no zips left or cooling down: the grey X, nothing spent.
  if (k.webZip && inp.zipPressed && !zipUsed && !locked && !b.zipOn && !b.yankOn && b.ledgeMode === 0) {
    if (b.yankOk) startYank(b, k);
    else if (b.zipCd <= 0 && Math.min(b.zipLeft, k.zipCharges) > 0 && zipAim(b, b.ringId >= 0 ? A : null, inp.aimX, inp.aimY, inp.aimZ, k, w, ZA) > 0) startZip(b, ZA, k);
    else b.events |= EV_NOANCHOR;
  }

  // §6.5 dive: a fresh C press in the air with room under you (not on the rope, zipping, on a wall or round a corner).
  if (k.dive && inp.slidePressed && !locked && !b.grounded && b.coyote <= 0 && b.ropeSolid < 0 && !b.zipOn && !b.yankOn && !b.cornerOn &&
    b.wallMode === 0 && b.ledgeMode === 0 && b.chargeT === 0 && feetBefore - idx.groundBelow(p.x, p.z, p.y) >= k.diveMinDrop) {
    b.diveOn = true;
    if (v.y > -k.diveSpeed) v.y = -k.diveSpeed;
    b.events |= EV_DIVE;
  }
  if (b.diveOn && (!inp.slideHeld || b.grounded || b.ropeSolid >= 0 || b.zipOn || b.yankOn || b.wallMode > 0 || b.ledgeMode > 0)) b.diveOn = false;

  // Actions (§3.8 table).
  const wantJump = !locked && (inp.jumpPressed || b.jumpBuf > 0);
  const canAttach = !locked && held && b.heldFor >= k.holdDelay && b.ringId >= 0 && b.ropeSolid < 0 && !b.cornerOn &&
    (b.relT >= k.swingRehook || b.heldFor <= b.relT);
  if (b.zipOn || b.yankOn) {
    // (the zip's / yank's pull and end are below)
  } else if (b.ledgeMode > 0) {
    if (b.ledgeMode === LEDGE_HANG_MODE && !locked) {
      if (launch >= 0) {
        // Charged hang launch: straight up, a little inward.
        b.ledgeMode = 0;
        v.x = -b.ledgeNx * k.ledgeExitSpeed * 0.5; v.z = -b.ledgeNz * k.ledgeExitSpeed * 0.5;
        v.y = k.ledgeJumpUp + launch * k.chargeUp;
        b.lastWall = b.ledgeSolid; b.lastWallT = 0;
        b.jumpBuf = 0;
        b.events |= EV_JUMP;
        launched(b, k, launch);
      } else if (wantJump) { b.ledgeMode = LEDGE_CLIMBJUMP; b.ledgeT = 0; b.jumpBuf = 0; }
      else if (canAttach) { b.ledgeMode = 0; attach(b, A, k, w); }
      else if (mx * b.ledgeNx + mz * b.ledgeNz > 0.5) {
        b.ledgeMode = 0;
        v.x = b.ledgeNx * 1.5; v.z = b.ledgeNz * 1.5;
        b.lastWall = b.ledgeSolid; b.lastWallT = 0;
      }
    }
  } else if (b.wallMode > 0) {
    const out = mx * b.wallNx + mz * b.wallNz;
    if (launch >= 0) {
      // Charged wall launch: a wall jump plus the charge out and up.
      const nx = b.wallNx, nz = b.wallNz;
      wallJump(b, k, b.wallSolid, nx, nz);
      v.x += nx * launch * k.chargeWallOut; v.z += nz * launch * k.chargeWallOut; v.y += launch * k.chargeWallUp;
      launched(b, k, launch);
    } else if (wantJump && b.wallSolid !== b.kickSolid) wallJump(b, k, b.wallSolid, b.wallNx, b.wallNz);
    else if (canAttach) { endWall(b, 0); attach(b, A, k, w); }
    else if (out > 0.5 || (b.wallMode === WALL_UP && -out < 0.3)) endWall(b, 0);
  } else if (b.grounded) {
    const hs = Math.sqrt(v.x * v.x + v.z * v.z);
    if (k.slide && !locked && b.slideT <= 0 && b.slideBuf > 0 && hs >= k.slideMinSpeed) startSlide(b, k);
    if (b.slideT > 0) {
      // Round 12: while C charges, a running slide carries on (no time-out, no decay down to run speed).
      const charging = b.chargeT > 0;
      slideMove(b, mx, mz, k, dt, charging && hs <= k.runSpeed ? 0 : k.slideDecay);
      b.slideT = hs < 1 ? 0 : charging ? Math.max(dt, b.slideT) : Math.max(0, b.slideT - dt);
    } else groundMove(b, mx, mz, k, dt, b.chargeT > 0 ? k.chargeWalk : k.runSpeed);
    const zip = k.zip && !locked && inp.webPressed && b.ringId >= 0;
    if (launch >= 0) {
      groundLaunch(b, k, launch, mx, mz, inp.aimX, inp.aimZ);
    } else if (wantJump || zip) {
      if (b.slideT > 0) {
        const s = Math.sqrt(v.x * v.x + v.z * v.z);
        if (s > 1e-6) { v.x += (v.x / s) * k.slideJumpFwd; v.z += (v.z / s) * k.slideJumpFwd; }
        b.slideT = 0;
      }
      v.y = k.jumpSpeed;
      b.grounded = false;
      b.jumpBuf = 0;
      b.chargeT = 0;
      b.events |= EV_JUMP;
      if (zip) { attach(b, A, k, w); liftStart(b, k, w); }
    } else if (k.vault && !locked) {
      // §3.5: a low solid right ahead -> hop it, horizontal speed kept. The hop starts at vaultLook, or earlier
      // when the rise needs more run-up (so the feet clear the front edge by VAULT_EDGE at this speed).
      const s = Math.sqrt(v.x * v.x + v.z * v.z);
      if (s >= k.vaultMinSpeed && obstacleAhead(idx, p.x, feetBefore, p.z, v.x / s, v.z / s, Math.max(k.vaultLook, s * VAULT_LOOK_T), hw, FH)) {
        const h = FH.top - feetBefore;
        if (h >= 0.3 && h <= k.vaultMax) {
          const g = k.gravity, v0 = Math.sqrt(2 * g * (h + k.vaultClear));
          const rest = v0 * v0 - 2 * g * (h + VAULT_EDGE);
          const tRise = (v0 - Math.sqrt(rest > 0 ? rest : 0)) / g;
          if (FH.dist <= Math.max(k.vaultLook, s * tRise)) {
            v.y = v0;
            b.grounded = false;
            b.slideT = 0;
            b.parkour++;
            b.events |= EV_VAULT;
          }
        }
      }
    }
  } else if (b.cornerOn) {
    // A corner swing: Jump lets go with a hop, letting go of the web lets go (both with the corner boost).
    if (wantJump) {
      cornerEnd(b, k, true);
      v.y = (v.y > 0 ? v.y : 0) + k.releaseUp;
      b.jumpBuf = 0;
      b.events |= EV_JUMP;
    } else if (!held) cornerEnd(b, k, true);
  } else if (launch >= 0 && b.coyote > 0) {
    groundLaunch(b, k, launch, mx, mz, inp.aimX, inp.aimZ);
  } else if (launch >= 0 && b.ropeSolid >= 0) {
    // The slingshot (§5): let go with the charge along the velocity and up; the timed / perfect bonuses stack.
    ropeRelease(b, k);
    const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
    v.x += (v.x / sp) * launch * k.chargeFling; v.y += (v.y / sp) * launch * k.chargeFling + launch * k.chargeFlingUp; v.z += (v.z / sp) * launch * k.chargeFling;
    launched(b, k, launch);
  } else if (wantJump && b.coyote > 0) {
    v.y = k.jumpSpeed;
    b.coyote = 0;
    b.jumpBuf = 0;
    b.events |= EV_JUMP;
  } else if (inp.jumpPressed && !locked && b.ropeSolid < 0 && b.touchWall >= 0 && b.touchT <= k.wallJumpGrace && b.touchWall !== b.kickSolid) {
    wallJump(b, k, b.touchWall, b.touchNx, b.touchNz);
  } else if (inp.jumpPressed && !locked && b.ropeSolid < 0 && b.airJumps > 0 && !(k.airJumpNoRing && b.ringId >= 0)) {
    // Double jump: one more upward kick while airborne (not on the rope).
    if (v.y < k.doubleJumpSpeed) v.y = k.doubleJumpSpeed;
    b.airJumps--;
    b.jumpBuf = 0;
    b.events |= EV_JUMP | EV_DJUMP;
  } else if (k.cornerSwing && held && !locked && !b.diveOn && b.chargeT === 0 && cornerFind(b, k, w, mx, mz)) {
    cornerStart(b, k);
  } else if (canAttach) {
    attach(b, A, k, w);
  } else if (b.ropeSolid >= 0 && !held) {
    ropeRelease(b, k);
  }
  if (inp.webPressed && !locked && b.ringId === RING_NONE && b.ropeSolid < 0 && !b.zipOn && !b.yankOn) b.events |= EV_NOANCHOR;

  // Forces.
  let scripted = false, reeling = false, air = 0;
  if (b.zipOn) {
    // §4.3: a straight pull (no gravity / wind) at zipSpeed: the velocity turns onto the line to the target at
    // zipPull (on it within ~4 steps). Below a rim: first to the point just outside its edge, then over it.
    b.zipT += dt;
    let tx = b.zipP.x, tz = b.zipP.z;
    if (b.zipRoof >= 0 && p.y - hh < idx.solids[b.zipRoof].top + 0.3) {
      tx -= b.zipDx * (LEDGE_IN + LEDGE_OUT);
      tz -= b.zipDz * (LEDGE_IN + LEDGE_OUT);
    }
    const dx = tx - p.x, dy = b.zipP.y - p.y, dz = tz - p.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 1e-6) {
      const sp = (k.speedCap > 0 && k.zipSpeed > k.speedCap ? k.speedCap : k.zipSpeed) / d;
      const f = Math.min(1, k.zipPull * dt);
      v.x += (dx * sp - v.x) * f;
      v.y += (dy * sp - v.y) * f;
      v.z += (dz * sp - v.z) * f;
    }
  } else if (b.yankOn) {
    // §6.6 the yank: a homing zip at yankSpeed, re-aimed at him every step.
    b.yankT += dt;
    const r = w.runner!.p;
    const dx = r.x - p.x, dy = r.y - p.y, dz = r.z - p.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 1e-6) { const sp = k.yankSpeed / d; v.x = dx * sp; v.y = dy * sp; v.z = dz * sp; }
  } else if (b.ledgeMode > 0) {
    ledgeStep(b, k, w, b.chargeT > 0 && inp.slideHeld);
    scripted = true;
  } else if (b.wallMode === WALL_RUN) {
    // §3.2: light gravity (full while rising faster than the kick), along-face speed eased up to wallRunSpeed.
    b.wallT += dt;
    const nx = b.wallNx, nz = b.wallNz, tx = -nz, tz = nx;
    v.y -= (v.y > k.wallRunKick ? k.gravity : k.gravity * k.wallRunGravity) * dt;
    let va = v.x * tx + v.z * tz;
    const aa = va < 0 ? -va : va, sg = va < 0 ? -1 : 1;
    if (aa < k.wallRunSpeed) va = sg * Math.min(k.wallRunSpeed, aa + k.wallRunAccel * dt);
    v.x = tx * va; v.z = tz * va;
    // Round 11: an inside corner ahead (a wall across the run) turns the run onto it, out along the new face,
    // instead of stopping dead in the corner and sliding down it.
    const run = va < 0 ? -va : va;
    if (k.swingAvoid > 0 && run > 1 && obstacleAhead(idx, p.x, p.y - hh, p.z, tx * sg, tz * sg, Math.max(0.6, run * CORNER_LOOK), hw, FH, b.wallSolid) &&
      FH.solid !== b.wallSolid && FH.top - (p.y - hh) >= k.wallRunMinBelowTop && FH.nx * tx * sg + FH.nz * tz * sg < -0.7) {
      const ox = b.wallNx, oz = b.wallNz, keepVy = v.y;
      v.x = ox * run; v.z = oz * run;
      startWall(b, k, w, FH.solid, FH.nx, FH.nz, WALL_RUN);
      v.y = keepVy > k.wallRunKick ? keepVy : k.wallRunKick;
      b.parkour--; // (the same run, turned)
    } else if (b.wallT >= k.wallRunTime) endWall(b, 2);
  } else if (b.wallMode === WALL_UP) {
    b.wallT += dt;
    // Up the wall at the entry speed, easing down under wall-run gravity to wallClimbSpeed (round 10).
    v.x = 0; v.z = 0; v.y = Math.max(k.wallClimbSpeed, v.y - k.gravity * k.wallRunGravity * dt);
    // Time up: it ends like a wall run, still rising (a ledge grab can follow on the way up: ~9 m reach). Round 11:
    // then a kick off the wall once you start falling (wallUpKick), so a run-up that tops out short of the rim does
    // not slide down the face.
    if (b.wallT >= k.wallClimbTime) { endWall(b, 0); b.upKick = k.wallUpKick > 0; }
  } else if (b.cornerOn) {
    // Corner swing: a level orbit (the web on the post holds you up; light gravity), speed kept by the constraint below.
    b.cornerT += dt;
    v.y -= k.gravity * k.cornerGravity * dt;
    v.y -= v.y * Math.min(1, CORNER_HOLD * dt);
  } else if (!b.grounded) {
    const onRope = b.ropeSolid >= 0;
    v.y -= k.gravity * (onRope ? k.swingGravity : b.diveOn ? k.diveGravity : 1) * dt;
    if (w.wind !== undefined) { v.x += w.wind.x * dt; v.z += w.wind.z * dt; }
    if (onRope && b.liftOn) {
      // Round 11 lift: the rope pulls you in at webLift (at least that fast toward the pivot), lighter gravity.
      const P = b.ropeP;
      const rx = p.x - P.x, ry = p.y - P.y, rz = p.z - P.z;
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (rl > 1e-6) {
        const vr = (v.x * rx + v.y * ry + v.z * rz) / rl;
        if (vr > -k.webLift) { const a = (-k.webLift - vr) / rl; v.x += rx * a; v.y += ry * a; v.z += rz * a; }
      }
    } else if (onRope) {
      // §2.3: pump along the swing through the bottom half (below the pivot, descending); steer only
      // across the swing plane (nothing along the arc).
      const P = b.ropeP;
      const rx = p.x - P.x, ry = p.y - P.y, rz = p.z - P.z;
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (rl > 1e-9) {
        const nx = rx / rl, ny = ry / rl, nz = rz / rl;
        const vr = v.x * nx + v.y * ny + v.z * nz;
        const tx = v.x - vr * nx, ty = v.y - vr * ny, tz = v.z - vr * nz;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (tl > 1e-6) {
          const ux = tx / tl, uy = ty / tl, uz = tz / tl;
          if (k.swingPump > 0 && ry < 0 && v.y < 0 && tl > 2) {
            const a = k.swingPump * dt;
            v.x += ux * a; v.y += uy * a; v.z += uz * a;
          }
          // The surge: speed along the swing through the bottom of the arc (on the way down, full at the bottom, and
          // just past it; the climb after that is yours to time).
          if (k.swingSurge > 0 && b.ropeTaut && -ny > k.swingSurgeCos && (v.y < 0 || -ny > SURGE_PAST) && tl > 2) {
            const a = (k.swingSurge * (-ny - k.swingSurgeCos) / (1 - k.swingSurgeCos)) * dt;
            v.x += ux * a; v.y += uy * a; v.z += uz * a;
          }
          // Round 11 upswing reel: rising on the forward side with the stick along the swing, the rope pulls you in.
          // (Only until the sweet spot: holding on past it earns nothing more.)
          if (k.swingReelUp > 0 && b.ropeTaut && ry < 0 && v.y > 0 && -ny > k.swingSweetCos && (rx * v.x + rz * v.z) > 0 &&
            mx * v.x + mz * v.z > 0.3 * Math.sqrt(v.x * v.x + v.z * v.z) && b.ropeLen > k.ropeMin && vr > -k.swingReelUp) {
            const a = -k.swingReelUp - vr;
            v.x += nx * a; v.y += ny * a; v.z += nz * a;
            reeling = true;
          }
          if (k.ropeSteer > 0 && (mx !== 0 || mz !== 0) && tl > 0.5) {
            // side = n x u (unit: n and u are orthonormal).
            const sx = ny * uz - nz * uy, sy = nz * ux - nx * uz, sz = nx * uy - ny * ux;
            const a = (mx * sx + mz * sz) * k.ropeSteer * dt;
            v.x += sx * a; v.y += sy * a; v.z += sz * a;
          }
        }
      }
      // Round 11: a facade ahead (head-on) bends the swing along it; else round 10's swing heading: the horizontal
      // velocity turns toward the stick (speed kept), so the sideways swing of a web to a side building dies out
      // instead of carrying you into a wall.
      const sl = mx * mx + mz * mz;
      let avoid = wallAhead(b, k, w, mx, mz);
      if (avoid <= 0) avoid = edgeAhead(b, k, w, mx, mz);
      if (avoid > 0) turnToward(v, AV.x, AV.z, avoid * dt);
      else if (k.swingAlign > 0 && sl > 0.09) {
        const hsv = Math.sqrt(v.x * v.x + v.z * v.z), il = 1 / Math.sqrt(sl);
        const hx = mx * il, hz = mz * il, al = v.x * hx + v.z * hz;
        if (hsv > 1 && al > 0) {
          const f = Math.max(0, 1 - k.swingAlign * dt);
          let ax = hx * al + (v.x - hx * al) * f, az = hz * al + (v.z - hz * al) * f;
          const nl = Math.sqrt(ax * ax + az * az);
          if (nl > 1e-6) { ax *= hsv / nl; az *= hsv / nl; v.x = ax; v.z = az; }
        }
      }
    } else if ((air = airAvoid(b, k, w, mx, mz)) > 0) {
      // Round 11: just flung toward a facade head-on, or flying out over the city's edge: the flight bends along
      // it (no air control into it).
      turnToward(v, AV.x, AV.z, air * dt);
    } else if (b.diveOn && k.diveTurn > 0 && (mx !== 0 || mz !== 0)) {
      // The web-slinger dive: the stick turns the dive (speed kept), nothing more.
      const hs = Math.sqrt(v.x * v.x + v.z * v.z), sl = Math.sqrt(mx * mx + mz * mz);
      if (hs > 1 && sl > 0.1 && (v.x * mx + v.z * mz) >= CARVE_COS * hs * sl) turnToward(v, mx / sl, mz / sl, k.diveTurn * dt);
    } else if (!b.diveOn && (mx !== 0 || mz !== 0) && (k.airAccel > 0 || k.airTurn > 0)) {
      // Round 12 air carve (§6.7): the horizontal velocity turns toward the stick at airTurn rad/s, speed kept, when
      // the stick is within ~100 deg of the way you are going. (Diving: no air control at all.)
      if (k.airTurn > 0) {
        const hs = Math.sqrt(v.x * v.x + v.z * v.z), sl = Math.sqrt(mx * mx + mz * mz);
        if (hs > 1 && sl > 0.1 && (v.x * mx + v.z * mz) >= CARVE_COS * hs * sl) turnToward(v, mx / sl, mz / sl, k.airTurn * dt);
      }
      // Round 11: just off a facade, the stick no longer presses you into it (no sliding down the face).
      let ax = mx, az = mz;
      if (b.touchT < WALL_HUG && k.swingAvoid > 0) {
        const into = ax * b.touchNx + az * b.touchNz;
        if (into < 0) { ax -= into * b.touchNx; az -= into * b.touchNz; }
      }
      const s0 = Math.sqrt(v.x * v.x + v.z * v.z);
      v.x += ax * k.airAccel * dt;
      v.z += az * k.airAccel * dt;
      const s1 = Math.sqrt(v.x * v.x + v.z * v.z);
      const lim = Math.max(s0, k.runSpeed);
      if (s1 > lim) { v.x *= lim / s1; v.z *= lim / s1; }
    }
  }
  if (!scripted) {
    // (§6.8 flow: each pip raises the cap by flowCap.) The web-slinger dive: diving, the cap is diveCap, and the speed
    // over the usual cap after it (capX) wears off at diveCarryDecay.
    const cap0 = k.speedCap > 0 ? k.speedCap + b.flow * k.flowCap : 0;
    if (b.diveOn && cap0 > 0 && k.diveCap > cap0) {
      capSpeed(v, k.diveCap);
      const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      b.capX = sp > cap0 ? sp - cap0 : 0;
    } else {
      if (b.capX > 0) {
        const ex = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) - cap0;
        b.capX = Math.max(0, Math.min(b.capX, ex) - k.diveCarryDecay * dt);
      }
      capSpeed(v, cap0 > 0 ? cap0 + b.capX : 0);
    }
    // Integrate (semi-implicit Euler).
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;
    if (b.wallMode > 0) {
      // Stay flush with the face.
      const f = faceCoord(idx.solids[b.wallSolid], b.wallNx, b.wallNz);
      if (b.wallNx !== 0) p.x = f + b.wallNx * hw; else p.z = f + b.wallNz * hw;
    }
  }

  // Rope: floor-safety reel, project onto the sphere; the first taut step keeps the speed (at most
  // x swingKeepSpeed), later ones only remove the outward radial part.
  if (b.ropeSolid >= 0) {
    b.ropeSteps++;
    if (b.ropeLen > b.ropeTarget) {
      const reel = k.swingReelPerSpeed > 0 ? k.swingReel + k.swingReelPerSpeed * Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : k.swingReel;
      b.ropeLen = Math.max(b.ropeTarget, b.ropeLen - reel * dt);
    }
    const P = b.ropeP;
    const dx = p.x - P.x, dy = p.y - P.y, dz = p.z - P.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // The upswing reel takes the rope in with you (it stays taut); so does the lift, down to its target.
    if (reeling && dist < b.ropeLen) b.ropeLen = Math.max(k.ropeMin, dist);
    if (b.liftOn) {
      if (dist < b.ropeLen) b.ropeLen = Math.max(b.ropeTarget, dist);
      if (b.ropeLen <= b.ropeTarget + LIFT_DONE) b.liftOn = false;
    }
    if (dist > b.ropeLen) {
      const nx = dx / dist, ny = dy / dist, nz = dz / dist;
      p.x = P.x + nx * b.ropeLen;
      p.y = P.y + ny * b.ropeLen;
      p.z = P.z + nz * b.ropeLen;
      const vr = v.x * nx + v.y * ny + v.z * nz;
      if (vr > 0) {
        const sp0 = b.ropeTaut ? 0 : Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        v.x -= vr * nx; v.y -= vr * ny; v.z -= vr * nz;
        if (!b.ropeTaut) {
          b.ropeTaut = true;
          const sp1 = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
          const keep = b.ropeDive && k.diveKeep > k.swingKeepSpeed ? k.diveKeep : k.swingKeepSpeed;
          if (sp1 > 1e-6) { const f = Math.min(sp0 / sp1, keep); v.x *= f; v.y *= f; v.z *= f; }
        }
      }
    }
    // Line check every losSteps steps (and the snapping-webs mutator): the web snaps, no boost. Round 10: the
    // physics rope (body -> pivot) is checked, not the drawn line to the rim, so a podium corner between you
    // and a tower's rim no longer snaps a swing that clears it.
    const los = k.losSteps >= 1 ? Math.floor(k.losSteps) : 1;
    if ((w.snapSteps !== undefined && b.ropeSteps >= w.snapSteps) ||
      (b.ropeSteps % los === 0 && !anchorVisible(idx, p.x, p.y, p.z, P.x, P.y, P.z, b.ropeSolid, -1))) {
      release(b, k, false);
      b.events |= EV_SNAP;
    } else if (k.autoRelease) {
      // Fling: rising on the forward side (moving away from the pivot's vertical) past swingReleaseCos from
      // straight down, or near the pivot height; a short swing lets go at its forward apex (never swings back).
      const rx = p.x - P.x, ry = p.y - P.y, rz = p.z - P.z;
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const cosDown = rl > 1e-9 ? -ry / rl : 1;
      const rh = Math.sqrt(rx * rx + rz * rz), vh = Math.sqrt(v.x * v.x + v.z * v.z);
      const away = rh > 1e-6 && vh > 1 && rx * v.x + rz * v.z > 0.5 * rh * vh;
      if (b.ropeTaut && v.y > 0 && away) b.ropeUp = true;
      if (p.y > P.y - k.autoReleaseBelow || (v.y > 0 && away && cosDown < k.swingReleaseCos) || (b.ropeUp && v.y <= 0)) {
        // Round 11: the auto-release flings with autoReleaseUp (a release you time yourself gets releaseUp + sweet).
        if (k.autoReleaseKeep < 1) {
          // The web-slinger swing: held to the end, the fling gets only autoReleaseKeep of the release boost.
          const bo = k.releaseBoost * k.autoReleaseKeep, sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
          v.x += (v.x / sp) * bo; v.y += (v.y / sp) * bo; v.z += (v.z / sp) * bo;
          if (v.y > -4) v.y += k.autoReleaseUp;
          release(b, k, false);
        } else release(b, k, true, k.autoReleaseUp);
        b.events |= EV_AUTORELEASE;
        capSpeed(v, k.speedCap > 0 ? k.speedCap + b.capX : 0);
      }
    }
  }

  // Corner swing: the web on the post holds you on the orbit (it only ever shortens), the horizontal speed kept; it lets go
  // (with the boost) once you head where the stick points, the stick lets go, you have turned round, or cornerMaxT.
  if (b.cornerOn) {
    const dx = p.x - b.cornerX, dz = p.z - b.cornerZ, d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-6) {
      const ux = dx / d, uz = dz / d;
      if (d < b.cornerR) b.cornerR = Math.max(CORNER_MIN_R, d);
      if (d > b.cornerR) { p.x = b.cornerX + ux * b.cornerR; p.z = b.cornerZ + uz * b.cornerR; }
      const vr = v.x * ux + v.z * uz;
      if (vr > 0) {
        const hs0 = Math.sqrt(v.x * v.x + v.z * v.z);
        v.x -= vr * ux; v.z -= vr * uz;
        const hs1 = Math.sqrt(v.x * v.x + v.z * v.z);
        if (hs1 > 1e-6) { v.x *= hs0 / hs1; v.z *= hs0 / hs1; }
      }
    }
    const hs = Math.sqrt(v.x * v.x + v.z * v.z), ml = Math.sqrt(mx * mx + mz * mz);
    if (b.cornerT >= k.cornerMaxT || ml < 0.3 || (hs > 1e-6 && v.x * mx + v.z * mz >= k.cornerExitCos * hs * ml) ||
      v.x * b.cornerDx + v.z * b.cornerDz < -0.5 * hs) cornerEnd(b, k, true);
  }

  // The zip ends at its target (zipStop short; a facade: just off the wall), or early after zipMaxTime.
  if (b.zipOn) {
    const dx = b.zipP.x - p.x, dy = b.zipP.y - p.y, dz = b.zipP.z - p.z;
    const r = b.zipKind === ZIP_FACE ? WALL_ZIP_END : k.zipStop;
    if (dx * dx + dy * dy + dz * dz <= r * r) endZip(b, k, w, ZIP_ARRIVE, inp);
    else if (b.zipT >= k.zipMaxTime) endZip(b, k, w, ZIP_EARLY, inp);
  }
  // The yank ends after yankTime, or when a solid comes between you (its momentum kept; the cooldown starts).
  if (b.yankOn) {
    const r = w.runner!.p;
    if (b.yankT >= k.yankTime || idx.segmentBlocked(p.x, p.y + CHEST, p.z, r.x, r.y + CHEST, r.z, -1, w.runner!.roofId)) endYank(b, k);
  }

  // Collision: box vs ground-rooted AABBs (none while hanging / climbing: the path is scripted).
  let supported = false, landed = false;
  let contact = -1, cnx = 0, cnz = 0;
  const v0x = v.x, v0z = v.z;
  if (!scripted) {
    const n = idx.nearbySolids(p.x - hw, p.z - hw, p.x + hw, p.z + hw);
    for (let i = 0; i < n; i++) {
      const s = idx.solids[idx.out[i]];
      if (p.x + hw <= s.x0 || p.x - hw >= s.x1 || p.z + hw <= s.z0 || p.z - hw >= s.z1) continue;
      if (p.y - hh > s.top + 1e-6) continue;
      // Round 12 floating solids (§3): skipped while the body is entirely below; hit from below = a head bump.
      const y0 = s.y0 ?? 0;
      if (y0 > 0) {
        if (p.y + hh <= y0 + 1e-6) continue;
        if (feetBefore + 2 * hh <= y0 + 1e-6 && v.y > 0) {
          p.y = y0 - hh;
          v.y = 0;
          b.events |= EV_WALL;
          if (b.zipOn) endZip(b, k, w, ZIP_EARLY, inp);
          continue;
        }
      }
      if (b.zipOn && s.id === b.zipFrom && feetBefore >= s.top - 1e-6) {
        // A zip down and away from the roof you stood on drags you across it (and off its edge).
        p.y = s.top + hh;
        if (v.y < 0) v.y = 0;
        supported = true;
        continue;
      }
      if (feetBefore >= s.top - 1e-6 && v.y <= 0) {
        p.y = s.top + hh;
        if (!b.grounded) b.landVy = v.y;
        v.y = 0;
        supported = true;
        if (!b.grounded) {
          b.grounded = true;
          landed = true;
          if (b.ropeSolid >= 0) { b.lastRope = b.ropeSolid; b.relT = 0; b.ropeSolid = -1; }
          if (b.wallMode > 0) endWall(b, 0);
          b.roofId = s.id;
          b.chainCount = 0;
          b.airJumps = k.airJumps;
          b.events |= EV_LAND;
          if (b.zipOn) endZip(b, k, w, ZIP_LANDED, inp);
        }
      } else {
        let nx = 0, nz = 0;
        // Corner slip: entering a face with only a sliver of overlap on the other axis slides past the corner.
        const oxd = Math.min(p.x + hw - s.x0, s.x1 - (p.x - hw)), ozd = Math.min(p.z + hw - s.z0, s.z1 - (p.z - hw));
        const xFace = px + hw <= s.x0 + 1e-6 || px - hw >= s.x1 - 1e-6;
        const zFace = pz + hw <= s.z0 + 1e-6 || pz - hw >= s.z1 - 1e-6;
        if (xFace && ozd <= CORNER_SLIP && ozd < oxd) {
          if (p.z < (s.z0 + s.z1) * 0.5) { nz = -1; p.z = s.z0 - hw; if (v.z > 0) v.z = 0; } else { nz = 1; p.z = s.z1 + hw; if (v.z < 0) v.z = 0; }
        } else if (zFace && !xFace && oxd <= CORNER_SLIP && oxd < ozd) {
          if (p.x < (s.x0 + s.x1) * 0.5) { nx = -1; p.x = s.x0 - hw; if (v.x > 0) v.x = 0; } else { nx = 1; p.x = s.x1 + hw; if (v.x < 0) v.x = 0; }
        } else if (px + hw <= s.x0 + 1e-6) { nx = -1; p.x = s.x0 - hw; if (v.x > 0) v.x = 0; }
        else if (px - hw >= s.x1 - 1e-6) { nx = 1; p.x = s.x1 + hw; if (v.x < 0) v.x = 0; }
        else if (pz + hw <= s.z0 + 1e-6) { nz = -1; p.z = s.z0 - hw; if (v.z > 0) v.z = 0; }
        else if (pz - hw >= s.z1 - 1e-6) { nz = 1; p.z = s.z1 + hw; if (v.z < 0) v.z = 0; }
        else {
          // Started overlapping (should not happen): leave through the shallowest side face.
          const ox0 = p.x + hw - s.x0, ox1 = s.x1 - (p.x - hw), oz0 = p.z + hw - s.z0, oz1 = s.z1 - (p.z - hw);
          const m = Math.min(ox0, ox1, oz0, oz1);
          if (m === ox0) { p.x = s.x0 - hw; if (v.x > 0) v.x = 0; }
          else if (m === ox1) { p.x = s.x1 + hw; if (v.x < 0) v.x = 0; }
          else if (m === oz0) { p.z = s.z0 - hw; if (v.z > 0) v.z = 0; }
          else { p.z = s.z1 + hw; if (v.z < 0) v.z = 0; }
        }
        if (contact < 0 && (nx !== 0 || nz !== 0) && s.id !== b.wallSolid) { contact = s.id; cnx = nx; cnz = nz; }
        b.events |= EV_WALL;
      }
    }
  }
  // A corner swing that meets a facade or lands is over (no boost; the contact below takes it).
  if (b.cornerOn && (b.grounded || contact >= 0)) { b.cornerOn = false; b.lastRope = b.cornerSolid; b.relT = 0; }
  // A zip that meets a facade: its own target face = arrived; anything else in the way ends it.
  if (b.zipOn && contact >= 0) endZip(b, k, w, b.zipKind === ZIP_FACE && contact === b.zipWall ? ZIP_ARRIVE : ZIP_EARLY, inp);
  // A wall push can move the body away from the pivot: pay the rope out so |p - pivot| <= len holds.
  if (b.ropeSolid >= 0 && (b.events & EV_WALL) !== 0) {
    const P = b.ropeP;
    const dx = p.x - P.x, dy = p.y - P.y, dz = p.z - P.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > b.ropeLen) b.ropeLen = dist;
  }
  if (b.grounded && !supported && !scripted) {
    b.grounded = false;
    b.coyote = k.coyoteTime;
    b.slideT = 0;
  }

  // Round 11: a topped-out run-up kicks off the wall as the fall starts (anything else that happens first cancels it).
  if (b.upKick && (b.grounded || b.ropeSolid >= 0 || b.zipOn || b.ledgeMode > 0 || b.wallMode > 0)) b.upKick = false;
  else if (b.upKick && v.y <= 0) {
    v.x += b.touchNx * k.wallUpKick; v.z += b.touchNz * k.wallUpKick;
    b.upKick = false;
  }
  // Airborne parkour: wall-run upkeep, facade contact (ledge / run-up / wall run / bonk), then proximity.
  if (!b.grounded && !b.zipOn && !b.yankOn && b.ledgeMode === 0 && !scripted) {
    const feet = p.y - hh;
    if (b.wallMode > 0) {
      const s = idx.solids[b.wallSolid];
      const c = b.wallNx !== 0 ? p.z : p.x;
      const va = b.wallMode === WALL_RUN ? v.x * -b.wallNz + v.z * b.wallNx : 1;
      if (b.wallMode === WALL_UP && tryLedge(b, k, w, mx, mz, true)) { /* grabbed the top */ }
      // (Round 12: a floating solid's side ends under its bottom.)
      else if (c < b.wallLo || c > b.wallHi || s.top - feet < 0.1 || (s.y0 ?? 0) > feet + 0.2 || contact >= 0 || (va < 1 && va > -1)) endWall(b, 0);
    } else if (contact >= 0) {
      const s = idx.solids[contact];
      b.touchWall = contact; b.touchT = 0; b.touchNx = cnx; b.touchNz = cnz;
      const tx = -cnz, tz = cnx;
      const va0 = v0x * tx + v0z * tz, va = va0 < 0 ? -va0 : va0;
      const vi0 = -(v0x * cnx + v0z * cnz), vi = vi0 > 0 ? vi0 : 0;
      const hs0 = Math.sqrt(v0x * v0x + v0z * v0z);
      const mIn = -(mx * cnx + mz * cnz);
      // Round 10: a swing into a facade with its rim in reach lets go and grabs the ledge (then climbs it).
      if (tryLedge(b, k, w, mx, mz, false)) { if (b.ropeSolid >= 0) release(b, k, false); }
      else if (k.wallRun && vi > va * 1.5 && hs0 >= 6 && mIn > 0.7 && s.top - feet >= k.wallRunMinBelowTop &&
        !(contact === b.lastWall && b.lastWallT < k.wallRunCooldown)) startWall(b, k, w, contact, cnx, cnz, WALL_UP, hs0);
      // Swinging into a facade (W9): any real along-face speed becomes a wall run (the rope is let go).
      else if (wallRunOk(b, k, contact, cnx, cnz, s.top, v0x, v0z, feet, b.ropeSolid >= 0 ? 0 : k.wallRunRatio)) startWall(b, k, w, contact, cnx, cnz, WALL_RUN);
      else if (k.bonk && vi > k.bonkMinSpeed && vi > k.bonkRatio * hs0 && mIn <= 0.7) {
        if (b.ropeSolid >= 0) release(b, k, false);
        // Round 12 rebound (§6.3): Jump in the jump buffer before the hit (or within reboundWindow after it) kicks you
        // off the face instead of the bonk.
        if (k.reboundWindow > 0 && b.jumpBuf > 0) rebound(b, k, cnx, cnz, vi);
        else {
          b.bonkT = k.bonkLock;
          b.rebT = 0; b.rebVin = vi; b.rebNx = cnx; b.rebNz = cnz;
          b.flow = 0;
          b.events |= EV_BONK;
        }
      } else if (k.wallPushOff > 0 && b.ropeSolid < 0 && v.y < 0) {
        // Round 11: falling along the face with nothing to take the contact (too fast for a wall run): push off it
        // (no slide down the facade with the camera on the wall).
        const vo = v.x * cnx + v.z * cnz;
        if (vo < k.wallPushOff) { v.x += (k.wallPushOff - vo) * cnx; v.z += (k.wallPushOff - vo) * cnz; }
      }
    } else if (b.ropeSolid < 0 && !b.cornerOn) {
      if (!tryLedge(b, k, w, mx, mz, false) && wallProbe(idx, p.x, feet, p.z, hw, k.wallRunReach, FH)) {
        b.touchWall = FH.solid; b.touchT = 0; b.touchNx = FH.nx; b.touchNz = FH.nz;
        if (wallRunOk(b, k, FH.solid, FH.nx, FH.nz, FH.top, v.x, v.z, feet, k.wallRunRatio)) startWall(b, k, w, FH.solid, FH.nx, FH.nz, WALL_RUN);
      }
    }
  }

  // Landing: roll (fast + stick along / buffered slide), stumble (very hard), or a buffered slide.
  if (landed) {
    const hs = Math.sqrt(v.x * v.x + v.z * v.z);
    b.kickSolid = -1;
    const along = hs > 1e-6 ? (mx * v.x + mz * v.z) / hs : 0;
    if (b.landVy < k.rollMinVy && hs >= 6 && (along >= 0.3 || b.slideBuf > 0)) {
      b.rollT = k.rollTime;
      b.events |= EV_ROLL;
    } else if (b.landVy < k.stumbleVy) {
      v.x *= k.stumbleKeep; v.z *= k.stumbleKeep;
      b.bonkT = Math.max(b.bonkT, k.stumbleLock);
      b.flow = 0;
      b.events |= EV_BIGLAND;
    } else if (k.slide && (b.slideBuf > 0 || (inp.slideHeld && b.diveOn)) && hs >= k.slideMinSpeed) startSlide(b, k);
    b.diveOn = false;
  }
  if (b.grounded) {
    b.chainCount = 0;
    b.airJumps = k.airJumps;
    b.kickSolid = -1;
    b.kicks = 0;
    b.zipLeft = k.zipCharges;
    // (§6.8: near-stopping on the ground drops every flow pip.)
    if (b.flow > 0 && v.x * v.x + v.z * v.z < FLOW_STOP * FLOW_STOP) b.flow = 0;
    // Only real roofs are safe respawn points (never a rooftop prop).
    const s = idx.solids[b.roofId];
    if (s !== undefined && s.kind === "roof") {
      b.lastSafeRoof = b.roofId;
      b.lastSafe.x = p.x; b.lastSafe.y = p.y; b.lastSafe.z = p.z;
    }
  }
  if (p.y - hh < k.failFloor) { b.events |= EV_FALL; b.flow = 0; }
}

/** The surge runs this far past the bottom of the arc (cosine from straight down, ~11 deg). */
const SURGE_PAST = 0.98;

/** §6.8: slower than this on the ground (m/s) loses the flow. */
const FLOW_STOP = 4;
