// Whole best-of-3 series through the wager room (docs/WAGER.md §9.2 "Results"): two real OnlineSession clients driven
// by TagBots over a fake network (one-way legs on a fake clock), the relay's sealed release, the incremental referee,
// the log, signing and settle on the in-memory vault. Both clients agree: a signed win whose logHash is the published
// log's and which the public replay confirms. A client that lies about its final hash is flagged `desync` and the
// referee's result stands; both clients agreeing against the referee is held. The sharp TagBot is flagged and held.
// It also reports the referee's CPU per INPUT message and a cold whole-series re-verify (docs/WAGER.md §4.10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { OnlineSession } from "../src/net/session.ts";
import { TagBot, type BotLevel } from "../src/game/tagBot.ts";
import { random32, payout } from "../src/wager/eip712.ts";
import { seriesLogHash, type SeriesLog, type Side } from "../src/wager/log.ts";
import { verifySeries } from "../src/wager/replay.ts";
import type { RoomServerMsg } from "../src/wager/protocol.ts";
import type { ClientMsg } from "../src/net/wire.ts";
import { keccak256, toBytes, type Hex, type LocalAccount } from "viem";
import { Humanize, SIMS, eventually, flush, roomHarness, type RoomClient, type RoomHarness } from "./wager-relay-fakes.ts";

class Player {
  readonly c: RoomClient;
  readonly side: Side;
  session: OnlineSession | null = null;
  bot: TagBot | null = null;
  /** Human-like input (reaction delay and aim wobble) instead of the raw bot. */
  human: Humanize | null = null;
  humanLike = false;
  /** A fixed seed share (a deterministic series). */
  share: Hex | null = null;
  private setup = false;
  private readyFor = 0;
  /** Tamper with the final hash this client reports. */
  liar: ((h: number) => number) | null = null;

  readonly h: RoomHarness;
  readonly acct: LocalAccount;
  readonly level: BotLevel;

  constructor(h: RoomHarness, acct: LocalAccount, side: Side, level: BotLevel, leg: number) {
    this.h = h;
    this.acct = acct;
    this.level = level;
    this.side = side;
    this.c = h.client(leg);
    this.c.onJson = m => this.onJson(m);
    this.c.onBinary = b => this.session?.onBinary(b);
  }

  private onJson(m: RoomServerMsg): void {
    if (m.t === "series") {
      const st = m.state;
      if (st.phase === "waiting" && !this.setup) {
        this.setup = true;
        this.c.sendJson({ t: "pick", radbro: this.side ? "4764" : "652", own: null });
        this.c.sendJson({ t: "seed", share: this.share ?? random32() });
        this.c.sendJson({ t: "ready" });
      }
      if (st.phase === "between" && this.readyFor !== st.round && !st.ready[this.side]) {
        this.readyFor = st.round;
        this.c.sendJson({ t: "ready" });
      }
    }
    if (m.t === "start") {
      const local = this.side === 0 ? m.slotOfA : 1 - m.slotOfA;
      const a = this.h.sim.assets;
      this.session = new OnlineSession({
        model: a.model, index: a.index, tuning: a.tuning, start: m, local,
        transport: {
          relayNow: () => this.h.clock.now(),
          sendJson: (x: ClientMsg) => this.c.sendJson(x.t === "end" && this.liar ? { ...x, hash: this.liar(x.hash) } : x),
          sendBinary: b => this.c.sendBin(b),
        },
      });
      this.bot = new TagBot(this.session.match, local, 100 * m.round + this.side, this.level);
      this.human = this.humanLike ? new Humanize(m.round * 10 + this.side) : null;
    }
  }

  frame(dt: number): void {
    const s = this.session;
    if (!s) return;
    const n = s.stepsFor(dt);
    for (let i = 0; i < n; i++) {
      const b = this.bot ? this.bot.next(s.match) : 0;
      s.step(this.human ? this.human.word(b) : b);
      this.bot?.after();
    }
  }
}

async function series(o: {
  roundSeconds?: number; vars?: Record<string, string>; levels?: [BotLevel, BotLevel]; legs?: [number, number]; human?: [boolean, boolean];
  /** Fixes the relay secret and both shares: the whole series is deterministic. */
  seed?: number;
  liars?: [((h: number) => number) | null, ((h: number) => number) | null];
}) {
  const fixed = (k: number) => (o.seed === undefined ? null : keccak256(toBytes(`series-${o.seed}-${k}`)));
  const h = await roomHarness({ vars: o.vars, roundSeconds: o.roundSeconds, ...(o.seed === undefined ? {} : { secret: fixed(0)! }) });
  const legs = o.legs ?? [15, 30];
  const ps = [new Player(h, h.a, 0, o.levels?.[0] ?? "normal", legs[0]), new Player(h, h.b, 1, o.levels?.[1] ?? "normal", legs[1])];
  ps[0].liar = o.liars?.[0] ?? null;
  ps[1].liar = o.liars?.[1] ?? null;
  ps[0].humanLike = o.human?.[0] ?? false;
  ps[1].humanLike = o.human?.[1] ?? false;
  ps[0].share = fixed(1);
  ps[1].share = fixed(2);
  await ps[0].c.login(h.a);
  await ps[1].c.login(h.b);
  const dt = 1000 / 60;
  const done = () => ps[0].c.last("settled") || ps[0].c.last("voided") || ps[0].c.last("outcome")?.held;
  for (let f = 0; f < 60 * 400 && !done(); f++) {
    h.clock.tick(dt);
    for (const p of ps) p.frame(dt);
    if (f % 20 === 0) await flush(3);
  }
  await eventually(() => done() && (ps.every(p => p.c.last("settled")) || ps[0].c.last("outcome")?.held), h.clock, 10_000, 20).catch(() => {});
  assert.ok(done(), `the series finished: ${JSON.stringify(ps.map(p => p.c.json.map(m => m.t).slice(-12)))} ${JSON.stringify(ps[0].c.json.filter(m => m.t === "error"))}`);
  const log = JSON.parse(gunzipSync(h.room.logGz()!).toString("utf8")) as SeriesLog;
  return { h, ps, log, outcome: ps[0].c.last("outcome")! };
}

