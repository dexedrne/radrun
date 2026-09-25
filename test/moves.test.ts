// Moves (player) and round 9 parkour (player + runner): the double jump fires once per airtime and recharges
// on landing / rope attach; a web zip goes to the ringed building anchor (a rim = a ledge zip onto that roof)
// or onto a roof ledge under the aim, then cools down; wall run (start rule, time limit with push-off, face
// span), wall jump (off the wall, not the same wall twice, alternating walls climb an alley), ledge grab +
// climb, run-up, vault, slide (+ slide-jump, buffered landing slide), landing roll / stumble; the runner and
// moves-off tunings have no double jump / zip / slide; a recorded run with every new input replays bit-exactly
// (ghost format 3), a format-2 record replays with the slide off.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CityIndex, type CityModel, type Solid } from "../src/world/cityModel.ts";
import {
  createBody, emptyInput, pickRing, stepBody, zipTarget, emptyZipAim, EV_ATTACH, EV_BIGLAND, EV_CLIMB, EV_DJUMP, EV_JUMP, EV_LEDGE,
  EV_ROLL, EV_SLIDE, EV_VAULT, EV_WALLJUMP, EV_WALLRUN, EV_ZIP, EV_ZIP_END, WALL_RUN, WALL_UP,
  type Body, type InputFrame, type SimWorld,
} from "../src/sim/player.ts";
import { applyTuningJson, MOVES_OFF, PLAYER, RUNNER, TOUCH, type Difficulty, type Tuning } from "../src/sim/tuning.ts";
import { emptyAnchor } from "../src/world/cityQuery.ts";
import { decodePack } from "../src/route/trackPack.ts";
import { Round } from "../src/game/round.ts";
import { InputLatch } from "../src/input/input.ts";
import {
  B_SLIDE, B_ZIP, GhostLog, GhostRun, buildFrame, decodeBytes, emptyRec, encodeBytes, packGhost, roundTuning, unpackGhost, type GhostFlags,
} from "../src/game/ghost.ts";
import { mulberry32 } from "../src/sim/math.ts";
import { TALL, tallModel, tallWorld } from "./helpers.ts";

const K: Tuning = { ...PLAYER };
const aimX = (f: InputFrame, x: number, z = 0) => { f.aimX = x; f.aimY = 0; f.aimZ = z; return f; };

/** Step with a fresh input each time (`set` edits it); returns the OR of the event bits. */
function run(b: Body, k: Tuning, w: SimWorld, n: number, set: (f: InputFrame, i: number) => void = () => {}): number {
  let ev = 0;
  for (let i = 0; i < n; i++) {
    const f = aimX(emptyInput(), 1);
    set(f, i);
    stepBody(b, f, k, w);
    ev |= b.events;
  }
  return ev;
}

/** Hand-made boxes (ids = order). */
function boxes(list: Omit<Solid, "id">[]): SimWorld {
  const model = { solids: list.map((s, id) => ({ ...s, id })), lowestRoof: 0 } as unknown as CityModel;
  return { index: new CityIndex(model), runner: null };
}
const roof = (x0: number, z0: number, x1: number, z1: number, top: number): Omit<Solid, "id"> => ({ kind: "roof", landable: true, x0, z0, x1, z1, top });
const tower = (x0: number, z0: number, x1: number, z1: number, top: number): Omit<Solid, "id"> => ({ kind: "tower", landable: false, x0, z0, x1, z1, top });

/** Airborne body with velocity (vx, vy, vz). */
function flying(x: number, y: number, z: number, vx: number, vy: number, vz: number): Body {
  const b = createBody(x, y, z, -1);
  b.grounded = false;
  b.v.x = vx; b.v.y = vy; b.v.z = vz;
  return b;
}

// ---- double jump + web zip -------------------------------------------------------------------------

