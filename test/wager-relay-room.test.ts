// The wager series room (relay/wager/src/room.ts, docs/WAGER.md §4.4, §5, §6) on a fake clock, fake sockets and an
// in-memory vault: who gets a seat (Login signatures, single-use challenges), sealed release and fills through the
// room, no-shows, the reconnect grace and forfeits, draws and tie-breaks, the round-2 first holder, the holder fee,
// holds and the owner's review, and a relay restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { MSG_FILL, MSG_INPUT_OUT, decodeFill, decodeRelayInput, encodeInput } from "../src/net/wire.ts";
import { REVIEW_SETTLE, REVIEW_VOID, newMatchId, random32, reviewTypedData } from "../src/wager/eip712.ts";
import { gunzipSync as gunzipBuf } from "node:zlib";
import { firstHolderSlot, seriesLogHash, type RoundResult, type SeriesLog } from "../src/wager/log.ts";
import { WAGER_PROTOCOL, type WagerStartMsg } from "../src/wager/protocol.ts";
import { MockRadbroSource } from "../relay/wager/src/radbro.ts";
import { FailingRadbro, eventually, flush, newAccount, roomHarness, sleep, type RoomClient, type RoomHarness } from "./wager-relay-fakes.ts";

/** Both players in, picked, seeded and READY: round 1 starts. */
async function readyUp(h: RoomHarness, ca: RoomClient, cb: RoomClient): Promise<WagerStartMsg> {
  await ca.login(h.a);
  await cb.login(h.b);
  for (const c of [ca, cb]) {
    c.sendJson({ t: "pick", radbro: "652", own: null });
    c.sendJson({ t: "seed", share: random32() });
    c.sendJson({ t: "ready" });
  }
  await ca.until(() => ca.last("start") && cb.last("start"));
  return ca.last("start") as WagerStartMsg;
}

/** Tick until the room sends `t` to this client (idle rounds progress on fills alone). */
const idleUntil = (c: RoomClient, cond: () => unknown, maxMs = 60_000) => c.until(cond, maxMs, 25);

const gunzipSync = (b: Uint8Array) => gunzipBuf(b).toString("utf8");
const win = (side: 0 | 1) => (): RoundResult => ({ winner: side, bag: [0, 0], falls: [0, 0], tags: [0, 0], hash: 1 });

test("seats: a stranger gets `full`; replayed, expired, forged and wrong-match logins are refused", async () => {
  const h = await roomHarness();
  const stranger = h.client();
  await stranger.login(newAccount());
  assert.equal(stranger.last("error")?.code, "full");
  assert.ok(stranger.closed);

  // A good login, then its message replayed on a fresh socket (another challenge): refused.
  const c1 = h.client();
  await c1.hello();
  const msg = await c1.loginMsg(h.a.address, h.a);
  c1.sendJson(msg);
  await c1.until(() => c1.last("series"));
  assert.equal(c1.last("series")?.state.you, 0);
  const c2 = h.client();
  await c2.hello();
  c2.sendJson(msg);
  await c2.until(() => c2.closed);
  assert.equal(c2.last("error")?.code, "auth");
  // The same login again on its own socket: the challenge was single use.
  const c3 = h.client();
  await c3.hello();
  const m3 = await c3.loginMsg(h.b.address, h.b);
  c3.sendJson(m3);
  await c3.until(() => c3.last("series"));
  c3.sendJson(m3);
  await c3.until(() => c3.closed);
  assert.equal(c3.last("error")?.code, "auth");

  // Expired challenge.
  const c4 = h.client();
  await c4.hello();
  h.clock.tick(61_000);
  c4.sendJson(await c4.loginMsg(h.b.address, h.b));
  await c4.until(() => c4.closed);
  assert.match(c4.last("error")!.message, /expired/);
  // Someone else's key claiming player B.
  const c5 = h.client();
  await c5.hello();
  c5.sendJson(await c5.loginMsg(h.b.address, h.a));
  await c5.until(() => c5.closed);
  assert.equal(c5.last("error")?.code, "auth");
  // Wrong match, wrong sim, wrong protocol.
  const c6 = h.client();
  await c6.hello({ matchId: random32() });
  assert.equal(c6.last("error")?.code, "bad");
  const c7 = h.client();
  await c7.hello({ compat: c7.compat({ city: "another-city" }) });
  assert.equal(c7.last("error")?.code, "version");
  const c8 = h.client();
  await c8.hello({ v: WAGER_PROTOCOL + 1 });
  assert.equal(c8.last("error")?.code, "version");
});

