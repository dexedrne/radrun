// Phase 0 netcode gates (multiplayer design §7) on the committed Downtown city:
//   gate 1, rollback fuzz: random rewinds replay the same hash at every step as a straight run, and a Rollback fed
//     late / out-of-order inputs ends on the straight run's hash with every confirmed hash equal to it;
//   gate 2, netsim: 2 and 8 peers over a fake network (one-way 15-75 ms, +-30 ms jitter, TCP ordering and
//     retransmit stalls), driven by SwingBots (tag bots) and random inputs - every peer ends on identical hashes
//     (equal to a straight run of the same inputs), rollback depth p99 <= 12 at 150 ms RTT, no stalls without loss.
// The cross-engine gate (3) and the phone cost (4) need real browsers: the dev ?bench page prints both.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { TagMatch, type TagSlot } from "../src/game/tagMatch.ts";
import { TagBot } from "../src/game/tagBot.ts";
import { Rollback } from "../src/net/rollback.ts";
import { emptyRec, recFromInput } from "../src/game/ghost.ts";
import { packWord } from "../src/net/wire.ts";
import { mulberry32 } from "../src/sim/math.ts";
import { SELFTEST_HASH, selfTestHash } from "../src/net/selftest.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8"))).player;
const ROSTER = ["652", "4764", "2564", "723", "3171"] as const;
const slotsOf = (n: number): TagSlot[] => Array.from({ length: n }, (_, i) => ({ radbro: ROSTER[i % ROSTER.length] }));
const newMatch = (n: number, seed: number, seconds: number, index = new CityIndex(model)) =>
  new TagMatch({ model, index, tuning, slots: slotsOf(n), seed, seconds, countdown: false });

/** A human-ish random input: holds a direction / web for a while, presses now and then. */
class RandomInput {
  private readonly r: () => number;
  private yaw = 0; private fwd = 1; private right = 0; private held = false; private left = 0; private slide = false;
  constructor(seed: number) { this.r = mulberry32(seed); }
  next(): number {
    const r = this.r;
    if (--this.left <= 0) {
      this.left = 10 + Math.floor(r() * 50);
      this.yaw = r() * 6.283; this.fwd = r() < 0.8 ? 1 : 0; this.right = r() < 0.3 ? (r() < 0.5 ? -1 : 1) : 0; this.held = r() < 0.5; this.slide = r() < 0.1;
    }
    this.yaw += (r() - 0.5) * 0.03;
    const jump = r() < 0.01, web = r() < 0.015, zip = r() < 0.004;
    return packWord(recFromInput(emptyRec(), this.yaw, this.fwd, this.right, jump, web, this.held || web, zip, false, this.slide, (r() - 0.5) * 0.6));
  }
}

test("self-test fixture hashes to the value baked into the build (the online join check)", () => {
  assert.equal(selfTestHash(), SELFTEST_HASH);
});

test("gate 1a: random rewinds (snapshot load + re-sim) give the straight run's hash at every step", () => {
  const n = 3, steps = 2400;
  const ins = Array.from({ length: n }, (_, i) => new RandomInput(100 + i));
  const words: number[][] = Array.from({ length: steps + 1 }, () => ins.map(x => x.next()));
  const straight = newMatch(n, 5, 30);
  const hash: number[] = [straight.hash()];
  for (let s = 1; s <= steps; s++) { straight.stepWords(words[s]); hash.push(straight.hash()); }
  const m = newMatch(n, 5, 30);
  const snaps = Array.from({ length: 64 }, () => m.newSnap());
  const snapAt = new Int32Array(64).fill(-1);
  const r = mulberry32(77);
  let rewinds = 0;
  for (let s = 1; s <= steps; s++) {
    m.save(snaps[(s - 1) % 64]); snapAt[(s - 1) % 64] = s - 1;
    m.stepWords(words[s]);
    assert.equal(m.hash(), hash[s], `step ${s}`);
    if (r() < 0.08 && s > 30) {
      const back = 1 + Math.floor(r() * 30);
      const from = s - back + 1;
      assert.equal(snapAt[(from - 1) % 64], from - 1);
      m.load(snaps[(from - 1) % 64]);
      assert.equal(m.hash(), hash[from - 1], `load before ${from}`);
      for (let t = from; t <= s; t++) { m.save(snaps[(t - 1) % 64]); snapAt[(t - 1) % 64] = t - 1; m.stepWords(words[t]); assert.equal(m.hash(), hash[t], `re-sim ${t}`); }
      rewinds++;
    }
  }
  assert.ok(rewinds > 100);
});

