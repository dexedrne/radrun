// The web-slinger swing (docs/specs/2026-09-27-web-slinger-swing.md): web length from your height, the surge through the bottom
// of the arc, the later auto-release and the wider perfect window with its pop, corner swings, the fast dive and the
// dive-into-swing; the runner and older ghosts keep the round 12 swing exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBody, emptyInput, resetMoves, stepBody, EV_ATTACH, EV_BONK, EV_CHARGE, EV_CORNER, EV_DIVE, EV_FALL, EV_LAND, EV_PERFECT, EV_RELEASE,
  EV_WALLRUN, EV_ZIP, type Body, type InputFrame, type SimWorld,
} from "../src/sim/player.ts";
import { PLAYER, RUNNER, SWING_KEYS, SWING_OFF, SWING_R12, TUNABLE_KEYS, type Tuning } from "../src/sim/tuning.ts";
import { Fnv1a, mulberry32 } from "../src/sim/math.ts";
import { CityIndex } from "../src/world/cityModel.ts";
import { roundTuning, decodeBytes, encodeBytes, GhostLog } from "../src/game/ghost.ts";
import { tallBlocks, tallModel, tallWorld } from "./helpers.ts";

// tallBlocks(7, 4): blocks of 2 x 2 12 m buildings (4 m alleys), 18 m streets (pitch 46): the street along x at z 28..46.
const blocks = tallBlocks(7, 4);
const bw: SimWorld = { index: new CityIndex(blocks), runner: null };

function steps(b: Body, k: Tuning, w: SimWorld, n: number, set: (f: InputFrame, i: number) => void): number {
  let ev = 0;
  for (let i = 0; i < n; i++) {
    const f = emptyInput();
    set(f, i);
    stepBody(b, f, k, w);
    ev |= b.events;
    if (b.events & (EV_LAND | EV_FALL)) break;
  }
  return ev;
}

test("the runner and the older ghosts keep the round 12 swing: every new key off, the shared release point pinned", () => {
  for (const [key, v] of Object.entries(SWING_OFF)) assert.equal((RUNNER as Record<string, unknown>)[key], v, key);
  for (const key of SWING_KEYS) assert.ok((TUNABLE_KEYS as readonly string[]).includes(key), `${key} is a tuning.json / ?tune key`);
  const old = roundTuning(PLAYER, { touch: false, easy: false, swing: false });
  for (const [key, v] of Object.entries(SWING_R12)) assert.equal((old as Record<string, unknown>)[key], v, key);
  assert.equal(roundTuning(PLAYER, { touch: false, easy: false }).swingSurge, PLAYER.swingSurge, "a new record plays the new swing");
});

test("SWING_R12 steps exactly like the round 12 build (a golden digest of swings, releases, dives, zips and charges)", () => {
  // Made with the same script on the round 12 build (its PLAYER): if this moves, v6 links no longer replay faithfully.
  const k = { ...PLAYER, ...SWING_R12 };
  const h = new Fnv1a();
  const seen: Record<string, number> = {};
  for (let run = 0; run < 6; run++) {
    const r = mulberry32(900 + run);
    const b = createBody(10 + run * 30, 60, 37, -1);
    b.grounded = false; b.v.x = 14;
    let yaw = 0, held = 0, c = 0;
    for (let i = 0; i < 1800; i++) {
      const f = emptyInput();
      if (r() < 0.02) yaw += (r() - 0.5) * 2;
      f.aimX = Math.cos(yaw); f.aimZ = Math.sin(yaw); f.aimY = (r() - 0.5) * 0.4;
      f.moveX = f.aimX; f.moveZ = f.aimZ;
      if (r() < 0.1) { f.moveX = -f.aimZ; f.moveZ = f.aimX; }
      if (held <= 0 && r() < 0.03) held = 30 + Math.floor(r() * 120);
      f.webHeld = held > 0;
      if (held > 0) held--;
      if (held > 0) held--;
      f.jumpPressed = r() < 0.01; f.zipPressed = r() < 0.004;
      if (c <= 0 && r() < 0.01) c = 10 + Math.floor(r() * 90);
      f.slidePressed = c > 0 && r() < 0.1; f.slideHeld = c-- > 0;
      stepBody(b, f, k, bw);
      for (const [n, e] of Object.entries({ attach: EV_ATTACH, dive: EV_DIVE, zip: EV_ZIP, charge: EV_CHARGE, perfect: EV_PERFECT, wallrun: EV_WALLRUN })) if (b.events & e) seen[n] = (seen[n] ?? 0) + 1;
      h.f64(b.p.x).f64(b.p.y).f64(b.p.z).f64(b.v.x).f64(b.v.y).f64(b.v.z).i32(b.ropeSolid).i32(b.grounded ? 1 : 0).i32(b.events);
      if (b.events & EV_FALL) { resetMoves(b); b.p.x = 10; b.p.y = 60; b.p.z = 37; b.v.x = b.v.y = b.v.z = 0; b.grounded = false; }
    }
  }
  for (const n of ["attach", "dive", "zip", "charge", "perfect", "wallrun"]) assert.ok((seen[n] ?? 0) > 0, `the script covers ${n}`);
  assert.equal(h.hex(), "fcf6b555");
});

