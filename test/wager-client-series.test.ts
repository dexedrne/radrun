// The wager client's netcode (docs/WAGER.md §5.3, §7.4, §9.3): two OnlineSessions in wager mode against a fake wager
// room (test/wager-client-fakes.ts: sealed release, relay-clock deadlines with FILLs, a canonical-sim referee, best of
// 3) on a fake clock, in session.test.ts style. Every client must end every round on the referee's own hash: its
// FILLs (its own slot included) roll it back to the relay's words; a hidden tab and a reconnect catch up from the
// relay's sealed words; a player who stays away forfeits. The published log then verifies with the shared replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Hex } from "viem";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { OnlineSession } from "../src/net/session.ts";
import { Rollback } from "../src/net/rollback.ts";
import { TagMatch } from "../src/game/tagMatch.ts";
import { packWord } from "../src/net/wire.ts";
import { emptyRec, recFromInput } from "../src/game/ghost.ts";
import { mulberry32 } from "../src/sim/math.ts";
import { MSG_PROBE, MSG_PROBE_ECHO, decodeProbe, encodeProbe, type OutcomeMsg, type RoomServerMsg, type RoundMsg, type WagerStartMsg } from "../src/wager/protocol.ts";
import { random32, resultTypedData } from "../src/wager/eip712.ts";
import { seriesLogHash } from "../src/wager/log.ts";
import { verifySeries, type SimAssets } from "../src/wager/replay.ts";
import { FakeRoom, acct, type Clock, type Sock } from "./wager-client-fakes.ts";
import type { PlayerCard } from "../src/wager/protocol.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const tuningJson = JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8"));
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(tuningJson).player;
const index = new CityIndex(model);
const assets: SimAssets = { model, index, tuning, tag: tuningJson.tag };

const A = acct(1), B = acct(2);
const card = (a: `0x${string}`, name: string): PlayerCard => ({ address: a, name, rating: 1200, wins: 0, losses: 0, forfeits: 0, voids: 0, held: 0, firstSeen: 0, holder: false, radbros: [], cosmetic: null });

type Opts = {
  leg: number; fps: number; seconds: number;
  /** Side 1 stops rendering (its tab hidden) for ms, at ms after its first round start. */
  hide?: { at: number; ms: number };
  /** Side 1's socket drops at `at` ms after the first start and comes back after `ms` (null: never). */
  drop?: { at: number; ms: number | null };
};

