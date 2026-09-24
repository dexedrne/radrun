// runner.pack.bin codec (spec §7 "ship the tracks, don't re-simulate them"). Layout:
//   "RRP1" | u32 header byte length | header JSON (utf8, space-padded to an even length) | Int16 samples
// Samples are 60 Hz, 5 int16 each: x, y, z (cm relative to the edge's origin junction), phase
// (0 ground / 1 air / 2 rope) and ref (roof id on the ground, hook id on the rope, -1 in the air).
// The header holds only integers (cm, steps, mm/s) so decoding is exact. Pure TS; runtime decoder +
// the encoder used by the bake. Determinism rule applies (sqrt-only maths).
import { Fnv1a, type Vec3 } from "../sim/math.ts";

export const PACK_MAGIC = "RRP1";
export const SAMPLE_HZ = 60;
export const STEP_HZ = 120;
export const SAMPLE_STRIDE = 5;
export const PHASE_GROUND = 0;
export const PHASE_AIR = 1;
export const PHASE_ROPE = 2;

export const EVT_TAKEOFF = 1;
export const EVT_ATTACH = 2;
export const EVT_RELEASE = 3;
export const EVT_LAND = 4;

export type PackJunction = { roof: number; x: number; y: number; z: number };

export type PackEdgeHeader = {
  from: number;
  to: number;
  /** Track length in 120 Hz steps (even). */
  steps: number;
  /** Offset (in int16 units) of the first sample and the sample count (steps / 2 + 1). */
  offset: number;
  count: number;
  /** [state index, type, arg] triples flattened. */
  events: number[];
  /** Position at +2 s minus start, cm. */
  exit: [number, number, number];
  /** Along-path speed, mm/s (3D path length / duration). */
  speed: number;
  /** Bake margin score x1000 (min over hops of window / threshold). */
  score: number;
  hops: number;
  roofs: number[];
};

export type PackHeader = {
  version: 1;
  city: string;
  tuning: string;
  junctions: { roof: number; x: number; y: number; z: number }[]; // cm
  edges: PackEdgeHeader[];
};

export type PackEdge = {
  index: number;
  from: number;
  to: number;
  steps: number;
  /** Seconds of baked track. */
  duration: number;
  samples: Int16Array;
  count: number;
  origin: Vec3;
  events: { step: number; type: number; arg: number }[];
  /** Unit horizontal exit direction (for branch scoring) and the raw exit vector (m). */
  exitX: number;
  exitZ: number;
  exit: Vec3;
  /** Along-path speed, m/s. */
  speed: number;
  score: number;
  roofs: number[];
};

export type Pack = {
  header: PackHeader;
  junctions: PackJunction[];
  edges: PackEdge[];
  /** Outgoing edge indices per junction. */
  out: number[][];
  hash: string;
  bytes: number;
};

export function packHash(bytes: Uint8Array): string {
  const h = new Fnv1a();
  for (let i = 0; i < bytes.length; i++) h.byte(bytes[i]);
  return h.hex();
}

export function encodePack(header: PackHeader, samples: Int16Array): Uint8Array {
  let json = JSON.stringify(header);
  const enc = new TextEncoder();
  let hb = enc.encode(json);
  while ((8 + hb.length) % 2 !== 0) { json += " "; hb = enc.encode(json); }
  const out = new Uint8Array(8 + hb.length + samples.length * 2);
  out.set(enc.encode(PACK_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, hb.length, true);
  out.set(hb, 8);
  const dv = new DataView(out.buffer, 8 + hb.length);
  for (let i = 0; i < samples.length; i++) dv.setInt16(i * 2, samples[i], true);
  return out;
}

export function decodePack(buf: ArrayBuffer | Uint8Array): Pack {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== PACK_MAGIC) throw new Error(`runner.pack.bin: bad magic ${magic}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hl = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl))) as PackHeader;
  const base = 8 + hl;
  const n = (bytes.length - base) / 2;
  const all = new Int16Array(n);
  for (let i = 0; i < n; i++) all[i] = dv.getInt16(base + i * 2, true);
  const junctions = header.junctions.map(j => ({ roof: j.roof, x: j.x / 100, y: j.y / 100, z: j.z / 100 }));
  const edges: PackEdge[] = header.edges.map((e, index) => {
    const o = junctions[e.from];
    const ex = e.exit[0] / 100, ez = e.exit[2] / 100;
    const el = Math.sqrt(ex * ex + ez * ez) || 1;
    const ev: PackEdge["events"] = [];
    for (let i = 0; i < e.events.length; i += 3) ev.push({ step: e.events[i], type: e.events[i + 1], arg: e.events[i + 2] });
    return {
      index, from: e.from, to: e.to, steps: e.steps, duration: e.steps / STEP_HZ,
      samples: all.subarray(e.offset, e.offset + e.count * SAMPLE_STRIDE), count: e.count,
      origin: { x: o.x, y: o.y, z: o.z }, events: ev,
      exitX: ex / el, exitZ: ez / el, exit: { x: ex, y: e.exit[1] / 100, z: ez },
      speed: e.speed / 1000, score: e.score / 1000, roofs: e.roofs,
    };
  });
  const out: number[][] = junctions.map(() => []);
  for (const e of edges) out[e.from].push(e.index);
  return { header, junctions, edges, out, hash: packHash(bytes), bytes: bytes.length };
}

/** A decoded pose on a track. */
export type TrackPose = { x: number; y: number; z: number; phase: number; ref: number };

/**
 * Pose at track time t (seconds of baked time), linearly interpolated between 60 Hz samples; phase/ref
 * come from the sample at or before t. Clamped to [0, duration].
 */
export function sampleEdge(e: PackEdge, t: number, out: TrackPose): TrackPose {
  const s = e.samples;
  let f = t * SAMPLE_HZ;
  const last = e.count - 1;
  if (f <= 0) f = 0;
  if (f >= last) f = last;
  let i = Math.floor(f);
  if (i >= last) i = last - 1;
  if (i < 0) i = 0;
  const a = f - i;
  const o = i * SAMPLE_STRIDE, p = o + SAMPLE_STRIDE;
  out.x = e.origin.x + (s[o] + (s[p] - s[o]) * a) / 100;
  out.y = e.origin.y + (s[o + 1] + (s[p + 1] - s[o + 1]) * a) / 100;
  out.z = e.origin.z + (s[o + 2] + (s[p + 2] - s[o + 2]) * a) / 100;
  const k = a >= 1 ? p : o;
  out.phase = s[k + 3];
  out.ref = s[k + 4];
  return out;
}

/** Events with state index in (t0, t1] seconds of baked time (lookahead windows for animation). */
export function eventsBetween(e: PackEdge, t0: number, t1: number): PackEdge["events"] {
  const a = t0 * STEP_HZ, b = t1 * STEP_HZ;
  return e.events.filter(ev => ev.step > a && ev.step <= b);
}