test("double jump: once per airtime, v.y = max(v.y, doubleJumpSpeed), recharged on landing and rope attach", () => {
  const w = tallWorld();
  const b = createBody(9, 50.9, 9, TALL.south[0]);
  run(b, K, w, 3);
  assert.ok(b.grounded);
  assert.equal(b.airJumps, 1);
  assert.ok(run(b, K, w, 1, f => { f.jumpPressed = true; }) & EV_JUMP);
  run(b, K, w, 30);
  const vy0 = b.v.y;
  assert.ok(vy0 < K.doubleJumpSpeed, `falling slower than the double jump (${vy0})`);
  const ev = run(b, K, w, 1, f => { f.jumpPressed = true; });
  assert.ok(ev & EV_DJUMP, "double jump fired");
  assert.equal(b.airJumps, 0);
  assert.ok(Math.abs(b.v.y - (K.doubleJumpSpeed - K.gravity * K.dt)) < 1e-9, `vy ${b.v.y}`);
  run(b, K, w, 10);
  assert.equal(run(b, K, w, 1, f => { f.jumpPressed = true; }) & EV_JUMP, 0, "no third jump");
  let steps = 0;
  while (!b.grounded && steps++ < 600) run(b, K, w, 1);
  assert.ok(b.grounded);
  assert.equal(b.airJumps, 1);
  // A rope attach recharges it: jump, double jump, then web the tower across the avenue.
  run(b, K, w, 1, f => { f.jumpPressed = true; });
  run(b, K, w, 1, f => { f.jumpPressed = true; });
  assert.equal(b.airJumps, 0);
  const inp = aimX(emptyInput(), 0.3, 1);
  assert.ok(pickRing(b, inp, K, w, emptyAnchor()) >= 0, "a building across the avenue is ringed");
  const ev2 = run(b, K, w, 1, f => { aimX(f, 0.3, 1); f.webPressed = f.webHeld = true; });
  assert.ok(ev2 & EV_ATTACH);
  assert.equal(b.airJumps, 1);
});

test("double jump and slide are player-only (the runner and moves-off tunings ignore them); zip only in the runner's baked zip hops", () => {
  for (const [name, k] of [["runner", RUNNER], ["moves off", { ...K, ...MOVES_OFF }]] as [string, Tuning][]) {
    const w = tallWorld();
    const b = createBody(9, 50.9, 9, TALL.south[0]);
    run(b, k, w, 3);
    run(b, k, w, 1, f => { f.jumpPressed = true; });
    run(b, k, w, 30);
    // (the runner's zip key is pressed only by the bake bot, with a forced rim anchor: route.test.ts)
    const ev = run(b, k, w, 1, f => { f.jumpPressed = true; f.zipPressed = name !== "runner"; f.slidePressed = true; });
    assert.equal(ev & (EV_DJUMP | EV_JUMP | EV_ZIP | EV_WALLJUMP), 0, name);
    assert.equal(b.zipOn, false, name);
    while (!b.grounded) run(b, k, w, 1);
    b.v.x = 12;
    assert.equal(run(b, k, w, 2, f => { f.slidePressed = true; }) & EV_SLIDE, 0, `${name}: no slide`);
  }
});

test("web zip to a ringed rim: pulled up under the speed cap, launched onto that roof, cooldown", () => {
  const w = tallWorld();
  // From the avenue, aim at the 62 m north roof's rim (solid 7): a ledge zip onto it.
  const b = createBody(24, 50.9, 16, TALL.south[1] - 1); // south roof 0? (x 0..18): use a body in the air instead
  b.grounded = false; b.p.x = 28; b.p.y = 52; b.p.z = 30; b.roofId = -1;
  const a = emptyAnchor();
  const inp = aimX(emptyInput(), 0.2, 1);
  // (the anchor search's ideal point at round 9's 18 m up: this spot rings the 62 m roof's rim)
  const KR = { ...K, anchorUp: 18 };
  const ring = pickRing(b, inp, KR, w, a);
  assert.ok(ring === 7 && a.rim, `ringed the rim of the 62 m roof (${ring}, rim ${a.rim})`);
  const za = emptyZipAim();
  assert.equal(zipTarget(b, a, inp.aimX, inp.aimZ, KR, w, za), 2, "a rim of a landable roof = a ledge zip");
  assert.equal(za.roof, 7);
  assert.ok(run(b, KR, w, 1, f => { aimX(f, 0.2, 1); f.zipPressed = true; }) & EV_ZIP);
  let steps = 0, maxSp = 0;
  while (!(b.grounded && !b.zipOn) && steps++ < 600) {
    run(b, K, w, 1);
    maxSp = Math.max(maxSp, Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z));
  }
  assert.ok(b.grounded && b.roofId === 7, `landed on the rim's roof (roof ${b.roofId})`);
  assert.ok(maxSp <= K.speedCap + 1e-9, `speed cap kept (${maxSp})`);
  assert.ok(b.zipCd > 0 && b.zipCd <= K.zipCooldown);
  assert.equal(run(b, K, w, 1, f => { f.zipPressed = true; }) & EV_ZIP, 0, "cooling down");
});

