// The relay's room logic (relay/src/room.ts) with fake sockets and a fake clock: hello / versions / full rooms, the
// start on READY, inputs forwarded with the relay's slot stamp (never the client's), step checks, pings, the hash
// compare (DESYNC) and the end-of-match agreement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomCore, inputDelayFor, type RoomEnv } from "../relay/src/room.ts";
import {
  MSG_DESYNC, MSG_INPUT_OUT, NET_VERSION, decodePong, decodeRelayInput, encodeInput, encodePing, type ClientMsg, type Compat, type ServerMsg, type StartMsg,
} from "../src/net/wire.ts";

type Fake = { json: ServerMsg[]; bin: Uint8Array[]; closed: string | null; h: ReturnType<RoomCore["open"]> };

function setup(lagMs = 0) {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  const env: RoomEnv = { now: () => now, setTimeout: (fn, ms) => { timers.push({ at: now + ms, fn }); return 0; }, lagMs, random: () => 0.5 };
  const room = new RoomCore("K7QXM", env);
  const tick = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift()!;
      now = Math.max(now, t.at);
      t.fn();
    }
    now = end;
  };
  const sock = (): Fake => {
    const f: Fake = { json: [], bin: [], closed: null, h: null as unknown as Fake["h"] };
    f.h = room.open({
      send: d => { if (typeof d === "string") f.json.push(JSON.parse(d) as ServerMsg); else f.bin.push(d); },
      close: (_c, r) => { f.closed = r ?? "closed"; f.h.close(); },
    });
    return f;
  };
  return { room, tick, sock, now: () => now };
}

const compat = (o: Partial<Compat> = {}): Compat => ({ v: NET_VERSION, build: "abc", link: 6, city: "c1", tuning: "t1", ...o });
const hello = (radbro = "652", c = compat()): string =>
  JSON.stringify({ t: "hello", compat: c, name: "tester", radbro, touch: false, easy: false, district: "downtown" } satisfies ClientMsg);
