// stepBody(): the pure 3D kinematic body sim. Round 9 (docs/specs/2026-09-25-round9-movement.md): webs
// stick to buildings (rims, corners, facades) found at run time by findAnchor, a real pendulum does the
// work (speed-keeping taut, pump through the bottom, sideways-only steering, fling past 50 deg), and between
// swings you wall-run, wall-jump, grab ledges, vault, slide and roll. Player and runner share this sim.
// Determinism rule: only + - * /, Math.sqrt, min/max/abs/floor; fixed iteration order; no allocation
// in the hot path.
import { Fnv1a, type Vec3 } from "./math.ts";
import type { Tuning } from "./tuning.ts";
import type { CityIndex } from "../world/cityModel.ts";
import { anchorVisible, copyAnchor, emptyAnchor, emptyFace, faceCoord, findAnchor, ledgeAt, obstacleAhead, wallProbe, type AnchorHit, type FaceHit } from "../world/cityQuery.ts";

export const RING_NONE = -1;
export const RING_RUNNER = -2;

/** One latched input sample, consumed by exactly one fixed step. */
export type InputFrame = {
  /** World-space horizontal move vector, |move| <= 1. */
  moveX: number;
  moveZ: number;
  /** Aim = camera forward (unit vector). */
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
};

export const emptyInput = (): InputFrame => ({
  moveX: 0, moveZ: 0, aimX: 1, aimY: 0, aimZ: 0, jumpPressed: false, webHeld: false, webPressed: false, zipPressed: false, slidePressed: false,
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
/** A web press with nothing ringed (the view plays a soft "no"). */
export const EV_NOANCHOR = 1048576;

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
  };
}

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
  if (findAnchor(w.index, p.x, p.y, p.z, fx / fl, fz / fl, vl, k, ring, last, b.grounded ? b.roofId : -1, out)) return out.solid;
  // Round 10: falling with nothing in the aim cone (the end of an avenue, a crossing): the wider fall cone.
  if (!b.grounded && b.v.y < 0 && k.aimCosFall < k.aimCos &&
    findAnchor(w.index, p.x, p.y, p.z, fx / fl, fz / fl, vl, k, ring, last, -1, out, k.aimCosFall)) return out.solid;
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

/** A web zip target: kind 2 = roof ledge (roof + inward dir), 3 = a facade (solid + inward dir), 0 = none. */
export type ZipAim = { kind: number; solid: number; roof: number; x: number; y: number; z: number; dx: number; dz: number };
export const emptyZipAim = (): ZipAim => ({ kind: 0, solid: -1, roof: -1, x: 0, y: 0, z: 0, dx: 0, dz: 0 });

/**
 * Where a web zip from `b` goes this step: the ringed anchor `a` (a rim of a landable roof = a ledge zip
 * onto it, a facade = up to the wall), else the first roof ledge along the horizontal aim within zipRange
 * (clear line of sight to just outside its edge). Pure (the HUD previews it); returns out.kind.
 */
export function zipTarget(b: Body, a: AnchorHit | null, aimX: number, aimZ: number, k: Tuning, w: SimWorld, out: ZipAim): number {
  out.kind = 0; out.solid = -1; out.roof = -1;
  const p = b.p, idx = w.index;
  if (a !== null && a.solid >= 0) {
    const s = idx.solids[a.solid];
    out.solid = a.solid; out.dx = -a.nx; out.dz = -a.nz;
    if (a.rim && s.landable) {
      out.kind = 2; out.roof = a.solid;
      out.x = a.ax - a.nx * LEDGE_IN; out.y = s.top + k.halfHeight + LEDGE_UP; out.z = a.az - a.nz * LEDGE_IN;
      return 2;
    }
    const off = k.halfWidth + 0.1;
    out.kind = 3;
    out.x = a.ax + a.nx * off; out.y = a.rim ? a.ay - k.halfHeight - 0.4 : a.ay; out.z = a.az + a.nz * off;
    return 3;
  }
  const al = Math.sqrt(aimX * aimX + aimZ * aimZ);
  if (al < 1e-9) return 0;
  const dx = aimX / al, dz = aimZ / al;
  const feet = p.y - k.halfHeight;
  const skip = b.grounded ? b.roofId : -1;
  const roof = idx.ledgeAlong(p.x, p.z, dx, dz, k.zipRange, feet - k.zipDrop, feet + k.zipRise, skip);
  if (roof < 0) return 0;
  const t = idx.ledgeT;
  const y = Math.max(idx.solids[roof].top + k.halfHeight + LEDGE_UP, p.y + 0.3);
  const o = Math.max(0, t - LEDGE_OUT);
  if (idx.segmentBlocked(p.x, p.y, p.z, p.x + dx * o, y, p.z + dz * o, skip, roof)) return 0;
  out.kind = 2; out.roof = roof;
  out.x = p.x + dx * (t + LEDGE_IN); out.y = y; out.z = p.z + dz * (t + LEDGE_IN);
  out.dx = dx; out.dz = dz;
  return 2;
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
  b.wallMode = 0;
  b.ledgeMode = 0;
  b.slideT = 0;
  b.chainCount++;
  b.airJumps = k.airJumps;
  b.kickSolid = -1;
  b.events |= EV_ATTACH;
}