test("session-key logins: the live key works; a revoked or expired one does not", async () => {
  const h = await roomHarness();
  const key = newAccount();
  h.fv.setSession(h.a.address, key.address, 10n ** 20n, 10n ** 21n, Math.floor(h.clock.now() / 1000) + 3600);
  const c = h.client();
  await c.login(h.a, "session", key);
  assert.equal(c.last("series")?.state.you, 0);
  h.fv.sessions.delete(h.a.address.toLowerCase());
  const d = h.client();
  await d.login(h.a, "session", key);
  assert.equal(d.last("error")?.code, "auth");
  h.fv.setSession(h.a.address, key.address, 10n ** 20n, 10n ** 21n, Math.floor(h.clock.now() / 1000) - 1);
  const e = h.client();
  await e.login(h.a, "session", key);
  assert.match(e.last("error")!.message, /expired/);
});

test("sealed release through the room: nobody sees the opponent's step before their own is in; fills reach both clients", async () => {
  const h = await roomHarness();
  const ca = h.client(), cb = h.client();
  const st = await readyUp(h, ca, cb);
  assert.equal(st.round, 1);
  assert.ok(st.slots.every(s => !s.touch && !s.easy), "assists are off for both slots");
  assert.equal(st.config.seconds, 20);
  const slotA = st.slotOfA, slotB = 1 - slotA, D = st.inputDelay;
  h.clock.tick(st.startAtMs - h.clock.now() + 20);
  // A sends 40 steps at once; B sends nothing.
  ca.sendBin(encodeInput({ firstStep: D + 1, words: Array.from({ length: 40 }, (_, i) => 1000 + i) }));
  h.clock.tick(15);
  const outsToB = () => cb.bin.filter(b => b[0] === MSG_INPUT_OUT).map(b => decodeRelayInput(b)!).filter(m => m.slot === slotA);
  assert.equal(outsToB().length, 0, "B has not committed its steps: A's words are held back");
  // Past B's deadlines: B's steps are filled, B hears its own FILL, then A's words are released to B.
  h.clock.tick(40 * 8.34 + 200);
  const bFills = cb.bin.filter(b => b[0] === MSG_FILL).map(b => decodeFill(b)!).filter(f => f.slot === slotB);
  assert.ok(bFills.length > 0, "the late player gets its own FILL");
  const released = outsToB().flatMap(m => m.words.map((_, i) => m.firstStep + i));
  assert.ok(released.includes(D + 1) && released.includes(D + 40));
  const filledB = new Set(bFills.flatMap(f => Array.from({ length: f.count }, (_, i) => f.firstStep + i)));
  for (const s of released) assert.ok(filledB.has(s), `step ${s}: B's own word was in before A's was released to B`);
  const aFills = ca.bin.filter(b => b[0] === MSG_FILL).map(b => decodeFill(b)!).filter(f => f.slot === slotB);
  assert.ok(aFills.length > 0, "the opponent gets the FILL too");
  assert.ok(!ca.bin.some(b => b[0] === MSG_INPUT_OUT && decodeRelayInput(b)!.slot === slotA), "never echoed to the sender");
  // A word B sends now for a filled step is dropped: A never gets it as input.
  const before = ca.bin.length;
  cb.sendBin(encodeInput({ firstStep: D + 1, words: [7, 7] }));
  h.clock.tick(30);
  assert.ok(!ca.bin.slice(before).some(b => b[0] === MSG_INPUT_OUT && decodeRelayInput(b)!.slot === slotB && decodeRelayInput(b)!.firstStep === D + 1));
});

