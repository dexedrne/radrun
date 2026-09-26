// Round 9 movement queries over the CityIndex (docs/specs/2026-09-25-round9-movement.md §9.3): web anchors
// on buildings (rims, corners, facades), the facade next to the body (wall run / wall kick), the obstacle
// ahead (vault) and the grabbable ledge in front (ledge grab). Free functions: cityModel.ts is not touched.
// Determinism rule: + - * / sqrt min max abs floor only, ascending solid-id iteration, no allocation in the
// hot path (module scratch). idx.out is copied into a private scratch before segmentBlocked (which reuses it).
// Every solid kind is treated the same way: only `landable` and `top` are read.
import { slab, type CityIndex, type Solid } from "./cityModel.ts";
import type { Tuning } from "../sim/tuning.ts";

/** A web anchor on a building: visual point (a*), physics pivot (p*), face normal, rim/corner flag. */
export type AnchorHit = {
  solid: number; ax: number; ay: number; az: number; px: number; py: number; pz: number;
  nx: number; nz: number; rim: boolean; score: number;
};
export const emptyAnchor = (): AnchorHit => ({ solid: -1, ax: 0, ay: 0, az: 0, px: 0, py: 0, pz: 0, nx: 0, nz: 0, rim: false, score: 0 });

export function copyAnchor(dst: AnchorHit, src: AnchorHit): AnchorHit {
  dst.solid = src.solid; dst.ax = src.ax; dst.ay = src.ay; dst.az = src.az; dst.px = src.px; dst.py = src.py; dst.pz = src.pz;
  dst.nx = src.nx; dst.nz = src.nz; dst.rim = src.rim; dst.score = src.score;
  return dst;
}

/** A vertical side face of a solid near the body. lo / hi = its extent along the face tangent. */
export type FaceHit = { solid: number; nx: number; nz: number; dist: number; top: number; lo: number; hi: number };
export const emptyFace = (): FaceHit => ({ solid: -1, nx: 0, nz: 0, dist: 0, top: 0, lo: 0, hi: 0 });

/** Anchors less than this far out horizontally pass the aim cone (straight up). */
export const CONE_FREE = 3;
/** Ledge grab reach (m from the body side to the face). */
export const LEDGE_REACH = 0.4;
const S2 = 0.7071067811865476;

let scratch = new Int32Array(64);
function keep(idx: CityIndex, n: number): Int32Array {
  if (scratch.length < n) scratch = new Int32Array(Math.max(n, scratch.length * 2));
  for (let i = 0; i < n; i++) scratch[i] = idx.out[i];
  return scratch;
}

/**
 * Clear web line from (x, y, z) to a point (ax, ay, az) on the surface of `solid`: no other solid in the way
 * (skipRoof = the roof stood on), and the line meets `solid` only at its end (never through the building to
 * a face on its far side).
 */
export function anchorVisible(idx: CityIndex, x: number, y: number, z: number, ax: number, ay: number, az: number, solid: number, skipRoof: number): boolean {
  const s = idx.solids[solid];
  const dx = ax - x, dy = ay - y, dz = az - z;
  const t = slab(x, y, z, dx, dy, dz, s.x0, 0, s.z0, s.x1, s.top, s.z1);
  if (t >= 0) {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if ((1 - t) * len > 0.05) return false;
  }
  return !idx.segmentBlocked(x, y, z, ax, ay, az, solid, skipRoof);
}

/** The face coordinate of solid `s` with outward normal (nx, nz) (axis-aligned; corners use the x face). */
export function faceCoord(s: Solid, nx: number, nz: number): number {
  return nx < -0.5 ? s.x0 : nx > 0.5 ? s.x1 : nz < -0.5 ? s.z0 : s.z1;
}