/** Let go: boost along the velocity + a little up (boost = false: a snap / bonk / wall contact drop). */
function release(b: Body, k: Tuning, boost: boolean): void {
  const v = b.v;
  if (boost) {
    const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
    v.x += (v.x / sp) * k.releaseBoost;
    v.y += (v.y / sp) * k.releaseBoost;
    v.z += (v.z / sp) * k.releaseBoost;
    if (v.y > -4) v.y += k.releaseUp;
  }
  b.lastRope = b.ropeSolid;
  b.relT = 0;
  b.ropeSolid = -1;
  b.events |= EV_RELEASE;
}

function startZip(b: Body, a: ZipAim, k: Tuning): void {
  b.zipOn = true;
  b.zipT = 0;
  b.zipSolid = a.solid;
  b.zipRoof = a.kind === 2 ? a.roof : -1;
  b.zipWall = a.kind === 3 ? a.solid : -1;
  b.zipP.x = a.x; b.zipP.y = a.y; b.zipP.z = a.z;
  b.zipDx = a.dx; b.zipDz = a.dz;
  if (b.ropeSolid >= 0) release(b, k, false);
  b.wallMode = 0;
  b.ledgeMode = 0;
  b.slideT = 0;
  b.grounded = false;
  b.coyote = 0;
  b.jumpBuf = 0;
  b.airJumps = k.airJumps;
  if (a.solid >= 0) b.chainCount++;
  b.events |= EV_ZIP;
}

/**
 * End a zip: `fling` = the auto-release (ledge: onto the roof; facade: a wall run along the aim when fast
 * enough, else forward + up), else a landing.
 */
function endZip(b: Body, k: Tuning, w: SimWorld, fling: boolean, aimX: number, aimZ: number): void {
  b.zipOn = false;
  b.zipCd = k.zipCooldown;
  b.events |= EV_ZIP_END;
  const v = b.v;
  if (!fling) return;
  if (b.zipRoof >= 0) {
    v.x = b.zipDx * k.zipLedgeSpeed;
    v.z = b.zipDz * k.zipLedgeSpeed;
    v.y = k.zipLedgeUp;
  } else {
    let walled = false;
    if (b.zipWall >= 0 && k.wallRun) {
      const s = w.index.solids[b.zipWall];
      const nx = -b.zipDx, nz = -b.zipDz;
      const ax = nx !== 0 && nz !== 0 ? 0 : 1; // corners: no wall run
      const tx = -nz, tz = nx;
      const al = Math.sqrt(aimX * aimX + aimZ * aimZ) || 1;
      const along = (aimX * tx + aimZ * tz) / al;
      const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (ax && (along > 0.3 || along < -0.3) && sp >= k.wallRunMinSpeed && s.top - (b.p.y - k.halfHeight) >= k.wallRunMinBelowTop) {
        const va0 = v.x * tx + v.z * tz;
        const va = (along < 0 ? -1 : 1) * Math.max(k.wallRunSpeed, va0 < 0 ? -va0 : va0);
        v.x = tx * va; v.z = tz * va; v.y = v.y > 0 ? v.y : 0;
        startWall(b, k, w, b.zipWall, nx, nz, WALL_RUN);
        walled = true;
      }
    }
    if (!walled) {
      const hs = Math.sqrt(v.x * v.x + v.z * v.z);
      if (hs > 1e-6) { v.x += (v.x / hs) * k.zipFlingFwd; v.z += (v.z / hs) * k.zipFlingFwd; }
      v.y = Math.max(v.y, 0) + k.zipFlingUp;
    }
  }
  capSpeed(v, k.speedCap);
}

