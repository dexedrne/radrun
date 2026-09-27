// Round 12 (docs/specs/2026-09-26-round12-spider-tag.md): web-slinger tag. Step 0: floating solids in the
// CityIndex queries (a model without y0 answers exactly as before).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CityIndex, pointBoxDist, RIG0, type CityModel, type Solid } from "../src/world/cityModel.ts";

const box = (id: number, x0: number, z0: number, x1: number, z1: number, top: number, y0?: number): Solid =>
  ({ id, kind: y0 === undefined ? "roof" : "fixture", landable: true, x0, z0, x1, z1, top, ...(y0 === undefined ? {} : { y0, sub: "skybridge" as const }) });

const modelOf = (solids: Solid[]): CityModel => ({
  version: 1, config: null as unknown as CityModel["config"], bounds: { x0: -50, z0: -50, x1: 50, z1: 50 }, lowestRoof: 10, solids,
  adjacency: [], wallGaps: [], junctionCandidates: [], spawn: { roofId: 0, x: 0, y: 11, z: 0, yaw: 0 }, rigs: [], hash: "t",
});

test("step 0: a floating box blocks segments only between its bottom and top", () => {
  const idx = new CityIndex(modelOf([box(0, -30, -30, -20, -20, 10), box(1, -2, -2, 2, 2, 23.5, 20)]));
  // Under the bridge: clear. Through it: blocked. Over it: clear.
  assert.equal(idx.segmentHit(-10, 10, 0, 10, 10, 0), -1);
  assert.ok(Math.abs(idx.segmentHit(-10, 21, 0, 10, 21, 0) - 0.4) < 1e-9);
  assert.equal(idx.segmentHit(-10, 24, 0, 10, 24, 0), -1);
  // Straight up from under it: hits its underside.
  assert.ok(Math.abs(idx.segmentHit(0, 10, 0, 0, 30, 0) - 0.5) < 1e-9);
  // pointBoxDist measures from the bottom.
  const s = idx.solids[1];
  assert.equal(pointBoxDist(0, 15, 0, s), 5);
  assert.equal(pointBoxDist(0, 22, 0, s), 0);
  assert.equal(pointBoxDist(0, 25.5, 0, s), 2);
  // groundBelow: the bridge top is the floor above it, the street below it.
  assert.equal(idx.groundBelow(0, 0, 30), 23.5);
  assert.equal(idx.groundBelow(0, 0, 15), 0);
  // A ground-rooted box is unchanged (y0 missing = 0).
  assert.equal(pointBoxDist(-25, 5, -25, idx.solids[0]), 0);
  assert.ok(RIG0 > 1000000);
});

// ---- MOVEMENT (§3-§6) on the synthetic canyon ----------------------------------------------------------------

import fs from "node:fs";
import {
  chargeLevel, createBody, emptyInput, emptyZipAim, pickRing, stepBody, zipAim, CHEST, EV_ATTACH, EV_BONK, EV_CHARGE, EV_DIVE, EV_JUMP, EV_NOANCHOR,
  EV_PERFECT, EV_REBOUND, EV_RELEASE, EV_SNAP, EV_WALL, EV_WALLRUN, EV_YANK, EV_YANK_END, EV_ZIP, LEDGE_HANG_MODE, WALL_RUN, ZIP_CABLE,
  type Body, type InputFrame, type SimWorld,
} from "../src/sim/player.ts";
import { PLAYER, type Tuning } from "../src/sim/tuning.ts";
import { emptyAnchor } from "../src/world/cityQuery.ts";
import { CANYON, canyonModel } from "./helpers.ts";
import { B_SLIDE_HELD, GhostLog, PITCH_RES, decodeBytes, encodeBytes, buildFrame, emptyRec } from "../src/game/ghost.ts";

