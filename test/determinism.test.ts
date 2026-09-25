// Test 2 (spec §16): a recorded 60 s InputFrame log replayed under five frame patterns gives an
// identical final state hash (ringId included) on the committed city. The log includes double jumps
// (a second Space in the air), web zips and (round 9) slides; the building-anchor swings, wall runs,
// ledge grabs and vaults happen from the same inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Sandbox } from "../src/game/sandbox.ts";
import { hashBody, type InputFrame } from "../src/sim/player.ts";
import { CAMERA, PLAYER } from "../src/sim/tuning.ts";
import { mulberry32 } from "../src/sim/math.ts";
import type { CityModel } from "../src/world/cityModel.ts";

const model: CityModel = JSON.parse(fs.readFileSync(new URL("../public/levels/city.model.json", import.meta.url), "utf8"));
const STEPS = 7200; // 60 s at 120 Hz

function run(pattern: (i: number) => number, log: InputFrame[] | null): { hash: string; sb: Sandbox } {
  const sb = new Sandbox(model, { ...PLAYER }, { ...CAMERA });
  sb.stepLimit = STEPS;
  if (log) {
    sb.input.script = (f, i) => Object.assign(f, log[i]);
  } else {
    // Recording run: a wandering, jumping, swinging scripted player.
    const rand = mulberry32(1234);
    let yaw = model.spawn.yaw, turn = 0, webFor = 0, jumpIn = 60, djIn = -1;
    sb.input.record = [];
    sb.input.script = (f, i) => {
      if (i % 90 === 0) turn = (rand() - 0.5) * 1.6;
      yaw += turn / 120;
      const sy = Math.sin(yaw), cy = Math.cos(yaw), pitch = 0.35;
      f.aimX = -sy * Math.cos(pitch); f.aimY = Math.sin(pitch); f.aimZ = -cy * Math.cos(pitch);
      f.moveX = -sy; f.moveZ = -cy;
      f.jumpPressed = --jumpIn <= 0 || --djIn === 0;
      if (jumpIn <= 0) { jumpIn = 80 + Math.floor(rand() * 120); djIn = 25 + Math.floor(rand() * 30); }
      f.zipPressed = i % 420 === 210;
      f.slidePressed = i % 240 === 70;
      f.webPressed = webFor <= 0 && rand() < 0.02;
      if (f.webPressed) webFor = 40 + Math.floor(rand() * 110);
      f.webHeld = webFor-- > 0;
    };
  }
  let frame = 0;
  while (sb.stats.steps < STEPS) sb.frame(pattern(frame++));
  return { hash: hashBody(sb.body).hex(), sb };
}

test("60 s input log replays to the same state hash under five frame patterns", () => {
  const rec = run(() => 1 / 60, null);
  const log = rec.sb.input.record!;
  assert.equal(log.length, STEPS);
  assert.ok(rec.sb.stats.swings > 5, `recording should swing (swings=${rec.sb.stats.swings})`);
  assert.ok(log.some(f => f.zipPressed) && log.filter(f => f.jumpPressed).length > 30, "recording presses zip and double jumps");
  assert.ok(log.some(f => f.slidePressed), "recording presses slide");
  const jit = mulberry32(99);
  const patterns: [string, (i: number) => number][] = [
    ["60 Hz", () => 1 / 60],
    ["144 Hz", () => 1 / 144],
    ["30 Hz", () => 1 / 30],
    ["24-144 fps jitter", () => 1 / (24 + jit() * 120)],
    ["5-7 fps", () => 1 / (5 + jit() * 2)],
  ];
  for (const [name, pat] of patterns) {
    const r = run(pat, log);
    assert.equal(r.sb.stats.steps, STEPS, name);
    assert.equal(r.hash, rec.hash, `${name}: hash ${r.hash} != ${rec.hash}`);
  }
});
