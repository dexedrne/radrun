// Round 11 (the swing polish): a web from a roof lifts you off into the swing; a release on the way up keeps your
// height, one at the bottom does not; a swing whose arc runs into a facade scores worse (swingClear); a flight out
// over the city's edge bends along it; the camera keeps off the wall on a wall run and swings round a facade behind
// the Radbro on the rope; Chill's head start; the swing bot's stall watchdog; the thief swings far more than he zips.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createBody, emptyInput, stepBody, EV_LAND, EV_RELEASE } from "../src/sim/player.ts";
import { applyTuningJson, CAMERA, PLAYER, RUNNER, TUNABLE_KEYS, type Tuning } from "../src/sim/tuning.ts";
import { swingClear } from "../src/world/cityQuery.ts";
import { createRig, rigUpdate } from "../src/camera/rig.ts";
import { decodePack } from "../src/route/trackPack.ts";
import { Round } from "../src/game/round.ts";
import { SwingBot } from "../src/game/bots.ts";
import { RE_TAUNT, RM_EDGE } from "../src/runner/runner.ts";
import { DISTRICTS, DISTRICT_IDS } from "../src/world/districts.ts";
import { tallModel, tallWorld } from "./helpers.ts";

const model = tallModel();
const world = tallWorld(model);
const hit = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => world.index.segmentHit(ax, ay, az, bx, by, bz);

test("round 11 web from a roof: the web pulls you up and off the edge into the swing (webLift 0: the old hop back onto it)", () => {
  const roof = model.solids[0]; // south roof, x 0..18, z 0..18, top 50; the avenue is z 18..40
  const go = (k: Tuning) => {
    const b = createBody(9, roof.top + k.halfHeight, 15, 0);
    b.grounded = true;
    let backOn = false, left = false, peak = -Infinity;
    for (let i = 0; i < 240; i++) {
      const f = emptyInput();
      f.aimX = 0.55; f.aimY = 0.35; f.aimZ = 0.76; f.moveX = 0.6; f.moveZ = 0.8;
      f.webHeld = true; f.webPressed = i === 0;
      stepBody(b, f, k, world);
      if (b.p.z > roof.z1 + 0.5) left = true;
      if ((b.events & EV_LAND) && b.roofId === 0 && !left) backOn = true;
      peak = Math.max(peak, b.p.y - (roof.top + k.halfHeight));
    }
    return { backOn, left, peak, rope: b.ropeSolid };
  };
  const lift = go({ ...PLAYER });
  assert.ok(PLAYER.webLift > 0);
  assert.equal(lift.backOn, false, "never drops back onto the roof");
  assert.ok(lift.left && lift.rope >= 0, "off the roof, still swinging");
  assert.ok(lift.peak > 3, `lifted ${lift.peak.toFixed(1)} m`);
  const hop = go({ ...PLAYER, webLift: 0 });
  assert.equal(hop.backOn, true, "without the lift the web is a hop back onto the roof");
});

test("round 11 timing: a release on the way up (past swingSweetCos) flings you higher than one at the bottom or holding to the auto-release", () => {
  const k: Tuning = { ...PLAYER };
  const fling = (pol: "timed" | "bottom" | "hold") => {
    const b = createBody(4, 48, 29, -1); // flying down the avenue at 16 m/s
    b.grounded = false; b.v.x = 16;
    let rel = -1, apex = -Infinity;
    for (let i = 0; i < 360; i++) {
      const f = emptyInput();
      f.aimX = 0.9; f.aimY = 0.4; f.moveX = 1;
      let held = rel < 0;
      if (b.ropeSolid >= 0) {
        const rx = b.p.x - b.ropeP.x, ry = b.p.y - b.ropeP.y, rz = b.p.z - b.ropeP.z;
        const ang = Math.acos(Math.min(1, -ry / Math.hypot(rx, ry, rz))) * 180 / Math.PI;
        if (pol === "timed" && rx * b.v.x + rz * b.v.z > 0 && b.v.y > 0 && ang > 25) held = false;
        if (pol === "bottom" && b.ropeTaut && b.v.y > 0) held = false;
      }
      f.webHeld = held; f.webPressed = i === 0;
      stepBody(b, f, k, world);
      if ((b.events & EV_RELEASE) && rel < 0) rel = i;
      if (rel >= 0) apex = Math.max(apex, b.p.y);
      if (rel >= 0 && b.v.y < 0 && i > rel + 5) break;
    }
    assert.ok(rel > 0, `${pol}: let go`);
    return apex;
  };
  const timed = fling("timed"), bottom = fling("bottom"), hold = fling("hold");
  assert.ok(timed > bottom + 8, `timed apex ${timed.toFixed(1)} vs bottom ${bottom.toFixed(1)}`);
  assert.ok(timed > hold + 3, `timed apex ${timed.toFixed(1)} vs hold ${hold.toFixed(1)}`);
});