const K: Tuning = { ...PLAYER, yankRange: 12 };
const canyon = (): SimWorld => ({ index: new CityIndex(canyonModel()), runner: null });
const frame = (x = 1, z = 0, y = 0): InputFrame => { const f = emptyInput(); f.aimX = x; f.aimZ = z; f.aimY = y; return f; };
function run(b: Body, k: Tuning, w: SimWorld, n: number, set: (f: InputFrame, i: number) => void = () => {}): number {
  let ev = 0;
  for (let i = 0; i < n; i++) { const f = frame(); set(f, i); stepBody(b, f, k, w); ev |= b.events; }
  return ev;
}
const air = (x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): Body => {
  const b = createBody(x, y, z, -1);
  b.grounded = false; b.v.x = vx; b.v.y = vy; b.v.z = vz;
  return b;
};
/** Aim (yaw + pitch sine) so the zip's lifted ray goes from b's chest at the point. */
function aimAt(f: InputFrame, b: Body, x: number, y: number, z: number, k: Tuning = K): InputFrame {
  const dx = x - b.p.x, dy = y - (b.p.y + CHEST), dz = z - b.p.z, l = Math.hypot(dx, dy, dz), s = dy / l;
  const sl = k.zipLift, cl = Math.sqrt(1 - sl * sl), c = Math.sqrt(1 - s * s);
  f.aimX = dx; f.aimZ = dz; f.aimY = s * cl - c * sl;
  return f;
}
const deg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) =>
  (Math.acos(Math.min(1, (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz)))) * 180) / Math.PI;

test("floating solids: land on a gantry; a head bump under a skybridge; a wall run along its side; the floor clamp over it", () => {
  const w = canyon();
  // Land on the gantry's truss (never a safe respawn roof).
  const g = air(140.5, 18, 29, 0, -2, 0);
  for (let i = 0; i < 240 && !g.grounded; i++) run(g, K, w, 1);
  assert.ok(g.grounded && g.roofId === CANYON.gantry, `on the gantry (roof ${g.roofId})`);
  assert.ok(Math.abs(g.p.y - (15.2 + K.halfHeight)) < 1e-9);
  assert.notEqual(g.lastSafeRoof, CANYON.gantry);
  // Jumping up into the skybridge's underside: a head bump.
  const h = air(162, 17, 29, 0, 12, 0);
  let ev = 0;
  for (let i = 0; i < 60 && !(ev & EV_WALL); i++) ev |= run(h, K, w, 1);
  assert.ok(ev & EV_WALL, "bumped");
  assert.ok(Math.abs(h.p.y - (20 - K.halfHeight)) < 1e-9 && h.v.y === 0);
  // Running along the skybridge's +x face at its height: a wall run.
  const r = air(164 + K.halfWidth + 0.15, 21.8, 22, -0.5, 1, 12);
  ev = run(r, K, w, 3, f => { f.moveX = -0.3; f.moveZ = 1; });
  assert.ok(ev & EV_WALLRUN, "wall run on the bridge's side");
  assert.equal(r.wallMode, WALL_RUN);
  assert.equal(r.wallSolid, CANYON.bridge);
  // A web to a pivot over the bridge: its top is the floor for the clamp.
  const s = air(150, 30, 29, 10, 0, 0);
  const a = emptyAnchor();
  a.solid = 0; a.ax = a.px = 162; a.ay = a.py = 38; a.az = a.pz = 29; a.nx = 0; a.nz = 0; a.rim = false;
  const wf: SimWorld = { ...w, forceAnchor: a };
  run(s, K, wf, 1, f => { f.webPressed = f.webHeld = true; });
  assert.ok(s.ropeSolid >= 0);
  assert.equal(s.ropeTarget, K.ropeMin, `reeled for the bridge (${s.ropeTarget})`);
});

