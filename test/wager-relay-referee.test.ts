// The wager relay's input pipeline and referee (relay/wager/src/referee.ts, docs/WAGER.md §5.3): sealed release,
// relay-clock deadlines and fills, late and overlapping words, and that the words the referee consumed are exactly
// the round's log (the public replay gets the referee's final state). Plus the flag thresholds (flags.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { predictWord } from "../src/net/wire.ts";
import { replayRound } from "../src/wager/replay.ts";
import { wordsFromBase64 } from "../src/wager/log.ts";
import { TagBot } from "../src/game/tagBot.ts";
import { mulberry32 } from "../src/sim/math.ts";
import { RoundReferee, STEP_MS, W_FILL, W_RECV } from "../relay/wager/src/referee.ts";
import { FLAG_LIMITS, emptyMetrics, evaluate, mergeFlags } from "../relay/wager/src/flags.ts";
import { SIMS } from "./wager-relay-fakes.ts";

const sim = (await SIMS.district("downtown"))!;
const JUMP = 1 << 26, WEB = 2 << 26, HELD = 4 << 26;
const ref = (o: Partial<ConstructorParameters<typeof RoundReferee>[0]> = {}) =>
  new RoundReferee({ assets: sim.assets, round: 1, seed: 5, slotOfA: 0, roundSeconds: 20, radbros: ["652", "4764"], inputDelay: 2, startAtMs: 0, late: [100, 100], aheadSteps: 600, ...o });

test("sealed release: a step is released only once both slots have it", () => {
  const r = ref();
  // Steps 1..inputDelay are the empty word for both slots from the start.
  assert.deepEqual(r.seal(), { from: 1, to: 2 });
  r.receive(0, 3, [11, 12, 13, 14], 0);
  assert.equal(r.seal(), null, "slot 1 has nothing past the input delay: nothing of slot 0 is released");
  assert.equal(r.sealedTo, 2);
  r.receive(1, 3, [21, 22], 0);
  assert.deepEqual(r.seal(), { from: 3, to: 4 });
  assert.deepEqual(r.runs(0, 3, 4), [{ slot: 0, first: 3, words: [11, 12], filled: false }]);
  assert.deepEqual(r.runs(1, 3, 4), [{ slot: 1, first: 3, words: [21, 22], filled: false }]);
  // Slot 0's steps 5-6 wait for slot 1's.
  assert.equal(r.seal(), null);
  assert.equal(r.have[0], 6);
  assert.equal(r.have[1], 4);
});

test("deadlines: a missed word is filled with the last word minus presses; a late word is dropped; an overlapping INPUT is taken from the first unfilled step", () => {
  const r = ref({ late: [100, 140] });
  const w3 = 300 + JUMP + WEB + HELD; // a held web plus two presses
  r.receive(1, 3, [w3], 0);
  r.receive(0, 3, [1, 2, 3, 4, 5, 6, 7, 8], 0);
  // Slot 1's step 4 is due at 4 x 8.33 + 140 ms.
  assert.equal(r.deadline(1, 4), 4 * STEP_MS + 140);
  assert.deepEqual(r.fillDue(r.deadline(1, 4) - 0.01, [true, true]), []);
  const fills = r.fillDue(r.deadline(1, 5) + 0.01, [true, true]);
  assert.deepEqual(fills, [{ slot: 1, first: 4, words: [predictWord(w3), predictWord(w3)], filled: true }]);
  assert.equal(predictWord(w3), 300 + HELD, "held keys stay, presses are dropped");
  assert.equal(r.kind[1][4], W_FILL);
  assert.equal(r.fills[1], 2);
  assert.deepEqual(r.seal(), { from: 1, to: 5 });
  // The late player's words for 4..5 are dropped; 6..7 are taken.
  const got = r.receive(1, 4, [40, 50, 60, 70], r.deadline(1, 5) + 5);
  assert.deepEqual(got, { taken: 2, late: 2, bad: 0 });
  assert.equal(r.words[1][4], 300 + HELD);
  assert.equal(r.words[1][6], 60);
  assert.equal(r.kind[1][6], W_RECV);
  assert.deepEqual(r.seal(), { from: 6, to: 7 });
  // The released runs tell the other client which steps were filled.
  assert.deepEqual(r.runs(1, 3, 7), [
    { slot: 1, first: 3, words: [w3], filled: false },
    { slot: 1, first: 4, words: [300 + HELD, 300 + HELD], filled: true },
    { slot: 1, first: 6, words: [60, 70], filled: false },
  ]);
});