test("round 11 swing look-ahead: an arc into the facade ahead is not clear, one down the avenue is", () => {
  const k: Tuning = { ...PLAYER };
  assert.equal(swingClear(world.index, k, 60, 50, 29, 0, 0, 15, 60, 75, 36, -1), false);
  assert.equal(swingClear(world.index, k, 60, 50, 29, 15, 0, 0, 75, 75, 29, -1), true);
  assert.ok(PLAYER.anchorArcPenalty > 0 && RUNNER.anchorArcPenalty === 0);
});

test("round 11 city edge: a flight out over the edge bends along it (the runner's tuning has it off)", () => {
  const fly = (k: Tuning) => {
    const b = createBody(120, 90, 45, -1); // bounds z1 = 58
    b.grounded = false; b.v.x = 3; b.v.y = 5; b.v.z = 20;
    let maxZ = 0;
    for (let i = 0; i < 150; i++) { const f = emptyInput(); f.aimZ = 1; f.moveZ = 1; stepBody(b, f, k, world); maxZ = Math.max(maxZ, b.p.z); }
    return { maxZ, vx: b.v.x };
  };
  const on = fly({ ...PLAYER });
  assert.ok(on.maxZ < model.bounds.z1, `stayed inside (max z ${on.maxZ.toFixed(1)})`);
  assert.ok(on.vx > 15, "along the edge at speed");
  const off = fly({ ...PLAYER, edgeAvoid: 0 });
  assert.ok(off.maxZ > model.bounds.z1 + 5);
  assert.equal(RUNNER.edgeAvoid, 0);
});

test("round 11 camera: on a wall run it keeps wallCam off the wall; on the rope a facade behind swings it round (arm >= armMin)", () => {
  // Wall run along tower 1's north face (z = 18), looking 30 deg away from the wall: the arm would hit the face.
  const run = (wallCam: number) => {
    const a = Math.PI / 6;
    const r = createRig(Math.atan2(-Math.cos(a), -Math.sin(a)), 0.1);
    const p = { x: 30, y: 60, z: 18.35 };
    let minOff = Infinity;
    for (let i = 0; i < 90; i++) {
      p.x += 11 / 60;
      rigUpdate(r, 1 / 60, { p, speed: 11, grounded: false, hook: null, landed: false, wall: true, wallNx: 0, wallNz: 1 }, { ...CAMERA, wallCam }, hit);
      if (i > 30) minOff = Math.min(minOff, r.pos.z - 18);
    }
    return minOff;
  };
  assert.ok(run(CAMERA.wallCam) >= CAMERA.wallCam - 0.1, "camera off the wall");
  assert.ok(run(0) < 0.5, "(without it the arm rides the facade)");
  // On the rope 1.05 m off the same face, looking away from it (the arm points into the wall).
  const rope = (armMin: number) => {
    const r = createRig(Math.atan2(0, -1), 0.1);
    const p = { x: 30, y: 60, z: 19.4 }, hook = { x: 30, y: 80, z: 24 };
    let minArm = Infinity;
    for (let i = 0; i < 120; i++) {
      rigUpdate(r, 1 / 60, { p, speed: 8, grounded: false, hook, landed: false, web: { ax: p.x, ay: p.y + 0.25, az: p.z, bx: 30, by: 80, bz: 18 } }, { ...CAMERA, armMin }, hit);
      if (i > 40) minArm = Math.min(minArm, r.armUsed);
    }
    return minArm;
  };
  assert.ok(rope(CAMERA.armMin) >= CAMERA.armMin, "swung round to room");
  assert.ok(rope(0) < 2, "(without it the camera sits in the Radbro's back)");
});

