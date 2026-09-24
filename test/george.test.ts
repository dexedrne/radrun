// George's follow model (spec §10, errata 10), fixture-driven on the prototype level: he sits until
// the buffer holds 0.5 s, trails 0.9 m to the path's left on the roof, follows airborne samples
// exactly (never more than maxTrail of path behind), never stands off a roof, never steps sideways
// more than 0.9/18 m, handles falls / respawns, and picks his gait by speed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { George, GEORGE } from "../src/sidekick/george.ts";
import { protoModel } from "./helpers.ts";

const model = protoModel();
const roof = model.solids[0];
const top = roof.top;

test("george: sits until the buffer fills, then trails left of the path on the roof", () => {
  const g = new George(model);
  const x0 = roof.x0 + 1;
  g.place(x0, top + 0.9, 0, 0, 1, 0);
  g.setBeat("");
  let x = x0;
  for (let i = 0; i < GEORGE.delay; i++) {
    x += 3 * GEORGE.dt;
    g.step({ x, y: top + 0.9, z: 0, grounded: true, rope: false, roofId: 0 });
    assert.equal(g.clip, "Sit_Idle");
  }
  for (let i = 0; i < 120; i++) {
    x += 3 * GEORGE.dt;
    g.step({ x, y: top + 0.9, z: 0, grounded: true, rope: false, roofId: 0 });
  }
  // Moving +x: the left is (tz, -tx) = (0, -1); w stays 1 on the ground.
  assert.ok(Math.abs(g.z - -GEORGE.side) < 1e-9, `z ${g.z}`);
  assert.ok(Math.abs(g.x - (x - 3 * GEORGE.delay * GEORGE.dt)) < 1e-9);
  assert.equal(g.y, top);
  assert.ok(g.x >= roof.x0 + GEORGE.inset && g.x <= roof.x1 - GEORGE.inset);
  assert.equal(g.clip, "Run");
  // Clamped into the roof when the sample hugs its edge.
  const h = new George(model);
  h.place(x0, top + 0.9, roof.z1, 0, 1, 0);
  h.setBeat("");
  for (let i = 0; i < 200; i++) h.step({ x: x0, y: top + 0.9, z: roof.z1 - 0.05, grounded: true, rope: false, roofId: 0 });
  assert.ok(h.z <= roof.z1 - GEORGE.inset + 1e-9);
});

test("george: airborne samples are followed exactly once the side offset has blended out", () => {
  const g = new George(model);
  g.place(0, top + 0.9, 0, 0, 1, 0);
  g.setBeat("");
  const path = (i: number) => ({ x: 0.03 * i, y: top + 0.9 + 4 * Math.sin(i / 200), z: 0 });
  for (let i = 0; i < 400; i++) g.step({ ...path(i), grounded: false, rope: true, roofId: -1 });
  const s = path(399 - GEORGE.delay);
  assert.equal(g.age, GEORGE.delay);
  assert.ok(Math.abs(g.x - s.x) < 1e-9 && Math.abs(g.z - s.z) < 1e-9 && Math.abs(g.y - (s.y - GEORGE.halfHeight)) < 1e-9);
  assert.equal(g.clip, "Leap_Air");
});

test("george: at 9 m/s he follows the path point maxTrail behind you, not the full 0.5 s", () => {
  const g = new George(model);
  g.place(0, top + 0.9, 0, 0, 1, 0);
  g.setBeat("");
  const v = 9 / 120;
  const path = (i: number) => ({ x: v * i, y: top + 3, z: 0 });
  for (let i = 0; i < 300; i++) g.step({ ...path(i), grounded: false, rope: false, roofId: -1 });
  assert.equal(g.age, Math.ceil(GEORGE.maxTrail / v - 1e-9));
  const s = path(299 - g.age);
  assert.ok(Math.abs(g.x - s.x) < 1e-9 && Math.abs(g.z) < 1e-9);
  assert.ok(path(299).x - g.x >= GEORGE.maxTrail - 1e-9 && path(299).x - g.x < GEORGE.maxTrail + v);
});

test("george: the side offset blends in and out by at most 0.9/18 m per step", () => {
  const g = new George(model);
  g.place(-28, top + 0.9, 0, 0, 1, 0);
  g.setBeat("");
  let x = -28, lastZ = g.z, worst = 0;
  for (let i = 0; i < 600; i++) {
    x += 3 * GEORGE.dt;
    const ground = Math.floor(i / 60) % 2 === 0;
    g.step({ x, y: top + 0.9, z: 0, grounded: ground, rope: !ground, roofId: ground ? 0 : -1 });
    if (i > GEORGE.delay + 1) worst = Math.max(worst, Math.abs(g.z - lastZ));
    lastZ = g.z;
  }
  assert.ok(worst <= GEORGE.side * GEORGE.wRate + 1e-9, `worst sideways step ${worst}`);
  assert.ok(worst > 0.04, "the offset did blend");
});

test("george: a fall parks him sitting at his last grounded point; respawn places him beside you", () => {
  const g = new George(model);
  g.place(-20, top + 0.9, 0, 0, 1, 0);
  g.setBeat("");
  let x = -20;
  for (let i = 0; i < 200; i++) { x += 3 * GEORGE.dt; g.step({ x, y: top + 0.9, z: 0, grounded: true, rope: false, roofId: 0 }); }
  const gx = g.x, gz = g.z;
  for (let i = 0; i < 90; i++) { x += 3 * GEORGE.dt; g.step({ x, y: top + 0.9 - i * 0.2, z: 0, grounded: false, rope: false, roofId: -1 }); }
  g.fall();
  assert.equal(g.clip, "Sit_Idle");
  assert.equal(g.y, top);
  assert.ok(g.x >= gx - 1e-9 && g.x <= x && Math.abs(g.z - gz) < 1e-9);
  g.place(0, top + 0.9, 0, 0, 0, 1);
  assert.equal(g.count, 0);
  assert.ok(Math.abs(g.x - GEORGE.side) < 1e-9 && Math.abs(g.z) < 1e-9 && g.y === top);
  g.step({ x: 0, y: top + 0.9, z: 0, grounded: true, rope: false, roofId: 0 });
  assert.equal(g.clip, "Sit_Idle");
});

test("george: gait by speed", () => {
  const g = new George(model);
  for (const [v, clip] of [[0.1, "Idle"], [0.4, "Walk"], [1.0, "Trot"], [9, "Run"]] as const) {
    g.gait(v);
    assert.equal(g.clip, clip, `${v} m/s`);
  }
  g.gait(9);
  assert.ok(g.rate > 2.5 && g.rate <= GEORGE.runRateMax);
});
