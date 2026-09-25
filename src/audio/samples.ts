// Sampled audio files (public/audio/, see catalog.ts): fetched with a small concurrency limit (the
// round's models load at the same time and must not starve), decoded once the context exists, cached.
// A failed file is remembered and never retried; callers then fall back to the procedural sound.
import { engine, whenCreated, type Engine } from "./engine.ts";

const BASE = `${(import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}audio/`;
const MAX_FETCHES = 4;

type Entry = { buf: AudioBuffer | null; failed: boolean; p: Promise<AudioBuffer | null> };
const cache = new Map<string, Entry>();
const queue: (() => void)[] = [];
let inFlight = 0;

export const audioUrl = (path: string): string => BASE + path;

function ctx(): Promise<Engine> {
  const e = engine();
  return e ? Promise.resolve(e) : new Promise(r => whenCreated(r));
}

function slot(first: boolean): Promise<void> {
  if (inFlight < MAX_FETCHES) { inFlight++; return Promise.resolve(); }
  return new Promise(r => {
    const go = () => { inFlight++; r(); };
    if (first) queue.unshift(go);
    else queue.push(go);
  });
}
function release(): void {
  inFlight--;
  queue.shift()?.();
}

/** Fetch + decode `path` (relative to public/audio/) once; resolves null on any failure. `first` jumps the queue. */
export function loadSample(path: string, first = false): Promise<AudioBuffer | null> {
  const have = cache.get(path);
  if (have) return have.p;
  const entry: Entry = { buf: null, failed: false, p: Promise.resolve(null) };
  entry.p = (async () => {
    let data: ArrayBuffer;
    await slot(first);
    try {
      const res = await fetch(BASE + path);
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      data = await res.arrayBuffer();
    } catch {
      entry.failed = true;
      return null;
    } finally {
      release();
    }
    try {
      const e = await ctx();
      entry.buf = await e.ac.decodeAudioData(data);
      return entry.buf;
    } catch {
      entry.failed = true;
      return null;
    }
  })();
  cache.set(path, entry);
  return entry.p;
}

export function preloadSamples(paths: readonly string[], first = false): void {
  for (const p of paths) void loadSample(p, first);
}

/** The decoded buffer, or null (not requested, still loading, or failed). */
export function sample(path: string): AudioBuffer | null {
  return cache.get(path)?.buf ?? null;
}

/** Forget decoded files under a prefix (another Radbro's lines once the pair changes). */
export function dropSamples(prefix: string): void {
  for (const [k, v] of cache) if (k.startsWith(prefix) && (v.buf || v.failed)) cache.delete(k);
}

export function sampleStats(): { loaded: number; failed: number; pending: number } {
  let loaded = 0, failed = 0, pending = 0;
  for (const v of cache.values()) {
    if (v.buf) loaded++;
    else if (v.failed) failed++;
    else pending++;
  }
  return { loaded, failed, pending };
}

/** Play a decoded buffer into `dest` at context time `t`. */
export function playBuffer(e: Engine, buf: AudioBuffer, dest: AudioNode, t: number, gain = 1, rate = 1, offset = 0): { src: AudioBufferSourceNode; g: GainNode } {
  const src = e.ac.createBufferSource();
  src.buffer = buf;
  if (rate !== 1) src.playbackRate.value = rate;
  const g = e.ac.createGain();
  g.gain.value = gain;
  src.connect(g).connect(dest);
  src.onended = () => {
    try { g.disconnect(); } catch { /* already gone */ }
  };
  src.start(t, offset);
  return { src, g };
}