const lv = (dir: string, f: string) => new URL(`../public/${dir}${f}`, import.meta.url);
const tj = applyTuningJson(JSON.parse(fs.readFileSync(lv("levels/", "tuning.json"), "utf8")));
const load = (dir: string) => ({ model: JSON.parse(fs.readFileSync(lv(dir, "city.model.json"), "utf8")), pack: decodePack(fs.readFileSync(lv(dir, "runner.pack.bin"))) });

test("round 11 Chill head start: at GO he is already down his first run, and keeps running (no taunt stop) for lead s", () => {
  const { model: m, pack } = load("levels/");
  assert.ok(tj.difficulty.chill.lead > 0 && tj.difficulty.normal.lead === 0);
  const mk = (lead: number) => new Round({ model: m, pack, difficulty: "chill", params: { ...tj.difficulty.chill, lead }, tuning: tj.player, chaser: "652", runner: "4764", seed: 21, countdown: false });
  const a = mk(tj.difficulty.chill.lead), b = mk(0);
  assert.equal(a.runner.mode, RM_EDGE);
  assert.ok(a.d > b.d + 10, `d at GO ${a.d.toFixed(1)} vs ${b.d.toFixed(1)}`);
  const inp = emptyInput();
  let taunts = 0;
  for (let i = 0; i < tj.difficulty.chill.lead * 120; i++) { a.step(inp); if (a.runner.events & RE_TAUNT) taunts++; }
  assert.equal(taunts, 0);
  assert.equal(a.runner.calm, 0);
});

test("round 11 swing bot: never stuck under one tower (Towers, seeds 1-8, with and without the moves)", () => {
  const { model: m, pack } = load("levels/towers/");
  for (const moves of [true, false]) for (let seed = 1; seed <= 8; seed++) {
    const r = new Round({ model: m, pack, difficulty: "normal", params: tj.difficulty.normal, tuning: tj.player, chaser: "652", runner: "4764", seed, countdown: false, mutators: 0, district: "towers" });
    const bot = new SwingBot(r, seed, moves);
    const inp = emptyInput();
    const hist: number[][] = [];
    while (!r.over) {
      bot.next(r, inp); r.step(inp, null); bot.after(r);
      if (r.chaseSteps % 30 === 0) hist.push([r.player.p.x, r.player.p.y, r.player.p.z]);
    }
    // The longest stretch (s) inside a 20 m box.
    let longest = 0;
    for (let i = 0; i < hist.length; i++) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, j = i;
      for (; j < hist.length; j++) {
        const [x, y, z] = hist[j];
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        if (x1 - x0 > 20 || y1 - y0 > 20 || z1 - z0 > 20) break;
      }
      longest = Math.max(longest, (j - i) / 4);
    }
    assert.ok(longest < 10, `seed ${seed}${moves ? " moves" : ""}: ${longest} s inside a 20 m box`);
  }
});

test("round 11 thief: in every district his kept routes swing across the streets far more often than they zip", () => {
  for (const id of DISTRICT_IDS) {
    const rep = JSON.parse(fs.readFileSync(lv(DISTRICTS[id].dir, "bake.report.json"), "utf8")) as { edges: { kept: boolean; hops: { kind: string }[] }[] };
    let swings = 0, zips = 0;
    for (const e of rep.edges) if (e.kept) for (const h of e.hops) { if (h.kind === "street") swings++; if (h.kind === "zip") zips++; }
    assert.ok(swings >= 2.5 * zips, `${id}: ${swings} swings vs ${zips} zips`);
  }
});

test("round 11: every new number is a tuning key (tuning.json / ?tune)", () => {
  const keys = ["autoReleaseUp", "anchorArcPenalty", "releaseSweet", "swingSweetCos", "swingReelUp", "webLift", "webLiftClear", "swingAvoid", "swingAvoidT", "swingAvoidAir", "edgeAvoid", "edgeMargin", "wallUpKick", "wallPushOff"] as const;
  for (const key of keys) assert.ok((TUNABLE_KEYS as readonly string[]).includes(key), key);
  for (const key of ["armMin", "dodgeRate", "webClear", "wallCam"] as const) assert.ok(key in CAMERA, key);
  assert.ok("lead" in tj.difficulty.chill);
});
