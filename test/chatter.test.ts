// The runner's chase chatter (audio/chatter.ts): few sounds a round, mostly reactions, never the same slot twice
// in a row, the countdown line not on every retry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Chatter, PANIC_MAX, TAUNT_GAP, TAUNT_MAX, isWorded } from "../src/audio/chatter.ts";

/** A seeded stand-in for Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

test("chatter: at most 2 taunts a round, 25 s apart, at most one worded, no slot twice in a row", () => {
  const c = new Chatter(lcg(7));
  let last = -1, reactions = 0, words = 0;
  for (let round = 0; round < 400; round++) {
    c.startRound(false);
    const got: { t: number; slot: number }[] = [];
    for (let t = 0; t < 90; t += 2.5) { const s = c.taunt(t); if (s >= 0) got.push({ t, slot: s }); }
    assert.ok(got.length <= TAUNT_MAX);
    assert.ok(got.filter(g => isWorded(g.slot)).length <= 1);
    if (got.length === 2) assert.ok(got[1].t - got[0].t >= TAUNT_GAP);
    for (const g of got) {
      assert.notEqual(g.slot, last);
      last = g.slot;
      if (isWorded(g.slot)) words++; else reactions++;
    }
  }
  assert.ok(reactions > 2.5 * words, `reactions ${reactions} vs words ${words}`);
});

test("chatter: a failed roll is silent (he just waves)", () => {
  const c = new Chatter(() => 0.99);
  c.startRound(true);
  assert.equal(c.taunt(10), -1);
});

test("chatter: panic voiced first, then only 20 s later, 2 a round; cornered once", () => {
  const c = new Chatter();
  c.startRound(true);
  const voiced = [0, 3, 10, 21, 30, 50, 80].filter(t => c.panic(t));
  assert.deepEqual(voiced, [0, 21]);
  assert.equal(voiced.length, PANIC_MAX);
  assert.deepEqual([c.corner(), c.corner(), c.corner()], [true, false, false]);
  c.startRound(false);
  assert.ok(c.panic(5));
  assert.ok(c.corner());
});

test("chatter: the countdown line after a menu, then one retry in three", () => {
  const c = new Chatter();
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => c.startRound(i === 0)),
    [true, false, false, true, false, false, true, false]);
  assert.ok(c.startRound(true));
});

test("chatter: a line the speech timeline drops spends nothing (no silent bubble eats the slot)", () => {
  const c = new Chatter(() => 0.1);
  c.startRound(true);
  assert.equal(c.panic(0, () => false), false);
  assert.equal(c.panic(0.5), true);
  assert.equal(c.corner(() => false), false);
  assert.equal(c.corner(), true);
  assert.equal(c.corner(), false);
  let asked = -1;
  assert.equal(c.taunt(5, s => { asked = s; return false; }), -1);
  assert.ok(asked >= 0);
  assert.ok(c.taunt(6) >= 0);
  assert.ok(c.taunt(31) >= 0);
  assert.equal(c.taunt(90), -1);
});