test("no-show: a player who never arrives voids the series and both stakes go back", async () => {
  const h = await roomHarness();
  const ca = h.client();
  await ca.login(h.a);
  ca.sendJson({ t: "seed", share: random32() });
  ca.sendJson({ t: "ready" });
  const freeA = h.fv.freeOfSync(h.a.address);
  await idleUntil(ca, () => ca.last("voided"), 90_000);
  assert.equal(ca.last("outcome")?.outcome.reason, "noshow");
  assert.equal(h.calls.settles[0].settlement.result.outcome, 2);
  assert.equal(h.fv.freeOfSync(h.a.address), freeA + h.stake);
  assert.equal(h.fv.lockedOfSync(h.b.address), 0n);
  // The log of a no-show is the header alone, and it is public.
  const log = JSON.parse(gunzipSync(h.room.logGz()!)) as SeriesLog;
  assert.equal(log.rounds.length, 0);
  assert.equal(seriesLogHash(log), h.calls.settles[0].settlement.result.logHash);
});

test("reconnect: back within the grace (start and every word again); gone past the grace forfeits the series", async () => {
  const h = await roomHarness({ vars: { HOLD_ON_FLAGS: "0" }, roundSeconds: 60 });
  const ca = h.client(), cb = h.client();
  const st = await readyUp(h, ca, cb);
  const slotA = st.slotOfA, D = st.inputDelay;
  h.clock.tick(st.startAtMs - h.clock.now() + 100);
  ca.sendBin(encodeInput({ firstStep: D + 1, words: [5, 6, 7, 8] }));
  h.clock.tick(500);
  ca.close();
  h.clock.tick(20);
  assert.equal(cb.last("drop")?.side, 0);
  assert.equal(cb.last("drop")?.graceMs, 20_000);
  h.clock.tick(5_000);
  const back = h.client();
  await back.login(h.a);
  await back.until(() => back.last("start"));
  assert.equal(back.last("start")?.startAtMs, st.startAtMs, "the same round again");
  assert.equal(cb.last("back")?.side, 0);
  const own = back.bin.filter(b => b[0] === MSG_INPUT_OUT).map(b => decodeRelayInput(b)!).find(m => m.slot === slotA);
  assert.deepEqual(own?.words.slice(0, 4), [5, 6, 7, 8], "its own words so far come back too");
  // Gone for good: forfeit after the grace.
  back.close();
  const bFree = h.fv.freeOfSync(h.b.address);
  await idleUntil(cb, () => cb.last("settled"), 30_000);
  const o = cb.last("outcome")!.outcome;
  assert.deepEqual([o.kind, o.winner, o.reason, o.forfeit?.by, o.forfeit?.why], ["win", 1, "forfeit", 0, "disconnect"]);
  assert.equal(h.fv.freeOfSync(h.b.address), bFree + 2n * h.stake - (2n * h.stake * 300n) / 10_000n);
  const log = JSON.parse(gunzipSync(h.room.logGz()!)) as SeriesLog;
  assert.equal(log.rounds[0].result, null, "the round cut short is in the log");
  assert.ok(log.rounds[0].lastStep > 0 && log.rounds[0].lastStep < log.rounds[0].endStep);
});

test("both players gone past the grace: void", async () => {
  const h = await roomHarness();
  const ca = h.client(), cb = h.client();
  const st = await readyUp(h, ca, cb);
  h.clock.tick(st.startAtMs - h.clock.now() + 100);
  ca.close();
  h.clock.tick(3_000);
  cb.close();
  await eventually(() => h.calls.settles.length, h.clock);
  assert.equal(h.calls.settles[0]?.outcome.kind, "void");
  assert.equal(h.calls.settles[0]?.outcome.reason, "error");
  assert.equal(h.room.phase, "voided");
});