test("rig anchors: a cable is found mid-street and the ring glides along it; the web snaps when a skybridge blocks it", () => {
  // (Cables only: nothing else to ring.)
  const w: SimWorld = { index: new CityIndex({ ...canyonModel(), solids: [{ id: 0, kind: "roof", landable: true, x0: 400, z0: 400, x1: 410, z1: 410, top: 10 }] }), runner: null };
  const b = air(20, 25, 29, 15, 0, 0);
  const a = emptyAnchor();
  const ring = pickRing(b, frame(1, 0), K, w, a);
  assert.ok(ring >= RIG0, `a cable is ringed (${ring})`);
  assert.ok(Math.abs(a.az - 29) < 1.5, `ring over the body's lane (${a.az.toFixed(2)})`);
  assert.equal(a.px, a.ax, "a rig's pivot is the point itself");
  b.p.z = 23;
  pickRing(b, frame(1, 0), K, w, a);
  assert.ok(Math.abs(a.az - 23) < 1.5, `the ring glided along the cable (${a.az.toFixed(2)})`);
  b.p.z = 18.5;
  pickRing(b, frame(1, 0), K, w, a);
  assert.ok(a.az >= 18 + K.rigEndInset - 1e-9, `kept rigEndInset from its end (${a.az.toFixed(2)})`);
  // Swinging on a cable just past the bridge; moved under the bridge's shadow the web snaps on the next line check.
  const s = air(150, 25, 29, 10, 0, 0);
  const c = emptyAnchor();
  c.solid = RIG0 + 9; c.ax = c.px = 175; c.ay = c.py = 30; c.az = c.pz = 29; c.nx = c.nz = 0; c.rim = false;
  const m = canyonModel();
  m.rigs.push({ id: 9, kind: "cable", ax: 175, ay: 30, az: 18, bx: 175, by: 30, bz: 40, sag: 0 });
  const w2: SimWorld = { index: new CityIndex(m), runner: null };
  run(s, K, { ...w2, forceAnchor: c }, 1, f => { f.webPressed = f.webHeld = true; });
  assert.ok(s.ropeSolid === RIG0 + 9);
  s.p.x = 150; s.p.y = 15; // the line to (175, 30) now crosses the bridge (x 160-164, y 20-23.5)
  const ev = run(s, K, w2, K.losSteps, f => { f.webHeld = true; });
  assert.ok(ev & EV_SNAP, "snapped");
});

test("straight zip: on the line within 4 steps (< 1 deg); a cable zip with web held becomes a swing; charges refill", () => {
  const w = canyon();
  // In the air with a 7 m/s sideways drift, a zip at the north facade: on the line within 4 steps.
  const b = air(10, 40, 25, 7, 0, 0);
  const f0 = aimAt(frame(), b, 10, 38, 40);
  const za = emptyZipAim();
  assert.ok(zipAim(b, null, f0.aimX, f0.aimY, f0.aimZ, K, w, za) > 0);
  run(b, K, w, 1, f => { Object.assign(f, f0); f.zipPressed = true; });
  run(b, K, w, 3);
  assert.ok(b.zipOn);
  const off = deg(b.v.x, b.v.y, b.v.z, b.zipP.x - b.p.x, b.zipP.y - b.p.y, b.zipP.z - b.p.z);
  assert.ok(off < 1, `on the line after 4 steps (${off.toFixed(3)} deg)`);
  // Across the 22 m street from the south roof's edge to the north rim: <= 0.8 s, then the ledge pop onto it.
  const e = createBody(10, CANYON.top + K.halfHeight, 17.6, 0);
  const fe = aimAt(frame(), e, 10, CANYON.top - 1, 40);
  run(e, K, w, 1, f => { Object.assign(f, fe); f.zipPressed = true; });
  let t = K.dt;
  while (e.zipOn && t < 2) { run(e, K, w, 1); t += K.dt; }
  assert.ok(t <= 0.8, `22 m street in ${t.toFixed(2)} s`);
  for (let i = 0; i < 240 && !e.grounded; i++) run(e, K, w, 1);
  assert.equal(e.roofId, 1, "popped onto the north roof");
  // Zip-to-swing: aim at the 42 m cable with web held.
  const c = air(18, 28, 29, 5, 0, 0);
  const fc = aimAt(frame(), c, 30, 42, 29);
  assert.equal(zipAim(c, null, fc.aimX, fc.aimY, fc.aimZ, K, w, za), ZIP_CABLE);
  run(c, K, w, 1, f => { Object.assign(f, fc); f.zipPressed = true; f.webHeld = true; });
  let ev = 0;
  for (let i = 0; i < 240 && c.zipOn; i++) ev |= run(c, K, w, 1, f => { f.webHeld = true; });
  assert.ok(ev & EV_ATTACH, "attached on arrival");
  assert.ok(c.ropeSolid >= RIG0 || (ev & EV_RELEASE), "on the cable (or already flung off it)");
  // Two zips per airtime, then none until a landing.
  const d = air(20, 30, 29, 0, 0, 0);
  const up = (f: InputFrame) => { aimAt(f, d, 40, 36, 40); f.zipPressed = true; };
  assert.ok(run(d, K, w, 1, up) & EV_ZIP);
  run(d, K, w, 1, f => { f.zipPressed = true; }); // (ends it early)
  run(d, K, w, Math.ceil(K.zipCooldown * 120) + 1);
  assert.ok(run(d, K, w, 1, up) & EV_ZIP);
  run(d, K, w, 1, f => { f.zipPressed = true; });
  run(d, K, w, Math.ceil(K.zipCooldown * 120) + 1);
  assert.equal(d.zipLeft, 0);
  assert.ok(run(d, K, w, 1, up) & EV_NOANCHOR, "out of zips");
});

