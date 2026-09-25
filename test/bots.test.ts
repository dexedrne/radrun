// The swinging chaser (game/bots.ts SwingBot, round 3; round 9 building anchors): it plays through the real
// player sim, so it must be deterministic (same seed -> same round, byte for byte) and it must actually
// chain swings and catch him. Balance numbers themselves are `npm run balance` (printed, not a gate; the
// round 9 bands are set once the taller cities land).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodePack } from "../src/route/trackPack.ts";
import { applyTuningJson, type Difficulty } from "../src/sim/tuning.ts";
import { Round } from "../src/game/round.ts";
import { SwingBot, runBotRound, streetLanes } from "../src/game/bots.ts";
import { emptyInput } from "../src/sim/player.ts";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8")));
const pack = decodePack(fs.readFileSync(lv("runner.pack.bin")));
const index = new CityIndex(model);

const mk = (seed: number, difficulty: Difficulty) =>
  new Round({ model, index, pack, difficulty, params: tuning.difficulty[difficulty], tuning: tuning.player, chaser: "652", runner: "4764", seed, countdown: false });

test("street lanes come from the street adjacencies (both axes)", () => {
  const lanes = streetLanes(model);
  assert.ok(lanes.some(l => l.along === 0) && lanes.some(l => l.along === 1));
  for (const l of lanes) assert.ok(l.hi > l.lo);
});

test("swinging chaser: same seed -> identical round; it chains swings and catches on Chill", () => {
  const run = (seed: number, d: Difficulty) => {
    const round = mk(seed, d);
    const r = runBotRound(round, { kind: "swing", k: 1, yoink: true }, emptyInput());
    return { r, hash: round.hash() };
  };
  const a = run(5, "normal"), b = run(5, "normal");
  assert.equal(a.hash, b.hash);
  assert.equal(a.r.steps, b.r.steps);
  assert.ok((a.r.swing?.swings ?? 0) >= 3, `swings ${a.r.swing?.swings}`);
  let caught = 0;
  for (const s of [1, 2, 3, 4]) if (run(s, "chill").r.caught) caught++;
  assert.ok(caught >= 2, `chill catches ${caught}/4`);
});

test("swinging chaser never draws from the round's rng (his branch choices stay the round's own)", () => {
  const round = mk(9, "degen");
  const s0 = round.rng.s;
  new SwingBot(round, 9);
  assert.equal(round.rng.s, s0);
});
