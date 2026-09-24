// stepBody(): the pure 3D kinematic body sim (spec §5). A generalisation of the verified 2D prototype
// rope sim: with the PROTOTYPE preset it reproduces the prototype trace (test 1).
// Determinism rule: only + - * /, Math.sqrt, min/max/abs/floor; fixed iteration order; no allocation
// in the hot path.
import { Fnv1a, type Vec3 } from "./math.ts";
import type { Tuning } from "./tuning.ts";
import type { CityIndex, Hook } from "../world/cityModel.ts";

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
};

export const emptyInput = (): InputFrame => ({
  moveX: 0, moveZ: 0, aimX: 1, aimY: 0, aimZ: 0, jumpPressed: false, webHeld: false, webPressed: false,
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

export type Body = {
  /** Body centre (feet = p.y - halfHeight). */
  p: Vec3;
  v: Vec3;
  grounded: boolean;
  roofId: number;
  /** Rope: hook id or -1. */
  ropeHook: number;
  ropeLen: number;
  ropeTarget: number;
  heldFor: number;
  coyote: number;
  jumpBuf: number;
  bonkT: number;
  lastSafeRoof: number;
  lastSafe: Vec3;
  /** Hook id, RING_RUNNER or RING_NONE; updated only inside stepBody. */
  ringId: number;
  chainCount: number;
  step: number;
  t: number;
  events: number;
  /** v.y at the most recent landing (animation / FX). */
  landVy: number;
};

/** What stepBody needs from the world. */
export type SimWorld = {
  index: CityIndex;
  hooks: Hook[];
  lowestRoof: number;
  /** Runner body point + the roof he stands on (-1 airborne), or null (sandbox). */
  runner: { p: Vec3; roofId: number } | null;
  /** Bake only: when set, the ring is this hook id (or none for -1) instead of pickTarget. */
  forceHook?: number;
};

export function createBody(x: number, y: number, z: number, roofId: number): Body {
  return {
    p: { x, y, z },
    v: { x: 0, y: 0, z: 0 },
    grounded: roofId >= 0,
    roofId,
    ropeHook: -1,
    ropeLen: 0,
    ropeTarget: 0,
    heldFor: 0,
    coyote: 0,
    jumpBuf: 0,
    bonkT: 0,
    lastSafeRoof: roofId,
    lastSafe: { x, y, z },
    ringId: RING_NONE,
    chainCount: 0,
    step: 0,
    t: 0,
    events: 0,
    landVy: 0,
  };
}

export function copyBody(dst: Body, src: Body): Body {
  dst.p.x = src.p.x; dst.p.y = src.p.y; dst.p.z = src.p.z;
  dst.v.x = src.v.x; dst.v.y = src.v.y; dst.v.z = src.v.z;
  dst.grounded = src.grounded;
  dst.roofId = src.roofId;
  dst.ropeHook = src.ropeHook;
  dst.ropeLen = src.ropeLen;
  dst.ropeTarget = src.ropeTarget;
  dst.heldFor = src.heldFor;
  dst.coyote = src.coyote;
  dst.jumpBuf = src.jumpBuf;
  dst.bonkT = src.bonkT;
  dst.lastSafeRoof = src.lastSafeRoof;
  dst.lastSafe.x = src.lastSafe.x; dst.lastSafe.y = src.lastSafe.y; dst.lastSafe.z = src.lastSafe.z;
  dst.ringId = src.ringId;
  dst.chainCount = src.chainCount;
  dst.step = src.step;
  dst.t = src.t;
  dst.events = src.events;
  dst.landVy = src.landVy;
  return dst;
}

export const cloneBody = (b: Body): Body => copyBody(createBody(0, 0, 0, -1), b);

/** FNV-1a over the full sim state (ringId included). */
export function hashBody(b: Body, h: Fnv1a = new Fnv1a()): Fnv1a {
  h.f64(b.p.x).f64(b.p.y).f64(b.p.z).f64(b.v.x).f64(b.v.y).f64(b.v.z);
  h.i32(b.grounded ? 1 : 0).i32(b.roofId).i32(b.ropeHook).f64(b.ropeLen).f64(b.ropeTarget);
  h.f64(b.heldFor).f64(b.coyote).f64(b.jumpBuf).f64(b.bonkT);
  h.i32(b.lastSafeRoof).f64(b.lastSafe.x).f64(b.lastSafe.y).f64(b.lastSafe.z);
  h.i32(b.ringId).i32(b.chainCount).i32(b.step);
  return h;
}

// ---- targeting (§5.2) ------------------------------------------------------------------------------

/** d (§5.3): chase distance with vertical differences counted at half weight. */
export function chaseDist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = (a.y - b.y) * 0.5, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The hook (or runner) the latched aim rings this step. Pure; reads b.ringId for hysteresis. */
export function pickTarget(b: Body, inp: InputFrame, k: Tuning, w: SimWorld): number {
  const p = b.p;
  const hooks = w.hooks;
  if (k.targeting === "prototype") {
    // Prototype: nearest anchor that is above and not behind (+x), within aimRadius. Aim ignored.
    let best = RING_NONE, bestD = Infinity;
    for (let i = 0; i < hooks.length; i++) {
      const h = hooks[i];
      if (h.x < p.x - 0.5 || h.y < p.y + 1) continue;
      const dx = h.x - p.x, dy = h.y - p.y, dz = h.z - p.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= k.aimRadius && d < bestD) { best = i; bestD = d; }
    }
    return best;
  }

  let ax = inp.aimX, az = inp.aimZ;
  const al = Math.sqrt(ax * ax + az * az);
  if (al > 1e-9) { ax /= al; az /= al; } else { ax = 0; az = 0; }

  // Runner (Yoink) beats every hook.
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

  const cx = p.x + ax * k.scoreAhead, cy = p.y + k.scoreUp, cz = p.z + az * k.scoreAhead;
  const r2 = k.aimRadius * k.aimRadius;
  let best = RING_NONE, bestS = Infinity;
  for (let i = 0; i < hooks.length; i++) {
    const h = hooks[i];
    const dx = h.x - p.x, dy = h.y - p.y, dz = h.z - p.z;
    if (dy < k.hookMinAbove) continue;
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    const hl = Math.sqrt(dx * dx + dz * dz);
    if (hl > 1e-6 && dx * ax + dz * az < k.aimCos * hl) continue;
    const sx = h.x - cx, sy = h.y - cy, sz = h.z - cz;
    let s = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (i === b.ringId) s -= k.hysteresis;
    if (s >= bestS) continue;
    if (w.index.segmentBlocked(p.x, p.y, p.z, h.x, h.y, h.z)) continue;
    best = i;
    bestS = s;
  }
  return best;
}

// ---- helpers -----------------------------------------------------------------------------------

function attach(b: Body, hookId: number, k: Tuning, w: SimWorld): void {
  const h = w.hooks[hookId];
  const dx = h.x - b.p.x, dy = h.y - b.p.y, dz = h.z - b.p.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  b.ropeHook = hookId;
  b.ropeLen = d;
  b.ropeTarget = d * k.ropeScale;
  b.chainCount++;
  b.events |= EV_ATTACH;
}

function release(b: Body, k: Tuning): void {
  const v = b.v;
  const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  v.x += (v.x / sp) * k.releaseBoost;
  v.y += (v.y / sp) * k.releaseBoost;
  v.z += (v.z / sp) * k.releaseBoost;
  b.ropeHook = -1;
  b.events |= EV_RELEASE;
}

function groundMove(b: Body, mx: number, mz: number, k: Tuning, dt: number): void {
  const v = b.v;
  if (k.instantGround) {
    v.x = mx * k.runSpeed;
    v.z = mz * k.runSpeed;
    return;
  }
  const s = Math.sqrt(v.x * v.x + v.z * v.z);
  const ml = Math.sqrt(mx * mx + mz * mz);
  // Momentum carry: speed above runSpeed is kept and decays at carryDecay.
  const top = s > k.runSpeed ? Math.max(k.runSpeed, s - k.carryDecay * dt) : k.runSpeed;
  const tx = mx * top, tz = mz * top;
  const rate = ml > 0.01 ? k.groundAccel : k.groundBrake;
  const dx = tx - v.x, dz = tz - v.z;
  const dl = Math.sqrt(dx * dx + dz * dz);
  const maxd = rate * dt;
  if (dl <= maxd) { v.x = tx; v.z = tz; } else { v.x += (dx / dl) * maxd; v.z += (dz / dl) * maxd; }
}

// ---- the step ------------------------------------------------------------------------------------

export function stepBody(b: Body, inp: InputFrame, k: Tuning, w: SimWorld): void {
  const dt = k.dt;
  const p = b.p, v = b.v;
  b.events = 0;
  b.step++;
  b.t += dt;
  const held = inp.webHeld;
  b.heldFor = held ? b.heldFor + dt : 0;
  b.coyote = Math.max(0, b.coyote - dt);
  b.jumpBuf = inp.jumpPressed ? k.jumpBuffer : Math.max(0, b.jumpBuf - dt);
  const locked = b.bonkT > 0;
  b.bonkT = Math.max(0, b.bonkT - dt);

  let mx = locked ? 0 : inp.moveX, mz = locked ? 0 : inp.moveZ;
  const ml = Math.sqrt(mx * mx + mz * mz);
  if (ml > 1) { mx /= ml; mz /= ml; }

  const px = p.x, pz = p.z, feetBefore = p.y - k.halfHeight;

  // Targeting from this step's latched aim. While on the rope the ring stays on its hook.
  b.ringId = b.ropeHook >= 0 ? b.ropeHook : w.forceHook !== undefined ? w.forceHook : pickTarget(b, inp, k, w);

  // Actions (same precedence as the prototype).
  const wantJump = !locked && (inp.jumpPressed || b.jumpBuf > 0);
  if (b.grounded) {
    groundMove(b, mx, mz, k, dt);
    const zip = k.zip && !locked && inp.webPressed && b.ringId >= 0;
    if (wantJump || zip) {
      v.y = k.jumpSpeed;
      b.grounded = false;
      b.jumpBuf = 0;
      b.events |= EV_JUMP;
      if (zip) attach(b, b.ringId, k, w);
    }
  } else if (wantJump && b.coyote > 0) {
    v.y = k.jumpSpeed;
    b.coyote = 0;
    b.jumpBuf = 0;
    b.events |= EV_JUMP;
  } else if (b.ropeHook < 0 && held && !locked && b.heldFor >= k.holdDelay && b.ringId >= 0) {
    attach(b, b.ringId, k, w);
  } else if (b.ropeHook >= 0 && !held) {
    release(b, k);
  }

  // Forces.
  if (!b.grounded) {
    v.y -= k.gravity * dt;
    if (b.ropeHook >= 0) {
      if (k.ropeSteer > 0 && (mx !== 0 || mz !== 0)) {
        const h = w.hooks[b.ropeHook];
        const rx = p.x - h.x, ry = p.y - h.y, rz = p.z - h.z;
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rl > 1e-9) {
          const nx = rx / rl, ny = ry / rl, nz = rz / rl;
          const mn = mx * nx + mz * nz;
          const a = k.ropeSteer * dt;
          v.x += (mx - mn * nx) * a;
          v.y += (0 - mn * ny) * a;
          v.z += (mz - mn * nz) * a;
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
  if (k.speedCap > 0) {
    const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (sp > k.speedCap) { const f = k.speedCap / sp; v.x *= f; v.y *= f; v.z *= f; }
  }

  // Integrate (semi-implicit Euler).
  p.x += v.x * dt;
  p.y += v.y * dt;
  p.z += v.z * dt;

  // Rope: reel in, project onto the sphere, cancel outward radial velocity beyond the reel rate.
  if (b.ropeHook >= 0) {
    const reel = b.ropeLen > b.ropeTarget ? k.reelSpeed : 0;
    b.ropeLen = Math.max(b.ropeTarget, b.ropeLen - reel * dt);
    const h = w.hooks[b.ropeHook];
    const dx = p.x - h.x, dy = p.y - h.y, dz = p.z - h.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > b.ropeLen) {
      const nx = dx / dist, ny = dy / dist, nz = dz / dist;
      p.x = h.x + nx * b.ropeLen;
      p.y = h.y + ny * b.ropeLen;
      p.z = h.z + nz * b.ropeLen;
      const vr = v.x * nx + v.y * ny + v.z * nz;
      if (vr > -reel) {
        v.x -= (vr + reel) * nx;
        v.y -= (vr + reel) * ny;
        v.z -= (vr + reel) * nz;
      }
    }
    if (k.autoRelease && p.y > h.y - k.autoReleaseBelow) {
      release(b, k);
      b.events |= EV_AUTORELEASE;
      if (k.speedCap > 0) {
        const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        if (sp > k.speedCap) { const f = k.speedCap / sp; v.x *= f; v.y *= f; v.z *= f; }
      }
    }
  }

  // Collision: box vs ground-rooted AABBs.
  const hw = k.halfWidth, hh = k.halfHeight;
  const feet = p.y - hh;
  let supported = false;
  const idx = w.index;
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
        b.ropeHook = -1;
        b.roofId = s.id;
        b.chainCount = 0;
        b.events |= EV_LAND;
      }
    } else {
      const hs = Math.sqrt(v.x * v.x + v.z * v.z);
      let nrm = 0;
      if (px + hw <= s.x0 + 1e-6) { nrm = v.x; p.x = s.x0 - hw; if (v.x > 0) v.x = 0; }
      else if (px - hw >= s.x1 - 1e-6) { nrm = -v.x; p.x = s.x1 + hw; if (v.x < 0) v.x = 0; }
      else if (pz + hw <= s.z0 + 1e-6) { nrm = v.z; p.z = s.z0 - hw; if (v.z > 0) v.z = 0; }
      else if (pz - hw >= s.z1 - 1e-6) { nrm = -v.z; p.z = s.z1 + hw; if (v.z < 0) v.z = 0; }
      else {
        // Started overlapping (should not happen): leave through the shallowest side face.
        const ox0 = p.x + hw - s.x0, ox1 = s.x1 - (p.x - hw), oz0 = p.z + hw - s.z0, oz1 = s.z1 - (p.z - hw);
        const m = Math.min(ox0, ox1, oz0, oz1);
        if (m === ox0) { p.x = s.x0 - hw; if (v.x > 0) v.x = 0; }
        else if (m === ox1) { p.x = s.x1 + hw; if (v.x < 0) v.x = 0; }
        else if (m === oz0) { p.z = s.z0 - hw; if (v.z > 0) v.z = 0; }
        else { p.z = s.z1 + hw; if (v.z < 0) v.z = 0; }
      }
      b.events |= EV_WALL;
      if (k.bonk && !b.grounded && nrm > k.bonkMinSpeed && nrm > k.bonkRatio * hs) {
        b.ropeHook = -1;
        b.bonkT = k.bonkLock;
        b.events |= EV_BONK;
      }
    }
  }
  // A wall push can move the body away from the hook: pay the rope out so |p - hook| <= len holds.
  if (b.ropeHook >= 0 && (b.events & EV_WALL) !== 0) {
    const h = w.hooks[b.ropeHook];
    const dx = p.x - h.x, dy = p.y - h.y, dz = p.z - h.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > b.ropeLen) b.ropeLen = dist;
  }
  if (b.grounded && !supported) {
    b.grounded = false;
    b.coyote = k.coyoteTime;
  }
  if (b.grounded) {
    b.chainCount = 0;
    b.lastSafeRoof = b.roofId;
    b.lastSafe.x = p.x; b.lastSafe.y = p.y; b.lastSafe.z = p.z;
  }
  if (p.y - hh < w.lowestRoof - k.failBelowLowestRoof) b.events |= EV_FALL;
}