test("draws: a drawn round is replayed with the next round number and a fresh seed; a 3rd draw voids the series", async () => {
  const draw = (): RoundResult => ({ winner: "draw", bag: [100, 100], falls: [0, 0], tags: [1, 1], hash: 7 });
  const h = await roomHarness({ judge: draw });
  const ca = h.client(), cb = h.client();
  await readyUp(h, ca, cb);
  await idleUntil(ca, () => ca.last("outcome"), 200_000);
  const rounds = ca.all("round");
  assert.deepEqual(rounds.map(r => [r.round, r.result.winner, r.draws]), [[1, "draw", 1], [2, "draw", 2], [3, "draw", 3]]);
  const seeds = ca.all("start").map(s => s.seed);
  assert.equal(new Set(seeds).size, 3);
  assert.deepEqual(ca.last("outcome")?.outcome, { kind: "void", winner: null, reason: "draws", score: [0, 0] });
  await idleUntil(ca, () => ca.last("voided"));
});

test("round 2 gives the bag first to the player who did not start with it in round 1", async () => {
  const h = await roomHarness({ judge: win(0), vars: { HOLD_ON_FLAGS: "0" } });
  const ca = h.client(), cb = h.client();
  await readyUp(h, ca, cb);
  await idleUntil(ca, () => ca.all("start").length === 2, 120_000);
  const [s1, s2] = ca.all("start");
  assert.equal(s1.slotOfA, 0);
  const firstSide = (s: WagerStartMsg) => (firstHolderSlot(s.seed) === s.slotOfA ? 0 : 1);
  assert.notEqual(firstSide(s2), firstSide(s1));
  assert.deepEqual(s2.score, [1, 0]);
  await idleUntil(ca, () => ca.last("settled"), 120_000);
  assert.deepEqual(ca.last("outcome")?.outcome.score, [2, 0]);
});

test("holder fee: a winner holding a Radbro pays the holder fee; an RPC failure means no perk", async () => {
  const h = await roomHarness({ judge: win(0), vars: { HOLD_ON_FLAGS: "0" }, radbro: a => new MockRadbroSource(new Map([[a.toLowerCase(), [652]]])) });
  const ca = h.client(), cb = h.client();
  await readyUp(h, ca, cb);
  await idleUntil(ca, () => ca.last("settlement"), 120_000);
  assert.equal(ca.last("settlement")?.settlement.result.feeBps, 150);
  const g = await roomHarness({ judge: win(0), vars: { HOLD_ON_FLAGS: "0" }, radbro: new FailingRadbro() });
  const ga = g.client(), gb = g.client();
  await readyUp(g, ga, gb);
  await idleUntil(ga, () => ga.last("settlement"), 120_000);
  assert.equal(ga.last("settlement")?.settlement.result.feeBps, 300);
});

