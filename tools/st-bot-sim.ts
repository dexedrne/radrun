// Local-only abuse probe: no wallet, transactions, or remote services.
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { verifyReceipt } from '../relay/src/receipt.ts';
import { loadReferee } from '../relay/src/referee.ts';
import { NET_VERSION, encodeInput, encodePing, decodePong, packWord, type ServerMsg, type StartMsg } from '../src/net/wire.ts';
const base = process.env.RELAY_PROBE_URL ?? 'http://127.0.0.1:6009';
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'local relay only');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => boolean) { const end = Date.now() + 35000; while (!f()) { assert.ok(Date.now() < end, 'relay timeout'); await pause(10); } }
async function pair() {
  const response = await fetch(base + '/room', { method: 'POST' }); assert.equal(response.status, 200);
  const { code } = await response.json() as { code: string };
  const peers = [0, 1].map(slot => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws?room=' + code); ws.binaryType = 'arraybuffer';
    const p = { ws, slot, messages: [] as ServerMsg[], closed: '', bytesIn: 0, bytesOut: 0, sent: 0, rtt: [] as number[] };
    ws.addEventListener('message', e => {
      if (typeof e.data === 'string') { p.bytesIn += e.data.length; p.messages.push(JSON.parse(e.data)); }
      else { const b = new Uint8Array(e.data); p.bytesIn += b.length; const pong = decodePong(b); if (pong) p.rtt.push((Math.floor(performance.now()) >>> 0) - pong.clientMs); if (b[0] === 6) ws.send(b); }
    });
    ws.addEventListener('close', e => { p.closed = e.reason || String(e.code); });
    return p;
  });
  const send = (p: typeof peers[number], data: string | Uint8Array) => { p.sent++; p.bytesOut += data.length; p.ws.send(data as string); };
  const json = (p: typeof peers[number], m: unknown) => send(p, JSON.stringify(m));
  for (const p of peers) { await until(() => p.ws.readyState === WebSocket.OPEN); json(p, { t: 'hello', name: 'practice' + p.slot, radbro: '652', district: 'downtown', compat: { v: NET_VERSION, build: 'probe', link: 6, city: 'c', tuning: 't' } }); await until(() => p.messages.some(m => m.t === 'welcome')); }
  json(peers[0], { t: 'config', seconds: 20 }); for (const p of peers) json(p, { t: 'ready', ready: true });
  await until(() => peers.every(p => p.messages.some(m => m.t === 'start')));
  return { peers, send, json, start: peers[0].messages.find(m => m.t === 'start') as StartMsg, close: () => peers.forEach(p => p.ws.close()) };
}
const rejected: string[] = [];
for (const attack of ['speed', 'clock', 'result']) {
  const h = await pair(); await pause(Math.max(0, h.start.startAtMs - Date.now()));
  if (attack === 'speed') h.send(h.peers[0], encodeInput({ firstStep: h.start.inputDelay + 1, words: [packWord({ yaw: 0, fwd: 127, right: 0, pitch: 0, bits: 0 })] }));
  if (attack === 'clock') h.send(h.peers[0], encodeInput({ firstStep: h.start.inputDelay + 1, words: new Array(128).fill(0) }));
  if (attack === 'result') h.json(h.peers[0], { t: 'end', step: 2760, hash: 1, bag: [0, 0] });
  await until(() => !!h.peers[0].closed); rejected.push(attack + ': ' + h.peers[0].closed); h.close();
}
const h = await pair(), factory = await loadReferee('downtown'), canonical = factory(h.start);
const words: [number[], number[]] = [[], []];
for (let step = 1; step <= canonical.endStep; step++) {
  const pair = [0, 1].map(slot => step <= h.start.inputDelay ? 0 : packWord({ yaw: (slot * 512 + Math.floor(step / 24)) % 1024, fwd: 48, right: 8, pitch: 25, bits: (step % 170 === 0 ? 1 : 0) | (step % 240 === 0 ? 6 : step % 240 < 100 ? 4 : 0) }));
  words[0].push(pair[0]); words[1].push(pair[1]); canonical.stepWords(pair);
}
let next = h.start.inputDelay + 1, lastPing = 0;
const t0 = performance.now();
while (next <= canonical.endStep) {
  const elapsed = Date.now() - h.start.startAtMs;
  const to = Math.min(canonical.endStep, Math.floor(elapsed * 120 / 1000));
  if (to >= next + 5 || to === canonical.endStep) {
    const last = Math.min(to, next + 127);
    for (const p of h.peers) h.send(p, encodeInput({ firstStep: next, words: words[p.slot].slice(next - 1, last) }));
    next = last + 1;
  }
  if (elapsed - lastPing >= 500) { lastPing = elapsed; for (const p of h.peers) h.send(p, encodePing(Math.floor(performance.now()) >>> 0)); }
  assert.ok(h.peers.every(p => !p.closed), 'normal play accepted'); await pause(5);
}
for (const p of h.peers) h.json(p, { t: 'end', step: canonical.endStep, hash: canonical.hash(), bag: [...canonical.bag] });
await until(() => h.peers.every(p => p.messages.some(m => m.t === 'result')));
for (const p of h.peers) assert.ok(p.messages.some(m => m.t === 'result' && m.ok));
const pinnedKey = await readFile(join(homedir(), 'Documents/spidertag/review/st-polish/dev-receipt-public-key.txt'), 'utf8').catch(() => '');
let receiptsVerified = false;
if (pinnedKey) {
  for (const p of h.peers) {
    const result = p.messages.find(m => m.t === 'result');
    assert.ok(result?.t === 'result' && result.receipt, 'configured relay issues receipts');
    assert.ok(await verifyReceipt(result.receipt, pinnedKey.trim()));
    assert.equal(await verifyReceipt({ ...result.receipt, payload: result.receipt.payload.replace('"round":1', '"round":2') }, pinnedKey.trim()), false);
  }
  receiptsVerified = true;
}
const result = { rejected, receiptsVerified, normalAccepted: true, durationMs: performance.now() - t0, peers: h.peers.map(p => ({ sent: p.sent, bytesOut: p.bytesOut, bytesIn: p.bytesIn, rtt: p.rtt, result: p.messages.find(m => m.t === 'result') })) };
h.close();
await writeFile(join(homedir(), 'Documents/spidertag/review/st-polish/bot-simulation.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