test("ghost format 5 = the web-slinger swing; a format-4 record decodes as the round 12 swing (swing: false)", () => {
  const log = new GhostLog(10);
  for (let i = 0; i < 10; i++) log.push({ yaw: i, fwd: 64, right: 0, bits: 36, pitch: 3 });
  const now = encodeBytes(log, { touch: false, easy: false });
  assert.equal(now[0], 5);
  assert.equal(decodeBytes(now)?.flags.swing, undefined);
  const old = encodeBytes(log, { touch: false, easy: false, swing: false });
  assert.equal(old[0], 4);
  const d = decodeBytes(old);
  assert.ok(d);
  assert.equal(d.flags.swing, false);
  assert.equal(d.log.pitch[0], 3, "the same columns as format 5");
  assert.equal(roundTuning(PLAYER, d.flags).swingSurge, 0);
});

/** A web from high over the street at `y`, flying +x at 16 m/s: the rope length at the attach. */
function ropeFrom(k: Tuning, y: number): number {
  const b = createBody(4, y, 37, -1);
  b.grounded = false; b.v.x = 16;
  steps(b, k, bw, 60, f => { f.aimX = 1; f.moveX = 1; f.webHeld = true; f.webPressed = true; });
  return b.ropeSolid >= 0 ? b.ropeLen : NaN;
}

test("web length from your height: high over the street the web goes to a rim further up and ahead (a longer rope)", () => {
  const flat = { ...PLAYER, anchorHeightGain: 0, anchorHeightAhead: 0 };
  const hiNew = ropeFrom(PLAYER, 70), hiFlat = ropeFrom(flat, 70);
  assert.ok(hiNew > hiFlat + 2, `70 m up: rope ${hiNew.toFixed(1)} vs ${hiFlat.toFixed(1)} m`);
  // Low down (under anchorHeightFree over the ground) nothing changes.
  const lo = createBody(4, 12, 37, -1);
  assert.ok(lo.p.y - PLAYER.halfHeight < PLAYER.anchorHeightFree);
  assert.equal(ropeFrom(PLAYER, 12), ropeFrom(flat, 12));
});

/** One swing off a web taken at 45 m flying +x at 14 m/s (held to the end): max speed on the rope and the release point. */
function oneSwing(k: Tuning): { vMax: number; cosAtRelease: number } {
  const w = tallWorld(tallModel());
  const b = createBody(4, 45, 29, -1);
  b.grounded = false; b.v.x = 14;
  let vMax = 0, cosAtRelease = NaN;
  for (let i = 0; i < 900 && Number.isNaN(cosAtRelease); i++) {
    const f = emptyInput();
    f.aimX = 0.9; f.aimY = 0.3; f.moveX = 1; f.webHeld = true; f.webPressed = i === 0;
    const P = { ...b.ropeP }, on = b.ropeSolid >= 0;
    stepBody(b, f, k, w);
    if (b.ropeSolid >= 0) vMax = Math.max(vMax, Math.hypot(b.v.x, b.v.y, b.v.z));
    if (on && (b.events & EV_RELEASE)) {
      const rx = b.p.x - P.x, ry = b.p.y - P.y, rz = b.p.z - P.z;
      cosAtRelease = -ry / Math.hypot(rx, ry, rz);
    }
  }
  return { vMax, cosAtRelease };
}

test("the surge: faster through the bottom of the arc; held to the end the web lets go later (higher) on the arc", () => {
  const cap = { speedCap: 60 };
  const on = oneSwing({ ...PLAYER, ...cap }), off = oneSwing({ ...PLAYER, ...cap, swingSurge: 0 });
  assert.ok(on.vMax > off.vMax + 1.5, `bottom speed ${on.vMax.toFixed(1)} vs ${off.vMax.toFixed(1)} m/s`);
  const r12 = oneSwing({ ...PLAYER, ...SWING_R12, ...cap });
  assert.ok(on.cosAtRelease < r12.cosAtRelease - 0.05, `auto-release at cos ${on.cosAtRelease.toFixed(2)} vs ${r12.cosAtRelease.toFixed(2)}`);
});