test("holds: a flagged winner waits for the owner's review; only the vault owner's signature decides it", async () => {
  const owner = newAccount();
  const h = await roomHarness({ judge: win(0) });
  h.fv.owner = owner.address;
  const ca = h.client(), cb = h.client();
  await readyUp(h, ca, cb);
  // Nobody sends inputs: every step is filled on a fast connection, so both are flagged late-inputs.
  await idleUntil(ca, () => ca.last("outcome"), 120_000);
  const oc = ca.last("outcome")!;
  assert.equal(oc.held, true);
  assert.ok(oc.flags.some(f => f.side === 0 && f.kind === "late-inputs"));
  assert.equal(h.room.phase, "held");
  assert.equal(h.calls.settles.length, 0, "nothing signed while held");
  const sign = (by: typeof owner, decision: number, logHash: Hex = oc.logHash) =>
    by.signTypedData(reviewTypedData(h.fv.chainId, h.fv.vault, { matchId: h.matchId, decision, logHash }));
  const bad = await h.room.review({ matchId: h.matchId, decision: REVIEW_SETTLE, logHash: oc.logHash, sig: await sign(newAccount(), REVIEW_SETTLE) });
  assert.equal(bad.ok, false);
  const wrongLog = await h.room.review({ matchId: h.matchId, decision: REVIEW_SETTLE, logHash: random32(), sig: await sign(owner, REVIEW_SETTLE) });
  assert.equal(wrongLog.ok, false);
  const good = await h.room.review({ matchId: h.matchId, decision: REVIEW_SETTLE, logHash: oc.logHash, sig: await sign(owner, REVIEW_SETTLE) });
  assert.equal(good.ok, true);
  await eventually(() => h.room.phase === "settled", h.clock);
  assert.equal(h.calls.settles[0].settlement.result.winner, h.a.address);
  // A second review of the same series: refused.
  assert.equal((await h.room.review({ matchId: h.matchId, decision: REVIEW_VOID, logHash: oc.logHash, sig: await sign(owner, REVIEW_VOID) })).ok, false);
  // And a review that voids.
  const v = await roomHarness({ judge: win(1) });
  v.fv.owner = owner.address;
  const va = v.client(), vb = v.client();
  await readyUp(v, va, vb);
  await idleUntil(va, () => va.last("outcome"), 120_000);
  const lh = va.last("outcome")!.logHash;
  const sig = await owner.signTypedData(reviewTypedData(v.fv.chainId, v.fv.vault, { matchId: v.matchId, decision: REVIEW_VOID, logHash: lh }));
  assert.equal((await v.room.review({ matchId: v.matchId, decision: REVIEW_VOID, logHash: lh, sig })).ok, true);
  await eventually(() => v.room.phase === "voided", v.clock);
  const log = JSON.parse(gunzipSync(v.room.logGz()!)) as SeriesLog;
  assert.equal(log.outcome.reason, "review");
  assert.equal(log.logHash, lh, "the outcome is not hashed: the log hash stays");
});

test("a relay restart mid-round voids the series (a relay fault never picks a winner)", async () => {
  const h = await roomHarness({ judge: win(0) });
  const ca = h.client(), cb = h.client();
  const st = await readyUp(h, ca, cb);
  h.clock.tick(st.startAtMs - h.clock.now() + 1000);
  const fresh = h.restart();
  assert.equal(await fresh.ensure(), true);
  await eventually(() => fresh.phase === "voided", h.clock);
  assert.equal(h.calls.settles[0].outcome.reason, "error");
});

test("a relay restart between rounds: both players get the grace; one who stays away voids the series, never forfeits it", async () => {
  const h = await roomHarness({ judge: win(0), vars: { HOLD_ON_FLAGS: "0" } });
  const ca = h.client(), cb = h.client();
  await readyUp(h, ca, cb);
  await idleUntil(ca, () => ca.last("round"));
  assert.equal(h.room.phase, "between");
  const [fa, fb] = [h.fv.freeOfSync(h.a.address), h.fv.freeOfSync(h.b.address)];
  const fresh = h.restart();
  assert.equal(await fresh.ensure(), true);
  assert.ok(fresh.nextDeadline() !== null, "the new instance keeps a deadline (it never waits for ever)");
  // A comes back, B never does: a void (a relay fault never picks a winner), and both stakes go back.
  const back = h.client();
  await back.login(h.a);
  await eventually(() => fresh.phase === "voided", h.clock, 20_000, 500);
  assert.deepEqual([h.calls.settles[0].outcome.kind, h.calls.settles[0].outcome.reason], ["void", "error"]);
  assert.deepEqual([h.fv.freeOfSync(h.a.address), h.fv.freeOfSync(h.b.address)], [fa + h.stake, fb + h.stake]);
});