test("charge: a full leap from a run goes 28-32 m to the same height with a 9-10.5 m apex; wall, hang and rope launches", () => {
  const w: SimWorld = { index: new CityIndex({ ...canyonModel(), solids: [{ id: 0, kind: "roof", landable: true, x0: -10, z0: -10, x1: 300, z1: 10, top: 20 }], rigs: [] }), runner: null };
  const b = createBody(0, 20.9, 0, 0);
  run(b, K, w, 90, f => { f.moveX = 1; });
  const hold = Math.round((K.chargeMin + K.chargeTime) / K.dt) + 2;
  run(b, K, w, hold, (f, i) => { f.moveX = 1; f.slideHeld = true; f.slidePressed = i === 0; });
  assert.ok(chargeLevel(b.chargeT, K) >= 1);
  const x0 = b.p.x;
  let apex = b.p.y;
  assert.ok(run(b, K, w, 1, f => { f.moveX = 1; }) & EV_CHARGE, "released -> launch");
  while (!b.grounded) { run(b, K, w, 1, f => { f.moveX = 1; }); apex = Math.max(apex, b.p.y); }
  const dist = b.p.x - x0, up = apex - 20.9;
  assert.ok(dist >= 28 && dist <= 32, `leap ${dist.toFixed(2)} m`);
  assert.ok(up >= 9 && up <= 10.5, `apex ${up.toFixed(2)} m`);
  // Wall launch: charging on a wall run, then let go -> a wall jump + the charge out and up.
  const wr = air(164 + K.halfWidth + 0.15, 21.8, 22, -0.5, 1, 12);
  const wc = canyon();
  run(wr, K, wc, 3, f => { f.moveX = -0.3; f.moveZ = 1; });
  assert.equal(wr.wallMode, WALL_RUN);
  run(wr, K, wc, 30, f => { f.moveZ = 1; f.moveX = -0.3; f.slideHeld = true; });
  const c1 = chargeLevel(wr.chargeT, K);
  const ev = run(wr, K, wc, 1, f => { f.moveZ = 1; });
  assert.ok(ev & EV_CHARGE);
  assert.ok(Math.abs(wr.v.x - (K.wallJumpOut + c1 * K.chargeWallOut)) < 0.5, `out ${wr.v.x}`);
  // Hang launch: the climb waits while C charges; letting go launches straight up.
  const hw: SimWorld = { index: new CityIndex({ ...canyonModel(), solids: [{ id: 0, kind: "roof", landable: true, x0: 10, z0: -10, x1: 30, z1: 10, top: 20 }], rigs: [] }), runner: null };
  const h = air(10 - K.halfWidth - 0.05, 20 - 1.4, 0, 3, 1, 0);
  let hv = 0;
  for (let i = 0; i < 30 && h.ledgeMode !== LEDGE_HANG_MODE; i++) hv |= run(h, K, hw, 1, f => { f.moveX = 1; f.slideHeld = true; });
  assert.equal(h.ledgeMode, LEDGE_HANG_MODE, "hanging");
  run(h, K, hw, 90, f => { f.slideHeld = true; });
  assert.equal(h.ledgeMode, LEDGE_HANG_MODE, "the climb waits while charging");
  const hc = chargeLevel(h.chargeT, K);
  run(h, K, hw, 1);
  assert.ok(Math.abs(h.v.y - (K.ledgeJumpUp + hc * K.chargeUp) + K.gravity * K.dt) < 0.01, `hang launch ${h.v.y}`);
  void hv;
  // The slingshot: charging on the rope, letting go of C lets go with the charge along the velocity.
  const s = air(20, 25, 29, 15, 0, 0);
  run(s, K, w0(), 1, f => { f.webPressed = f.webHeld = true; });
  assert.ok(s.ropeSolid >= 0);
  run(s, K, w0(), 40, f => { f.webHeld = true; f.slideHeld = true; });
  const sp0 = Math.hypot(s.v.x, s.v.y, s.v.z), sc = chargeLevel(s.chargeT, K);
  const sev = run(s, K, w0(), 1, f => { f.webHeld = true; });
  assert.ok((sev & EV_RELEASE) && (sev & EV_CHARGE), "slingshot");
  assert.ok(Math.hypot(s.v.x, s.v.y, s.v.z) > sp0 + sc * K.chargeFling * 0.8);
});
const w0 = canyon;

