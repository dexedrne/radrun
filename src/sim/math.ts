// sqrt-only vector helpers, mulberry32, Irwin-Hall noise and an FNV-1a state hash.
// Determinism rule (spec §5.1): only + - * /, Math.sqrt, min/max/abs/floor in sim code. No hypot, trig,
// pow, exp or log. Everything here is allocation-free on the hot path.

export type Vec3 = { x: number; y: number; z: number };

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const set3 = (o: Vec3, x: number, y: number, z: number): Vec3 => {
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
};
export const copy3 = (o: Vec3, a: Vec3): Vec3 => {
  o.x = a.x;
  o.y = a.y;
  o.z = a.z;
  return o;
};
export const len3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);
export const len2 = (x: number, z: number): number => Math.sqrt(x * x + z * z);
export const dist3 = (a: Vec3, b: Vec3): number => len3(a.x - b.x, a.y - b.y, a.z - b.z);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Mulberry32 PRNG: returns a function producing uniforms in [0, 1). The only randomness in sim code. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Irwin-Hall approximation of N(0,1): sum of 12 uniforms minus 6. */
export function irwinHall(rand: () => number): number {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rand();
  return s - 6;
}

// ---- FNV-1a over float64 / int32 values ------------------------------------------------------------
const f64 = new Float64Array(1);
const u8 = new Uint8Array(f64.buffer);

export class Fnv1a {
  h = 0x811c9dc5;
  byte(b: number): this {
    this.h ^= b & 0xff;
    this.h = Math.imul(this.h, 0x01000193) >>> 0;
    return this;
  }
  f64(v: number): this {
    f64[0] = v === 0 ? 0 : v; // fold -0 into +0
    for (let i = 0; i < 8; i++) this.byte(u8[i]);
    return this;
  }
  i32(v: number): this {
    const x = v | 0;
    this.byte(x).byte(x >>> 8).byte(x >>> 16).byte(x >>> 24);
    return this;
  }
  str(s: string): this {
    for (let i = 0; i < s.length; i++) this.i32(s.charCodeAt(i));
    return this;
  }
  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, "0");
  }
}

/** mulberry32 with visible state (hashable / restorable); same sequence as mulberry32(seed). */
export class Rand {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Irwin-Hall N(0,1) approximation: 12 uniforms - 6. */
  gauss(): number {
    let s = 0;
    for (let i = 0; i < 12; i++) s += this.next();
    return s - 6;
  }
}

/** Integer hash of four ints -> [0, 1) (murmur3 fmix32; no floats until the final scale). */
export function hash01(a: number, b: number, c: number, d: number): number {
  let h = (a | 0) ^ Math.imul(b | 0, 0x9e3779b1) ^ Math.imul(c | 0, 0x85ebca77) ^ Math.imul(d | 0, 0xc2b2ae3d);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
