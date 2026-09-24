// Auto quality (app/autoQuality.ts): the verdict from the first ~10 s of a chase's frame times.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_Q, AutoQuality } from "../src/app/autoQuality.ts";

test("auto quality: sustained < 40 fps in the first 10 s of a chase fires once; 60 fps with hitches does not", () => {
  const run = (fps: number, hitchEvery: number, runId: number, aq = new AutoQuality()) => {
    let fired = 0;
    for (let t = 0; t < 12; t += 1 / fps) {
      const dt = hitchEvery && Math.floor(t * fps) % hitchEvery === 0 ? 0.2 : 1 / fps;
      if (aq.frame(dt, runId, true)) fired++;
    }
    return { fired, aq };
  };
  assert.equal(run(60, 7, 1).fired, 0);
  assert.equal(run(45, 0, 1).fired, 0);
  const slow = run(30, 0, 1);
  assert.equal(slow.fired, 1);
  assert.equal(run(20, 0, 2, slow.aq).fired, 0, "never fires twice");
  assert.equal(run(6, 0, 1).fired, 1, "a 6 fps device still gets a verdict");
  // Inactive frames (paused, title, Low) never count; the warm-up is skipped.
  const aq = new AutoQuality();
  for (let i = 0; i < 2000; i++) assert.equal(aq.frame(1 / 20, 3, false), false);
  let f = 0;
  for (let t = 0; t < AUTO_Q.warmup + 0.5; t += 1 / 20) if (aq.frame(1 / 20, 3, true)) f++;
  assert.equal(f, 0);
});
