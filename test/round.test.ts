// Test 8 (round rules) on the committed city + pack: tag radius and |dy| gate, Yoink range and line of
// sight, fall (feet under failFloor, round 9) -> respawn -3 s at the nearest point, timer -> ESCAPED,
// seeded setup, restart hashing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodePack } from "../src/route/trackPack.ts";
import { applyTuningJson, DT, ROUND, type Difficulty } from "../src/sim/tuning.ts";
import { Round, type Kinematic } from "../src/game/round.ts";
import { Bot } from "../src/game/bots.ts";
import { createBody, emptyInput, pickRing, RING_RUNNER, type SimWorld } from "../src/sim/player.ts";
import { emptyAnchor } from "../src/world/cityQuery.ts";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8")));
const pack = decodePack(fs.readFileSync(lv("runner.pack.bin")));
const index = new CityIndex(model);

const mk = (seed: number, difficulty: Difficulty = "normal") =>
  new Round({ model, index, pack, difficulty, params: tuning.difficulty[difficulty], tuning: tuning.player, chaser: "652", runner: "4764", seed, countdown: false });

const at = (x: number, y: number, z: number): Kinematic => ({ p: { x, y, z }, v: { x: 0, y: 0, z: 0 }, grounded: false, phase: 1, roofId: -1 });

test("tag: 1.49 m horizontal catches, 1.51 m does not; |dy| gate at 1.8 m", () => {
  // At GO he is dwelling (head turn) on his start junction, so he stands still for 35 steps.
  for (const [dx, dy, want] of [[1.49, 0, "caught"], [1.51, 0, "chase"], [1.0, 1.79, "caught"], [1.0, 1.81, "chase"]] as const) {
    const r = mk(7);
    const inp = emptyInput();
    const p = r.runner.p;
    r.step(inp, at(p.x + dx, p.y + dy, p.z));
    assert.equal(r.phase, want, `dx ${dx} dy ${dy}`);
    if (want === "caught") assert.equal(r.stats.catchKind, "tag");
  }
});

test("Yoink: catches at d = R - 0.01 with a web press, not at R + 0.01", () => {
  for (const d of ["normal", "chill"] as const) {
    const R = tuning.difficulty[d].yoinkRange;
    for (const [off, want] of [[R - 0.01, "caught"], [R + 0.01, "chase"]] as const) {
      const r = mk(11, d);
      const p = r.runner.p;
      const inp = emptyInput();
      inp.aimX = -1; inp.aimY = 0; inp.aimZ = 0; // player sits at +x, aims back at him
      const ov = at(p.x + off, p.y, p.z);
      r.step(inp, ov); // ring is computed from the pre-step position, so place first ...
      inp.webPressed = true; inp.webHeld = true;
      r.step(inp, ov); // ... then press
      assert.equal(r.phase, want, `${d} offset ${off}`);
      if (want === "caught") assert.equal(r.stats.catchKind, "yoink");
    }
  }
});

test("Yoink line of sight: a building between the chests blocks the red ring", () => {
  const solids = [
    { id: 0, kind: "roof" as const, landable: true, x0: -6, z0: -6, x1: 0, z1: 6, top: 20 },
    { id: 1, kind: "tower" as const, landable: false, x0: 1, z0: -6, x1: 2, z1: 6, top: 60 },
    { id: 2, kind: "roof" as const, landable: true, x0: 3, z0: -6, x1: 9, z1: 6, top: 20 },
  ];
  const m = { ...model, solids, hooks: [], adjacency: [] } as CityModel;
  const w: SimWorld = { index: new CityIndex(m), runner: { p: { x: 4, y: 20.9, z: 0 }, roofId: 2 } };
  const b = createBody(-1, 20.9, 0, 0);
  const inp = emptyInput();
  inp.aimX = 1; inp.aimZ = 0;
  const k = { ...tuning.player, yoinkRange: 6 };
  assert.notEqual(pickRing(b, inp, k, w, emptyAnchor()), RING_RUNNER, "tower in between");
  w.index = new CityIndex({ ...m, solids: [solids[0], solids[2]].map((s, id) => ({ ...s, id })) });
  w.runner!.roofId = 1;
  assert.equal(pickRing(b, inp, k, w, emptyAnchor()), RING_RUNNER, "clear line");
});

test("fall: respawn on the last safe roof at the point nearest him, -3 s", () => {
  const r = mk(3);
  const inp = emptyInput();
  r.step(inp); // one real step on the spawn roof (last safe = spawn roof)
  const roof = model.solids[r.player.lastSafeRoof];
  r.player.p.y = tuning.player.failFloor; // feet under failFloor = in the street
  r.player.grounded = false;
  const clock = r.clock;
  r.step(inp);
  assert.equal(r.stats.falls, 1);
  assert.ok(Math.abs(r.clock - (clock - ROUND.respawnPenalty - DT)) < 1e-9);
  const rp = r.runner.p;
  const x = Math.min(Math.max(rp.x, roof.x0 + 1), roof.x1 - 1), z = Math.min(Math.max(rp.z, roof.z0 + 1), roof.z1 - 1);
  assert.deepEqual([r.player.p.x, r.player.p.y, r.player.p.z], [x, roof.top + 0.9, z]);
  assert.ok(r.player.grounded);
});

test("timer runs out -> ESCAPED; same seed -> same setup; a round after a round hashes like a cold start", () => {
  const r = mk(5);
  const inp = emptyInput();
  const still = at(r.player.p.x, r.player.p.y, r.player.p.z);
  still.grounded = true; still.roofId = r.player.roofId;
  while (!r.over) r.step(inp, still);
  assert.equal(r.phase, "escaped");
  assert.equal(r.chaseSteps, Math.ceil(ROUND.seconds * 120 - 1e-6));

  const a = mk(99), b = mk(99);
  assert.equal(a.startJunction, b.startJunction);
  assert.deepEqual(a.spawn, b.spawn);

  const run = (seed: number) => {
    const round = mk(seed);
    const bot = new Bot(round, { kind: "follow", k: 1.1, yoink: true });
    for (let i = 0; i < 900 && !round.over; i++) { const ov = bot.next(round, inp); round.step(inp, ov); bot.after(round); }
    return round.hash();
  };
  const cold = run(42);
  run(8);
  assert.equal(run(42), cold);
});

test("practice: a round's spawn, no countdown/clock/runner, falls cost nothing, same rng draws as a round", () => {
  const p = new Round({ model, index, pack, difficulty: "normal", params: tuning.difficulty.normal, tuning: tuning.player, chaser: "652", runner: "4764", seed: 3, practice: true });
  const real = mk(3);
  assert.equal(p.phase, "chase");
  assert.equal(p.world.runner, null);
  assert.deepEqual(p.spawn, real.spawn);
  assert.equal(p.rng.s, real.rng.s);
  const runner0 = p.runner.hash().hex();
  const inp = emptyInput();
  inp.moveX = 1; // run off the roof
  for (let i = 0; i < 1200; i++) p.step(inp);
  assert.equal(p.phase, "chase");
  assert.equal(p.clock, ROUND.seconds);
  assert.ok(p.stats.falls >= 1, `falls ${p.stats.falls}`);
  assert.equal(p.runner.hash().hex(), runner0);
});