test("web zip to a ringed facade ends in a wall run along the aim when fast enough", () => {
  // A long wall ahead (its -z face at z = 20), top 60; the body below its top, aiming mostly at it.
  const w = boxes([tower(0, 20, 80, 40, 60)]);
  const b = flying(30, 30, 0, 0, 0, 0);
  const a = emptyAnchor();
  const inp = aimX(emptyInput(), 0.45, 1);
  assert.ok(pickRing(b, inp, K, w, a) === 0 && !a.rim, "a facade point is ringed");
  run(b, K, w, 1, f => { aimX(f, 0.45, 1); f.zipPressed = true; });
  let ev = 0;
  for (let i = 0; i < 200 && !(ev & EV_WALLRUN); i++) ev |= run(b, K, w, 1, f => aimX(f, 0.45, 1));
  assert.ok(ev & EV_ZIP_END, "the zip ended at the wall");
  assert.ok(ev & EV_WALLRUN, "into a wall run");
  assert.equal(b.wallMode, WALL_RUN);
  assert.ok(b.v.x > K.wallRunSpeed - 1e-6, `running along the aim (+x): ${b.v.x.toFixed(2)}`);
});

test("web zip to a roof ledge under the aim (nothing ringed) lands you on that roof; no target = no zip, no cooldown", () => {
  for (const top1 of [24, 16]) {
    const w = boxes([roof(0, 0, 20, 20, 20), roof(26, 0, 46, 20, top1)]);
    const b = createBody(10, 20.9, 10, 0);
    run(b, K, w, 3);
    const za = emptyZipAim();
    assert.equal(zipTarget(b, null, 1, 0, K, w, za), 2, `ledge found (top ${top1})`);
    assert.equal(za.roof, 1);
    assert.ok(run(b, K, w, 1, f => { f.zipPressed = true; }) & EV_ZIP);
    let steps = 0;
    while (!(b.grounded && !b.zipOn) && steps++ < 800) run(b, K, w, 1);
    assert.ok(b.grounded, `landed (top ${top1})`);
    assert.equal(b.roofId, 1, `on the target roof (top ${top1}), at x=${b.p.x.toFixed(2)}`);
    run(b, K, w, Math.ceil(K.zipCooldown * 120));
    const cd = b.zipCd;
    assert.equal(run(b, K, w, 1, f => { aimX(f, 0, -1); f.zipPressed = true; }) & EV_ZIP, 0);
    assert.equal(b.zipCd, cd);
  }
});

// ---- wall run / wall jump ----------------------------------------------------------------------------

/** The -z face (z = 0) of a 40 m long, 60 m tall wall; the street below. */
const wallWorld = () => boxes([tower(0, 0, 40, 12, 60)]);

test("wall run: starts alongside a facade with enough along speed, light gravity, ends after wallRunTime with a push-off", () => {
  const w = wallWorld();
  const b = flying(3, 40, -0.6, 10, 2, 0);
  const ev = run(b, K, w, 1);
  assert.ok(ev & EV_WALLRUN, "started");
  assert.equal(b.wallMode, WALL_RUN);
  assert.equal(b.wallSolid, 0);
  assert.ok(Math.abs(b.p.z - (0 - K.halfWidth)) < 1e-9, "snapped flush");
  assert.ok(b.v.y >= K.wallRunKick - K.gravity * K.dt - 1e-9, "kicked up");
  const y0 = b.p.y;
  let steps = 0;
  while (b.wallMode === WALL_RUN && steps++ < 400) run(b, K, w, 1, f => { f.moveX = 1; });
  assert.ok(Math.abs(steps - K.wallRunTime * 120) <= 2, `lasted ${steps} steps (~wallRunTime)`);
  assert.ok(b.v.z < -1.5, `pushed off the wall (${b.v.z.toFixed(2)})`);
  assert.ok(b.p.y > y0 - 6, `light gravity: dropped ${(y0 - b.p.y).toFixed(2)} m in ${K.wallRunTime} s`);
  assert.ok(b.v.x >= K.wallRunSpeed - 1e-6, "eased up to wallRunSpeed");
  // Too slow along the face, or too steep into it: no wall run.
  assert.equal(run(flying(3, 40, -0.6, 3, 2, 0), K, w, 1) & EV_WALLRUN, 0, "too slow");
  assert.equal(run(flying(20, 40, -2, 4, 2, 9), K, wallWorld(), 20) & EV_WALLRUN, 0, "too steep (> 45 deg into it)");
});

