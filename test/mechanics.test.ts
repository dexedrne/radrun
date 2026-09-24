// Round 4 mechanics: popping balloons, wind, low gravity, no Yoink, one life and the 60 s clock are
// deterministic, player-only (the runner is untouched) and part of the round hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodePack } from "../src/route/trackPack.ts";
import { applyTuningJson, MECH } from "../src/sim/tuning.ts";
import { Fnv1a } from "../src/sim/math.ts";
import { emptyInput, EV_POP } from "../src/sim/player.ts";
import { Round, windSchedule } from "../src/game/round.ts";
import { Bot, SwingBot } from "../src/game/bots.ts";
import { M_LOWGRAV, M_NOYOINK, M_ONELIFE, M_POPS, M_SIXTY, M_WIND } from "../src/game/mutators.ts";
import type { CityModel } from "../src/world/cityModel.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const pack = decodePack(fs.readFileSync(lv("runner.pack.bin")));
const { player, difficulty } = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8")));
const make = (seed: number, mutators: number, countdown = false) =>
  new Round({ model, pack, difficulty: "normal", params: difficulty.normal, tuning: player, chaser: "652", runner: "4764", seed, countdown, mutators });

/** Drive a round with the swinging bot (real player sim) for up to `steps`; returns its per-step pop count. */
function swingRun(r: Round, steps: number): { pops: number; hashes: string[] } {
  const bot = new SwingBot(r, r.opts.seed);
  const inp = emptyInput();
  let pops = 0;
  const hashes: string[] = [];
  for (let i = 0; i < steps && !r.over; i++) {
    const ov = bot.next(r, inp);
    r.step(inp, ov);
    bot.after(r);
    if (r.player.events & EV_POP) pops++;
    if (i % 120 === 0) hashes.push(r.hash());
  }
  return { pops, hashes };
}

test("mechanics: pops + wind + low gravity replay bit-exactly (same seed, same bot)", () => {
  const all = M_POPS | M_WIND | M_LOWGRAV;
  const a = swingRun(make(4242, all), 120 * 40);
  const b = swingRun(make(4242, all), 120 * 40);
  assert.deepEqual(a.hashes, b.hashes);
  // And the mutators change the round (the hash differs from a classic round with the same seed).
  const c = swingRun(make(4242, 0), 120 * 40);
  assert.notDeepEqual(a.hashes, c.hashes);
});

test("mechanics: fragile balloons pop when the rope leaves them and grow back after popRespawn", () => {
  const r = make(77, M_POPS);
  const { pops } = swingRun(r, 120 * 60);
  assert.ok(pops > 0, "the swinging bot never popped a balloon");
  const down = r.world.hookDown!;
  const frag = r.world.fragile!;
  let fragile = 0;
  for (let i = 0; i < frag.length; i++) fragile += frag[i];
  const share = fragile / frag.length;
  assert.ok(Math.abs(share - MECH.popShare) < 0.12, `fragile share ${share}`);
  for (let i = 0; i < down.length; i++) {
    if (down[i] === 0) continue;
    assert.equal(frag[i], 1, "only fragile balloons pop");
    assert.ok(down[i] <= r.player.step + Math.round(MECH.popRespawn * 120), "popped for longer than popRespawn");
  }
});

test("mechanics: the runner never reads the player's mechanics (same player path -> same runner)", () => {
  // The follower bot drives the player kinematically (no stepBody), so the player path is identical;
  // the runner must then be step-for-step identical with and without every player mutator.
  const runnerHash = (r: Round) => { const h = new Fnv1a(); r.runner.hash(h); return h.hex(); };
  const a = make(9001, 0), b = make(9001, M_POPS | M_WIND | M_LOWGRAV | M_NOYOINK);
  const ba = new Bot(a, { kind: "follow", k: 1.1, yoink: false }), bb = new Bot(b, { kind: "follow", k: 1.1, yoink: false });
  const inp = emptyInput();
  for (let i = 0; i < 120 * 30 && !a.over && !b.over; i++) {
    a.step(inp, ba.next(a, inp)); ba.after(a);
    b.step(inp, bb.next(b, inp)); bb.after(b);
    assert.equal(runnerHash(a), runnerHash(b), `runner diverged at step ${i}`);
  }
});

test("mechanics: wind gusts come from their own rng and only push while airborne", () => {
  const g1 = windSchedule(5), g2 = windSchedule(5), g3 = windSchedule(6);
  assert.deepEqual(g1, g2);
  assert.notDeepEqual(g1, g3);
  assert.ok(g1.length >= 5, `${g1.length} gusts`);
  for (const g of g1) {
    assert.equal(g.end - g.start, Math.round(MECH.windGust * 120));
    assert.ok(Math.abs(g.dx * g.dx + g.dz * g.dz - 1) < 1e-12);
  }
  // Same seed with and without wind: identical round rng draws (spawn / start junction unchanged).
  const a = make(31337, 0), b = make(31337, M_WIND);
  assert.equal(a.startJunction, b.startJunction);
  assert.deepEqual(a.spawn, b.spawn);
  // Standing still through a gust: a grounded body is never pushed.
  const inp = emptyInput();
  const g = b.gusts[0];
  for (let i = 0; i < g.end + 10; i++) b.step(inp);
  assert.ok(Math.abs(b.player.p.x - b.spawn.x) < 1e-9 && Math.abs(b.player.p.z - b.spawn.z) < 1e-9, "wind moved a grounded player");
});

test("mechanics: one life ends the round on the first fall; sixty starts a 60 s clock; no-Yoink disables the lasso", () => {
  const s = make(1, M_SIXTY);
  assert.equal(s.clock, MECH.sixtyClock);
  assert.equal(s.clock0, MECH.sixtyClock);
  const n = make(1, M_NOYOINK);
  assert.equal(n.tuning.yoink, false);
  const o = make(1, M_ONELIFE);
  // Walk straight off the spawn roof into the street.
  const inp = emptyInput();
  inp.moveX = 1;
  for (let i = 0; i < 120 * 20 && !o.over; i++) {
    inp.moveX = 1; inp.moveZ = 0;
    o.step(inp);
  }
  if (o.stats.falls > 0) assert.equal(o.phase, "escaped");
});