/**
 * §2.1 search. (x, y, z) body centre; (fx, fz) unit forward; speed = |v_xz|; ringSolid = hysteresis;
 * lastSolid (-1 = none) = the building let go of in the last 1.0 s; skipRoof = the roof stood on (-1 airborne);
 * cone = the aim cone's cosine (k.aimCos; round 10's falling fallback passes k.aimCosFall); vel = the body's
 * velocity for the round 11 swing look-ahead (null: forward x speed, level).
 * For each solid in ropeMax, Q = the closest point of its box to the ideal point (roof interior -> the rim, a
 * point inside the box -> the nearest side face), filtered by height, rope length, aim cone and a clear line.
 * Round 11: the best few (ARC_TOP) are then looked at in score order with a coarse run of the swing each would
 * give (swingClear): one that carries you head-on into a facade (its own building's, most often: a web to the
 * face ahead) scores anchorArcPenalty worse. Fills out (pivot included, §2.2), returns false when nothing
 * qualifies. Allocation-free.
 */
export function findAnchor(
  idx: CityIndex, x: number, y: number, z: number, fx: number, fz: number, speed: number,
  k: Tuning, ringSolid: number, lastSolid: number, skipRoof: number, out: AnchorHit, cone: number = k.aimCos,
  vel: { x: number; y: number; z: number } | null = null,
): boolean {
  const ahead = k.anchorAhead + k.anchorAheadPerSpeed * speed;
  const sx = x + fx * ahead, sy = y + k.anchorUp, sz = z + fz * ahead;
  const R = k.ropeMax;
  const n = idx.nearbySolids(x - R, z - R, x + R, z + R);
  const ids = keep(idx, n);
  const minY = y + k.anchorMinAbove;
  const rMin2 = k.ropeMin * k.ropeMin, rMax2 = R * R;
  const top = k.anchorArcPenalty > 0 ? ARC_TOP : 1;
  let kept = 0;
  out.solid = -1;
  for (let i = 0; i < n; i++) {
    const s = idx.solids[ids[i]];
    if (s.top < minY) continue;
    let qx = sx < s.x0 ? s.x0 : sx > s.x1 ? s.x1 : sx;
    let qy = sy < 0 ? 0 : sy > s.top ? s.top : sy;
    let qz = sz < s.z0 ? s.z0 : sz > s.z1 ? s.z1 : sz;
    const inX = sx > s.x0 && sx < s.x1, inZ = sz > s.z0 && sz < s.z1;
    let rim: boolean;
    if (inX && inZ) {
      // Over the roof interior -> the nearest rim point; inside the box -> the nearest side face. Only sides
      // that face the body count (the far side is behind the building), unless none does.
      rim = sy >= s.top;
      if (rim) qy = s.top;
      const f0 = x <= s.x0, f1 = x >= s.x1, f2 = z <= s.z0, f3 = z >= s.z1, any = f0 || f1 || f2 || f3;
      const d0 = f0 || !any ? qx - s.x0 : Infinity, d1 = f1 || !any ? s.x1 - qx : Infinity;
      const d2 = f2 || !any ? qz - s.z0 : Infinity, d3 = f3 || !any ? s.z1 - qz : Infinity;
      const m = Math.min(d0, d1, d2, d3);
      if (m === d0) qx = s.x0; else if (m === d1) qx = s.x1; else if (m === d2) qz = s.z0; else qz = s.z1;
    } else rim = qy >= s.top;
    const dy = qy - y;
    if (dy < k.anchorMinAbove) continue;
    const dx = qx - x, dz = qz - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < rMin2 || d2 > rMax2) continue;
    const hl = Math.sqrt(dx * dx + dz * dz);
    if (hl >= CONE_FREE && dx * fx + dz * fz < cone * hl) continue;
    const ex = qx - sx, ey = qy - sy, ez = qz - sz;
    let sc = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (rim) sc -= k.anchorRimBonus;
    if (s.id === ringSolid) sc -= k.hysteresis;
    if (s.id === lastSolid) sc += k.anchorAlternate;
    // Only a candidate that makes the top list is line-checked (ties keep the lower solid id: ascending ids).
    if (kept === top && sc >= TOPS[kept - 1].score) continue;
    if (!anchorVisible(idx, x, y, z, qx, qy, qz, s.id, skipRoof)) continue;
    let nx = qx === s.x0 ? -1 : qx === s.x1 ? 1 : 0;
    let nz = qz === s.z0 ? -1 : qz === s.z1 ? 1 : 0;
    if (nx !== 0 && nz !== 0) { nx *= S2; nz *= S2; }
    else if (nx === 0 && nz === 0) {
      // (not reachable for a box: Q always ends on a side) - face the body.
      const l = hl > 1e-9 ? hl : 1;
      nx = -dx / l; nz = -dz / l;
    }
    // Insert into the sorted top list.
    let j = kept < top ? kept++ : kept - 1;
    while (j > 0 && TOPS[j - 1].score > sc) { copyAnchor(TOPS[j], TOPS[j - 1]); j--; }
    const t = TOPS[j];
    t.solid = s.id; t.ax = qx; t.ay = qy; t.az = qz; t.nx = nx; t.nz = nz; t.rim = rim; t.score = sc;
  }
  if (kept === 0) return false;
  let best = Infinity;
  const vx = vel ? vel.x : fx * speed, vy = vel ? vel.y : 0, vz = vel ? vel.z : fz * speed;
  for (let i = 0; i < kept; i++) {
    const c = TOPS[i];
    if (c.score >= best) break;
    pivotFor(idx, k, x, z, c);
    let sc = c.score;
    if (top > 1 && !swingClear(idx, k, x, y, z, vx, vy, vz, c.px, c.py, c.pz, skipRoof)) sc += k.anchorArcPenalty;
    if (sc < best) { best = sc; copyAnchor(out, c); out.score = sc; }
  }
  return true;
}

