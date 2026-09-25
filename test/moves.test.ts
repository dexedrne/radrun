// Double jump + web zip (player only): the double jump fires once per airtime and recharges on landing /
// rope attach; a zip pulls you to the ringed balloon (auto-release with a forward + up fling, speed cap
// kept) or onto a roof ledge under the aim, then cools down; the runner / prototype presets and format-1
// ghost records run without the moves; a recorded run with the new inputs replays bit-exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import {
  createBody, emptyInput, pickTarget, stepBody, zipTarget, emptyZipAim, EV_ATTACH, EV_DJUMP, EV_JUMP, EV_ZIP, EV_ZIP_END,
  type Body, type InputFrame, type SimWorld,
} from "../src/sim/player.ts";
import { applyTuningJson, MOVES_OFF, PLAYER, PROTOTYPE, RUNNER, TOUCH, type Difficulty, type Tuning } from "../src/sim/tuning.ts";
import { decodePack } from "../src/route/trackPack.ts";
import { Round } from "../src/game/round.ts";
import { InputLatch } from "../src/input/input.ts";
import {
  B_ZIP, GhostLog, GhostRun, buildFrame, decodeBytes, emptyRec, encodeBytes, packGhost, roundTuning, unpackGhost, type GhostFlags,
} from "../src/game/ghost.ts";
import { mulberry32 } from "../src/sim/math.ts";

const K: Tuning = { ...PLAYER, speedCap: 20 };

/** Two roofs across a 6 m gap (roof 1 at `top1`), optionally one balloon over the gap. */
function world(top1 = 24, hook = true): SimWorld {
  const model = {
    solids: [
      { id: 0, kind: "roof", landable: true, x0: 0, z0: 0, x1: 20, z1: 20, top: 20 },
      { id: 1, kind: "roof", landable: true, x0: 26, z0: 0, x1: 46, z1: 20, top: top1 },
    ],
    hooks: hook ? [{ id: 0, x: 23, y: 32, z: 10, src: "manual" }] : [],
    lowestRoof: 16,
  } as unknown as CityModel;
  return { index: new CityIndex(model), hooks: model.hooks, lowestRoof: 16, runner: null };
}

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

test("double jump: once per airtime, v.y = max(v.y, doubleJumpSpeed), recharged on landing and rope attach", () => {
  const w = world(24, true);
  const b = createBody(12, 20.9, 10, 0);
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
  // No third jump in the same airtime.
  run(b, K, w, 10);
  assert.equal(run(b, K, w, 1, f => { f.jumpPressed = true; }) & EV_JUMP, 0);
  // Land -> recharged; no bonus jump from the buffered press.
  let steps = 0;
  while (!b.grounded && steps++ < 600) run(b, K, w, 1);
  assert.ok(b.grounded);
  assert.equal(b.airJumps, 1);
  // Rising faster than the double jump: it keeps the faster v.y.
  run(b, K, w, 1, f => { f.jumpPressed = true; });
  const vyUp = b.v.y;
  run(b, K, w, 1, f => { f.jumpPressed = true; });
  assert.ok(b.events & EV_DJUMP);
  assert.ok(Math.abs(b.v.y - (vyUp - K.gravity * K.dt)) < 1e-9, "max() keeps the faster rise");
  // Rope attach recharges it.
  const ring = pickTarget(b, aimX(emptyInput(), 1), K, w);
  assert.equal(ring, 0, "the balloon is ringed");
  const ev2 = run(b, K, w, 1, f => { f.webPressed = f.webHeld = true; });
  assert.ok(ev2 & EV_ATTACH);
  assert.equal(b.airJumps, 1);
});