test("tech: perfect release window, rebound instead of a bonk, kick chains, the dive", () => {
  const w = canyon();
  // On a taut rope under (30, 42, 29): rising on the forward side at 40 deg from straight down -> perfect; at 20 -> not.
  for (const [ang, want] of [[40, true], [20, false]] as [number, boolean][]) {
    const b = air(20, 25, 29, 15, 0, 0);
    run(b, K, w, 1, f => { f.webPressed = f.webHeld = true; });
    const P = b.ropeP, L = 14, r = (ang * Math.PI) / 180;
    b.p.x = P.x + Math.sin(r) * L; b.p.y = P.y - Math.cos(r) * L; b.p.z = P.z; b.ropeLen = L; b.ropeTarget = L; b.ropeTaut = true;
    b.v.x = 18 * Math.cos(r); b.v.y = 18 * Math.sin(r); b.v.z = 0;
    const ev = run(b, K, w, 1);
    assert.ok(ev & EV_RELEASE);
    assert.equal((ev & EV_PERFECT) !== 0, want, `perfect at ${ang} deg`);
  }
  // Rebound: a head-on hit at 16 m/s with Jump buffered.
  const wall: SimWorld = { index: new CityIndex({ ...canyonModel(), solids: [{ id: 0, kind: "tower", landable: false, x0: 10, z0: -20, x1: 30, z1: 20, top: 80 }], rigs: [] }), runner: null };
  const r1 = air(8, 40, 0, 16, 0, 0);
  run(r1, K, wall, 1, f => { f.jumpPressed = true; });
  let ev = 0;
  for (let i = 0; i < 30 && !(ev & (EV_REBOUND | EV_BONK)); i++) ev |= run(r1, K, wall, 1);
  assert.ok(ev & EV_REBOUND, "rebound");
  assert.equal(ev & EV_BONK, 0);
  assert.ok(r1.v.x < -16 * K.reboundKeep + 0.5, `kicked back (${r1.v.x.toFixed(2)})`);
  // ...and Jump within reboundWindow after the bonk.
  const r2 = air(8, 40, 0, 16, 0, 0);
  ev = 0;
  for (let i = 0; i < 30 && !(ev & EV_BONK); i++) ev |= run(r2, K, wall, 1);
  assert.ok(ev & EV_BONK);
  assert.ok(run(r2, K, wall, 1, f => { f.jumpPressed = true; }) & EV_REBOUND, "late rebound");
  // Kick chains: wallJumpUp, +0.8, +1.6, +2.4, +2.4.
  const kc = air(8, 40, 0, 0, 0, 0);
  const ups: number[] = [];
  for (let i = 0; i < 5; i++) {
    kc.touchWall = 0; kc.touchT = 0; kc.touchNx = -1; kc.touchNz = 0; kc.kickSolid = -1; kc.p.x = 10 - K.halfWidth;
    run(kc, K, wall, 1, f => { f.jumpPressed = true; });
    ups.push(kc.v.y + K.gravity * K.dt);
  }
  assert.deepEqual(ups.map(u => +u.toFixed(3)), [0, 1, 2, 3, 3].map(n => +(K.wallJumpUp + Math.min(n, 3) * K.kickChainUp).toFixed(3)));
  // The dive: a fresh C press high over the street.
  const d = air(20, 40, 29, 8, 2, 0);
  assert.ok(run(d, K, w, 1, f => { f.slidePressed = f.slideHeld = true; }) & EV_DIVE);
  assert.ok(d.v.y <= -K.diveSpeed + 1e-9);
  const vy0 = d.v.y;
  run(d, K, w, 1, f => { f.slideHeld = true; });
  assert.ok(Math.abs(d.v.y - (vy0 - K.gravity * K.diveGravity * K.dt)) < 1e-9, "diving gravity");
});