test("a relay restart between rounds: both back within the grace, the series goes on", async () => {
  const h = await roomHarness({ judge: win(0), vars: { HOLD_ON_FLAGS: "0" } });
  const ca = h.client(), cb = h.client();
  await readyUp(h, ca, cb);
  await idleUntil(ca, () => ca.last("round"));
  const fresh = h.restart();
  assert.equal(await fresh.ensure(), true);
  const a2 = h.client(), b2 = h.client();
  await a2.login(h.a);
  h.clock.tick(5_000);
  await b2.login(h.b);
  a2.sendJson({ t: "ready" });
  b2.sendJson({ t: "ready" });
  await a2.until(() => a2.last("start"));
  assert.equal(a2.last("start")?.round, 2);
  await idleUntil(a2, () => a2.last("settled"), 120_000);
  assert.deepEqual(a2.last("outcome")?.outcome, { kind: "win", winner: 0, reason: "played", score: [2, 0] });
});

test("a copied session key: it never takes a live seat from another connection; a forfeit after it signs in from a new IP is held", async () => {
  const h = await roomHarness({ ips: [["10.0.0.1"], ["10.0.0.2"]] });
  const key = newAccount();
  h.fv.setSession(h.a.address, key.address, 10n ** 20n, 10n ** 21n, Math.floor(h.clock.now() / 1000) + 3600);
  const ca = h.client(10, "10.0.0.1"), cb = h.client(10, "10.0.0.2");
  await ca.login(h.a, "session", key);
  assert.equal(ca.last("series")?.state.you, 0);
  // The same key from somewhere else while the seat is live: refused, and the seat stays.
  const thief = h.client(10, "10.9.9.9");
  await thief.login(h.a, "session", key);
  assert.equal(thief.last("error")?.code, "forbidden");
  assert.equal(ca.closed, null);
  // The wallet can move the seat (a player changing device).
  const moved = h.client(10, "10.0.0.7");
  await moved.login(h.a);
  assert.equal(moved.last("series")?.state.you, 0);
  assert.ok(ca.closed, "the old socket was replaced");
  moved.close();
  // With the seat empty the key gets in, but the room remembers where it signed in from.
  const t2 = h.client(10, "10.9.9.9");
  await t2.login(h.a, "session", key);
  assert.equal(t2.last("series")?.state.you, 0);
  await cb.login(h.b);
  for (const c of [t2, cb]) {
    c.sendJson({ t: "pick", radbro: "652", own: null });
    c.sendJson({ t: "seed", share: random32() });
    c.sendJson({ t: "ready" });
  }
  await t2.until(() => t2.last("start") && cb.last("start"));
  const st = t2.last("start")!;
  h.clock.tick(st.startAtMs - h.clock.now() + 100);
  // ...and throws the series by leaving.
  t2.close();
  await idleUntil(cb, () => cb.last("outcome"), 30_000);
  const out = cb.last("outcome")!;
  assert.deepEqual([out.outcome.kind, out.outcome.winner, out.outcome.reason], ["win", 1, "forfeit"]);
  assert.equal(out.held, true, "held for review instead of paying the thief's partner");
  assert.ok(out.flags.some(f => f.kind === "session-key" && f.side === 0));
  await flush();
  assert.equal(h.calls.settles.length, 0);
  assert.equal(h.room.phase, "held");
});

test("both seats on one IP and a loser who never plays: held; from two IPs there is no copied-key signal", async () => {
  for (const shared of [true, false]) {
    const h = await roomHarness({ judge: win(1) });
    const ca = h.client(10, "10.0.0.5"), cb = h.client(10, shared ? "10.0.0.5" : "10.0.0.6");
    await readyUp(h, ca, cb);
    await idleUntil(cb, () => cb.last("outcome"), 120_000);
    const out = cb.last("outcome")!;
    assert.deepEqual([out.outcome.kind, out.outcome.winner, out.outcome.reason], ["win", 1, "played"]);
    // (Both idle bots also draw late-input flags; only the copied-key signal is looked at here.)
    assert.equal(out.flags.some(f => f.kind === "session-key" && f.side === 0), shared, shared ? "one IP, and A idled" : "apart: no copied-key signal");
    if (shared) assert.equal(out.held, true);
  }
});