test("gate 1b: a Rollback fed late, bursty inputs ends on the straight hash; every confirmed hash matches", () => {
  const n = 4, seconds = 20, local = 1;
  const ins = Array.from({ length: n }, (_, i) => new RandomInput(300 + i));
  const m = newMatch(n, 9, seconds);
  const rb = new Rollback(m, local, { inputDelay: 2, maxRollback: 40, hashEvery: 60 });
  const log: number[][] = Array.from({ length: n }, () => []);
  const r = mulberry32(5);
  // Remote words arrive in bursts 0-30 steps late (in order per slot).
  const pending: { slot: number; step: number; word: number; at: number }[] = [];
  const reported: [number, number][] = [];
  for (let tick = 1; !rb.final && tick < 10000; tick++) {
    const s = rb.nextLocal <= m.endStep ? rb.addLocal(0) : -1;
    for (let i = 0; i < n && s > 0; i++) {
      if (i === local) { log[i][s] = 0; continue; }
      const w = ins[i].next();
      log[i][s] = w;
      const lastAt = pending.filter(p => p.slot === i).reduce((a, p) => Math.max(a, p.at), 0);
      pending.push({ slot: i, step: s, word: w, at: Math.max(lastAt, tick + Math.floor(r() * r() * 30)) });
    }
    for (let j = pending.length - 1; j >= 0; j--) if (pending[j].at <= tick) { const p = pending[j]; rb.receive(p.slot, p.step, [p.word]); pending.splice(j, 1); }
    rb.advance();
    reported.push(...rb.takeHashes());
  }
  assert.ok(rb.final, "never became final");
  assert.ok(rb.rollbacks > 50, `rollbacks ${rb.rollbacks}`);
  // Straight run of the same inputs (steps 1..delay are the empty word).
  const ref = newMatch(n, 9, seconds);
  const refHash = new Map<number, number>();
  for (let s = 1; s <= ref.endStep; s++) {
    ref.stepWords(log.map(l => (s <= 2 ? 0 : l[s] ?? 0)));
    if (s % 60 === 0) refHash.set(s, ref.hash());
  }
  assert.equal(m.hash(), ref.hash());
  assert.ok(reported.length >= seconds * 2 - 1, `reported ${reported.length}`);
  for (const [s, h] of reported) assert.equal(h, refHash.get(s), `confirmed hash at ${s}`);
});

// ---- the fake network ---------------------------------------------------------------------------------------

type NetCfg = { oneWay: number; jitter: number; stallP: number; stallMs: number; sendEvery: number; inputDelay: number };
type Pkt = { at: number; from: number; to: number; firstStep: number; words: number[] };

/**
 * n peers in virtual time (1 ms resolution not needed: event times are floats). Each peer steps at 120 Hz, sends its
 * newest local words to every other peer every `sendEvery` steps; a link delivers after oneWay +- jitter, never
 * before the previous packet on that link (TCP order), and a packet can stall for stallMs (a retransmit), holding
 * back everything behind it.
 */
function netsim(n: number, cfg: NetCfg, seconds: number, seed: number, bots: number) {
  const index = new CityIndex(model);
  const r = mulberry32(seed);
  const peers = Array.from({ length: n }, (_, i) => {
    const m = newMatch(n, seed, seconds, index);
    const rb = new Rollback(m, i, { inputDelay: cfg.inputDelay, maxRollback: 24, hashEvery: 60 });
    const bot = i < bots ? new TagBot(m, i, seed * 7 + i, "normal") : null;
    const rnd = new RandomInput(seed * 13 + i);
    return { m, rb, bot, rnd, out: [] as number[], outFirst: rb.nextLocal, linkLast: new Float64Array(n), hashes: [] as [number, number][] };
  });
  rb0Check(peers.map(p => p.rb));
  const log: number[][] = Array.from({ length: n }, () => []);
  const q: Pkt[] = [];
  const DT = 1000 / 120;
  let t = 0;
  const lastStep = peers[0].m.endStep;
  for (let tick = 1; tick < lastStep * 3; tick++) {
    t = tick * DT;
    // Deliveries due.
    q.sort((a, b) => a.at - b.at);
    while (q.length && q[0].at <= t) { const p = q.shift()!; peers[p.to].rb.receive(p.from, p.firstStep, p.words); }
    let done = true;
    for (let i = 0; i < n; i++) {
      const P = peers[i];
      if (P.rb.nextLocal <= lastStep) {
        const w = P.bot ? P.bot.next(P.m) : P.rnd.next();
        const s = P.rb.addLocal(w);
        log[i][s] = w;
        P.out.push(w);
      }
      if (P.out.length && (P.out.length >= cfg.sendEvery || P.rb.nextLocal > lastStep)) {
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          let at = t + cfg.oneWay + (r() * 2 - 1) * cfg.jitter;
          if (r() < cfg.stallP) at += cfg.stallMs;
          at = Math.max(at, P.linkLast[j]);
          P.linkLast[j] = at;
          q.push({ at, from: i, to: j, firstStep: P.outFirst, words: P.out.slice() });
        }
        P.outFirst += P.out.length;
        P.out.length = 0;
      }
      P.rb.advance();
      if (P.bot) P.bot.after();
      P.hashes.push(...P.rb.takeHashes());
      if (!P.rb.final) done = false;
    }
    if (done) break;
  }
  // Straight run of the logged inputs.
  const ref = newMatch(n, seed, seconds, index);
  for (let s = 1; s <= lastStep; s++) ref.stepWords(log.map(l => (s <= cfg.inputDelay ? 0 : l[s])));
  return { peers, ref };
}

