// Test 1 (spec §5.6): stepBody with the PROTOTYPE preset reproduces the verified 2D prototype trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LEVEL, SCRIPTS, scriptInput } from "./fixtures/proto/level.ts";
import { createBody, emptyInput, stepBody, EV_FALL } from "../src/sim/player.ts";
import { PROTOTYPE } from "../src/sim/tuning.ts";
import { protoWorld } from "./helpers.ts";

type Trace = { steps: number; landings: number[]; rows: number[][] };
const trace: Trace = JSON.parse(fs.readFileSync(new URL("./fixtures/proto/trace.json", import.meta.url), "utf8"));

test("PROTOTYPE preset matches the prototype trace within 1e-9 m, same landing steps", () => {
  const w = protoWorld();
  const b = createBody(0, LEVEL.roofs[0].top + 0.9, 0, 0);
  const inp = emptyInput();
  let t = 0, prev = false, maxErr = 0;
  const landings: number[] = [];
  const lastRoof = LEVEL.roofs.length - 1;
  for (let step = 1; step <= trace.steps; step++) {
    const si = scriptInput(t, prev, SCRIPTS.kinematic);
    inp.moveX = 1; inp.moveZ = 0; inp.aimX = 1; inp.aimY = 0; inp.aimZ = 0;
    inp.jumpPressed = si.jumpPressed;
    inp.webHeld = si.swingHeld;
    inp.webPressed = si.jumpPressed;
    const was = b.grounded;
    stepBody(b, inp, PROTOTYPE, w);
    t += PROTOTYPE.dt;
    prev = si.swingHeld;
    if (!was && b.grounded) landings.push(step);
    const r = trace.rows[step - 1];
    const err = Math.max(Math.abs(b.p.x - r[0]), Math.abs(b.p.y - r[1]), Math.abs(b.v.x - r[2]), Math.abs(b.v.y - r[3]));
    maxErr = Math.max(maxErr, err);
    assert.ok(err <= 1e-9, `step ${step}: err ${err} (x ${b.p.x} vs ${r[0]}, y ${b.p.y} vs ${r[1]})`);
    assert.equal(b.grounded ? 1 : 0, r[4], `grounded at step ${step}`);
    assert.equal(b.roofId, r[5], `roof at step ${step}`);
    assert.equal(b.ropeHook, r[6], `anchor at step ${step}`);
    assert.equal(Math.abs(b.p.z), 0);
    assert.equal(b.events & EV_FALL, 0, `fell at step ${step}`);
    if (b.grounded && b.roofId === lastRoof) {
      assert.equal(step, trace.steps, "reached the last roof on the final trace step");
    }
  }
  assert.deepEqual(landings, trace.landings);
  assert.ok(maxErr <= 1e-9, `max err ${maxErr}`);
});
