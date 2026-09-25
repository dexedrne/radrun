// The speech timeline (audio/speech.ts): lines never overlap, and the round end cuts the queue, plays one
// announcer call then one Radbro reply, and lets nothing else speak until the next round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GAP, PRI, Speech, roundEndVoice, type Line } from "../src/audio/speech.ts";

/** Plays a plan into a log of what is audible: cut lines end at the cut time. */
class Ear {
  heard: Line[] = [];
  apply(now: number, plan: { play: Line[]; cut: Line[] }): void {
    for (const c of plan.cut) {
      const h = this.heard.find(l => l.id === c.id);
      if (h) h.end = Math.min(h.end, now);
    }
    // A line cut before it started was never heard.
    this.heard = this.heard.filter(l => l.end > l.start);
    this.heard.push(...plan.play.map(l => ({ ...l })));
  }
  assertNoOverlap(): void {
    const ls = [...this.heard].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ls.length; i++) {
      assert.ok(ls[i].start >= ls[i - 1].end - 1e-9, `${ls[i - 1].who}:${ls[i - 1].key} [${ls[i - 1].start.toFixed(2)}-${ls[i - 1].end.toFixed(2)}] overlaps ${ls[i].who}:${ls[i].key} [${ls[i].start.toFixed(2)}-${ls[i].end.toFixed(2)}]`);
    }
  }
}

test("speech: a catch ends with one announcer call then one Radbro reply, never stacked", () => {
  const s = new Speech(), ear = new Ear();
  // The chase: GO, his countdown quip, a panic line, a taunt queued behind it.
  ear.apply(10, s.say(10, { who: "announcer", key: "go", dur: 0.7, interrupt: true, pri: PRI.call }));
  ear.apply(10, s.say(10, { who: "4764", key: "countdown", dur: 1.2, delay: 0.55, maxWait: 0.6 }));
  ear.apply(20, s.say(20, { who: "4764", key: "panic", dur: 2.9, maxWait: 0.4 }));
  ear.apply(20.2, s.say(20.2, { who: "4764", key: "cornered", dur: 2, maxWait: 5 }));
  assert.equal(s.pending(20.3).length, 2, "panic talking, cornered queued");
  // The catch, mid-panic.
  const vo = roundEndVoice({ caught: true, yoink: false, newBest: false, runner: "4764" });
  assert.deepEqual(vo, { call: "tagged", reply: { who: "4764", key: "caught" } });
  const end = s.roundEnd(21, 7, { who: "announcer", key: vo.call, dur: 0.96 }, { who: vo.reply.who, key: vo.reply.key, dur: 2.4 });
  ear.apply(21, end);
  assert.deepEqual(end.cut.map(l => l.key).sort(), ["cornered", "panic"], "the round end clears the queue and cuts the talking line");
  assert.deepEqual(end.play.map(l => `${l.who}:${l.key}`), ["announcer:tagged", "4764:caught"]);
  assert.ok(end.play[1].start >= end.play[0].end + GAP - 1e-9, "the reply waits for the call");
  // Everything the old code piled on after it is dropped: the chaser's cheer, NEW BEST on RESULTS, a
  // late taunt, a second round end for the same run (a re-render / a second caller).
  for (const [t, who, key] of [[21, "652", "win"], [22.3, "announcer", "new_best"], [21.5, "4764", "taunt_1"]] as const) {
    const p = s.say(t, { who, key, dur: 2.5, maxWait: 5, interrupt: who === "announcer", pri: who === "announcer" ? PRI.call : PRI.chatter });
    assert.equal(p.play.length + p.cut.length, 0, `${who}:${key} dropped`);
    assert.equal(p.drop, "closed");
  }
  const again = s.roundEnd(22, 7, { who: "announcer", key: "tagged", dur: 0.96 }, { who: "4764", key: "caught", dur: 2.4 });
  assert.equal(again.play.length + again.cut.length, 0, "a round end fires once per run");
  ear.assertNoOverlap();
  const tail = ear.heard.filter(l => l.start >= 21);
  assert.deepEqual(tail.map(l => l.key), ["tagged", "caught"], "exactly two lines after the catch");
  assert.equal(tail.filter(l => l.who === "announcer").length, 1);
});

