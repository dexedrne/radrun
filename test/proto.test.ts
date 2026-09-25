// Round 9 pendulum (docs/specs/2026-09-25-round9-movement.md §2.3): the swing is a real pendulum. Off a roof
// edge at 10 m/s under a pivot 16 m ahead / 18 m up / 6 m to the side, one arc takes about 2 s over ~36 m,
// dips well below the takeoff roof, reaches ~27 m/s at the bottom and flings forward + up. Without the pump,
// the speed-keeping taut and the release boost, the rope never adds energy. (The round 1 prototype trace
// test is retired with the balloons: its level had no buildings to web.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { CityIndex, type CityModel, type Solid } from "../src/world/cityModel.ts";
import { createBody, emptyInput, stepBody, EV_ATTACH, EV_AUTORELEASE, EV_RELEASE, type SimWorld } from "../src/sim/player.ts";
import { PLAYER, type Tuning } from "../src/sim/tuning.ts";
import { emptyAnchor, type AnchorHit } from "../src/world/cityQuery.ts";

/** A takeoff roof (top 30, its +x edge at x = 0) and a slim needle far off the arc the forced anchor sits on. */
function world(): { w: SimWorld; anchor: AnchorHit } {
  const solids: Solid[] = [
    { id: 0, kind: "roof", landable: true, x0: -30, z0: -10, x1: 0, z1: 10, top: 30 },
    { id: 1, kind: "tower", landable: false, x0: 15, z0: 40, x1: 16, z1: 41, top: 70 },
  ];
  const model = { solids, hooks: [], lowestRoof: 30 } as unknown as CityModel;
  const a = emptyAnchor();
  // Visual anchor on the needle's face toward the arc (clear line of sight), physics pivot 16 ahead / 18 up / 6 to the side.
  a.solid = 1; a.ax = 15.5; a.ay = 60; a.az = 40; a.px = 15.5; a.py = 48.9; a.pz = 6; a.nx = 0; a.nz = -1; a.rim = true;
  return { w: { index: new CityIndex(model), runner: null, forceAnchor: a }, anchor: a };
}

type Arc = { t: number; dx: number; dip: number; vMax: number; flingFwd: number; flingUp: number; eGain: number };

/** Run off the edge at 10 m/s with the web held; measure the arc from attach to the (auto) release. */
function arc(k: Tuning): Arc {
  const { w } = world();
  const b = createBody(-0.5, 30.9, 0, 0);
  b.v.x = 10;
  const inp = emptyInput();
  let t0 = -1, x0 = 0, minY = Infinity, vMax = 0, e0 = 0, eMax = -Infinity;
  const gs = k.gravity * k.swingGravity;
  for (let i = 0; i < 120 * 6; i++) {
    inp.moveX = 0; inp.moveZ = 0; inp.aimX = 1; inp.aimZ = 0;
    // Hold velocity on the roof (no stick): keep the run-off speed with a full stick along +x.
    if (b.grounded) inp.moveX = 1;
    inp.webHeld = !b.grounded;
    inp.webPressed = !b.grounded && t0 < 0;
    stepBody(b, inp, k, w);
    if (b.grounded) b.v.x = 10;
    if (b.events & EV_ATTACH) { t0 = b.t; x0 = b.p.x; e0 = 0.5 * (b.v.x ** 2 + b.v.y ** 2 + b.v.z ** 2) + gs * b.p.y; }
    if (t0 >= 0 && b.ropeSolid >= 0) {
      minY = Math.min(minY, b.p.y);
      vMax = Math.max(vMax, Math.sqrt(b.v.x ** 2 + b.v.y ** 2 + b.v.z ** 2));
      eMax = Math.max(eMax, 0.5 * (b.v.x ** 2 + b.v.y ** 2 + b.v.z ** 2) + gs * b.p.y);
    }
    if (t0 >= 0 && (b.events & EV_RELEASE)) {
      assert.ok(b.events & EV_AUTORELEASE, "the arc ends in the auto-release fling");
      return { t: b.t - t0, dx: b.p.x - x0, dip: 30.9 - minY, vMax, flingFwd: b.v.x, flingUp: b.v.y, eGain: (eMax - e0) / e0 };
    }
  }
  throw new Error("no release");
}

test("pendulum: one arc off a roof edge at 10 m/s ~2 s over ~36 m, dips below the roof, fast at the bottom, flings forward + up", () => {
  const a = arc(PLAYER);
  assert.ok(a.t > 1.5 && a.t < 2.8, `arc ${a.t.toFixed(2)} s`);
  assert.ok(a.dx > 26 && a.dx < 46, `arc covers ${a.dx.toFixed(1)} m`);
  assert.ok(a.dip > 4 && a.dip < 14, `dips ${a.dip.toFixed(1)} m below the takeoff roof`);
  assert.ok(a.vMax > 22 && a.vMax <= PLAYER.speedCap + 1e-9, `${a.vMax.toFixed(1)} m/s at the bottom`);
  assert.ok(a.flingFwd > 4 && a.flingUp > 4, `fling ${a.flingFwd.toFixed(1)} forward, ${a.flingUp.toFixed(1)} up`);
});

test("pendulum: without pump / speed-keeping / boost the rope never adds energy; the pump does", () => {
  const plain = arc({ ...PLAYER, swingPump: 0, swingKeepSpeed: 1, releaseBoost: 0, releaseUp: 0 });
  assert.ok(plain.eGain < 0.005, `energy grew ${(plain.eGain * 100).toFixed(2)}%`);
  const pumped = arc({ ...PLAYER, swingKeepSpeed: 1, releaseBoost: 0, releaseUp: 0 });
  assert.ok(pumped.eGain > 0.01, `the pump adds energy (${(pumped.eGain * 100).toFixed(2)}%)`);
  assert.ok(pumped.vMax > plain.vMax, "faster through the bottom with the pump");
});

test("pendulum: the floor clamp keeps the arc's bottom swingFloorClear above the street", () => {
  // A long rope from a high pivot straight over the street: reeled to keep the bottom 6 m up.
  const { w, anchor } = world();
  anchor.py = 30; anchor.px = 5; anchor.pz = 0; // pivot 30 m up, rope ~26 m to the body on the roof edge
  const b = createBody(-0.5, 30.9, 0, 0);
  b.v.x = 4;
  const inp = emptyInput();
  let minFeet = Infinity;
  for (let i = 0; i < 120 * 4; i++) {
    inp.aimX = 1; inp.webHeld = i > 0; inp.webPressed = i === 1;
    if (i === 0) inp.jumpPressed = true; else inp.jumpPressed = false;
    stepBody(b, inp, PLAYER, w);
    if (b.ropeSolid >= 0) minFeet = Math.min(minFeet, b.p.y - PLAYER.halfHeight);
  }
  assert.ok(minFeet >= PLAYER.swingFloorClear - 0.5, `lowest feet ${minFeet.toFixed(2)} m above the street`);
});
