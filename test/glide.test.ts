import { test } from "node:test";
import assert from "node:assert/strict";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { createBody, emptyInput, stepBody, EV_ROLL, type SimWorld } from "../src/sim/player.ts";
import { PLAYER } from "../src/sim/tuning.ts";
import { InputLatch } from "../src/input/input.ts";
import { LookShaper, PAD_DEFAULTS, PB, PadButtons, padToLatch, type PadSnap } from "../src/input/gamepad.ts";
import { B_GLIDE, buildFrame, emptyRec } from "../src/game/ghost.ts";

const world: SimWorld = { index: new CityIndex({ solids: [], lowestRoof: 0 } as unknown as CityModel), runner: null };
const body = () => {
  const b = createBody(0, 80, 0, -1);
  b.grounded = false;
  b.v.x = 24;
  return b;
};

test("held glide sinks slowly; pitching down gains speed, pitching up trades it for height; release cancels", () => {
  const level = body(), down = body(), up = body();
  const f = { ...emptyInput(), glideHeld: true, aimX: 1, moveX: 1 };
  for (let i = 0; i < 180; i++) {
    f.aimY = 0; stepBody(level, f, PLAYER, world);
    f.aimY = -0.55; stepBody(down, f, PLAYER, world);
    f.aimY = 0.55; stepBody(up, f, PLAYER, world);
  }
  assert.equal(level.glideOn, true);
  assert.ok(level.v.y > -5 && level.v.y < 0, `slow sink ${level.v.y}`);
  assert.ok(down.v.x > level.v.x + 3, `dive ${down.v.x} vs ${level.v.x}`);
  assert.ok(up.p.y > level.p.y + 1, `pull up ${up.p.y} vs ${level.p.y}`);
  assert.ok(up.v.x < level.v.x - 2, `height cost ${up.v.x} vs ${level.v.x}`);
  assert.ok(Math.hypot(down.v.x, down.v.y, down.v.z) <= PLAYER.glideCap + 1e-8);
  f.glideHeld = false; stepBody(level, f, PLAYER, world);
  assert.equal(level.glideOn, false);
});

test("G and Xbox LB produce the same held glide input word", () => {
  const key = new InputLatch(), pad = new InputLatch(), buttons = new PadButtons();
  key.press("KeyG");
  const bs = Array.from({ length: 18 }, () => ({ pressed: false, value: 0 }));
  bs[PB.L1] = { pressed: true, value: 1 };
  const snap: PadSnap = { id: "Xbox", index: 0, axes: [0, 0, 0, 0], buttons: bs };
  buttons.update(snap); padToLatch(pad, snap, buttons, new LookShaper(), PAD_DEFAULTS, 1 / 60);
  const kr = key.sample(emptyRec(), 0), pr = pad.sample(emptyRec(), 0);
  assert.equal(kr.bits & B_GLIDE, B_GLIDE);
  assert.equal(pr.bits, kr.bits);
  assert.equal(buildFrame(emptyInput(), kr, { x: 0, y: 0, z: 0 }, false, 9).glideHeld, true);
});

test("glide landing rolls", () => {
  const roof: SimWorld = { index: new CityIndex({ solids: [{ id: 0, kind: "roof", landable: true, x0: -100, x1: 100, z0: -100, z1: 100, top: 0 }], lowestRoof: 0 } as CityModel), runner: null };
  const b = createBody(0, 3, 0, -1);
  b.grounded = false; b.v.x = 15; b.v.y = -3;
  const f = { ...emptyInput(), glideHeld: true, moveX: 1 };
  for (let i = 0; i < 240 && !b.grounded; i++) stepBody(b, f, PLAYER, roof);
  assert.equal(b.grounded, true);
  assert.ok(b.events & EV_ROLL);
});