/** Round 11: how many of the best-scoring anchors get the swing look-ahead. */
export const ARC_TOP = 4;
const TOPS: AnchorHit[] = [emptyAnchor(), emptyAnchor(), emptyAnchor(), emptyAnchor()];

/**
 * Pivot (round 10): pushed off the face into the open air in front of it (a ray along the normal just under
 * the anchor): swingOutFree of that gap (0.5 = the middle of the street), at least swingOutMin but never past
 * the middle and never further out than the body at (x, z), at most swingOut. A web to a side building then
 * swings you down the street (the arc crosses toward its middle), not into that building's wall; from a wall
 * run on that face it carries you swingOutMin off it. Fills a.px / py / pz from a's anchor point and normal.
 */
export function pivotFor(idx: CityIndex, k: Tuning, x: number, z: number, a: AnchorHit): void {
  const ox = a.ax + a.nx * 0.05, oy = a.ay - 1, oz = a.az + a.nz * 0.05, reach = 2 * k.swingOut;
  const t = idx.segmentHit(ox, oy, oz, ox + a.nx * reach, oy, oz + a.nz * reach, a.solid, -1);
  const free = t >= 0 ? t * reach : reach;
  // ...and never further out than you are (a plaza or the city's edge must not pull you out over the open).
  const dist = (x - a.ax) * a.nx + (z - a.az) * a.nz;
  const off = Math.min(k.swingOut, Math.max(Math.min(k.swingOutMin, 0.5 * free), Math.min(k.swingOutFree * free, dist > k.swingOutMin ? dist : k.swingOutMin)));
  a.px = a.ax + a.nx * off;
  a.py = a.ay;
  a.pz = a.az + a.nz * off;
}

/** Round 11 swing look-ahead: step (s), horizon (s). */
export const ARC_DT = 0.08;
export const ARC_T = 1.2;
const FA = emptyFace();