test("wall run: ends past the face's end (corner exit keeps the velocity) and when the stick pulls away", () => {
  const b = flying(33, 40, -0.6, 11, 1, 0);
  const w = wallWorld();
  run(b, K, w, 1);
  assert.equal(b.wallMode, WALL_RUN);
  let steps = 0;
  while (b.wallMode === WALL_RUN && steps++ < 200) run(b, K, w, 1);
  assert.ok(b.p.x > 40 - 0.2, `ran off the end at x=${b.p.x.toFixed(2)}`);
  assert.ok(b.v.x > 10, "kept its speed round the corner");
  const c = flying(3, 40, -0.6, 10, 2, 0);
  run(c, K, w, 1);
  run(c, K, w, 1, f => { f.moveZ = -1; });
  assert.equal(c.wallMode, 0, "stick away from the wall ends it");
});

test("wall jump: off the wall (out + up, most of the along speed kept), never the same wall twice in a row", () => {
  const w = wallWorld();
  const b = flying(3, 40, -0.6, 10, 2, 0);
  run(b, K, w, 3);
  assert.equal(b.wallMode, WALL_RUN);
  const va = b.v.x;
  const ev = run(b, K, w, 1, f => { f.jumpPressed = true; });
  assert.ok(ev & EV_WALLJUMP);
  assert.equal(b.wallMode, 0);
  assert.ok(Math.abs(b.v.y - (K.wallJumpUp - K.gravity * K.dt)) < 1e-6, `up ${b.v.y}`);
  assert.ok(Math.abs(b.v.z - -K.wallJumpOut) < 1e-6, `out ${b.v.z}`);
  assert.ok(Math.abs(b.v.x - va * K.wallJumpKeep) < 0.5, `along ${b.v.x} vs ${va}`);
  // Back against the same wall: no second kick (the jump is a double jump instead).
  b.p.z = -K.halfWidth - 0.1; b.v.z = 1; b.v.y = -1;
  run(b, K, w, 2);
  const ev2 = run(b, K, w, 1, f => { f.jumpPressed = true; });
  assert.equal(ev2 & EV_WALLJUMP, 0, "not the same wall twice");
  assert.ok(ev2 & EV_DJUMP, "a double jump instead");
});

test("wall jump: kicking between the two walls of a 4 m alley climbs it", () => {
  const w = boxes([tower(0, 0, 30, 10, 60), tower(0, 14, 30, 24, 60)]);
  const b = flying(15, 10, 12, 0, 0, -4);
  const y0 = b.p.y;
  let kicks = 0;
  for (let i = 0; i < 120 * 4; i++) {
    const kick = b.touchWall >= 0 && b.touchT <= K.wallJumpGrace && b.touchWall !== b.kickSolid;
    const ev = run(b, K, w, 1, f => { f.jumpPressed = kick; });
    if (ev & EV_WALLJUMP) kicks++;
  }
  assert.ok(kicks >= 5, `${kicks} kicks`);
  assert.ok(b.p.y > y0 + 6, `climbed ${(b.p.y - y0).toFixed(1)} m`);
});

// ---- ledge grab / run-up / vault ---------------------------------------------------------------------

test("ledge grab + climb: jumping at a 2.8 m block grabs its rim, hangs, climbs onto it by itself", () => {
  const w = tallWorld();
  const b = createBody(213, 40.9, 15, TALL.propRoof);
  let ev = 0, jumped = false, grabbedAt = -1;
  for (let i = 0; i < 240 && !(ev & EV_CLIMB); i++) {
    const e = run(b, K, w, 1, f => { f.moveX = 1; if (!jumped && b.p.x >= 215.8) { f.jumpPressed = true; jumped = true; } });
    if ((e & EV_LEDGE) && grabbedAt < 0) grabbedAt = i;
    ev |= e;
  }
  assert.ok(ev & EV_LEDGE, "grabbed the ledge");
  assert.ok(ev & EV_CLIMB, "climbed");
  assert.ok(b.grounded && b.roofId === TALL.climbProp, `on the block (roof ${b.roofId})`);
  assert.ok(b.v.x > 0, "moving on inward");
});