test("bounds: words past the horn or far ahead of the relay clock are refused; repeats are ignored", () => {
  const r = ref({ aheadSteps: 10 });
  assert.equal(r.receive(0, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0).bad, 2, "steps 11-12 are past relay step 0 + 10");
  assert.equal(r.receive(0, 3, [99], 0).taken, 0, "a repeat changes nothing");
  assert.equal(r.words[0][3], 1);
  assert.equal(r.receive(0, r.endStep + 1, [1], 1e9).bad, 1);
  assert.equal(r.receive(0, 0, [1], 0).bad, 1);
  // Words are 41-bit.
  r.receive(1, 3, [2 ** 45 + 5], 0);
  assert.equal(r.words[1][3], 5);
});

test("a gap (a reconnecting client starting ahead) waits: its steps fill at their deadlines", () => {
  const r = ref();
  r.receive(0, 3, [1, 2], 0);
  r.receive(0, 10, [9, 9, 9], 0);
  assert.equal(r.have[0], 4);
  assert.equal(r.top[0], 12);
  r.fillDue(r.deadline(0, 9) + 1, [false, true]);
  assert.equal(r.have[0], 12, "the gap 5..9 is filled, then 10..12 were already in");
  assert.equal(r.fillsOnline[0], 0, "fills while disconnected are not lateness");
});

test("the referee's words are the log: replaying the logged round gives the referee's final state and result", () => {
  const r = ref({ seed: 99, late: [100, 100] });
  const bots = [new TagBot(r.match, 0, 3, "normal"), new TagBot(r.match, 1, 4, "normal")];
  const rnd = mulberry32(7);
  // Bots read the referee's own match (exact); every so often a slot's word is late and gets filled.
  let now = 0;
  for (let s = r.inputDelay + 1; s <= r.endStep; s++) {
    now = s * STEP_MS;
    const w = bots.map(b => b.next(r.match));
    if (rnd() > 0.03) r.receive(0, s, [w[0]], now);
    if (rnd() > 0.03) r.receive(1, s, [w[1]], now);
    r.fillDue(now + 200, [true, true]);
    r.seal();
    for (const b of bots) b.after();
  }
  assert.ok(r.over);
  assert.ok(r.fills[0] > 0 && r.fills[1] > 0);
  const res = r.result();
  const log = r.toLog(res);
  assert.equal(wordsFromBase64(log.words[0]).length, r.endStep);
  const rep = replayRound(sim.assets, { roundSeconds: 20, radbros: ["652", "4764"] }, log);
  assert.equal(rep.hash, res.hash);
  assert.deepEqual(rep.result, res);
});

test("flags: thresholds and one flag per player and kind", () => {
  const m = emptyMetrics();
  assert.deepEqual(evaluate(0, m, 1), []);
  m.reactions.push(3, 4, 30, 2, 5);
  m.aimErr.push(0, 1, 0, 25, 1);
  for (let i = 0; i < 12; i++) m.intervals.push(40);
  const f = evaluate(0, m, 2);
  assert.deepEqual(f.map(x => x.kind).sort(), ["aim", "periodic", "reaction"]);
  // Human-like: slow reactions, noisy aim, irregular presses.
  const h = emptyMetrics();
  h.reactions.push(25, 31, 22, 40, 27, 19);
  h.aimErr.push(14, 3, 30, 8, 11, 6);
  for (let i = 0; i < 30; i++) h.intervals.push(30 + ((i * 37) % 90));
  h.rtt = 40;
  for (let i = 0; i < 500; i++) h.slackMs.push(95 + (i % 40));
  h.steps = 10_000;
  h.fills = 30;
  assert.deepEqual(evaluate(1, h, 3), []);
  // Late inputs only count on a fast connection.
  const late = { ...emptyMetrics(), slackMs: new Array(200).fill(3), rtt: 60 };
  assert.equal(evaluate(0, late, 1)[0]?.kind, "late-inputs");
  assert.deepEqual(evaluate(0, { ...late, rtt: 220 }, 1), []);
  const filled = { ...emptyMetrics(), steps: 1000, fills: 80, rtt: 60 };
  assert.equal(evaluate(0, filled, 1)[0]?.kind, "late-inputs");
  // Three fast Yoinks are enough even when the median is human.
  const fast = { ...emptyMetrics(), reactions: [2, 3, 1, 40, 40, 40, 40] };
  assert.equal(evaluate(0, fast, 1)[0]?.kind, "reaction");
  const merged = mergeFlags(f, evaluate(0, m, 3));
  assert.equal(merged.length, 3);
  assert.ok(merged.every(x => x.round === 2), "a flag keeps the round it was first raised in");
  assert.equal(FLAG_LIMITS.reactionMedianSteps, 18);
});