test("perfect release: a wider window up to the auto-release, with a pop up", () => {
  assert.ok(PLAYER.swingPerfectCos > SWING_R12.swingPerfectCos && PLAYER.swingReleaseCos < SWING_OFF.swingReleaseCos, "wider at both ends");
  const fly = (k: Tuning) => {
    const w = tallWorld(tallModel());
    const b = createBody(4, 48, 29, -1);
    b.grounded = false; b.v.x = 16;
    let vy = NaN;
    for (let i = 0; i < 900 && Number.isNaN(vy); i++) {
      const f = emptyInput();
      f.aimX = 0.9; f.aimY = 0.4; f.moveX = 1;
      let held = true;
      if (b.ropeSolid >= 0) {
        const rx = b.p.x - b.ropeP.x, ry = b.p.y - b.ropeP.y, rz = b.p.z - b.ropeP.z;
        if (b.ropeTaut && b.v.y > 0 && rx * b.v.x > 0 && -ry / Math.hypot(rx, ry, rz) < PLAYER.swingPerfectCos - 0.03) held = false;
      }
      f.webHeld = held; f.webPressed = i === 0;
      const before = b.v.y;
      stepBody(b, f, k, w);
      if (b.events & EV_PERFECT) vy = b.v.y - before;
    }
    return vy;
  };
  const pop = fly({ ...PLAYER, speedCap: 60 }), flat = fly({ ...PLAYER, speedCap: 60, releasePerfectUp: 0 });
  assert.ok(!Number.isNaN(pop), "perfect");
  assert.ok(Math.abs(pop - flat - PLAYER.releasePerfectUp) < 1e-9, `pop ${(pop - flat).toFixed(2)} m/s`);
});

/** Flying +x down the street (z = zc, 40 m up) holding the web; past x 26 the stick turns to +z (into the cross street). */
function corner(k: Tuning, zc: number) {
  const b = createBody(0, 40, zc, -1);
  b.grounded = false; b.v.x = 20;
  let started = -1, ended = -1, bonk = false, spIn = 0, spOut = 0, headIn = 0, headOut = 0;
  for (let i = 0; i < 260; i++) {
    const f = emptyInput();
    f.aimX = 1; f.moveX = 1; f.webHeld = true;
    if (b.p.x > 26) { f.moveX = 0; f.moveZ = 1; f.aimX = 0; f.aimZ = 1; }
    const sp = Math.hypot(b.v.x, b.v.z), hd = Math.atan2(b.v.z, b.v.x);
    stepBody(b, f, k, bw);
    if ((b.events & EV_CORNER) && started < 0) { started = i; spIn = sp; headIn = hd; assert.ok(b.cornerOn); }
    if (started >= 0 && ended < 0 && !b.cornerOn) { ended = i; spOut = Math.hypot(b.v.x, b.v.z); headOut = Math.atan2(b.v.z, b.v.x); }
    if (b.events & EV_BONK) bonk = true;
  }
  return { started, ended, bonk, spIn, spOut, turn: headOut - headIn };
}

test("corner swing: steering into the cross street at speed webs the corner and swings round it, speed kept, no bonk", () => {
  for (const zc of [33, 37, 41]) {
    const c = corner(PLAYER, zc);
    assert.ok(c.started > 0 && c.ended > c.started, `z ${zc}: a corner swing (${c.started} -> ${c.ended})`);
    assert.ok(!c.bonk, `z ${zc}: no bonk`);
    assert.ok(c.turn > 0.9, `z ${zc}: turned ${(c.turn * 180 / Math.PI).toFixed(0)} deg`);
    assert.ok(c.spOut >= c.spIn, `z ${zc}: ${c.spIn.toFixed(1)} -> ${c.spOut.toFixed(1)} m/s`);
    assert.equal(corner({ ...PLAYER, cornerSwing: false }, zc).started, -1);
  }
});