test("run-up: head-on into a wall with the stick climbs it and grabs the top when it comes in reach", () => {
  const w = boxes([roof(0, 0, 20, 20, 20), roof(20, 0, 40, 20, 25)]);
  const b = createBody(12, 20.9, 10, 0);
  let ev = 0, up = false;
  for (let i = 0; i < 300 && !(ev & EV_CLIMB); i++) {
    ev |= run(b, K, w, 1, f => { f.moveX = 1; f.jumpPressed = b.grounded && b.roofId === 0 && b.p.x > 17.5; });
    if (b.wallMode === WALL_UP) up = true;
  }
  assert.ok(up, "ran up the wall");
  assert.ok(ev & EV_LEDGE && ev & EV_CLIMB, "grabbed the top and climbed");
  assert.equal(b.roofId, 1);
});

test("vault: running at a 1.2 m block hops it without stopping; a 2.8 m block is not vaulted", () => {
  const w = tallWorld();
  const b = createBody(203, 40.9, 15, TALL.propRoof);
  let ev = 0, minVx = Infinity;
  for (let i = 0; i < 180 && b.p.x < 214; i++) {
    ev |= run(b, K, w, 1, f => { f.moveX = 1; });
    if (i > 30) minVx = Math.min(minVx, b.v.x);
  }
  assert.ok(ev & EV_VAULT, "vaulted");
  assert.ok(b.p.x >= 214, `over it (x ${b.p.x.toFixed(1)})`);
  assert.ok(minVx > K.runSpeed - 1, `speed kept (${minVx.toFixed(2)})`);
  const c = createBody(214, 40.9, 15, TALL.propRoof);
  let ev2 = 0;
  for (let i = 0; i < 120; i++) ev2 |= run(c, K, w, 1, f => { f.moveX = 1; });
  assert.equal(ev2 & EV_VAULT, 0, "too tall to vault");
  assert.ok(c.p.x < 218, "stopped by the climb block");
});

// ---- slide / roll ------------------------------------------------------------------------------------

test("slide: keeps speed better than running on, steers sideways only, slide-jump adds forward speed; buffered landing slide", () => {
  const w = boxes([roof(0, 0, 200, 40, 20)]);
  const slide = createBody(10, 20.9, 20, 0), runOn = createBody(10, 20.9, 20, 0);
  slide.v.x = runOn.v.x = 14;
  assert.ok(run(slide, K, w, 1, f => { f.moveX = 1; f.slidePressed = true; }) & EV_SLIDE);
  run(runOn, K, w, 1, f => { f.moveX = 1; });
  run(slide, K, w, 59, f => { f.moveX = 1; f.moveZ = 0.4; });
  run(runOn, K, w, 59, f => { f.moveX = 1; });
  const sp = Math.hypot(slide.v.x, slide.v.z);
  assert.ok(Math.abs(sp - (14 - K.slideDecay * 0.5)) < 0.1, `slide speed ${sp.toFixed(2)}`);
  assert.ok(sp > runOn.v.x + 1, `beats the run-on carry (${runOn.v.x.toFixed(2)})`);
  assert.ok(slide.v.z > 0.5, "sideways steering turns it");
  assert.ok(slide.slideT > 0);
  const before = Math.hypot(slide.v.x, slide.v.z);
  assert.ok(run(slide, K, w, 1, f => { f.moveX = 1; f.jumpPressed = true; }) & EV_JUMP);
  assert.ok(Math.hypot(slide.v.x, slide.v.z) > before + K.slideJumpFwd - 0.2, "slide-jump adds forward speed");
  assert.equal(slide.slideT, 0);
  // A slide pressed in the air just before landing starts on touchdown.
  const b = flying(50, 21.4, 20, 12, -3, 0);
  run(b, K, w, 1, f => { f.moveX = 1; f.slidePressed = true; });
  let ev = 0;
  for (let i = 0; i < 20 && !b.grounded; i++) ev |= run(b, K, w, 1, f => { f.moveX = 1; });
  assert.ok(b.grounded && (ev & EV_SLIDE), "landed into a slide");
});