test("double jump is player-only: runner, prototype and moves-off tunings ignore airborne jump presses", () => {
  for (const [name, k] of [["runner", RUNNER], ["prototype", PROTOTYPE], ["moves off", { ...K, ...MOVES_OFF }]] as [string, Tuning][]) {
    const w = world(24, false);
    const b = createBody(6, 20.9, 10, 0);
    run(b, k, w, 3);
    run(b, k, w, 1, f => { f.jumpPressed = true; });
    run(b, k, w, 30);
    const ev = run(b, k, w, 1, f => { f.jumpPressed = true; f.zipPressed = true; });
    assert.equal(ev & (EV_DJUMP | EV_JUMP | EV_ZIP), 0, name);
    assert.equal(b.zipOn, false, name);
  }
});

test("web zip to the ringed balloon: pull under the speed cap, auto-release near it with a forward + up fling, cooldown", () => {
  const w = world(24, true);
  const b = createBody(14, 20.9, 10, 0);
  run(b, K, w, 3);
  assert.equal(b.ringId, 0);
  assert.ok(run(b, K, w, 1, f => { f.zipPressed = true; }) & EV_ZIP);
  assert.ok(b.zipOn && !b.grounded);
  assert.equal(b.zipHook, 0);
  let steps = 0, maxSp = 0;
  while (b.zipOn && steps++ < 400) {
    run(b, K, w, 1);
    maxSp = Math.max(maxSp, Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z));
  }
  assert.ok(!b.zipOn && (b.events & EV_ZIP_END), "released");
  assert.ok(steps < K.zipMaxTime * 120, `released near the anchor, not on the timeout (${steps} steps)`);
  assert.ok(maxSp <= K.speedCap + 1e-9, `speed cap kept (${maxSp})`);
  const h = w.hooks[0];
  const d = Math.sqrt((b.p.x - h.x) ** 2 + (b.p.y - h.y) ** 2 + (b.p.z - h.z) ** 2);
  assert.ok(d <= K.zipRelease + 0.5, `released ${d.toFixed(2)} m from the balloon`);
  assert.ok(b.v.y > 0 && b.v.x > 0, `flung forward + up (${b.v.x.toFixed(2)}, ${b.v.y.toFixed(2)})`);
  // Cooldown: a zip press right away does nothing; after zipCooldown it is ready again.
  assert.ok(Math.abs(b.zipCd - K.zipCooldown) < 1e-9);
  assert.equal(run(b, K, w, 1, f => { f.zipPressed = true; }) & EV_ZIP, 0);
  run(b, K, w, Math.ceil(K.zipCooldown * 120));
  assert.equal(b.zipCd, 0);
});