function series(o: Opts) {
  let now = 1_000_000, seq = 0;
  const timers: { at: number; seq: number; fn: () => void }[] = [];
  const later = (ms: number, fn: () => void) => { timers.push({ at: now + ms, seq: seq++, fn }); };
  const clock: Clock = { now: () => now, setTimeout: (fn, ms) => { later(ms, fn); return 0; } };
  const room = new FakeRoom({
    matchId: random32(), chainId: 31337, vault: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", players: [A.address, B.address], cards: [card(A.address, "alice"), card(B.address, "bob")],
    stake: 100n * 10n ** 18n, feeBps: 300, holderFeeBps: 150, roundSeconds: o.seconds, district: "downtown", assets, settleBy: 2_000_000_000, clock,
    timing: { betweenRoundsMs: 3000, startDelayMs: 1500, joinGraceMs: 20_000 },
    sign: r => acct(8).signTypedData(resultTypedData(31337, "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", r)),
    submit: async () => `0x${"ab".repeat(32)}` as Hex,
  });
  type C = {
    side: 0 | 1; name: string; sock: Sock | null; h: ReturnType<FakeRoom["attach"]> | null; session: OnlineSession | null; start: WagerStartMsg | null;
    rnd: () => number; yaw: number; finals: Map<number, number>; rounds: RoundMsg[]; outcome: OutcomeMsg | null; firstStart: number; starts: number;
    /** Per round: the words the relay filled for this client's own slot (its session's count at the horn). */
    filled: Map<number, number>;
  };
  const deliver = (c: C, d: string | Uint8Array) => {
    if (typeof d !== "string") {
      if (d[0] === MSG_PROBE) { const p = decodeProbe(d)!; toRelay(c, encodeProbe(MSG_PROBE_ECHO, p.id)); return; }
      c.session?.onBinary(d);
      return;
    }
    const m = JSON.parse(d) as RoomServerMsg;
    if (m.t === "start") {
      c.start = m;
      c.starts++;
      if (!c.firstStart) c.firstStart = now;
      const local = c.side === 0 ? m.slotOfA : 1 - m.slotOfA;
      const s = new OnlineSession({ model, index, tuning, start: m, local, transport: tr(c), wager: true });
      s.onFinal = h => { c.finals.set(m.round, h >>> 0); c.filled.set(m.round, s.filled); };
      c.session = s;
    } else if (m.t === "round") {
      c.rounds.push(m);
      later(400, () => toRelay(c, JSON.stringify({ t: "ready" })));
    } else if (m.t === "outcome") c.outcome = m;
  };
  const mkSock = (c: C): Sock => {
    const sock: Sock = { send: d => later(o.leg, () => { if (c.sock === sock) deliver(c, d); }), close: () => { if (c.sock === sock) c.sock = null; } };
    return sock;
  };
  const toRelay = (c: C, d: string | Uint8Array) => { const h = c.h, sock = c.sock; if (!h || !sock) return; later(o.leg, () => { if (c.sock === sock) h.message(d); }); };
  const tr = (c: C) => ({ relayNow: () => now, sendJson: (m: unknown) => toRelay(c, JSON.stringify(m)), sendBinary: (b: Uint8Array) => toRelay(c, b) });
  const mk = (side: 0 | 1, name: string): C => ({ side, name, sock: null, h: null, session: null, start: null, rnd: mulberry32(side + 11), yaw: 0, finals: new Map(), rounds: [], outcome: null, firstStart: 0, starts: 0, filled: new Map() });
  const connect = (c: C) => { c.sock = mkSock(c); c.h = room.attach(c.side, c.sock); };
  const word = (c: C) => {
    const r = c.rnd;
    if (r() < 0.02) c.yaw = r() * 6.283;
    return packWord(recFromInput(emptyRec(), c.yaw, 1, 0, r() < 0.01, r() < 0.015, r() < 0.5, r() < 0.004, false, false, 0));
  };
  const advance = (ms: number, frame?: () => void) => {
    const end = now + ms;
    let next = now;
    while (now < end) {
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      now = Math.max(now, Math.min(timers[0]?.at ?? Infinity, frame ? next : Infinity, end));
      while (timers.length && timers[0].at <= now) { timers.sort((a, b) => a.at - b.at || a.seq - b.seq); timers.shift()!.fn(); }
      if (frame && now >= next) { frame(); next += 1000 / o.fps; }
    }
  };
  const P = [mk(0, "A"), mk(1, "B")];
  for (const c of P) {
    connect(c);
    toRelay(c, JSON.stringify({ t: "pick", radbro: c.side ? "4764" : "652", own: null }));
    toRelay(c, JSON.stringify({ t: "seed", share: random32() }));
    toRelay(c, JSON.stringify({ t: "ready" }));
  }
  let dropped = false;
  advance((o.seconds * 3 + 60) * 1000, () => {
    const B = P[1];
    if (o.drop && B.firstStart && !dropped && now - B.firstStart >= o.drop.at) {
      dropped = true;
      const h = B.h!;
      B.sock = null;
      B.h = null;
      B.session = null;
      h.close();
      if (o.drop.ms !== null) later(o.drop.ms, () => connect(B));
    }
    for (const c of P) {
      const s = c.session;
      if (!s || !c.sock) continue;
      if (c === B && o.hide && B.firstStart && now - B.firstStart >= o.hide.at && now - B.firstStart < o.hide.at + o.hide.ms) continue;
      const n = s.stepsFor(1 / o.fps);
      for (let i = 0; i < n; i++) if (!s.step(word(c))) break;
    }
  });
  return { room, P };
}

async function settle(room: FakeRoom) {
  for (let i = 0; i < 50 && !room.settleTx; i++) await new Promise(r => setImmediate(r));
}

test("wager rounds: a best of 3 through the sealed-release room; both clients end every round on the referee's hash; the log verifies", async () => {
  const { room, P } = series({ leg: 35, fps: 60, seconds: 12 });
  assert.ok(room.outcome, "the series ended");
  assert.equal(room.outcome!.reason, room.outcome!.kind === "void" ? "draws" : "played");
  assert.ok(room.rounds.length >= 2 && room.rounds.length <= 5, `${room.rounds.length} rounds`);
  for (const r of room.rounds) {
    for (const c of P) assert.equal(c.finals.get(r.round), r.result!.hash, `round ${r.round}: ${c.name}'s final hash is the referee's`);
  }
  assert.equal(room.flags.length, 0, "no desync flags");
  for (const c of P) assert.equal(c.rounds.length, room.rounds.length, `${c.name} saw every round result`);
  const v = verifySeries(room.log!, assets);
  assert.ok(v.ok, v.problems.join("; "));
  assert.equal(room.log!.logHash, seriesLogHash(room.log!));
  await settle(room);
  assert.ok(room.settlement, "the referee signed");
  assert.equal(room.settlement!.result.logHash, room.log!.logHash);
});