test("landing: a hard landing with the stick along the run rolls (speed kept); a very hard one stumbles", () => {
  const w = boxes([roof(0, 0, 200, 40, 20)]);
  const roll = flying(20, 21, 20, 12, -17, 0);
  const ev = run(roll, K, w, 3, f => { f.moveX = 1; });
  assert.ok(ev & EV_ROLL, "rolled");
  run(roll, K, w, 24, f => { f.moveX = 1; });
  assert.ok(roll.v.x > 11.9, `no carry decay while rolling (${roll.v.x.toFixed(2)})`);
  const flat = flying(20, 21, 20, 12, -17, 0);
  const ev2 = run(flat, K, w, 3);
  assert.equal(ev2 & EV_ROLL, 0, "no stick along = no roll");
  const hard = flying(20, 21, 20, 12, -26, 0);
  const ev3 = run(hard, K, w, 3);
  assert.ok(ev3 & EV_BIGLAND, "stumbled");
  assert.ok(hard.v.x < 12 * K.stumbleKeep + 0.5, `speed cut (${hard.v.x.toFixed(2)})`);
  assert.ok(hard.bonkT > 0, "locked for a moment");
});

// ---- ghosts ----------------------------------------------------------------------------------------

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8")));
const pack = decodePack(fs.readFileSync(lv("runner.pack.bin")));
const mk = (seed: number, d: Difficulty, flags: GhostFlags, countdown = false) => new Round({
  model, index: new CityIndex(model), pack, difficulty: d, params: tuning.difficulty[d], tuning: roundTuning(tuning.player, flags),
  chaser: "652", runner: "4764", seed, countdown, yoinkBonus: flags.touch ? TOUCH.yoinkBonus : 0,
});

/** A player round through the latch with double jumps (Space twice), zips (E / Shift) and slides (C). */
function movesRound(seed: number, flags: GhostFlags, steps: number, zips = true, slides = true): { round: Round; log: GhostLog; djumps: number; zipsDone: number; slidesDone: number } {
  const round = mk(seed, "normal", flags, true);
  const latch = new InputLatch();
  const rand = mulberry32(seed * 13 + 5);
  const f = emptyInput(), rec = emptyRec(), log = new GhostLog();
  let yaw = round.spawn.yaw, djumps = 0, zipsDone = 0, slidesDone = 0;
  for (let i = 0; i < steps && !round.over; i++) {
    if (i % 2 === 0) yaw += (rand() - 0.5) * 0.03;
    if (i % 240 === 0) latch.press("KeyW");
    if (i % 150 === 40) { latch.press("Space"); latch.release("Space"); }
    if (i % 150 === 75) { latch.press("Space"); latch.release("Space"); }
    if (zips && i % 330 === 200) { latch.press(i % 660 === 200 ? "KeyE" : "ShiftLeft"); latch.release("KeyE"); latch.release("ShiftLeft"); }
    if (slides && i % 90 === 20) { latch.press("KeyC"); latch.release("KeyC"); }
    if (i % 500 === 300) latch.mouseDown(0);
    if (i % 500 === 380) latch.mouseUp(0);
    const chase = round.phase === "chase";
    latch.sample(rec, yaw);
    buildFrame(f, rec, round.player.v, flags.touch, round.tuning.runSpeed);
    if (chase) log.push(rec);
    round.step(f);
    if (round.player.events & EV_DJUMP) djumps++;
    if (round.player.events & EV_ZIP) zipsDone++;
    if (round.player.events & EV_SLIDE) slidesDone++;
  }
  return { round, log, djumps, zipsDone, slidesDone };
}