test("a referee rotation: a live match is signed with the key it locked under (REFEREE_KEY_PREV), never the new one", async () => {
  for (const prev of [true, false]) {
    const next = newAccount();
    const h = await roomHarness({ judge: win(0), vars: { HOLD_ON_FLAGS: "0" }, keys: old => ({ referee: next, refereePrev: prev ? old : null }) });
    h.fv.referee = next.address; // rotated after the lock
    const ca = h.client(), cb = h.client();
    await readyUp(h, ca, cb);
    if (prev) {
      await idleUntil(ca, () => ca.last("settled"), 120_000);
      assert.equal(h.calls.settleErrors.length, 0);
      assert.equal(h.room.phase, "settled");
    } else {
      await idleUntil(ca, () => ca.last("outcome"), 120_000);
      await eventually(() => true, h.clock);
      assert.equal(ca.last("settlement"), undefined, "no key of the match's referee: nothing is signed (the settle window refunds)");
      assert.equal(h.calls.settles.length, 0);
    }
  }
});

test("a Result the vault won't take is retried until settleBy, then left to refundExpired", async () => {
  const h = await roomHarness({ judge: win(0), vars: { HOLD_ON_FLAGS: "0" } });
  h.fv.settleFails = "BadResult()"; // the vault refuses this Result, whatever the reason
  const ca = h.client(), cb = h.client();
  await readyUp(h, ca, cb);
  await idleUntil(ca, () => ca.last("settlement"), 120_000);
  await eventually(() => h.calls.settleErrors.length > 0, h.clock);
  (h.room as unknown as { p: { settleBy: number } }).p.settleBy = Math.floor(h.clock.now() / 1000) + 90;
  const n0 = h.calls.settles.length;
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 5_000) { h.clock.tick(5_000); await flush(6); await sleep(1); } };
  await run(120_000);
  const n = h.calls.settles.length;
  assert.ok(n - n0 >= 2 && n - n0 <= 4, `retried every 30 s until settleBy (${n - n0})`);
  await run(600_000);
  assert.equal(h.calls.settles.length, n, "no retries after settleBy");
  assert.equal(h.room.nextDeadline(), null);
});

test("a socket that piles up JSON behind a message waiting on the chain is closed", async () => {
  const h = await roomHarness();
  const c = h.client(0);
  const hello = JSON.stringify({ t: "hello", v: WAGER_PROTOCOL, matchId: h.matchId, compat: c.compat() });
  for (let i = 0; i < 20; i++) c.h.message(hello);
  await c.until(() => c.closed);
  assert.equal(c.closed, "rate");
});

test("a room for an id that never locked writes nothing (no storage for strangers' ids)", async () => {
  const { WagerRoomCore } = await import("../relay/wager/src/room.ts");
  const { RadbroReader } = await import("../relay/wager/src/radbro.ts");
  const { nodeSql } = await import("../relay/wager/src/node.ts");
  const { SIMS, card } = await import("./wager-relay-fakes.ts");
  const h = await roomHarness();
  const sql = nodeSql();
  const room = new WagerRoomCore({
    matchId: random32(), clock: h.clock, sql, settings: h.settings, chain: h.fv, sims: SIMS, build: "test", referee: null,
    radbro: new RadbroReader({ src: new MockRadbroSource(new Map()), now: () => h.clock.now(), cacheMs: 1 }),
    lobby: { card: async a => card(a), paired: async () => null, update: async () => {}, settle: async () => {} },
  });
  assert.equal(room.logGz(), null);
  assert.equal(room.status(), null);
  assert.equal(await room.ensure(), false);
  await room.syncChain();
  const s = room.open({ send: () => {}, close: () => {} }, "http://relay.test");
  s.message(JSON.stringify({ t: "hello", v: WAGER_PROTOCOL, matchId: room.matchId, compat: {} }));
  await eventually(() => true, h.clock);
  assert.deepEqual(sql.exec("SELECT name FROM sqlite_master"), []);
  // The harness's room (a locked match) has its tables.
  assert.ok(h.room.status());
});