function groundMove(b: Body, mx: number, mz: number, k: Tuning, dt: number): void {
  const v = b.v;
  const s = Math.sqrt(v.x * v.x + v.z * v.z);
  const ml = Math.sqrt(mx * mx + mz * mz);
  // Momentum carry: speed above runSpeed is kept and decays at carryDecay (not at all while rolling).
  const top = s > k.runSpeed ? (b.rollT > 0 ? s : Math.max(k.runSpeed, s - k.carryDecay * dt)) : k.runSpeed;
  const tx = mx * top, tz = mz * top;
  const rate = ml > 0.01 ? k.groundAccel : k.groundBrake;
  const dx = tx - v.x, dz = tz - v.z;
  const dl = Math.sqrt(dx * dx + dz * dz);
  const maxd = rate * dt;
  if (dl <= maxd) { v.x = tx; v.z = tz; } else { v.x += (dx / dl) * maxd; v.z += (dz / dl) * maxd; }
}

/** Slide: speed decays at slideDecay, only the sideways part of the stick steers. */
function slideMove(b: Body, mx: number, mz: number, k: Tuning, dt: number): void {
  const v = b.v;
  const s = Math.sqrt(v.x * v.x + v.z * v.z);
  if (s < 1e-6) return;
  const dx = v.x / s, dz = v.z / s;
  const s1 = Math.max(0, s - k.slideDecay * dt);
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
  v.y = k.wallJumpUp;
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
function ledgeStep(b: Body, k: Tuning, w: SimWorld): void {
  const s = w.index.solids[b.ledgeSolid], p = b.p, v = b.v, dt = k.dt, hh = k.halfHeight;
  b.ledgeT += dt;
  if (b.ledgeMode === LEDGE_HANG_MODE) {
    v.x = v.y = v.z = 0;
    if (b.ledgeT >= k.ledgeHang) { b.ledgeMode = LEDGE_CLIMB; b.ledgeT = 0; }
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
  const locked = b.bonkT > 0;
  b.bonkT = Math.max(0, b.bonkT - dt);
  if (!b.zipOn) b.zipCd = Math.max(0, b.zipCd - dt);
  b.relT += dt;
  b.lastWallT += dt;
  b.touchT += dt;
  b.rollT = Math.max(0, b.rollT - dt);
  b.slideBuf = Math.max(0, b.slideBuf - dt);
  if (k.slide && inp.slidePressed && !locked) b.slideBuf = k.slideBuffer;

  let mx = locked ? 0 : inp.moveX, mz = locked ? 0 : inp.moveZ;
  const ml = Math.sqrt(mx * mx + mz * mz);
  if (ml > 1) { mx /= ml; mz /= ml; }

  const px = p.x, pz = p.z, feetBefore = p.y - hh;

  // Ring from this step's latched aim. On the rope it stays on the rope's anchor.
  const A = AH;
  if (b.ropeSolid >= 0) {
    b.ringId = b.ropeSolid;
    A.solid = -1;
  } else if (b.zipOn || b.ledgeMode >= LEDGE_CLIMB) {
    b.ringId = RING_NONE;
    A.solid = -1;
  } else {
    b.ringId = pickRing(b, inp, k, w, A);
    if (b.ringId >= 0) setRing(b, A);
  }

  // Web zip (player only): the ringed anchor, else a roof ledge under the aim. A zip owns the step's
  // actions until it ends (hold web through it to swing right after the release).
  if (k.webZip && inp.zipPressed && !locked && !b.zipOn && b.ropeSolid < 0 && b.ledgeMode === 0 && b.zipCd <= 0 &&
    zipTarget(b, b.ringId >= 0 ? A : null, inp.aimX, inp.aimZ, k, w, ZA) > 0) startZip(b, ZA, k);

  // Actions (§3.8 table).
  const wantJump = !locked && (inp.jumpPressed || b.jumpBuf > 0);
  const canAttach = !locked && held && b.heldFor >= k.holdDelay && b.ringId >= 0 && b.ropeSolid < 0 &&
    (b.relT >= k.swingRehook || b.heldFor <= b.relT);
  if (b.zipOn) {
    // (the zip's pull and release are below)
  } else if (b.ledgeMode > 0) {
    if (b.ledgeMode === LEDGE_HANG_MODE && !locked) {
      if (wantJump) { b.ledgeMode = LEDGE_CLIMBJUMP; b.ledgeT = 0; b.jumpBuf = 0; }
      else if (canAttach) { b.ledgeMode = 0; attach(b, A, k, w); }
      else if (mx * b.ledgeNx + mz * b.ledgeNz > 0.5) {
        b.ledgeMode = 0;
        v.x = b.ledgeNx * 1.5; v.z = b.ledgeNz * 1.5;
        b.lastWall = b.ledgeSolid; b.lastWallT = 0;
      }
    }
  } else if (b.wallMode > 0) {
    const out = mx * b.wallNx + mz * b.wallNz;
    if (wantJump && b.wallSolid !== b.kickSolid) wallJump(b, k, b.wallSolid, b.wallNx, b.wallNz);
    else if (canAttach) { endWall(b, 0); attach(b, A, k, w); }
    else if (out > 0.5 || (b.wallMode === WALL_UP && -out < 0.3)) endWall(b, 0);
  } else if (b.grounded) {
    const hs = Math.sqrt(v.x * v.x + v.z * v.z);
    if (k.slide && !locked && b.slideT <= 0 && b.slideBuf > 0 && hs >= k.slideMinSpeed) startSlide(b, k);
    if (b.slideT > 0) {
      slideMove(b, mx, mz, k, dt);
      b.slideT = hs < 1 ? 0 : Math.max(0, b.slideT - dt);
    } else groundMove(b, mx, mz, k, dt);
    const zip = k.zip && !locked && inp.webPressed && b.ringId >= 0;
    if (wantJump || zip) {
      if (b.slideT > 0) {
        const s = Math.sqrt(v.x * v.x + v.z * v.z);
        if (s > 1e-6) { v.x += (v.x / s) * k.slideJumpFwd; v.z += (v.z / s) * k.slideJumpFwd; }
        b.slideT = 0;
      }
      v.y = k.jumpSpeed;
      b.grounded = false;
      b.jumpBuf = 0;
      b.events |= EV_JUMP;
      if (zip) attach(b, A, k, w);
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
  } else if (canAttach) {
    attach(b, A, k, w);
  } else if (b.ropeSolid >= 0 && !held) {
    release(b, k, true);
  }
  if (inp.webPressed && !locked && b.ringId === RING_NONE && b.ropeSolid < 0 && !b.zipOn) b.events |= EV_NOANCHOR;

  // Forces.
  let scripted = false;
  if (b.zipOn) {
    // A zip is a straight pull (no gravity / wind): the velocity turns onto the line to the target (below a
    // ledge: first to the point just outside its edge) at zipSpeed, the speed cap included.
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
  } else if (b.ledgeMode > 0) {
    ledgeStep(b, k, w);
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
    if (b.wallT >= k.wallRunTime) endWall(b, 2);
  } else if (b.wallMode === WALL_UP) {
    b.wallT += dt;
    // Up the wall at the entry speed, easing down under wall-run gravity to wallClimbSpeed (round 10).
    v.x = 0; v.z = 0; v.y = Math.max(k.wallClimbSpeed, v.y - k.gravity * k.wallRunGravity * dt);
    // Time up: it ends like a wall run, still rising (a ledge grab can follow on the way up: ~9 m reach).
    if (b.wallT >= k.wallClimbTime) endWall(b, 0);
  } else if (!b.grounded) {
    const onRope = b.ropeSolid >= 0;
    v.y -= k.gravity * (onRope ? k.swingGravity : 1) * dt;
    if (w.wind !== undefined) { v.x += w.wind.x * dt; v.z += w.wind.z * dt; }
    if (onRope) {
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
          if (k.ropeSteer > 0 && (mx !== 0 || mz !== 0) && tl > 0.5) {
            // side = n x u (unit: n and u are orthonormal).
            const sx = ny * uz - nz * uy, sy = nz * ux - nx * uz, sz = nx * uy - ny * ux;
            const a = (mx * sx + mz * sz) * k.ropeSteer * dt;
            v.x += sx * a; v.y += sy * a; v.z += sz * a;
          }
        }
      }
      // Round 10 swing heading: the horizontal velocity turns toward the stick (speed kept), so the sideways
      // swing of a web to a side building dies out instead of carrying you into a wall.
      const sl = mx * mx + mz * mz;
      if (k.swingAlign > 0 && sl > 0.09) {
        const hsv = Math.sqrt(v.x * v.x + v.z * v.z), il = 1 / Math.sqrt(sl);
        const hx = mx * il, hz = mz * il, al = v.x * hx + v.z * hz;
        if (hsv > 1 && al > 0) {
          const f = Math.max(0, 1 - k.swingAlign * dt);
          let ax = hx * al + (v.x - hx * al) * f, az = hz * al + (v.z - hz * al) * f;
          const nl = Math.sqrt(ax * ax + az * az);
          if (nl > 1e-6) { ax *= hsv / nl; az *= hsv / nl; v.x = ax; v.z = az; }
        }
      }
    } else if (k.airAccel > 0 && (mx !== 0 || mz !== 0)) {
      const s0 = Math.sqrt(v.x * v.x + v.z * v.z);
      v.x += mx * k.airAccel * dt;
      v.z += mz * k.airAccel * dt;
      const s1 = Math.sqrt(v.x * v.x + v.z * v.z);
      const lim = Math.max(s0, k.runSpeed);
      if (s1 > lim) { v.x *= lim / s1; v.z *= lim / s1; }
    }
  }
  if (!scripted) {
    capSpeed(v, k.speedCap);
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
    if (b.ropeLen > b.ropeTarget) b.ropeLen = Math.max(b.ropeTarget, b.ropeLen - k.swingReel * dt);
    const P = b.ropeP;
    const dx = p.x - P.x, dy = p.y - P.y, dz = p.z - P.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
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
          if (sp1 > 1e-6) { const f = Math.min(sp0 / sp1, k.swingKeepSpeed); v.x *= f; v.y *= f; v.z *= f; }
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
        release(b, k, true);
        b.events |= EV_AUTORELEASE;
        capSpeed(v, k.speedCap);
      }
    }
  }

  // Zip auto-release near the target (or after zipMaxTime).
  if (b.zipOn) {
    const dx = b.zipP.x - p.x, dy = b.zipP.y - p.y, dz = b.zipP.z - p.z;
    const r = b.zipWall >= 0 ? WALL_ZIP_END : k.zipRelease;
    if (dx * dx + dy * dy + dz * dz <= r * r || b.zipT >= k.zipMaxTime) endZip(b, k, w, true, inp.aimX, inp.aimZ);
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
          if (b.zipOn) endZip(b, k, w, false, inp.aimX, inp.aimZ);
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

  // Airborne parkour: wall-run upkeep, facade contact (ledge / run-up / wall run / bonk), then proximity.
  if (!b.grounded && !b.zipOn && b.ledgeMode === 0 && !scripted) {
    const feet = p.y - hh;
    if (b.wallMode > 0) {
      const s = idx.solids[b.wallSolid];
      const c = b.wallNx !== 0 ? p.z : p.x;
      const va = b.wallMode === WALL_RUN ? v.x * -b.wallNz + v.z * b.wallNx : 1;
      if (b.wallMode === WALL_UP && tryLedge(b, k, w, mx, mz, true)) { /* grabbed the top */ }
      else if (c < b.wallLo || c > b.wallHi || s.top - feet < 0.1 || contact >= 0 || (va < 1 && va > -1)) endWall(b, 0);
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
        b.bonkT = k.bonkLock;
        b.events |= EV_BONK;
      }
    } else if (b.ropeSolid < 0) {
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
      b.events |= EV_BIGLAND;
    } else if (k.slide && b.slideBuf > 0 && hs >= k.slideMinSpeed) startSlide(b, k);
  }
  if (b.grounded) {
    b.chainCount = 0;
    b.airJumps = k.airJumps;
    b.kickSolid = -1;
    // Only real roofs are safe respawn points (never a rooftop prop).
    const s = idx.solids[b.roofId];
    if (s !== undefined && s.kind === "roof") {
      b.lastSafeRoof = b.roofId;
      b.lastSafe.x = p.x; b.lastSafe.y = p.y; b.lastSafe.z = p.z;
    }
  }
  if (p.y - hh < k.failFloor) b.events |= EV_FALL;
}