test("the dive: faster than a fall (diveCap), turned by the stick; a web out of it carries the speed into the swing", () => {
  const run = (k: Tuning, dive: boolean) => {
    const b = createBody(10, 75, 37, -1);
    b.grounded = false; b.v.x = 12;
    let fall = 0, swing = 0, rel = 0, capX = 0;
    for (let i = 0; i < 600; i++) {
      const f = emptyInput();
      f.aimX = 1; f.moveX = 1;
      f.slidePressed = dive && i === 0; f.slideHeld = dive && i < 150;
      f.webHeld = i >= 150;
      stepBody(b, f, k, bw);
      const sp = Math.hypot(b.v.x, b.v.y, b.v.z);
      if (i < 150) fall = Math.max(fall, sp);
      if (i === 150) capX = b.capX;
      if (b.ropeSolid >= 0) swing = Math.max(swing, sp);
      if (swing > 0 && (b.events & EV_RELEASE)) { rel = sp; break; }
    }
    return { fall, swing, rel, capX };
  };
  const dive = run(PLAYER, true), plain = run(PLAYER, false);
  assert.ok(dive.fall > PLAYER.speedCap + 8 && dive.fall <= PLAYER.diveCap + 1e-9, `dive ${dive.fall.toFixed(1)} m/s`);
  assert.ok(plain.fall <= PLAYER.speedCap + 1e-9, `fall ${plain.fall.toFixed(1)} m/s`);
  assert.ok(dive.capX > 0, "the dive's extra speed is carried");
  assert.ok(dive.swing > PLAYER.speedCap + 5, `swing out of the dive ${dive.swing.toFixed(1)} m/s`);
  assert.ok(dive.rel > plain.rel + 8, `release ${dive.rel.toFixed(1)} vs ${plain.rel.toFixed(1)} m/s`);
  const r12 = run({ ...PLAYER, ...SWING_R12 }, true);
  assert.ok(r12.fall <= PLAYER.speedCap + 1e-9, "the round 12 dive stays under the cap");
  // The stick turns a dive; round 12's dive had no air control.
  const turn = (k: Tuning) => {
    const b = createBody(10, 75, 37, -1);
    b.grounded = false; b.v.x = 12;
    steps(b, k, bw, 60, (f, i) => { f.slidePressed = i === 0; f.slideHeld = true; f.moveZ = 1; f.aimX = 1; });
    return b.v.z;
  };
  assert.ok(turn(PLAYER) > 3 && Math.abs(turn({ ...PLAYER, ...SWING_R12 })) < 1e-9);
  // The carried speed wears off at diveCarryDecay once the dive is over.
  const b = createBody(10, 75, 37, -1);
  b.grounded = false; b.v.x = 12;
  steps(b, PLAYER, bw, 150, (f, i) => { f.slidePressed = i === 0; f.slideHeld = true; f.aimX = 1; });
  const c0 = b.capX;
  assert.ok(c0 > 5);
  steps(b, PLAYER, bw, 60, f => { f.aimX = 1; });
  assert.ok(b.capX <= c0 - PLAYER.diveCarryDecay * 0.5 + 1e-9, `capX ${c0.toFixed(2)} -> ${b.capX.toFixed(2)}`);
});

test("camera: the look point trails the swing's height (bounded) and leads the motion across the view; the aim is unchanged", async () => {
  const { createRig, rigUpdate } = await import("../src/camera/rig.ts");
  const { CAMERA } = await import("../src/sim/tuning.ts");
  const r = createRig(0), plain = createRig(0);
  const p = { x: 0, y: 40, z: 0 }, vel = { x: 12, y: -18, z: 0 };
  for (let i = 0; i < 60; i++) {
    p.x += vel.x / 60; p.y += vel.y / 60;
    rigUpdate(r, 1 / 60, { p, speed: 22, grounded: false, hook: null, landed: false, vel }, CAMERA, null);
    rigUpdate(plain, 1 / 60, { p, speed: 22, grounded: false, hook: null, landed: false, vel }, { ...CAMERA, lagY: 0, lookAhead: 0, speedArm: 0 }, null);
  }
  assert.ok(r.yLag > 0.5 && r.yLag <= CAMERA.lagYMax + 1e-9, `the look point stays ${r.yLag.toFixed(2)} m above a fast drop`);
  assert.ok(r.target.x > plain.target.x + 0.3, "leads the sideways motion (yaw 0 looks down -z: +x is across the view)");
  // Same view direction: the camera and the look point move together.
  const d = (a: typeof r) => { const x = a.target.x - a.pos.x, y = a.target.y - a.pos.y, z = a.target.z - a.pos.z, l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
  const [a, b] = [d(r), d(plain)];
  assert.ok(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-9, "the aim is the same");
  assert.ok(r.arm > plain.arm + 0.5, "the arm pulls back with speed");
  const rm = createRig(0);
  rigUpdate(rm, 1 / 60, { p, speed: 22, grounded: false, hook: null, landed: false, vel }, { ...CAMERA, reducedMotion: true }, null);
  assert.equal(rm.yLag, 0);
  assert.equal(rm.aheadX, 0);
});