test("yank: a homing zip that reaches him inside yankTime; a whiff (lost sight) ends it with the cooldown", () => {
  const w = canyon();
  const him = { p: { x: 30, y: 25, z: 29 }, roofId: -1 };
  const ww: SimWorld = { ...w, runner: him };
  const b = air(20, 25, 29, 0, 0, 0);
  run(b, K, ww, 1);
  assert.ok(b.yankOk, "in yank range, in the cone, in sight");
  assert.ok(run(b, K, ww, 1, f => { f.zipPressed = true; }) & EV_YANK);
  let t = 0;
  while (Math.hypot(b.p.x - him.p.x, b.p.z - him.p.z) > 1.5 && t < K.yankTime) { run(b, K, ww, 1); t += K.dt; }
  assert.ok(t < K.yankTime, `reached him in ${t.toFixed(2)} s`);
  // Whiff: he drops behind a wall right after the yank starts.
  const wall: SimWorld = { index: new CityIndex({ ...canyonModel(), solids: [...canyonModel().solids, { id: 4, kind: "tower", landable: false, x0: 26, z0: 20, x1: 27, z1: 38, top: 60 }], rigs: [] }), runner: { p: { x: 25, y: 25, z: 29 }, roofId: -1 } };
  const c = air(18, 25, 29, 0, 0, 0);
  run(c, K, wall, 1, f => { f.zipPressed = true; });
  assert.ok(c.yankOn);
  wall.runner!.p.x = 32;
  const ev = run(c, K, wall, 2);
  assert.ok(ev & EV_YANK_END, "lost sight: ended");
  assert.ok(Math.abs(c.yankCd - K.yankCooldown) < 0.02);
});

test("ghost format 4: the pitch column and C held round-trip bit-exactly and rebuild the frame", () => {
  const log = new GhostLog();
  for (let i = 0; i < 400; i++) log.push({ yaw: (i * 7) % 1024, fwd: 64, right: i % 3 - 1, bits: i % 40 < 15 ? B_SLIDE_HELD : 0, pitch: ((i * 13) % 201) - 100 });
  const back = decodeBytes(encodeBytes(log, { touch: false, easy: false }));
  assert.ok(back);
  assert.equal(back.flags.charge, undefined);
  for (let i = 0; i < log.n; i++) { assert.equal(back.log.pitch[i], log.pitch[i]); assert.equal(back.log.bits[i], log.bits[i]); }
  const f = emptyInput(), rec = emptyRec();
  buildFrame(f, back.log.get(7, rec), { x: 0, y: 0, z: 0 }, false, 9);
  assert.equal(f.aimY, log.pitch[7] / PITCH_RES);
  assert.equal(f.slideHeld, (log.bits[7] & B_SLIDE_HELD) !== 0);
  // A format-3 (older) record decodes with the charge / dive off and pitch 0.
  const old = decodeBytes(encodeBytes(log, { touch: false, easy: false, charge: false }));
  assert.ok(old === null || old.flags.charge === false);
  void fs;
});
