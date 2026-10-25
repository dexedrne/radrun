// Repeatable local 1v1 benchmark on the real session and room, with region-independent RTT/jitter.
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyTuningJson } from '../src/sim/tuning.ts';
import { CityIndex } from '../src/world/cityModel.ts';
import tuningJson from '../public/levels/tuning.json' with { type: 'json' };
import model from '../public/levels/city.model.json' with { type: 'json' };
import { packWord, NET_VERSION, type ServerMsg, type StartMsg } from '../src/net/wire.ts';
import type { OnlineSession as Session } from '../src/net/session.ts';
const stage = process.argv[2] ?? 'after';
const root = process.env.NET_BENCH_ROOT ?? resolve('.');
const { OnlineSession } = await import(pathToFileURL(join(root, 'src/net/session.ts')).href);
const { RoomCore } = await import(pathToFileURL(join(root, 'relay/src/room.ts')).href);
const factory = stage === 'after' ? await (await import('../relay/src/referee.ts')).loadReferee('downtown') : undefined;
const tuning = applyTuningJson(tuningJson).player, index = new CityIndex(model as any);
function run(rtt: number, jitter: number, fps: number) {
  let now = 1000000, seq = 0, random = 7;
  const rnd = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 2 ** 32; };
  const events: { at: number; seq: number; fn: () => void }[] = [];
  const later = (fn: () => void, ms: number) => events.push({ at: now + ms, seq: seq++, fn });
  const network = (fn: () => void) => later(fn, Math.max(0, rtt / 4 + (rnd() - 0.5) * jitter));
  const room = new RoomCore('K7QXM', { now: () => now, setTimeout: later, lagMs: 0, random: rnd, referee: factory });
  const frames: number[] = [];
  const peers = [0, 1].map(slot => {
    const p = { session: null as Session | null, bytes: 0, messages: 0, closed: '', slot, h: null as any };
    let upstream = 0, downstream = 0;
    const deliver = (fn: () => void, direction: 'up' | 'down') => {
      const at = Math.max(direction === 'up' ? upstream : downstream, now + Math.max(0, rtt / 4 + (rnd() - .5) * jitter));
      if (direction === 'up') upstream = at; else downstream = at;
      later(fn, at - now);
    };
    const send = (d: string | Uint8Array) => { p.bytes += d.length; p.messages++; deliver(() => p.h.message(d), 'up'); };
    const transport = { relayNow: () => now, sendBinary: send, sendJson: (m: unknown) => send(JSON.stringify(m)) };
    p.h = room.open({ send: (d: string | Uint8Array) => deliver(() => { if (typeof d !== 'string') p.session?.onBinary(d); else { const m = JSON.parse(d) as ServerMsg; if (m.t === 'start') p.session = new OnlineSession({ model, index, tuning, start: m as StartMsg, local: slot, transport }); } }, 'down'), close: (_c: number, reason: string) => { p.closed = reason; } });
    return p;
  });
  for (const p of peers) p.h.message(JSON.stringify({ t: 'hello', compat: { v: stage === 'before' ? 4 : NET_VERSION, build: 'bench', link: 6, city: 'c', tuning: 't' }, name: 'player', radbro: '652', district: 'downtown' }));
  peers[0].h.message(JSON.stringify({ t: 'config', seconds: 20 }));
  for (const p of peers) p.h.message(JSON.stringify({ t: 'ready', ready: true, rtt: rtt / 2 }));
  const start = now, end = now + 30000;
  let frame = now;
  while (now < end) {
    events.sort((a, b) => a.at - b.at || a.seq - b.seq);
    now = Math.max(now, Math.min(events[0]?.at ?? Infinity, frame, end));
    while (events.length && events[0].at <= now) { events.shift()!.fn(); events.sort((a, b) => a.at - b.at || a.seq - b.seq); }
    if (now >= frame) {
      const t0 = performance.now();
      for (const p of peers) if (p.session) {
        const s = p.session, n = s.stepsFor(1 / fps);
        for (let k = 0; k < n; k++) {
          const step = s.match.step;
          const word = packWord({ yaw: (p.slot * 512 + Math.floor(step / 40)) % 1024, fwd: 48, right: 8, pitch: 20, bits: step % 180 === 0 ? 7 : step % 180 < 100 ? 4 : 0 });
          if (!s.step(word)) break;
        }
      }
      frames.push(performance.now() - t0); frame += 1000 / fps;
    }
    if (peers.every(p => p.session?.final)) break;
  }
  if (peers.some(p => p.closed || !p.session?.final)) throw new Error('benchmark failed: ' + JSON.stringify(peers.map(p => ({ closed: p.closed, step: p.session?.match.step }))));
  if (peers[0].session!.match.hash() !== peers[1].session!.match.hash()) throw new Error('divergent clients');
  frames.sort((a, b) => a - b);
  return { peerRttMs: rtt, jitterSpanMs: jitter, renderFps: fps, durationMs: now - start, inputMessages: peers[0].session!.inputsSent, inputBytes: peers[0].bytes, inputMessagesPerSecond: +(peers[0].session!.inputsSent / 23).toFixed(2), bytesPerSecond: +(peers[0].bytes / 23).toFixed(1), rollbackP99: Math.max(...peers.map(p => p.session!.rb.depthQuantile(.99))), stalls: peers.map(p => p.session!.rb.stalls), simulationFrameP99Ms: frames[Math.floor(frames.length * .99)], hashesEqual: true, relay: room.metrics ?? null };
}
const rows = [run(0, 0, 60), run(100, 30, 60), run(200, 30, 30), run(200, 30, 15)];
await writeFile(join(homedir(), 'Documents/spidertag/review/st-polish', stage + '-net-bench.json'), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));