test("wager rounds: a hidden tab gets its own inputs filled (FILL for its own slot), rolls back to them and still ends on the referee's hash", () => {
  const { room, P } = series({ leg: 40, fps: 60, seconds: 12, hide: { at: 4000, ms: 3500 } });
  const r1 = room.rounds[0];
  assert.ok(r1.result, "round 1 finished");
  assert.ok(r1.fills[r1.slotOfA === 0 ? 1 : 0] > 300, `the relay filled B's slot (${r1.fills})`);
  for (const c of P) assert.equal(c.finals.get(1), r1.result!.hash, `${c.name} ends round 1 on the referee's hash`);
  const own = P[1].filled.get(1) ?? 0;
  assert.ok(own > 300, `B's session took the relay's FILLs for its own slot (${own})`);
  assert.ok((P[0].filled.get(1) ?? 0) < 20, `A, never hidden, needed (almost) none (${P[0].filled.get(1)})`);
  assert.equal(room.flags.filter(f => f.kind === "desync").length, 0, "no desync");
});

test("wager rounds: a dropped socket reconnects within the grace; the fresh session catches up from step 0 on the sealed words", () => {
  const { room, P } = series({ leg: 30, fps: 60, seconds: 20, drop: { at: 9000, ms: 4000 } });
  const r1 = room.rounds[0];
  assert.ok(r1?.result, "round 1 finished (no forfeit)");
  assert.ok(P[1].starts >= 2, "B got the round's start again");
  for (const c of P) assert.equal(c.finals.get(1), r1.result!.hash, `${c.name} ends round 1 on the referee's hash`);
  assert.notEqual(room.outcome?.reason, "forfeit");
});

test("wager rounds: a player who stays away past the grace forfeits the series", () => {
  const { room } = series({ leg: 30, fps: 60, seconds: 20, drop: { at: 5000, ms: null } });
  assert.equal(room.outcome?.kind, "win");
  assert.equal(room.outcome?.reason, "forfeit");
  assert.equal(room.outcome?.winner, 0);
  assert.equal(room.outcome?.forfeit?.by, 1);
  const v = verifySeries(room.log!, assets);
  assert.ok(v.ok, v.problems.join("; "));
});

test("wager rounds: a 280 ms round trip on both sides never holds back a player's own words (no fills)", () => {
  // The sealed release hands over the other player's words a whole round trip later than the live mode: a stall on
  // them used to hold back this player's own words too, which then missed their deadlines (almost every step filled).
  const { room, P } = series({ leg: 140, fps: 60, seconds: 12 });
  const r1 = room.rounds[0];
  assert.ok(r1?.result, "round 1 finished");
  assert.deepEqual(r1.fills, [0, 0], `fills ${r1.fills}`);
  for (const c of P) assert.equal(c.finals.get(1), r1.result!.hash, `${c.name} ends round 1 on the referee's hash`);
});

test("wager rounds: at 12 frames a second the words a frame samples go out that frame and make their deadlines", () => {
  const { room, P } = series({ leg: 40, fps: 12, seconds: 12 });
  const r1 = room.rounds[0];
  assert.ok(r1?.result, "round 1 finished");
  assert.deepEqual(r1.fills, [0, 0], `fills ${r1.fills}`);
  for (const c of P) assert.equal(c.finals.get(1), r1.result!.hash, `${c.name} ends round 1 on the referee's hash`);
});

test("Rollback.force: the relay's word replaces a confirmed local word and the match re-simulates to the straight run's hash", () => {
  const mkMatch = () => new TagMatch({ model, index, tuning, slots: [{ radbro: "652" }, { radbro: "4764" }], seed: 77, seconds: 20 });
  const rnd = mulberry32(5), w: number[][] = [[], []];
  let yaw = 0;
  for (let s = 0; s <= 400; s++) for (let k = 0; k < 2; k++) { if (rnd() < 0.03) yaw = rnd() * 6; w[k][s] = s <= 3 ? 0 : packWord(recFromInput(emptyRec(), yaw, 1, 0, rnd() < 0.02, rnd() < 0.02, rnd() < 0.5, false, false, false, 0)); }
  // The relay filled local steps 200..209 with a stand-in.
  const fillWord = w[0][150];
  const truth = w.map(a => [...a]);
  for (let s = 200; s < 210; s++) truth[0][s] = fillWord;
  const straight = mkMatch();
  for (let s = 1; s <= 400; s++) straight.stepWords([truth[0][s], truth[1][s]]);
  const m = mkMatch();
  const rb = new Rollback(m, 0, { inputDelay: 3 });
  for (let s = 4; s <= 400; s++) {
    rb.addLocal(w[0][s]);
    rb.receive(1, s, [w[1][s]]);
    if (s === 230) for (let f = 200; f < 210; f++) rb.force(0, f, fillWord); // arrives late: a rewind of 31 steps
    rb.advance();
  }
  while (m.step < 400) rb.advance();
  rb.catchUp();
  assert.equal(m.hash(), straight.hash(), "the forced words replaced the local ones");
  assert.ok(rb.rollbacks >= 1);
  assert.ok(rb.has(0, 205));
  rb.force(0, 2, 12345); // inside the input delay: ignored
  assert.ok(rb.confirmedTo[0] >= 400);
});
