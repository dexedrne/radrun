import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quotas, validInputWord } from '../relay/src/guard.ts';
import { admit } from '../relay/src/admission.ts';
import { receiptSigner, verifyReceipt, transcriptDigest } from '../relay/src/receipt.ts';
import { loadReferee } from '../relay/src/referee.ts';
import { RoomCore } from '../relay/src/room.ts';
import { NET_VERSION, encodePing, packWord, encodeInput, decodeInput, type StartMsg, type ServerMsg } from '../src/net/wire.ts';

function harness(autoStart = true) {
  let now = 1000000;
  const events: string[] = [], timers: (() => void)[] = [];
  const room = new RoomCore('K7QXM', { now: () => now, random: () => 0.5, lagMs: 0, setTimeout: fn => timers.push(fn), log: e => events.push(e.rule), referee: factory });
  function peer() {
    const messages: ServerMsg[] = [], closed: string[] = [], binary: Uint8Array[] = [];
    const h = room.open({ send: d => { if (typeof d === 'string') messages.push(JSON.parse(d)); else binary.push(d); }, close: (_c, r) => { closed.push(r!); h.close(); } });
    const send = (m: unknown) => h.message(JSON.stringify(m));
    send({ t: 'hello', compat: { v: NET_VERSION, build: 't', link: 6, city: 'c', tuning: 't' }, name: 'player', radbro: '652', district: 'downtown' });
    return { h, send, messages, closed, binary };
  }
  const a = peer(), b = peer();
  a.send({ t: 'config', seconds: 20 }); if (autoStart) { a.send({ t: 'ready', ready: true }); b.send({ t: 'ready', ready: true }); }
  const start = a.messages.find(m => m.t === 'start') as StartMsg;
  return { room, a, b, start, events, timers, time: (n: number) => { now = n; } };
}
const factory = await loadReferee('downtown');

test('input domain rejects speed amplification, pitch overflow, reserved high bits; normal pad diagonal and fast turns pass', () => {
  const word = (fwd: number, right = 0, pitch = 0) => packWord({ yaw: 1023, fwd, right, bits: 127, pitch });
  for (const w of [word(65), word(-65), word(0, 100), word(0, 0, 101), 2 ** 41, NaN, -1, 0.5]) assert.equal(validInputWord(w), false);
  for (const w of [0, word(64, 64, 100), word(-64, -64, -100)]) assert.equal(validInputWord(w), true);
  const reserved = encodeInput({ firstStep: 3, words: [0] }); reserved[1] = 128; assert.equal(decodeInput(reserved), null);
});

test('normal 1v1 finishes against canonical movement and tag simulation; forged equal hashes fail', () => {
  for (const forged of [false, true]) {
    const h = harness(), canonical = factory(h.start);
    for (let step = 1; step <= canonical.endStep; step++) canonical.stepWords([0, 0]);
    for (let step = h.start.inputDelay + 1; step <= canonical.endStep; step += 4) {
      const words = new Array(Math.min(4, canonical.endStep - step + 1)).fill(0);
      h.time(h.start.startAtMs + (step + 4) * 1000 / 120);
      for (const p of [h.a, h.b]) p.h.message(encodeInput({ firstStep: step, words }));
    }
    h.time(h.start.startAtMs + canonical.endStep * 1000 / 120);
    for (const p of [h.a, h.b]) p.send({ t: 'end', step: canonical.endStep, hash: forged ? 123 : canonical.hash(), bag: [999, 0] });
    const result = h.a.messages.find(m => m.t === 'result');
    assert.ok(result?.t === 'result'); assert.equal(result.ok, !forged);
    assert.deepEqual(h.a.closed, []);
  }
});

test('relay rejects accelerated clock, malformed input, early results and message floods with detection events', () => {
  const speed = harness(); speed.time(speed.start.startAtMs);
  speed.a.h.message(encodeInput({ firstStep: 3, words: new Array(128).fill(0) }));
  assert.deepEqual(speed.a.closed, ['bad steps']); assert.ok(speed.events.includes('step-window'));
  const input = harness(); input.time(input.start.startAtMs);
  input.a.h.message(encodeInput({ firstStep: 3, words: [2 ** 42] }));
  assert.deepEqual(input.a.closed, ['bad input']); assert.ok(input.events.includes('invalid-input'));
  const early = harness(); early.a.send({ t: 'end', step: 999, hash: 1, bag: [] });
  assert.deepEqual(early.a.closed, ['premature result']); assert.ok(early.events.includes('premature-result'));
  const flood = harness(); for (let i = 0; i < 200; i++) flood.a.send({ t: 'ready', ready: true });
  assert.ok(flood.a.closed.includes('rate'));
});

test('network quotas refill, separate create/join and wallet buckets, fail closed at memory bound', async () => {
  const q = new Quotas(); for (let i = 0; i < 6; i++) assert.ok(q.take('create:network', 0, 6, 2));
  assert.equal(q.take('create:network', 0, 6, 2), false);
  assert.ok(q.take('join:network', 0, 16, 8)); assert.ok(q.take('create:network', 30000, 6, 2));
  for (let i = 0; i < 4094; i++) assert.ok(q.take('wallet:' + i, 30000, 1, 1));
  assert.equal(q.take('overflow', 30000, 1, 1), false); assert.ok(q.take('new', 700000, 1, 1));
  const data = new Map<string, unknown>();
  const storage = { get: async <T>(k: string) => data.get(k) as T | undefined, put: async <T>(k: string, v: T) => { data.set(k, v); } };
  for (let i = 0; i < 6; i++) assert.ok(await admit(storage, 'create', 0));
  assert.equal(await admit(storage, 'create', 0), false); assert.ok(await admit(storage, 'join', 0));
  assert.ok(await admit(storage, 'create', 30000)); assert.equal(data.size, 2);
});

test('signed canonical receipt rejects edited result, replay identity, transcript or wrong pinned key', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const b64 = (b: ArrayBuffer) => Buffer.from(b).toString('base64');
  const sign = await receiptSigner(b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
  const pub = b64(await crypto.subtle.exportKey('spki', pair.publicKey));
  const digest = await transcriptDigest([new Float64Array([0, 1]), new Float64Array([0, 2])]);
  const payload = JSON.stringify({ room: 'K7QXM', round: 1, startAtMs: 1, hash: 42, transcript: digest });
  const receipt = await sign(payload); assert.ok(await verifyReceipt(receipt, pub));
  for (const field of ['42', 'K7QXM', digest]) assert.equal(await verifyReceipt({ ...receipt, payload: payload.replace(field, 'edited') }, pub), false);
  const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  assert.equal(await verifyReceipt(receipt, b64(await crypto.subtle.exportKey('spki', other.publicKey))), false);
});


test('relay-measured probes override inflated client RTT; idle sockets expire before hello', () => {
  const h = harness(false);
  for (const p of [h.a, h.b]) p.h.message(encodePing(10));
  h.time(1000010);
  for (const p of [h.a, h.b]) {
    const probe = p.binary.find(b => b[0] === 6)!; assert.ok(probe); p.h.message(probe);
    p.send({ t: 'ready', ready: true, rtt: 2000 });
  }
  const start = h.a.messages.find(m => m.t === 'start') as StartMsg;
  assert.equal(start.inputDelay, 2, '20 ms measured beats the invented 4000 ms');
  const closed: string[] = [];
  h.room.open({ send: () => {}, close: (_c, r) => closed.push(r!) });
  for (const fn of h.timers) fn();
  assert.deepEqual(closed, ['hello timeout']); assert.deepEqual(h.a.closed, []);
});
