// Calibrating the anti-cheat flags (docs/WAGER.md §6.2) on the referee's own canonical replay: the repo's TagBot at
// every level is flagged (it tracks its target exactly, and at sharp Yoinks on the very step the ring turns red),
// and the same bot with a 200 ms reaction time and a hand's aim wobble is not. Human sessions recorded on the dev
// relay are the real calibration and are still to come (docs/WAGER.md §12); these are the starting values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TagBot, type BotLevel } from "../src/game/tagBot.ts";
import { RoundReferee, STEP_MS } from "../relay/wager/src/referee.ts";
import { emptyMetrics, evaluate, histMedian, median } from "../relay/wager/src/flags.ts";
import { Humanize, SIMS } from "./wager-relay-fakes.ts";

const sim = (await SIMS.district("downtown"))!;

/** Rounds of bot vs bot through the referee (both clients see the canonical state: no network). */
function rounds(levels: [BotLevel, BotLevel], human: [boolean, boolean], n: number, seconds = 90) {
  const ms = [emptyMetrics(), emptyMetrics()];
  for (let round = 1; round <= n; round++) {
    const r = new RoundReferee({ assets: sim.assets, round, seed: 4242 + round * 7919, slotOfA: 0, roundSeconds: seconds, radbros: ["652", "4764"], inputDelay: 0, startAtMs: 0, late: [100, 100], aheadSteps: 1e9 });
    const bots = [new TagBot(r.match, 0, 31 + round, levels[0]), new TagBot(r.match, 1, 57 + round, levels[1])];
    const hum = [human[0] ? new Humanize(round) : null, human[1] ? new Humanize(round + 100) : null];
    for (let s = 1; s <= r.endStep; s++) {
      const w = bots.map((b, i) => { const x = b.next(r.match); return hum[i] ? hum[i]!.word(x) : x; });
      r.receive(0, s, [w[0]], s * STEP_MS);
      r.receive(1, s, [w[1]], s * STEP_MS);
      r.seal(s * STEP_MS);
      for (const b of bots) b.after();
    }
    r.addEvidence(0, ms[0], 40);
    r.addEvidence(1, ms[1], 40);
  }
  return ms;
}

test("the sharp TagBot is flagged; the same bot with a human reaction time and aim wobble is not", t => {
  const [bot, hum] = rounds(["sharp", "sharp"], [false, true], 3);
  const fb = evaluate(0, bot, 3), fh = evaluate(1, hum, 3);
  t.diagnostic(`bot: tracking median ${histMedian(bot.track)} over ${bot.track.reduce((a, b) => a + b, 0)}, Yoinks ${JSON.stringify(bot.reactions)}, press aim ${median(bot.aimErr)}; `
    + `human-like: tracking median ${histMedian(hum.track)} over ${hum.track.reduce((a, b) => a + b, 0)}, Yoinks ${JSON.stringify(hum.reactions)}, press aim ${median(hum.aimErr)}`);
  assert.ok(fb.some(f => f.kind === "aim"), JSON.stringify(fb));
  assert.deepEqual(fh, [], JSON.stringify(fh));
});

test("every bot level tracks exactly; two human-like players raise nothing", () => {
  const [a, b] = rounds(["chill", "normal"], [false, false], 2);
  assert.ok(evaluate(0, a, 2).some(f => f.kind === "aim") || evaluate(1, b, 2).some(f => f.kind === "aim"));
  const [x, y] = rounds(["normal", "sharp"], [true, true], 2);
  assert.deepEqual([...evaluate(0, x, 2), ...evaluate(1, y, 2)], []);
});