test("both clients agree: the referee signs the win, its logHash is the published log's, the replay confirms it, settle pays 97/3", async t => {
  const { h, ps, log, outcome } = await series({ vars: { HOLD_ON_FLAGS: "0" }, seed: 1 });
  const o = outcome.outcome;
  assert.equal(o.kind, "win");
  assert.equal(o.reason, "played");
  const st = ps[0].c.last("settlement")!.settlement;
  assert.equal(st.result.logHash, seriesLogHash(log));
  assert.equal(st.result.logHash, outcome.logHash);
  assert.equal(st.result.winner, [h.a.address, h.b.address][o.winner!]);
  assert.equal(h.calls.settles.length, 1, "settle submitted once");
  assert.ok(ps[1].c.last("settled"));
  // Nobody disagreed with the referee.
  assert.ok(!log.flags.some(f => f.kind === "desync" || f.kind === "result-mismatch"), JSON.stringify(log.flags));
  // Anyone can re-verify it from the log alone (a cold replay with a fresh city index).
  const t0 = performance.now();
  const v = verifySeries(log, { ...h.sim.assets, index: undefined });
  const coldMs = performance.now() - t0;
  assert.deepEqual(v.problems, []);
  assert.equal(v.winner, o.winner);
  // The vault paid the winner 2 x stake - 3%, and the loser keeps the rest of the deposit.
  const p = payout(h.stake, st.result.feeBps);
  const w = o.winner === 0 ? h.a.address : h.b.address, l = o.winner === 0 ? h.b.address : h.a.address;
  assert.equal(h.fv.freeOfSync(w), 9n * h.stake + p.winner);
  assert.equal(h.fv.freeOfSync(l), 9n * h.stake);
  assert.equal(h.fv.houseAccrued, p.fee);
  const s = h.room.stats;
  t.diagnostic(`referee CPU (Node): ${s.inputs} INPUT messages, mean ${(s.inputMs / s.inputs * 1000).toFixed(1)} µs, max ${s.maxInputMs.toFixed(2)} ms; `
    + `${s.sealedSteps} steps stepped in ${s.simMs.toFixed(0)} ms (${(s.simMs / s.sealedSteps * 1000).toFixed(2)} µs/step); `
    + `cold re-verify of ${log.rounds.length} x 20 s rounds: ${coldMs.toFixed(0)} ms`);
});

test("a client that lies about its final hash is flagged desync; the referee's result stands", async () => {
  const { log, outcome } = await series({ vars: { HOLD_ON_FLAGS: "0" }, liars: [null, x => (x ^ 0x5a5a5a5a) >>> 0], seed: 2 });
  assert.ok(log.flags.some(f => f.side === 1 && f.kind === "desync"));
  assert.ok(!log.flags.some(f => f.side === 0 && f.kind === "desync"));
  assert.ok(!log.flags.some(f => f.kind === "result-mismatch"));
  // The outcome is the replay's, whatever B claimed.
  const v = verifySeries(log, (await SIMS.district("downtown"))!.assets);
  assert.equal(v.ok, true);
  assert.equal(outcome.outcome.winner, v.winner);
});

test("both clients agree with each other but not with the referee: held for review (result-mismatch)", async () => {
  const lie = (x: number) => (x ^ 0x1234) >>> 0;
  const { h, log, outcome } = await series({ vars: { HOLD_ON_FLAGS: "1" }, liars: [lie, lie], seed: 3 });
  assert.equal(outcome.held, true);
  assert.ok(log.flags.some(f => f.kind === "result-mismatch"));
  assert.equal(h.room.phase, "held");
  assert.equal(h.calls.settles.length, 0);
});

test("online, the sharp TagBot is flagged against its own view and a human-like player is not; a flagged winner is held", async t => {
  const { h, log, outcome } = await series({ vars: { HOLD_ON_FLAGS: "1" }, levels: ["sharp", "sharp"], human: [false, true], roundSeconds: 60, seed: 4 });
  const bot = log.flags.filter(f => f.side === 0), hum = log.flags.filter(f => f.side === 1);
  t.diagnostic(`winner ${outcome.outcome.winner}, flags ${JSON.stringify(log.flags)}`);
  assert.ok(bot.some(f => f.kind === "aim"), JSON.stringify(log.flags));
  assert.ok(!hum.some(f => f.kind === "aim" || f.kind === "reaction" || f.kind === "periodic"), JSON.stringify(log.flags));
  // Held exactly when the flagged player won (a cheater who lost anyway just loses).
  assert.equal(outcome.held, outcome.outcome.winner === 0);
  assert.equal(h.room.phase, outcome.held ? "held" : "settled");
});
