import { test } from "node:test";
import assert from "node:assert/strict";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { InputLatch } from "../src/input/input.ts";
import { PadButtons, LookShaper, PAD_DEFAULTS, PB, padToLatch, type PadSnap } from "../src/input/gamepad.ts";
import { emptyRec, buildFrame } from "../src/game/ghost.ts";
import { createBody, emptyInput, stepBody, EV_AUTORELEASE, type SimWorld } from "../src/sim/player.ts";
import { PLAYER } from "../src/sim/tuning.ts";

const model = { solids: [{ id: 0, kind: "roof", landable: true, x0: 90, x1: 100, z0: 90, z1: 100, top: 30 }], lowestRoof: 30 } as CityModel;
const world: SimWorld = { index: new CityIndex(model), runner: null };

function longArc(pad: boolean): void {
  const b = createBody(0, 20, 0, -1);
  b.grounded = false;
  b.ropeSolid = 0;
  b.ropeP = { x: 0, y: 40, z: 0 };
  b.ropeA = { ...b.ropeP };
  b.ropeLen = b.ropeTarget = 20;
  b.ropeTaut = true;
  b.v.x = 24;
  const latch = new InputLatch(), buttons = new PadButtons(), look = new LookShaper();
  if (!pad) latch.mouseDown(0);
  let up = false;
  for (let i = 0; i < 360; i++) {
    if (pad) {
      const v = i > 0 && i % 7 === 0 ? 0.23 : i > 0 && i % 5 === 0 ? 0.28 : 0.62;
      const bs = Array.from({ length: 18 }, () => ({ pressed: false, value: 0 }));
      bs[PB.R2] = { pressed: v >= 0.5, value: v };
      const s: PadSnap = { id: "Xbox", index: 0, axes: [0, 0, 0, 0], buttons: bs };
      buttons.update(s);
      padToLatch(latch, s, buttons, look, PAD_DEFAULTS, 1 / 120);
    }
    const rec = latch.sample(emptyRec(), -Math.PI / 2);
    const f = buildFrame(emptyInput(), rec, b.v, false, PLAYER.runSpeed);
    assert.equal(f.webHeld, true, `input dropped on frame ${i}`);
    stepBody(b, f, PLAYER, world);
    if (b.v.y > 0) up = true;
    assert.equal(b.events & EV_AUTORELEASE, 0, `automatic release on frame ${i}`);
    assert.equal(b.ropeSolid, 0, `rope dropped on frame ${i}`);
  }
  assert.ok(up, "script must cross a rising arc");
}

test("mouse hold keeps a web through a long arc", () => longArc(false));
test("noisy Xbox R2 hold keeps a web through a long arc", () => longArc(true));

test("corner web remains held past its old time and heading exits", () => {
  const b = createBody(5, 20, 0, -1);
  b.grounded = false;
  b.cornerOn = true;
  b.cornerSolid = 0;
  b.cornerX = b.cornerZ = 0;
  b.cornerY = 25;
  b.cornerR = 5;
  b.cornerDx = 0;
  b.cornerDz = 1;
  b.v.z = 12;
  const f = { ...emptyInput(), webHeld: true, moveX: 1 };
  for (let i = 0; i < 240; i++) {
    stepBody(b, f, PLAYER, world);
    assert.equal(b.cornerOn, true, `corner let go on frame ${i}`);
  }
});