test("web zip to a roof ledge under the aim lands you on that roof (higher and lower); no target = no zip, no cooldown", () => {
  for (const top1 of [24, 16]) {
    const w = world(top1, false);
    const b = createBody(10, 20.9, 10, 0);
    run(b, K, w, 3);
    const za = emptyZipAim();
    assert.equal(zipTarget(b, -1, 1, 0, K, w, za), 2, `ledge found (top ${top1})`);
    assert.equal(za.roof, 1);
    assert.ok(run(b, K, w, 1, f => { f.zipPressed = true; }) & EV_ZIP);
    let steps = 0;
    while (!(b.grounded && !b.zipOn) && steps++ < 800) run(b, K, w, 1);
    assert.ok(b.grounded, `landed (top ${top1})`);
    assert.equal(b.roofId, 1, `on the target roof (top ${top1}), at x=${b.p.x.toFixed(2)}`);
    // Aiming at open air: nothing happens and the cooldown is not spent.
    run(b, K, w, Math.ceil(K.zipCooldown * 120));
    const cd = b.zipCd;
    assert.equal(run(b, K, w, 1, f => { aimX(f, 0, -1); f.zipPressed = true; }) & EV_ZIP, 0);
    assert.equal(b.zipCd, cd);
  }
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

/** A player round through the latch with double jumps (Space twice) and zips (E / Shift). */
function movesRound(seed: number, flags: GhostFlags, steps: number, zips = true): { round: Round; log: GhostLog; djumps: number; zipsDone: number } {
  const round = mk(seed, "normal", flags, true);
  const latch = new InputLatch();
  const rand = mulberry32(seed * 13 + 5);
  const f = emptyInput(), rec = emptyRec(), log = new GhostLog();
  let yaw = round.spawn.yaw, djumps = 0, zipsDone = 0;
  for (let i = 0; i < steps && !round.over; i++) {
    if (i % 2 === 0) yaw += (rand() - 0.5) * 0.03;
    if (i % 240 === 0) latch.press("KeyW");
    if (i % 150 === 40) { latch.press("Space"); latch.release("Space"); }
    if (i % 150 === 75) { latch.press("Space"); latch.release("Space"); }
    if (zips && i % 330 === 200) { latch.press(i % 660 === 200 ? "KeyE" : "ShiftLeft"); latch.release("KeyE"); latch.release("ShiftLeft"); }
    if (i % 500 === 300) latch.mouseDown(0);
    if (i % 500 === 380) latch.mouseUp(0);
    const chase = round.phase === "chase";
    latch.sample(rec, yaw);
    buildFrame(f, rec, round.player.v, flags.touch, round.tuning.runSpeed);
    if (chase) log.push(rec);
    round.step(f);
    if (round.player.events & EV_DJUMP) djumps++;
    if (round.player.events & EV_ZIP) zipsDone++;
  }
  return { round, log, djumps, zipsDone };
}

test("ghost: a run with double jumps and zips records B_ZIP, round-trips the link codec and replays bit-exactly", async () => {
  const flags: GhostFlags = { touch: false, easy: false };
  const { round, log, djumps, zipsDone } = movesRound(31, flags, 360 + 3600);
  assert.ok(djumps >= 3, `double jumps ${djumps}`);
  assert.ok(zipsDone >= 2, `zips ${zipsDone}`);
  let zipBits = 0;
  for (let i = 0; i < log.n; i++) if (log.bits[i] & B_ZIP) zipBits++;
  assert.ok(zipBits >= 2);
  const back = await unpackGhost(await packGhost(log, flags));
  assert.ok(back);
  assert.equal(back.flags.moves, undefined, "format 2 = the moves ruleset");
  const g = new GhostRun(mk(31, "normal", back.flags, true), back.log, false);
  g.advance(20000);
  assert.equal(g.round.chaseSteps, round.chaseSteps);
  assert.equal(g.round.hash(), round.hash());
});

test("ghost: a format-1 record (before the moves) replays with them off; the moves ruleset would drift", () => {
  const old: GhostFlags = { touch: false, easy: false, moves: false };
  const { round, log, djumps } = movesRound(32, old, 360 + 3000, false);
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
  // A format-1 record cannot carry the zip bit.
  const bad = encodeBytes(log, old);
  const withZip = new GhostLog(log.n);
  for (let i = 0; i < log.n; i++) withZip.push({ yaw: log.yaw[i], fwd: log.fwd[i], right: log.right[i], bits: log.bits[i] | (i === 5 ? B_ZIP : 0) });
  assert.equal(decodeBytes(encodeBytes(withZip, old)), null);
  assert.ok(decodeBytes(bad));
});

test("input: E / Shift / touch ZIP latch one zip press (recorded as B_ZIP, consumed by one step)", () => {
  const latch = new InputLatch();
  const rec = emptyRec();
  for (const press of [() => latch.press("KeyE"), () => latch.press("ShiftLeft"), () => latch.press("ShiftRight"), () => latch.touchZip()]) {
    press();
    assert.ok(latch.sample(rec, 0).bits & B_ZIP);
    assert.equal(latch.sample(rec, 0).bits & B_ZIP, 0, "consumed");
    latch.clear();
  }
  const f = emptyInput();
  latch.press("KeyE");
  latch.consume(f, 0, 1, 1, 0, 0);
  assert.ok(f.zipPressed);
  latch.consume(f, 0, 1, 1, 0, 0);
  assert.ok(!f.zipPressed);
});
