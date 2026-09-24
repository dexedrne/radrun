// A few cheap sim invariants (spec §16 test 3 subset): no embedding/tunnelling at 28 m/s into faces
// and corners, and the rope never stretches past its length while attached.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { createBody, emptyInput, stepBody, EV_BONK, type SimWorld } from "../src/sim/player.ts";
import { PLAYER } from "../src/sim/tuning.ts";
import { Sandbox } from "../src/game/sandbox.ts";
import { CAMERA } from "../src/sim/tuning.ts";

function boxWorld(): SimWorld {
  const model = {
    solids: [{ id: 0, kind: "roof", landable: true, x0: 0, z0: 0, x1: 12, z1: 12, top: 30 }],
    hooks: [], lowestRoof: 30,
  } as unknown as CityModel;
  return { index: new CityIndex(model), hooks: [], lowestRoof: -1e9, runner: null };
}

test("28 m/s into every face and corner never embeds the body", () => {
  const w = boxWorld();
  const hw = PLAYER.halfWidth;
  const shots: [number, number, number, number][] = [
    [-3, 6, 28, 0], [15, 6, -28, 0], [6, -3, 0, 28], [6, 15, 0, -28], // faces
    [-3, -3, 19.8, 19.8], [15, 15, -19.8, -19.8], [-3, 15, 19.8, -19.8], [15, -3, -19.8, 19.8], // corners
  ];
  for (const [x, z, vx, vz] of shots) {
    const b = createBody(x, 15, z, -1);
    b.v.x = vx; b.v.z = vz; b.v.y = 3;
    const inp = emptyInput();
    inp.aimX = vx; inp.aimZ = vz;
    let bonked = false;
    for (let i = 0; i < 90; i++) {
      stepBody(b, inp, PLAYER, w);
      if (b.events & EV_BONK) bonked = true;
      const pen = Math.min(b.p.x + hw - 0, 12 - (b.p.x - hw), b.p.z + hw - 0, 12 - (b.p.z - hw));
      const below = b.p.y - 0.9 < 30;
      assert.ok(!(pen > 1e-9 && below), `embedded shot (${x},${z}) step ${i}: p=${b.p.x},${b.p.z} pen=${pen}`);
    }
    if (vx === 0 || vz === 0) assert.ok(bonked, `head-on shot (${x},${z}) should bonk`);
  }
});

test("rope never stretches past its length while attached", () => {
  const model: CityModel = JSON.parse(fs.readFileSync(new URL("../public/levels/city.model.json", import.meta.url), "utf8"));
  const sb = new Sandbox(model, { ...PLAYER }, { ...CAMERA });
  let held = true, press = true, cooldown = 0, checked = 0;
  sb.input.script = f => {
    const b = sb.body;
    f.moveX = -sb.rig.sy; f.moveZ = -sb.rig.cy;
    if (b.ropeHook >= 0 && b.v.y > 0) { held = false; cooldown = 8; }
    else if (!held && --cooldown <= 0) { held = true; press = true; }
    f.webHeld = held; f.webPressed = press; press = false;
  };
  for (let i = 0; i < 2400; i++) {
    sb.frame(1 / 120);
    const b = sb.body;
    if (b.ropeHook >= 0) {
      const h = model.hooks[b.ropeHook];
      const d = Math.sqrt((b.p.x - h.x) ** 2 + (b.p.y - h.y) ** 2 + (b.p.z - h.z) ** 2);
      assert.ok(d <= b.ropeLen + 1e-9, `stretch ${d - b.ropeLen} at step ${b.step}`);
      assert.ok(b.ropeLen >= b.ropeTarget - 1e-12);
      checked++;
    }
  }
  assert.ok(checked > 100, `rope was attached for ${checked} steps`);
});