test("speech: escape and new best pick one call each; the next round cuts the leftovers and reopens", () => {
  assert.deepEqual(roundEndVoice({ caught: false, yoink: false, newBest: false, runner: "652" }), { call: "rugged", reply: { who: "652", key: "escaped" } });
  assert.equal(roundEndVoice({ caught: true, yoink: true, newBest: false, runner: "652" }).call, "yoink");
  assert.equal(roundEndVoice({ caught: true, yoink: true, newBest: true, runner: "652" }).call, "new_best");
  const s = new Speech();
  const end = s.roundEnd(5, 1, { who: "announcer", key: "rugged", dur: 1.6 }, { who: "652", key: "escaped", dur: 1.9 });
  assert.equal(end.play.length, 2);
  // Retry during the reply: the new round cuts it and speaks again.
  const start = s.startRound(7);
  assert.deepEqual(start.cut.map(l => l.key), ["escaped"]);
  assert.equal(s.pending(7).length, 0);
  assert.equal(s.say(7.1, { who: "announcer", key: "three", dur: 0.7, interrupt: true, pri: PRI.call }).play.length, 1);
  // A round end with nothing loaded still closes; one with only the reply plays it at once.
  assert.ok(Math.abs(s.roundEnd(20, 2, null, { who: "652", key: "caught", dur: 2 }).play[0].start - 20.01) < 1e-9);
  assert.equal(s.say(20.5, { who: "652", key: "panic", dur: 1 }).drop, "closed");
  // Quit to a menu: cut, stays closed.
  s.startRound(30);
  s.say(30, { who: "652", key: "taunt_1", dur: 2 });
  assert.equal(s.hush(30.5).cut.length, 1);
  assert.equal(s.say(31, { who: "652", key: "taunt_2", dur: 2 }).drop, "closed");
});

test("speech: random chase chatter and calls never overlap; interrupts respect priority", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let round = 0; round < 50; round++) {
    const s = new Speech(), ear = new Ear();
    s.startRound(0);
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += rnd() * 1.5;
      const call = rnd() < 0.25;
      ear.apply(t, s.say(t, {
        who: call ? "announcer" : "723", key: call ? "go" : `taunt_${1 + Math.floor(rnd() * 6)}`, dur: 0.4 + rnd() * 2.6,
        delay: rnd() < 0.2 ? rnd() : 0, maxWait: rnd() * 3, interrupt: call, pri: call ? PRI.call : PRI.chatter,
        cooldown: call ? 0 : rnd() * 3, group: call ? undefined : "taunt",
      }));
    }
    ear.apply(t + 0.3, s.roundEnd(t + 0.3, round, { who: "announcer", key: "tagged", dur: 1 }, { who: "723", key: "caught", dur: 2 }));
    for (let k = 0; k < 5; k++) ear.apply(t + 0.5 + k, s.say(t + 0.5 + k, { who: "723", key: "win", dur: 1, maxWait: 9 }));
    ear.assertNoOverlap();
    assert.equal(ear.heard.filter(l => l.start >= t + 0.3).length, 2, `round ${round}: two lines after the end`);
  }
  // Chatter never cuts a call; a call cuts chatter.
  const s = new Speech();
  s.say(0, { who: "announcer", key: "rekt", dur: 1.6, interrupt: true, pri: PRI.call });
  const quip = s.say(0.1, { who: "652", key: "panic", dur: 1, interrupt: true, maxWait: 0.2 });
  assert.equal(quip.cut.length, 0);
  assert.equal(quip.drop, "busy");
  s.say(3, { who: "652", key: "panic", dur: 3 });
  const call = s.say(3.5, { who: "announcer", key: "gassed", dur: 1.1, interrupt: true, pri: PRI.call });
  assert.deepEqual(call.cut.map(l => l.key), ["panic"]);
});