function rb0Check(rbs: Rollback[]): void {
  for (const rb of rbs) assert.equal(rb.match.step, 0);
}

function report(label: string, peers: { rb: Rollback }[]): { p99: number; stalls: number } {
  const hist = new Int32Array(65);
  let total = 0, stalls = 0, max = 0, resim = 0;
  for (const { rb } of peers) { for (let d = 0; d < 65; d++) hist[d] += rb.depthHist[d]; total += rb.rollbacks; stalls += rb.stalls; max = Math.max(max, rb.maxDepth); resim += rb.resimSteps; }
  let acc = 0, p50 = 0, p99 = 0;
  for (let d = 0; d < 65; d++) { acc += hist[d]; if (!p50 && acc >= 0.5 * total) p50 = d; if (acc >= 0.99 * total) { p99 = d; break; } }
  console.log(`${label}: rollbacks ${total}, depth p50 ${p50} p99 ${p99} max ${max}, re-sim steps ${resim}, stalls ${stalls}`);
  return { p99, stalls };
}

function checkAgree(peers: { m: TagMatch; rb: Rollback; hashes: [number, number][] }[], ref: TagMatch): void {
  for (const P of peers) {
    assert.ok(P.rb.final, "a peer never became final");
    assert.equal(P.m.hash(), ref.hash(), "a peer's final hash differs from the straight run");
  }
  // The confirmed hashes every peer reported agree step by step.
  const by = new Map<number, number>();
  for (const P of peers) for (const [s, h] of P.hashes) { const o = by.get(s); if (o === undefined) by.set(s, h); else assert.equal(h, o, `hash at ${s}`); }
  assert.ok(by.size > 0);
}

// Input delay by RTT (net/session.ts inputDelayFor): 2 steps up to 100 ms, 3 up to 130 ms, 4 up to 180 ms.
for (const [label, oneWay, delay] of [["30 ms RTT", 15, 2], ["80 ms RTT", 40, 2], ["150 ms RTT", 75, 4]] as const) {
  test(`gate 2: 1v1 at ${label} (+-30 ms jitter), a SwingBot tag bot vs random input: identical hashes, no stalls`, () => {
    const { peers, ref } = netsim(2, { oneWay, jitter: 30, stallP: 0, stallMs: 0, sendEvery: 4, inputDelay: delay }, 40, 11, 1);
    checkAgree(peers, ref);
    const { p99, stalls } = report(`1v1 ${label}`, peers);
    assert.equal(stalls, 0, "stalled without loss");
    if (oneWay === 75) assert.ok(p99 <= 12, `p99 ${p99}`);
  });
}

test("gate 2: 1v1 at 150 ms RTT with TCP retransmit stalls (1 %, +150 ms): still identical", () => {
  const { peers, ref } = netsim(2, { oneWay: 75, jitter: 30, stallP: 0.01, stallMs: 150, sendEvery: 4, inputDelay: 4 }, 30, 12, 2);
  checkAgree(peers, ref);
  report("1v1 150 ms + stalls", peers);
});

test("gate 2: 8 peers at 150 ms RTT (+-30 ms), 3 tag bots + 5 random inputs: identical hashes, p99 <= 12, no stalls", () => {
  const { peers, ref } = netsim(8, { oneWay: 75, jitter: 30, stallP: 0, stallMs: 0, sendEvery: 4, inputDelay: 4 }, 10, 21, 3);
  checkAgree(peers, ref);
  const { p99, stalls } = report("8 peers 150 ms", peers);
  assert.equal(stalls, 0);
  assert.ok(p99 <= 12, `p99 ${p99}`);
});
