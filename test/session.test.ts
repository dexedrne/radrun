// The online session (src/net/session.ts) against the real relay room (relay/src/room.ts) on a fake clock: two clients
// render at a fixed frame rate, the relay legs have a one-way delay, and one client can start its match late (a slow
// model load, a hidden tab when `start` arrives) or stop rendering for a while (a hitch, a hidden tab mid-match).
// The match must never freeze for good, the relay must never close a socket for sending too much, both clients end
// on the same final hash, and the wait for the other player is visible while it lasts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { RELAY, RoomCore } from "../relay/src/room.ts";
import { OnlineSession } from "../src/net/session.ts";
import { MAX_INPUT_COUNT, NET_VERSION, packWord, type ServerMsg, type StartMsg } from "../src/net/wire.ts";
import { emptyRec, recFromInput } from "../src/game/ghost.ts";
import { mulberry32 } from "../src/sim/math.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8"))).player;
const index = new CityIndex(model);

type Opts = {
  fps: number;
  /** One-way delay of each relay leg (ms). */
  leg: number;
  /** Match length (s). */
  seconds: number;
  /** Client B builds its session when `start` arrives but only starts rendering this much later (ms). */
  lateMs?: number;
  /** Client B stops rendering for hideMs, hideAt ms after the start message. */
  hideAt?: number;
  hideMs?: number;
};

function run(o: Opts) {
  let now = 1_000_000, seq = 0;
  const timers: { at: number; seq: number; fn: () => void }[] = [];
  const later = (ms: number, fn: () => void) => { timers.push({ at: now + ms, seq: seq++, fn }); };
  const room = new RoomCore("K7QXM", { now: () => now, setTimeout: (fn, ms) => { later(ms, fn); return 0; }, lagMs: 0, random: mulberry32(3) });
  const mk = (name: string) => {
    const c = {
      name, closed: null as string | null, slot: -1, start: null as StartMsg | null, session: null as OnlineSession | null, sent: [] as number[],
      h: null as unknown as ReturnType<RoomCore["open"]>, maxWait: 0, rnd: mulberry32(name.charCodeAt(0)), yaw: 0,
    };
    c.h = room.open({
      send: d => later(o.leg, () => {
        if (c.closed) return;
        if (typeof d !== "string") { c.session?.onBinary(d); return; }
        const m = JSON.parse(d) as ServerMsg;
        if (m.t === "welcome") c.slot = m.slot;
        if (m.t === "start") {
          c.start = m;
          c.session = new OnlineSession({ model, index, tuning, start: m, local: c.slot, transport: transport(c) });
        }
      }),
      close: (_code, reason) => { if (!c.closed) { c.closed = reason ?? "closed"; c.h.close(); } },
    });
    return c;
  };
  type C = ReturnType<typeof mk>;
  const toRelay = (c: C, d: string | Uint8Array) => { if (c.closed) return; c.sent.push(now); later(o.leg, () => { if (!c.closed) c.h.message(d); }); };
  const transport = (c: C) => ({ relayNow: () => now, sendJson: (m: unknown) => toRelay(c, JSON.stringify(m)), sendBinary: (b: Uint8Array) => toRelay(c, b) });
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

  const A = mk("A"), B = mk("B");
  const compat = { v: NET_VERSION, build: "t", link: 6, city: "c", tuning: "t" };
  for (const c of [A, B]) toRelay(c, JSON.stringify({ t: "hello", compat, name: `${c.name}-player`, radbro: "652", touch: false, easy: false, district: "downtown" }));
  advance(50);
  toRelay(A, JSON.stringify({ t: "config", seconds: o.seconds }));
  for (const c of [A, B]) toRelay(c, JSON.stringify({ t: "ready", ready: true, rtt: 4 * o.leg }));
  advance(4 * o.leg + 20);
  assert.ok(A.session && B.session, "both got start");
  const t0 = now;
  let peak = 0;
  advance((o.seconds + 20) * 1000, () => {
    for (const c of [A, B]) {
      const s = c.session!;
      if (c.closed) continue;
      if (c === B && now - t0 < (o.lateMs ?? 0)) continue;
      if (c === B && o.hideMs && now - t0 >= o.hideAt! && now - t0 < o.hideAt! + o.hideMs) continue;
      const n = s.stepsFor(1 / o.fps);
      for (let i = 0; i < n; i++) if (!s.step(word(c))) break;
      c.maxWait = Math.max(c.maxWait, s.waitMs);
      let k = c.sent.length;
      while (k > 0 && c.sent[k - 1] > now - 1000) k--;
      peak = Math.max(peak, c.sent.length - k);
    }
  });
  return { A, B, peak };
}

const check = (r: ReturnType<typeof run>, what: string) => {
  const { A, B } = r;
  assert.equal(A.closed, null, `${what}: the relay closed A (${A.closed})`);
  assert.equal(B.closed, null, `${what}: the relay closed B (${B.closed})`);
  assert.ok(A.session!.final && B.session!.final, `${what}: not final (A step ${A.session!.match.step}, B step ${B.session!.match.step} of ${A.session!.match.endStep})`);
  assert.equal(A.session!.match.hash(), B.session!.match.hash(), `${what}: final hashes differ`);
  assert.ok(r.peak < RELAY.maxMsgsPerSec * 0.6, `${what}: peak ${r.peak} msgs/s`);
};

test("a client that starts its match late (models loading, tab hidden at the start) catches up: no freeze", () => {
  for (const lateMs of [2700, 6000]) {
    const r = run({ fps: 60, leg: 40, seconds: 20, lateMs });
    check(r, `late ${lateMs} ms`);
    assert.ok(r.A.maxWait > lateMs - 3000, `A saw the wait (${r.A.maxWait} ms)`);
  }
});

test("a hitch or a hidden tab mid-match: the catch-up stays far under the relay's message limit; the wait shows and ends", () => {
  for (const [fps, hideMs, leg] of [[60, 2000, 75], [60, 4000, 0], [144, 3000, 75], [240, 8000, 40]] as const) {
    const r = run({ fps, leg, seconds: 20, hideAt: 8000, hideMs });
    check(r, `${fps} fps, ${hideMs} ms hidden, ${leg} ms legs`);
    assert.ok(r.A.maxWait > hideMs - 1000, `A waited ${r.A.maxWait} ms`);
    assert.equal(r.A.session!.waitMs, 0, "the wait ended");
    assert.ok(r.B.session!.inputsSent < 20 * 45, `B sent ${r.B.session!.inputsSent} INPUTs`);
  }
});

test("the relay's message bucket: a burst passes, a flood is closed", () => {
  const room = new RoomCore("K7QXM", { now: () => 0, setTimeout: () => 0, lagMs: 0, random: () => 0.5 });
  let closed: string | null = null;
  const h = room.open({ send: () => {}, close: (_c, r) => { closed = r ?? "closed"; } });
  h.message(JSON.stringify({ t: "hello", compat: { v: NET_VERSION, build: "t", link: 6, city: "c", tuning: "t" }, name: "flood", radbro: "652", touch: false, easy: false, district: "downtown" }));
  for (let i = 0; i < RELAY.msgBurst - 1 && !closed; i++) h.message(JSON.stringify({ t: "pick", radbro: "652" }));
  assert.equal(closed, null, "a burst of msgBurst passes");
  for (let i = 0; i < 5 && !closed; i++) h.message(JSON.stringify({ t: "pick", radbro: "652" }));
  assert.equal(closed, "rate");
  assert.ok(MAX_INPUT_COUNT * 5 + 20 <= RELAY.maxMsgBytes, "a full INPUT fits the relay's message size");
});