test("ghost: a run with double jumps, zips and slides records B_ZIP / B_SLIDE, round-trips the link codec and replays bit-exactly", async () => {
  const flags: GhostFlags = { touch: false, easy: false };
  const { round, log, djumps, zipsDone } = movesRound(31, flags, 360 + 3600);
  assert.ok(djumps >= 3, `double jumps ${djumps}`);
  assert.ok(zipsDone >= 1, `zips ${zipsDone}`);
  let zipBits = 0, slideBits = 0;
  for (let i = 0; i < log.n; i++) { if (log.bits[i] & B_ZIP) zipBits++; if (log.bits[i] & B_SLIDE) slideBits++; }
  assert.ok(zipBits >= 2 && slideBits >= 10, `zip bits ${zipBits}, slide bits ${slideBits}`);
  const bytes = encodeBytes(log, flags);
  assert.equal(bytes[0], 3, "format 3");
  const back = await unpackGhost(await packGhost(log, flags));
  assert.ok(back);
  assert.equal(back.flags.moves, undefined, "the moves ruleset");
  assert.equal(back.flags.slide, undefined, "with the slide");
  const g = new GhostRun(mk(31, "normal", back.flags, true), back.log, false);
  g.advance(20000);
  assert.equal(g.round.chaseSteps, round.chaseSteps);
  assert.equal(g.round.hash(), round.hash());
});

test("ghost: a format-1 record replays with the moves off; a format-2 record with the slide off", () => {
  const old: GhostFlags = { touch: false, easy: false, moves: false };
  const { round, log, djumps } = movesRound(32, old, 360 + 3000, false, false);
  assert.equal(djumps, 0, "no double jumps under the old ruleset");
  const bytes = encodeBytes(log, old);
  assert.equal(bytes[0], 1, "format 1");
  const dec = decodeBytes(bytes);
  assert.ok(dec);
  assert.equal(dec.flags.moves, false);
  const g = new GhostRun(mk(32, "normal", dec.flags, true), dec.log, false);
  g.advance(20000);
  assert.equal(g.round.hash(), round.hash(), "old record replays exactly under the old ruleset");
  const drift = new GhostRun(mk(32, "normal", { touch: false, easy: false }, true), dec.log, false);
  drift.advance(20000);
  assert.notEqual(drift.round.hash(), round.hash(), "the same inputs with the double jump on play differently");
  // A format-1 record cannot carry the zip bit; a format-2 record cannot carry the slide bit.
  const withZip = new GhostLog(log.n);
  for (let i = 0; i < log.n; i++) withZip.push({ yaw: log.yaw[i], fwd: log.fwd[i], right: log.right[i], bits: log.bits[i] | (i === 5 ? B_ZIP : 0) });
  assert.equal(decodeBytes(encodeBytes(withZip, old)), null);
  const f2: GhostFlags = { touch: false, easy: false, slide: false };
  assert.equal(encodeBytes(log, f2)[0], 2, "format 2");
  const d2 = decodeBytes(encodeBytes(log, f2));
  assert.ok(d2 && d2.flags.slide === false && d2.flags.moves === undefined);
  assert.equal(roundTuning(tuning.player, d2.flags).slide, false);
  const withSlide = new GhostLog(log.n);
  for (let i = 0; i < log.n; i++) withSlide.push({ yaw: log.yaw[i], fwd: log.fwd[i], right: log.right[i], bits: log.bits[i] | (i === 5 ? B_SLIDE : 0) });
  assert.equal(decodeBytes(encodeBytes(withSlide, f2)), null);
});

test("input: E / Shift / touch ZIP latch one zip press; C / touch SLIDE one slide press (recorded, consumed by one step)", () => {
  const latch = new InputLatch();
  const rec = emptyRec();
  for (const press of [() => latch.press("KeyE"), () => latch.press("ShiftLeft"), () => latch.press("ShiftRight"), () => latch.touchZip()]) {
    press();
    assert.ok(latch.sample(rec, 0).bits & B_ZIP);
    assert.equal(latch.sample(rec, 0).bits & B_ZIP, 0, "consumed");
    latch.clear();
  }
  for (const press of [() => latch.press("KeyC"), () => latch.touchSlide()]) {
    press();
    assert.ok(latch.sample(rec, 0).bits & B_SLIDE);
    assert.equal(latch.sample(rec, 0).bits & B_SLIDE, 0, "consumed");
    latch.clear();
  }
  const f = emptyInput();
  latch.press("KeyE");
  latch.consume(f, 0, 1, 1, 0, 0);
  assert.ok(f.zipPressed);
  latch.consume(f, 0, 1, 1, 0, 0);
  assert.ok(!f.zipPressed);
  latch.press("KeyC");
  latch.consume(f, 0, 1, 1, 0, 0);
  assert.ok(f.slidePressed);
  latch.consume(f, 0, 1, 1, 0, 0);
  assert.ok(!f.slidePressed);
});