const send = (f: Fake, m: ClientMsg) => f.h.message(JSON.stringify(m));
const last = <T extends ServerMsg["t"]>(f: Fake, t: T) => [...f.json].reverse().find(m => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;

test("hello: slots, the lobby, a version mismatch and a full room are refused", () => {
  const { sock } = setup();
  const a = sock(); a.h.message(hello("652"));
  const b = sock(); b.h.message(hello("4764"));
  assert.equal(last(a, "welcome")?.slot, 0);
  assert.equal(last(a, "welcome")?.host, true);
  assert.equal(last(b, "welcome")?.slot, 1);
  assert.equal(last(a, "lobby")?.players.length, 2);
  const c = sock(); c.h.message(hello("723"));
  assert.equal(last(c, "error")?.code, "full");
  assert.ok(c.closed);
  const { sock: sock2 } = setup();
  const x = sock2(); x.h.message(hello());
  const y = sock2(); y.h.message(hello("652", compat({ build: "other" })));
  assert.equal(last(y, "error")?.code, "version");
  const z = sock2(); z.h.message("not json");
  assert.ok(z.closed);
});

test("start on both READY; inputs forwarded with the relay's slot; bad steps kick; pings answered", () => {
  const { sock, tick, now } = setup();
  const a = sock(); a.h.message(hello("652"));
  const b = sock(); b.h.message(hello("4764"));
  send(a, { t: "ready", ready: true, rtt: 30 });
  assert.equal(last(a, "start"), undefined);
  send(b, { t: "ready", ready: true, rtt: 40 });
  const st = last(a, "start") as StartMsg;
  assert.ok(st);
  assert.equal(st.inputDelay, inputDelayFor(70));
  assert.deepEqual(st.slots.map(s => s.radbro), ["652", "4764"]);
  assert.ok(st.startAtMs > now());
  tick(st.startAtMs - now() + 100);
  const d = st.inputDelay;
  a.h.message(encodeInput({ firstStep: d + 1, words: [7, 8, 9, 10] }));
  const got = b.bin.map(x => decodeRelayInput(x)).filter(Boolean);
  assert.deepEqual(got[0], { slot: 0, firstStep: d + 1, words: [7, 8, 9, 10] });
  assert.ok(!a.bin.some(x => x[0] === MSG_INPUT_OUT), "never echoed to the sender");
  a.h.message(encodePing(123));
  const pong = a.bin.map(x => decodePong(x)).find(Boolean);
  assert.equal(pong?.clientMs, 123);
  // A gap in the steps is refused.
  b.h.message(encodeInput({ firstStep: d + 5, words: [1] }));
  assert.equal(b.closed, "bad steps");
});

test("hash compare: equal hashes pass, a mismatch sends DESYNC; end hashes decide the result", () => {
  const { sock, tick, now } = setup();
  const a = sock(); a.h.message(hello());
  const b = sock(); b.h.message(hello("4764"));
  send(a, { t: "ready", ready: true }); send(b, { t: "ready", ready: true });
  const st = last(a, "start") as StartMsg;
  tick(st.startAtMs - now() + 1000);
  const d = st.inputDelay;
  const words = new Array(60 - d).fill(0);
  for (const [f, h] of [[a, 111], [b, 111]] as const) for (let s = d + 1; s <= 60; s += 29) f.h.message(encodeInput({ firstStep: s, words: words.slice(0, Math.min(29, 61 - s)), ...(s + 28 >= 60 ? { hashStep: 60, hash: h } : {}) }));
  assert.ok(!a.bin.some(x => x[0] === MSG_DESYNC));
  a.h.message(encodeInput({ firstStep: 61, words: new Array(60).fill(0).slice(0, 32) }));
  a.h.message(encodeInput({ firstStep: 93, words: new Array(28).fill(0), hashStep: 120, hash: 1 }));
  b.h.message(encodeInput({ firstStep: 61, words: new Array(32).fill(0) }));
  b.h.message(encodeInput({ firstStep: 93, words: new Array(28).fill(0), hashStep: 120, hash: 2 }));
  assert.ok(a.bin.some(x => x[0] === MSG_DESYNC) && b.bin.some(x => x[0] === MSG_DESYNC));
  send(a, { t: "end", step: 999, hash: 5, bag: [] });
  send(b, { t: "end", step: 999, hash: 5, bag: [] });
  assert.equal(last(a, "result")?.ok, true);
  // A leaver mid-match: the other gets `drop`.
  send(a, { t: "ready", ready: true }); send(b, { t: "ready", ready: true });
  a.h.close();
  assert.equal(last(b, "drop")?.slot, 0);
});

test("the lag knob delays every message a quarter of the round trip each way", () => {
  const { sock, tick } = setup(200);
  const a = sock(); a.h.message(hello());
  assert.equal(a.json.length, 0);
  tick(49);
  assert.equal(a.json.length, 0);
  tick(60);
  assert.equal(last(a, "welcome")?.lag, 200);
});

test("input delay by round trip", () => {
  assert.equal(inputDelayFor(30), 2);
  assert.equal(inputDelayFor(100), 2);
  assert.equal(inputDelayFor(120), 3);
  assert.equal(inputDelayFor(150), 4);
  assert.equal(inputDelayFor(400), 6);
});

test("Radbro ids are checked: an unknown one in hello is refused, in pick ignored", () => {
  const { sock } = setup();
  const a = sock(); a.h.message(hello("9999"));
  assert.equal(last(a, "error")?.code, "bad");
  assert.ok(a.closed);
  const b = sock(); b.h.message(hello("652"));
  send(b, { t: "pick", radbro: "../x" });
  assert.equal(last(b, "lobby")?.players[0].radbro, "652");
  send(b, { t: "pick", radbro: "3171" });
  assert.equal(last(b, "lobby")?.players[0].radbro, "3171");
  send(b, { t: "pick", radbro: "retardio555" });
  assert.equal(last(b, "lobby")?.players[0].radbro, "retardio555");
  send(b, { t: "pick", radbro: "555" });
  assert.equal(last(b, "lobby")?.players[0].radbro, "retardio555", "a bare 555 is not a Retardio id");
  const c = sock(); c.h.message(hello("retardio85"));
  assert.equal(last(c, "error"), undefined);
});
