// Ghost runs (game/ghost.ts): the link codec round-trips exactly, a recorded run replays to the same final
// state hash (player path through the input latch, touch aim bias, and the swinging bot), and the claim
// check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodePack } from "../src/route/trackPack.ts";
import { applyTuningJson, TOUCH, type Difficulty } from "../src/sim/tuning.ts";
import { Round } from "../src/game/round.ts";
import { SwingBot } from "../src/game/bots.ts";
import { emptyInput } from "../src/sim/player.ts";
import { mulberry32 } from "../src/sim/math.ts";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { InputLatch } from "../src/input/input.ts";
import {
  GHOST_MAX_STEPS, GhostLog, GhostRun, YAW_COS, YAW_RES, YAW_SIN, buildFrame, decodeBytes, emptyRec, encodeBytes, packGhost,
  recFromFrame, roundTuning, unpackGhost, type GhostFlags,
} from "../src/game/ghost.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8")));
const pack = decodePack(fs.readFileSync(lv("runner.pack.bin")));

/** A round exactly as PlayGame.makeRound / makeGhostRun build it (own CityIndex each time). */
const mk = (seed: number, d: Difficulty, flags: GhostFlags, countdown = false) => new Round({
  model, index: new CityIndex(model), pack, difficulty: d, params: tuning.difficulty[d], tuning: roundTuning(tuning.player, flags),
  chaser: "652", runner: "4764", seed, countdown, yoinkBonus: flags.touch ? TOUCH.yoinkBonus : 0,
});

function sameLog(a: GhostLog, b: GhostLog): void {
  assert.equal(a.n, b.n);
  for (let i = 0; i < a.n; i++) {
    if (a.yaw[i] !== b.yaw[i] || a.fwd[i] !== b.fwd[i] || a.right[i] !== b.right[i] || a.bits[i] !== b.bits[i]) assert.fail(`step ${i} differs`);
  }
}

test("yaw table: polynomial sin/cos match Math.sin/cos to 1e-14 in every quadrant", () => {
  let worst = 0;
  for (let k = 0; k < YAW_RES; k++) {
    const a = (k * 2 * Math.PI) / YAW_RES;
    worst = Math.max(worst, Math.abs(YAW_SIN[k] - Math.sin(a)), Math.abs(YAW_COS[k] - Math.cos(a)));
  }
  assert.ok(worst < 1e-14, `worst ${worst}`);
});

test("codec: encode -> decode and pack -> unpack round-trip exactly (runs, yaw wrap, extremes)", async () => {
  const rand = mulberry32(77);
  for (const n of [1, 2, 5000, GHOST_MAX_STEPS]) {
    const log = new GhostLog();
    const rec = emptyRec();
    let yaw = YAW_RES - 3, fwd = 64, right = 0, bits = 0;
    for (let i = 0; i < n; i++) {
      const u = rand();
      if (u < 0.3) yaw = (yaw + Math.floor(rand() * 9) - 4 + YAW_RES) % YAW_RES; // small moves, across 0 <-> YAW_RES - 1
      else if (u < 0.31) yaw = Math.floor(rand() * YAW_RES); // flicks
      if (rand() < 0.02) fwd = [127, -127, 64, 0, -64, 13][Math.floor(rand() * 6)];
      if (rand() < 0.02) right = Math.floor(rand() * 255) - 127;
      if (rand() < 0.05) bits = Math.floor(rand() * 16); // B_ZIP (8) included (format 2)
      rec.yaw = yaw; rec.fwd = fwd; rec.right = right; rec.bits = bits;
      log.push(rec);
    }
    const flags = { touch: n % 2 === 0, easy: n > 4000 };
    const dec = decodeBytes(encodeBytes(log, flags));
    assert.ok(dec, `decode n=${n}`);
    sameLog(dec.log, log);
    assert.deepEqual(dec.flags, flags);
    const s = await packGhost(log, flags);
    assert.match(s, /^[A-Za-z0-9_-]+$/);
    const back = await unpackGhost(s);
    assert.ok(back, `unpack n=${n}`);
    sameLog(back.log, log);
    assert.deepEqual(back.flags, flags);
  }
});

test("codec: garbage, truncated or tampered strings decode to null (never throw)", async () => {
  const log = new GhostLog();
  for (let i = 0; i < 300; i++) log.push({ yaw: i % YAW_RES, fwd: 64, right: 0, bits: i % 50 < 20 ? 4 : 0 });
  const bytes = encodeBytes(log, { touch: false, easy: false });
  assert.equal(decodeBytes(bytes.slice(0, bytes.length - 1)), null);
  assert.equal(decodeBytes(new Uint8Array([9, 0, 1, 0])), null);
  const s = await packGhost(log, { touch: false, easy: false });
  for (const bad of ["", "!!!!", "AAAAAAAAAAAA", s.slice(0, s.length >> 1), `${s}AAAA`]) assert.equal(await unpackGhost(bad), null, bad);
});