/**
 * Round 11: a coarse run of the swing a web to pivot (px, py, pz) gives from the body centre (x, y, z) moving
 * (vx, vy, vz): ARC_DT steps under rope gravity with the rope (attach length, reeled toward the floor clamp)
 * and its constraint, the slack flight included, until the fling (the auto-release rule), the pivot's height or
 * ARC_T. False when that path meets a facade head-on (more speed into the face than along it, or less than
 * wallRunMinSpeed along it: a slam, not a wall run). Landing on a roof top counts as clear; the roof stood on is
 * skipped (a web from a roof lifts you off it first). Allocation-free.
 */
export function swingClear(idx: CityIndex, k: Tuning, x: number, y: number, z: number, vx: number, vy: number, vz: number, px: number, py: number, pz: number, skipRoof: number): boolean {
  let rx = x - px, ry = y - py, rz = z - pz;
  let L = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const floor = idx.groundBelow(px, pz, py);
  const target = Math.min(L, Math.max(k.ropeMin, py - floor - k.swingFloorClear - k.halfHeight));
  const g = k.gravity * k.swingGravity, dt = ARC_DT, feet = k.halfHeight;
  // (A model without bounds - a test rig - has no city edge.)
  const B = idx.model.bounds, edge = k.edgeAvoid > 0 && B !== undefined;
  const out0 = edge && (x < B.x0 || x > B.x1 || z < B.z0 || z > B.z1);
  let taut = false;
  for (let t = 0; t < ARC_T; t += dt) {
    if (L > target) L = Math.max(target, L - k.swingReel * dt);
    vy -= g * dt;
    let nx = x + vx * dt, ny = y + vy * dt, nz = z + vz * dt;
    rx = nx - px; ry = ny - py; rz = nz - pz;
    const d = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (d > L && d > 1e-6) {
      const ux = rx / d, uy = ry / d, uz = rz / d;
      nx = px + ux * L; ny = py + uy * L; nz = pz + uz * L;
      const vr = vx * ux + vy * uy + vz * uz;
      if (vr > 0) { vx -= vr * ux; vy -= vr * uy; vz -= vr * uz; }
      taut = true;
    }
    // The body's feet sweep the segment (its centre line, a little low): a side face met head-on = a slam.
    if (segmentFace(idx, x, y - feet * 0.5, z, nx, ny - feet * 0.5, nz, skipRoof, FA)) {
      if (FA.nx === 0 && FA.nz === 0) return true; // onto a roof top
      const vin = -(vx * FA.nx + vz * FA.nz), va0 = vx * -FA.nz + vz * FA.nx, va = va0 < 0 ? -va0 : va0;
      return !(vin > va || va < k.wallRunMinSpeed);
    }
    x = nx; y = ny; z = nz;
    // (Round 11: a swing that carries you out past the city's edge is no better than one into a wall.)
    if (edge && !out0 && (x < B.x0 || x > B.x1 || z < B.z0 || z > B.z1)) return false;
    if (y > py - k.autoReleaseBelow) return true;
    if (taut && vy > 0) {
      const hx = x - px, hz = z - pz, hh = Math.sqrt(hx * hx + hz * hz), vh = Math.sqrt(vx * vx + vz * vz);
      const r = Math.sqrt(hh * hh + (y - py) * (y - py));
      if (hh > 1e-6 && vh > 1 && hx * vx + hz * vz > 0.5 * hh * vh && r > 1e-6 && -(y - py) / r < k.swingReleaseCos) return true;
    }
  }
  return true;
}

/**
 * Round 11: the first solid the segment a -> b enters (skip = an id to ignore) and the face it enters through:
 * out.solid, out.nx / nz (0, 0 = its top), out.dist = the parametric t. False when nothing is hit.
 */
