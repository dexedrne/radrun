// Procedural music (audio/score.ts, round 4): the score is deterministic, stays in range, varies across
// the loop, and the close-chase layer switches on under 20 m (or while he panics) with hysteresis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYER_OFF, LAYER_ON, barNotes, musicTarget, tempoFor, type MusicInput } from "../src/audio/score.ts";

test("score: deterministic, in range, varies across the chase loop and between cycles", () => {
  const sig = (bar: number) => JSON.stringify(barNotes("chase", bar).base.filter(n => n.voice === "lead").map(n => [n.step, n.midi]));
  assert.equal(sig(3), sig(3));
  for (const mode of ["chase", "calm", "intro"] as const) {
    for (let bar = 0; bar < 48; bar++) {
      const b = barNotes(mode, bar);
      for (const n of [...b.base, ...b.layer]) {
        assert.ok(n.step >= 0 && n.step < 16 && n.len >= 1 && n.vel > 0 && n.vel <= 1, `${mode} ${bar} ${JSON.stringify(n)}`);
        if (n.midi) assert.ok(n.midi >= 36 && n.midi <= 96, `${mode} ${bar} midi ${n.midi}`);
      }
      assert.ok(b.base.some(n => n.voice === "kick"), `${mode} bar ${bar} has a kick`);
    }
  }
  const loop = new Set(Array.from({ length: 16 }, (_, i) => sig(i)));
  assert.ok(loop.size >= 6, `16-bar loop has ${loop.size} distinct lead bars`);
  assert.notEqual([0, 1, 2, 3].map(sig).join(), [16, 17, 18, 19].map(sig).join(), "the next cycle changes the melody");
  // Only the layer carries the arp; the calm and intro bars have no layer.
  assert.ok(!barNotes("chase", 0).base.some(n => n.voice === "arp"));
  assert.ok(barNotes("chase", 0).layer.some(n => n.voice === "arp"));
  assert.equal(barNotes("calm", 0).layer.length, 0);
  assert.ok(tempoFor("chase", "chill") < tempoFor("chase", "normal") && tempoFor("chase", "normal") < tempoFor("chase", "degen"));
  assert.ok(tempoFor("chase", "normal") >= 120 && tempoFor("chase", "degen") <= 140);
});

test("music target: calm title/results, intro countdown, chase + close layer with hysteresis", () => {
  const base: MusicInput = { title: false, results: false, practice: false, phase: "chase", d: 40, panic: false, gassed: false };
  assert.deepEqual(musicTarget({ ...base, title: true, phase: "" }, false), { mode: "calm", layer: false });
  assert.deepEqual(musicTarget({ ...base, phase: "countdown" }, false), { mode: "intro", layer: false });
  assert.deepEqual(musicTarget(base, false), { mode: "chase", layer: false });
  assert.equal(musicTarget({ ...base, d: LAYER_ON - 1 }, false).layer, true);
  assert.equal(musicTarget({ ...base, d: (LAYER_ON + LAYER_OFF) / 2 }, true).layer, true, "stays on inside the band");
  assert.equal(musicTarget({ ...base, d: (LAYER_ON + LAYER_OFF) / 2 }, false).layer, false, "does not switch on inside the band");
  assert.equal(musicTarget({ ...base, d: LAYER_OFF + 1 }, true).layer, false);
  assert.equal(musicTarget({ ...base, panic: true }, false).layer, true);
  assert.equal(musicTarget({ ...base, panic: true, gassed: true }, false).layer, false);
  assert.deepEqual(musicTarget({ ...base, practice: true, d: 5 }, false), { mode: "chase", layer: false });
  assert.deepEqual(musicTarget({ ...base, phase: "caught" }, true), { mode: "calm", layer: false });
  assert.deepEqual(musicTarget({ ...base, results: true, phase: "escaped" }, false), { mode: "calm", layer: false });
});