/** A player round through the latch (the play page's path): keys, a sweeping mouse, LMB holds, jumps. */
function playerRound(seed: number, d: Difficulty, flags: GhostFlags, steps: number): { round: Round; log: GhostLog } {
  const round = mk(seed, d, flags, true);
  const latch = new InputLatch();
  latch.easyGrab = flags.easy;
  const rand = mulberry32(seed * 31 + 7);
  const f = emptyInput(), rec = emptyRec(), log = new GhostLog();
  let yaw = round.spawn.yaw, vel = 0, hold = 0, gap = 40;
  for (let i = 0; i < steps && !round.over; i++) {
    if (i % 2 === 0) { // the mouse moves once per 60 Hz frame
      if (rand() < 0.02) vel = (rand() - 0.5) * 0.2;
      vel *= 0.9;
      yaw += vel + (rand() - 0.5) * 0.004;
    }
    if (i % 240 === 0) latch.press("KeyW");
    if (i % 400 === 100) latch.press("KeyD");
    if (i % 400 === 220) latch.release("KeyD");
    if (flags.touch) latch.setStick(Math.sin(i / 97) * 0.9, 0.7);
    if (rand() < 0.004) { latch.press("Space"); latch.release("Space"); }
    if (hold > 0 && --hold === 0) latch.mouseUp(0);
    else if (hold === 0 && --gap <= 0) { latch.mouseDown(0); hold = 40 + Math.floor(rand() * 100); gap = 50 + Math.floor(rand() * 90); }
    const chase = round.phase === "chase";
    latch.sample(rec, yaw);
    buildFrame(f, rec, round.player.v, flags.touch, round.tuning.runSpeed);
    if (chase) log.push(rec);
    round.step(f);
  }
  return { round, log };
}

test("replay: a recorded player run (latch path) replays to the same final state hash", async () => {
  for (const [seed, d, flags] of [[11, "normal", { touch: false, easy: false }], [4, "degen", { touch: true, easy: false }], [8, "chill", { touch: false, easy: true }]] as [number, Difficulty, GhostFlags][]) {
    const { round, log } = playerRound(seed, d, flags, 360 + 5400);
    assert.ok(log.n > 1000, `recorded ${log.n}`);
    assert.equal(log.n, round.chaseSteps);
    assert.ok(round.stats.maxChain >= 1, `swung (chain ${round.stats.maxChain})`);
    const back = await unpackGhost(await packGhost(log, flags));
    assert.ok(back);
    // Lockstep replay (countdown included, like the live ghost) and the title's verification (no countdown).
    for (const countdown of [true, false]) {
      const g = new GhostRun(mk(seed, d, back.flags, countdown), back.log, back.flags.touch);
      g.advance(20000);
      assert.equal(g.round.chaseSteps, round.chaseSteps, `${d} steps (countdown ${countdown})`);
      if (countdown) assert.equal(g.round.hash(), round.hash(), `${d} ${JSON.stringify(flags)}: hash`);
      else assert.equal(g.round.player.p.x, round.player.p.x);
    }
  }
});

test("replay: the swinging bot's catch recorded through the codec verifies; a wrong claim does not", async () => {
  const flags = { touch: false, easy: false };
  const round = mk(24, "degen", flags);
  const bot = new SwingBot(round, 24);
  const f = emptyInput(), rec = emptyRec(), log = new GhostLog();
  while (!round.over) {
    bot.next(round, f);
    recFromFrame(rec, f);
    buildFrame(f, rec, round.player.v, false, round.tuning.runSpeed);
    log.push(rec);
    round.step(f);
    bot.after(round);
  }
  assert.equal(round.phase, "caught");
  const back = await unpackGhost(await packGhost(log, flags));
  assert.ok(back);
  const replay = (claimed: number) => {
    const g = new GhostRun(mk(24, "degen", back.flags), back.log, false);
    g.advance(20000);
    return g;
  };
  const g = replay(round.stats.catchTime);
  assert.equal(g.round.hash(), round.hash());
  assert.ok(g.verifies(Math.round(round.stats.catchTime * 10) / 10));
  assert.ok(!g.verifies(Math.round(round.stats.catchTime * 10) / 10 + 0.2));
  // Another seed's round: the record no longer catches him on its last step.
  const other = new GhostRun(mk(25, "degen", flags), back.log, false);
  other.advance(20000);
  assert.ok(!other.verifies(round.stats.catchTime));
});