export function segmentFace(idx: CityIndex, ax: number, ay: number, az: number, bx: number, by: number, bz: number, skip: number, out: FaceHit): boolean {
  const n = idx.nearbySolids(ax < bx ? ax : bx, az < bz ? az : bz, ax > bx ? ax : bx, az > bz ? az : bz);
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  let best = -1;
  out.solid = -1;
  for (let i = 0; i < n; i++) {
    const s = idx.solids[idx.out[i]];
    if (s.id === skip) continue;
    const t = slab(ax, ay, az, dx, dy, dz, s.x0, 0, s.z0, s.x1, s.top, s.z1);
    if (t < 0 || (best >= 0 && t >= best)) continue;
    best = t;
    // The entry face: the one the entry point lies on (closest).
    const hx = ax + dx * t, hy = ay + dy * t, hz = az + dz * t;
    const e0 = hx - s.x0, e1 = s.x1 - hx, e2 = hz - s.z0, e3 = s.z1 - hz, e4 = s.top - hy;
    const a0 = e0 < 0 ? -e0 : e0, a1 = e1 < 0 ? -e1 : e1, a2 = e2 < 0 ? -e2 : e2, a3 = e3 < 0 ? -e3 : e3, a4 = e4 < 0 ? -e4 : e4;
    const m = Math.min(a0, a1, a2, a3, a4);
    out.solid = s.id; out.dist = t; out.top = s.top;
    if (m === a4) { out.nx = 0; out.nz = 0; }
    else if (m === a0) { out.nx = -1; out.nz = 0; }
    else if (m === a1) { out.nx = 1; out.nz = 0; }
    else if (m === a2) { out.nx = 0; out.nz = -1; }
    else { out.nx = 0; out.nz = 1; }
  }
  return out.solid >= 0;
}

/**
 * Nearest side face within `reach` of the body's side (half width hw) with wall at the body's height
 * (top > feet + 0.2) and the body centre inside its span along the face. Ties -> lower solid id.
 */
export function wallProbe(idx: CityIndex, x: number, feet: number, z: number, hw: number, reach: number, out: FaceHit): boolean {
  const e = hw + reach;
  const n = idx.nearbySolids(x - e, z - e, x + e, z + e);
  let best = Infinity;
  out.solid = -1;
  for (let i = 0; i < n; i++) {
    const s = idx.solids[idx.out[i]];
    if (s.top <= feet + 0.2) continue;
    if (z >= s.z0 && z <= s.z1) {
      const g0 = s.x0 - (x + hw), g1 = (x - hw) - s.x1;
      if (g0 >= -1e-6 && g0 <= reach && g0 < best) { best = g0; setFace(out, s, -1, 0, g0); }
      if (g1 >= -1e-6 && g1 <= reach && g1 < best) { best = g1; setFace(out, s, 1, 0, g1); }
    }
    if (x >= s.x0 && x <= s.x1) {
      const g2 = s.z0 - (z + hw), g3 = (z - hw) - s.z1;
      if (g2 >= -1e-6 && g2 <= reach && g2 < best) { best = g2; setFace(out, s, 0, -1, g2); }
      if (g3 >= -1e-6 && g3 <= reach && g3 < best) { best = g3; setFace(out, s, 0, 1, g3); }
    }
  }
  return out.solid >= 0;
}

function setFace(out: FaceHit, s: Solid, nx: number, nz: number, gap: number): void {
  out.solid = s.id; out.nx = nx; out.nz = nz; out.dist = gap > 0 ? gap : 0; out.top = s.top;
  if (nx !== 0) { out.lo = s.z0; out.hi = s.z1; } else { out.lo = s.x0; out.hi = s.x1; }
}

/**
 * First side face the body (half width hw) meets moving from (x, z) along unit (dx, dz) within `look`,
 * among solids reaching into feet+0.1..feet+1.6 (vault / climb check). dist 0 = already touching. `skip` = a solid to
 * ignore (round 11: the wall you are running on).
 */