test("picks: an own Radbro must be owned on Ethereum; a rigged one plays as its model, any other shows its number", async () => {
  const h = await roomHarness({ radbro: a => new MockRadbroSource(new Map([[a.toLowerCase(), [3171, 42]]])) });
  const ca = h.client(), cb = h.client();
  await ca.login(h.a);
  await cb.login(h.b);
  ca.sendJson({ t: "pick", radbro: "652", own: 3171 });
  await ca.until(() => ca.last("series")?.state.picks[0]?.own === 3171);
  assert.equal(ca.last("series")?.state.picks[0]?.radbro, "3171");
  ca.sendJson({ t: "pick", radbro: "4764", own: 42 });
  await ca.until(() => ca.last("series")?.state.picks[0]?.own === 42);
  assert.equal(ca.last("series")?.state.picks[0]?.radbro, "4764");
  cb.sendJson({ t: "pick", radbro: "652", own: 3171 });
  await cb.until(() => cb.last("error"));
  assert.equal(cb.last("error")?.code, "forbidden");
  cb.sendJson({ t: "pick", radbro: "../x", own: null });
  await cb.until(() => cb.all("error").length === 2);
  const shares = [random32(), random32()];
  for (const [i, c] of [ca, cb].entries()) { c.sendJson({ t: "seed", share: shares[i] }); c.sendJson({ t: "ready" }); }
  // A reconnecting client sends the same share again: no error; another share is refused.
  ca.sendJson({ t: "seed", share: shares[0] });
  cb.sendJson({ t: "seed", share: random32() });
  await ca.until(() => ca.last("start"));
  assert.equal(ca.all("error").length, 0);
  assert.equal(cb.all("error").length, 3);
  const st = ca.last("start")!;
  assert.equal(st.slots[st.slotOfA].name, "#42");
  assert.equal(st.slots[st.slotOfA].radbro, "4764");
});

test("a player who arrives before the lock confirms is let in once it has (no stale 'not locked')", async () => {
  const h = await roomHarness();
  // A fresh room for a match that is not locked yet.
  const id = newMatchId(h.a.address);
  const fresh = new (h.room.constructor as typeof import("../relay/wager/src/room.ts").WagerRoomCore)({
    ...(h.room as unknown as { d: import("../relay/wager/src/room.ts").RoomDeps }).d, matchId: id, sql: (await import("../relay/wager/src/node.ts")).nodeSql(),
  });
  assert.equal(await fresh.ensure(), false);
  h.fv.forceLock({ matchId: id, a: h.a.address, b: h.b.address, stake: h.stake, rules: h.sim.rulesHash, roundSeconds: 20 });
  assert.equal(await fresh.ensure(), false, "remembered for a moment");
  h.clock.tick(3_001);
  // Locked on chain, but not a pairing the lobby made (Entries submitted straight to the vault): no room.
  assert.equal(await fresh.ensure(), false, "a lock the lobby never paired gets no room");
  h.pair(id);
  h.clock.tick(3_001);
  assert.equal(await fresh.ensure(), true);
  assert.equal(fresh.phase, "waiting");
  // The lobby's init afterwards only adds the lock transaction.
  assert.equal(await fresh.init({ match: await h.fv.matchOf(id), lockTx: `0x${"cd".repeat(32)}` }), true);
  assert.equal(fresh.status()?.lockTx, `0x${"cd".repeat(32)}`);
});
