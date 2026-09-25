// A few cheap sim invariants (spec §16 test 3 subset): no embedding/tunnelling at 28 m/s into faces
// and corners, the rope never stretches past its length while attached; round 9: webs attach only to
// buildings (a rim, corner or facade point of a solid, high enough, in rope range, never open sky), the ring
// stays on one building and glides along it, and a web press with nothing ringed does nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { createBody, emptyInput, pickRing, stepBody, EV_ATTACH, EV_BONK, EV_NOANCHOR, RING_NONE, type SimWorld } from "../src/sim/player.ts";
import { PLAYER } from "../src/sim/tuning.ts";
import { Sandbox } from "../src/game/sandbox.ts";
import { CAMERA } from "../src/sim/tuning.ts";
import { emptyAnchor, findAnchor } from "../src/world/cityQuery.ts";
import { mulberry32 } from "../src/sim/math.ts";
import { TALL, tallModel, tallWorld } from "./helpers.ts";

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
    if (b.ropeSolid >= 0 && b.v.y > 0) { held = false; cooldown = 8; }
    else if (!held && --cooldown <= 0) { held = true; press = true; }
    f.webHeld = held; f.webPressed = press; press = false;
  };
  for (let i = 0; i < 2400; i++) {
    sb.frame(1 / 120);
    const b = sb.body;
    if (b.ropeSolid >= 0) {
      const h = b.ropeP;
      const d = Math.sqrt((b.p.x - h.x) ** 2 + (b.p.y - h.y) ** 2 + (b.p.z - h.z) ** 2);
      assert.ok(d <= b.ropeLen + 1e-9, `stretch ${d - b.ropeLen} at step ${b.step}`);
      assert.ok(b.ropeLen >= b.ropeTarget - 1e-12);
      checked++;
    }
  }
  assert.ok(checked > 100, `rope was attached for ${checked} steps`);
});

test("anchors: always a point on a building (rim / corner / facade), high enough, in rope range, in the cone", () => {
  const model = tallModel();
  const w = tallWorld(model);
  const idx = w.index;
  const rand = mulberry32(9);
  const a = emptyAnchor();
  let found = 0, rims = 0, faces = 0;
  for (let i = 0; i < 3000; i++) {
    const x = rand() * 140 - 5, z = 20 + rand() * 18, y = 30 + rand() * 35;
    const yaw = rand() * 6.283185307179586, fx = Math.cos(yaw), fz = Math.sin(yaw);
    if (!findAnchor(idx, x, y, z, fx, fz, rand() * 25, PLAYER, -1, -1, -1, a)) continue;
    found++;
    const s = model.solids[a.solid];
    const onX = a.ax === s.x0 || a.ax === s.x1, onZ = a.az === s.z0 || a.az === s.z1;
    assert.ok(onX || onZ, `anchor inside the footprint of ${a.solid}: ${a.ax},${a.az}`);
    assert.ok(a.ax >= s.x0 && a.ax <= s.x1 && a.az >= s.z0 && a.az <= s.z1 && a.ay >= 0 && a.ay <= s.top, "on the box");
    if (a.rim) { rims++; assert.equal(a.ay, s.top, "a rim anchor sits on the top edge"); } else faces++;
    assert.ok(a.ay - y >= PLAYER.anchorMinAbove - 1e-9, "high enough");
    const d = Math.sqrt((a.ax - x) ** 2 + (a.ay - y) ** 2 + (a.az - z) ** 2);
    assert.ok(d >= PLAYER.ropeMin - 1e-9 && d <= PLAYER.ropeMax + 1e-9, `rope ${d}`);
    const hl = Math.sqrt((a.ax - x) ** 2 + (a.az - z) ** 2);
    assert.ok(hl < 3 || (a.ax - x) * fx + (a.az - z) * fz >= PLAYER.aimCos * hl - 1e-9, "in the aim cone");
    // The pivot sits off the face (never inside the building), at the anchor's height.
    assert.equal(a.py, a.ay);
    assert.ok(!(a.px > s.x0 && a.px < s.x1 && a.pz > s.z0 && a.pz < s.z1), "pivot outside the footprint");
  }
  assert.ok(found > 500 && rims > 50 && faces > 50, `found ${found} (${rims} rims, ${faces} facades)`);
});

test("anchors: nothing tall nearby = no ring; a web press then does nothing but the 'no anchor' event", () => {
  const model = { solids: [{ id: 0, kind: "roof", landable: true, x0: 0, z0: 0, x1: 30, z1: 30, top: 40 }], hooks: [], lowestRoof: 40 } as unknown as CityModel;
  const w: SimWorld = { index: new CityIndex(model), runner: null };
  const b = createBody(15, 40.9, 15, 0);
  const inp = { ...emptyInput(), aimX: 1, aimZ: 0 };
  assert.equal(pickRing(b, inp, PLAYER, w, emptyAnchor()), RING_NONE);
  inp.webPressed = inp.webHeld = true;
  stepBody(b, inp, PLAYER, w);
  assert.ok(b.events & EV_NOANCHOR);
  assert.equal(b.events & EV_ATTACH, 0);
  assert.equal(b.ropeSolid, -1);
  assert.ok(b.grounded, "no jump either");
});

test("ring: one building keeps the ring and its point glides along the facade as you move", () => {
  const w = tallWorld();
  const b = createBody(30, 45, 29, -1);
  b.grounded = false;
  const inp = { ...emptyInput(), aimX: 1, aimZ: 0 };
  const a = emptyAnchor();
  const ids: number[] = [];
  let maxJump = 0, prevX = NaN;
  for (let i = 0; i < 40; i++) {
    b.p.x = 30 + i * 0.25; // slide along the avenue
    b.ringId = pickRing(b, inp, PLAYER, w, a);
    ids.push(b.ringId);
    if (!Number.isNaN(prevX) && b.ringId === ids[ids.length - 2]) maxJump = Math.max(maxJump, Math.abs(a.ax - prevX));
    prevX = a.ax;
  }
  const switches = ids.filter((id, i) => i > 0 && id !== ids[i - 1]).length;
  assert.ok(ids.every(id => id >= 0), "something ringed all along the avenue");
  assert.ok(switches <= 2, `ring switched ${switches} times over 10 m`);
  assert.ok(maxJump <= 0.6, `the ring point glides (max step ${maxJump.toFixed(2)} m)`);
  assert.ok((TALL.north as readonly number[]).includes(ids[0]) || (TALL.south as readonly number[]).includes(ids[0]), "a building of the avenue");
});