export function obstacleAhead(idx: CityIndex, x: number, feet: number, z: number, dx: number, dz: number, look: number, hw: number, out: FaceHit, skip = -1): boolean {
  const ex = x + dx * look, ez = z + dz * look;
  const n = idx.nearbySolids((x < ex ? x : ex) - hw, (z < ez ? z : ez) - hw, (x > ex ? x : ex) + hw, (z > ez ? z : ez) + hw);
  let best = Infinity;
  out.solid = -1;
  for (let i = 0; i < n; i++) {
    const s = idx.solids[idx.out[i]];
    if (s.top <= feet + 0.1 || s.id === skip) continue;
    const bx0 = s.x0 - hw, bx1 = s.x1 + hw, bz0 = s.z0 - hw, bz1 = s.z1 + hw;
    if (x > bx0 && x < bx1 && z > bz0 && z < bz1) continue; // overlapping already (collision's job)
    let tx0 = -Infinity, tx1 = Infinity, tz0 = -Infinity, tz1 = Infinity;
    if (dx !== 0) { const a = (bx0 - x) / dx, b = (bx1 - x) / dx; tx0 = a < b ? a : b; tx1 = a < b ? b : a; }
    else if (x < bx0 || x > bx1) continue;
    if (dz !== 0) { const a = (bz0 - z) / dz, b = (bz1 - z) / dz; tz0 = a < b ? a : b; tz1 = a < b ? b : a; }
    else if (z < bz0 || z > bz1) continue;
    const t0 = tx0 > tz0 ? tx0 : tz0, t1 = tx1 < tz1 ? tx1 : tz1;
    if (t0 > t1 || t1 < 0 || t0 > look) continue;
    const t = t0 > 0 ? t0 : 0;
    if (t >= best) continue;
    best = t;
    if (tx0 > tz0) setFace(out, s, dx > 0 ? -1 : 1, 0, t); else setFace(out, s, 0, dz > 0 ? -1 : 1, t);
  }
  return out.solid >= 0;
}

/**
 * A grabbable ledge: the face with outward normal (nx, nz) (axis-aligned; -n = into it) within LEDGE_REACH of
 * the body side, the body centre inside its span, whose landable top is in [feet+lo, feet+hi] and whose rim
 * is not covered by a taller solid (room to climb in).
 */
export function ledgeAt(idx: CityIndex, x: number, feet: number, z: number, hw: number, nx: number, nz: number, lo: number, hi: number, out: FaceHit): boolean {
  const e = hw + LEDGE_REACH;
  const n = idx.nearbySolids(x - e, z - e, x + e, z + e);
  let best = Infinity;
  out.solid = -1;
  for (let i = 0; i < n; i++) {
    const s = idx.solids[idx.out[i]];
    if (!s.landable || s.top < feet + lo || s.top > feet + hi) continue;
    let g = Infinity;
    if (nx < -0.5) { if (z >= s.z0 && z <= s.z1) g = s.x0 - (x + hw); }
    else if (nx > 0.5) { if (z >= s.z0 && z <= s.z1) g = (x - hw) - s.x1; }
    else if (nz < -0.5) { if (x >= s.x0 && x <= s.x1) g = s.z0 - (z + hw); }
    else if (x >= s.x0 && x <= s.x1) g = (z - hw) - s.z1;
    if (g < -1e-6 || g > LEDGE_REACH || g >= best) continue;
    best = g;
    setFace(out, s, nx < -0.5 ? -1 : nx > 0.5 ? 1 : 0, nx < -0.5 || nx > 0.5 ? 0 : nz < 0 ? -1 : 1, g);
  }
  if (out.solid < 0) return false;
  // Room to climb in: nothing taller than the ledge covers the point just inside the rim.
  const s = idx.solids[out.solid];
  const cx = out.nx !== 0 ? faceCoord(s, out.nx, 0) - out.nx * (hw + 0.3) : x;
  const cz = out.nz !== 0 ? faceCoord(s, 0, out.nz) - out.nz * (hw + 0.3) : z;
  const m = idx.nearbySolids(cx, cz, cx, cz);
  for (let i = 0; i < m; i++) {
    const o = idx.solids[idx.out[i]];
    if (o.id === s.id || cx < o.x0 || cx > o.x1 || cz < o.z0 || cz > o.z1) continue;
    if (o.top > s.top + 0.05) { out.solid = -1; return false; }
  }
  return true;
}
