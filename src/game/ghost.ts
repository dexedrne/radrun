// Ghost runs (spec §17 stretch: "a verified ghost of your best run in challenge links"): the per-step
// input record of a round, the compact link codec and the replay.
//
// The sim reads only the horizontal aim direction (pickTarget normalises aim.xz; aim.y is unused), the
// move vector and three buttons. So one step is recorded as
//   yaw          camera yaw quantised to YAW_RES steps per turn (pitch never reaches the sim),
//   fwd / right  the move input in camera space, quantised to 1/MOVE_RES (a key = MOVE_RES),
//   bits         jumpPressed, webPressed, webHeld, zipPressed (format 2),
// and the LIVE round steps with the InputFrame rebuilt from that record (buildFrame). A replay of the
// record is therefore bit-exact. buildFrame takes sin/cos from a table built with + - * / only (no
// Math.sin: trig can differ across JS engines), so a link recorded in one browser replays the same in
// another. Pure TS shared with Node; the determinism rule applies (Math.round / atan2 appear only in
// quantYaw / recFromFrame, which run on the recording side before the record exists).
import { emptyInput, type InputFrame } from "../sim/player.ts";
import { AIM_COS_TOUCH, HOLD_DELAY_EASY, MOVES_OFF, ROUND, TOUCH, type Difficulty, type Tuning } from "../sim/tuning.ts";
import type { Vec3 } from "../sim/math.ts";
import type { Round, RadbroId } from "./round.ts";

export const YAW_RES = 1024;
export const MOVE_RES = 64;
const MOVE_MAX = 127;
export const B_JUMP = 1;
export const B_WEB_PRESSED = 2;
export const B_WEB_HELD = 4;
/** Format 2 (double jump + web zip): the zip press. */
export const B_ZIP = 8;
/** Chase steps a record can hold (the 90 s clock only runs down; +1 s slack). */
export const GHOST_MAX_STEPS = ROUND.seconds * 120 + 120;
/**
 * Record format: 1 = before the double jump / web zip (bits 0-7; replayed with those moves off, so old
 * links keep verifying), 2 = with them (+ B_ZIP).
 */
export const FORMAT = 2;
const FORMAT_OLD = 1;

/** One recorded step (integers). */
export type InputRec = { yaw: number; fwd: number; right: number; bits: number };
export const emptyRec = (): InputRec => ({ yaw: 0, fwd: 0, right: 0, bits: 0 });

/**
 * What the round was created with, beyond the setup: touch (aim cone, +1 m Yoink, aim bias), easy grab,
 * and moves = false for a format-1 record (made before the double jump / web zip; missing = on).
 */
export type GhostFlags = { touch: boolean; easy: boolean; moves?: boolean };

/** A decoded ghost ready to race: the round it belongs to, the claimed time and the record. */
export type GhostSpec = {
  chaser: RadbroId;
  runner: RadbroId;
  difficulty: Difficulty;
  seed: number;
  /** Claimed catch time from the link (s), or the stored best. */
  claimed: number;
  log: GhostLog;
  flags: GhostFlags;
  /** Round 4 mutator bits the round was played with (v1 links: 0). */
  mutators?: number;
};

// ---- deterministic sin / cos table ----------------------------------------------------------------

const STEP = 6.283185307179586 / YAW_RES;
const sinPoly = (x: number): number => {
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000))))))));
};
const cosPoly = (x: number): number => {
  const x2 = x * x;
  return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200)))))));
};
export const YAW_SIN = new Float64Array(YAW_RES);
export const YAW_COS = new Float64Array(YAW_RES);
{
  const Q = YAW_RES / 4, E = YAW_RES / 8;
  for (let k = 0; k < YAW_RES; k++) {
    const q = Math.floor(k / Q), r = k - q * Q;
    let s: number, c: number;
    if (r <= E) { const a = r * STEP; s = sinPoly(a); c = cosPoly(a); } else { const a = (Q - r) * STEP; s = cosPoly(a); c = sinPoly(a); }
    YAW_SIN[k] = q === 0 ? s : q === 1 ? c : q === 2 ? -s : -c;
    YAW_COS[k] = q === 0 ? c : q === 1 ? -s : q === 2 ? -c : s;
  }
}

/** Camera yaw (rad; forward = (-sin, -cos)) -> table index. Recording side only. */
export function quantYaw(yaw: number): number {
  let q = Math.round(yaw / STEP) % YAW_RES;
  if (q < 0) q += YAW_RES;
  return q;
}

const quantMove = (v: number): number => {
  const q = Math.round(v * MOVE_RES);
  return q > MOVE_MAX ? MOVE_MAX : q < -MOVE_MAX ? -MOVE_MAX : q;
};

/** Record from the latch's camera-space move (fwd / right, keys + stick) and buttons. */
export function recFromInput(rec: InputRec, yaw: number, fwd: number, right: number, jump: boolean, webPressed: boolean, webHeld: boolean, zip = false): InputRec {
  rec.yaw = quantYaw(yaw);
  rec.fwd = quantMove(fwd);
  rec.right = quantMove(right);
  rec.bits = (jump ? B_JUMP : 0) | (webPressed ? B_WEB_PRESSED : 0) | (webHeld ? B_WEB_HELD : 0) | (zip ? B_ZIP : 0);
  return rec;
}

/** Record from a finished InputFrame (bots: world-space move, aim = yaw). Recording side only. */
export function recFromFrame(rec: InputRec, f: InputFrame): InputRec {
  const yaw = f.aimX * f.aimX + f.aimZ * f.aimZ > 1e-12 ? Math.atan2(-f.aimX, -f.aimZ) : 0;
  const q = quantYaw(yaw);
  const sy = YAW_SIN[q], cy = YAW_COS[q];
  // move = -sy*fwd + cy*right, -cy*fwd - sy*right  =>  fwd = -(mx sy + mz cy), right = mx cy - mz sy
  return recFromInput(rec, yaw, -(f.moveX * sy + f.moveZ * cy), f.moveX * cy - f.moveZ * sy, f.jumpPressed, f.webPressed, f.webHeld, f.zipPressed);
}

/**
 * The InputFrame one step consumes, rebuilt from its record. `v` = the body's velocity before the step
 * (touch play biases the aim toward where you are going, spec §4 "Touch").
 */
export function buildFrame(f: InputFrame, rec: InputRec, v: Vec3, touch: boolean, runSpeed: number): InputFrame {
  const sy = YAW_SIN[rec.yaw], cy = YAW_COS[rec.yaw];
  const fw = rec.fwd / MOVE_RES, rt = rec.right / MOVE_RES;
  let mx = -sy * fw + cy * rt, mz = -cy * fw - sy * rt;
  const ml = Math.sqrt(mx * mx + mz * mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  f.moveX = mx;
  f.moveZ = mz;
  let ax = -sy, az = -cy;
  if (touch) {
    const vl = Math.sqrt(v.x * v.x + v.z * v.z);
    if (vl > 0.5) {
      const w = TOUCH.velBias * Math.min(1, vl / runSpeed);
      const bx = ax + (w * v.x) / vl, bz = az + (w * v.z) / vl;
      const bl = Math.sqrt(bx * bx + bz * bz);
      if (bl > 1e-6) { ax = bx / bl; az = bz / bl; }
    }
  }
  f.aimX = ax;
  f.aimY = 0;
  f.aimZ = az;
  f.jumpPressed = (rec.bits & B_JUMP) !== 0;
  f.webPressed = (rec.bits & B_WEB_PRESSED) !== 0;
  f.webHeld = (rec.bits & B_WEB_HELD) !== 0;
  f.zipPressed = (rec.bits & B_ZIP) !== 0;
  return f;
}

/**
 * The player tuning a round is created with (easy grab: longer hold delay, no zip, an airborne Space
 * with a ringed balloon grabs instead of double-jumping; touch: wider aim cone; a format-1 ghost: no
 * double jump / web zip).
 */
export function roundTuning(t: Tuning, flags: GhostFlags): Tuning {
  return {
    ...t,
    holdDelay: flags.easy ? Math.max(t.holdDelay, HOLD_DELAY_EASY) : t.holdDelay,
    zip: flags.easy ? false : t.zip,
    airJumpNoRing: flags.easy ? true : t.airJumpNoRing,
    aimCos: flags.touch ? Math.min(t.aimCos, AIM_COS_TOUCH) : t.aimCos,
    ...(flags.moves === false ? MOVES_OFF : {}),
  };
}

// ---- the record ------------------------------------------------------------------------------------

/** Column store of one round's chase steps (step i = the input of chase step i + 1). */
export class GhostLog {
  n = 0;
  readonly yaw: Uint16Array;
  readonly fwd: Int8Array;
  readonly right: Int8Array;
  readonly bits: Uint8Array;
  constructor(cap = GHOST_MAX_STEPS) {
    this.yaw = new Uint16Array(cap);
    this.fwd = new Int8Array(cap);
    this.right = new Int8Array(cap);
    this.bits = new Uint8Array(cap);
  }
  push(r: InputRec): void {
    const i = this.n;
    if (i >= this.yaw.length) return;
    this.yaw[i] = r.yaw; this.fwd[i] = r.fwd; this.right[i] = r.right; this.bits[i] = r.bits;
    this.n = i + 1;
  }
  get(i: number, r: InputRec): InputRec {
    r.yaw = this.yaw[i]; r.fwd = this.fwd[i]; r.right = this.right[i]; r.bits = this.bits[i];
    return r;
  }
}

// ---- binary codec (varint RLE of per-step changes, one column at a time) -----------------------------

class Writer {
  buf = new Uint8Array(1024);
  n = 0;
  byte(b: number): void {
    if (this.n === this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
    this.buf[this.n++] = b;
  }
  uv(v: number): void {
    while (v > 127) { this.byte((v & 127) | 128); v = Math.floor(v / 128); }
    this.byte(v);
  }
  sv(v: number): void {
    this.uv(v < 0 ? -2 * v - 1 : 2 * v);
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

class Reader {
  i = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  byte(): number {
    if (this.i >= this.b.length) throw new Error("ghost: truncated");
    return this.b[this.i++];
  }
  uv(): number {
    let v = 0, mul = 1;
    for (let k = 0; k < 5; k++) {
      const b = this.byte();
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
    throw new Error("ghost: bad varint");
  }
  sv(): number {
    const u = this.uv();
    return u % 2 ? -(u + 1) / 2 : u / 2;
  }
}

type Col = Uint16Array | Int8Array | Uint8Array;

/** First value, then (run of repeats, delta) pairs; yaw deltas wrap to [-YAW_RES/2, YAW_RES/2). */
function writeCol(w: Writer, col: Col, n: number, wrap: boolean): void {
  if (n === 0) return;
  w.sv(col[0]);
  let i = 1;
  while (i < n) {
    const prev = col[i - 1];
    let run = 0;
    while (i + run < n && col[i + run] === prev) run++;
    w.uv(run);
    i += run;
    if (i >= n) break;
    let d = col[i] - prev;
    if (wrap) d = ((d % YAW_RES) + YAW_RES + YAW_RES / 2) % YAW_RES - YAW_RES / 2;
    w.sv(d);
    i++;
  }
}

function readCol(r: Reader, col: Col, n: number, wrap: boolean, lo: number, hi: number): void {
  if (n === 0) return;
  const check = (v: number) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error("ghost: value out of range");
    return v;
  };
  let v = check(r.sv());
  col[0] = v;
  let i = 1;
  while (i < n) {
    const run = r.uv();
    if (i + run > n) throw new Error("ghost: run overflows");
    col.fill(v, i, i + run);
    i += run;
    if (i >= n) break;
    v += r.sv();
    if (wrap) v = ((v % YAW_RES) + YAW_RES) % YAW_RES;
    col[i++] = check(v);
  }
}

/**
 * Uncompressed bytes: format, flags, step count, then the yaw / fwd / right / bits columns. flags.moves
 * === false writes format 1 (the zip bit must then be unused).
 */
export function encodeBytes(log: GhostLog, flags: GhostFlags): Uint8Array {
  const w = new Writer();
  w.byte(flags.moves === false ? FORMAT_OLD : FORMAT);
  w.byte((flags.touch ? 1 : 0) | (flags.easy ? 2 : 0));
  w.uv(log.n);
  writeCol(w, log.yaw, log.n, true);
  writeCol(w, log.fwd, log.n, false);
  writeCol(w, log.right, log.n, false);
  writeCol(w, log.bits, log.n, false);
  return w.bytes();
}

/** Inverse of encodeBytes; null for anything malformed. */
export function decodeBytes(b: Uint8Array): { log: GhostLog; flags: GhostFlags } | null {
  try {
    const r = new Reader(b);
    const format = r.byte();
    if (format !== FORMAT && format !== FORMAT_OLD) return null;
    const fl = r.byte();
    const n = r.uv();
    if (n < 1 || n > GHOST_MAX_STEPS) return null;
    const log = new GhostLog(n);
    log.n = n;
    readCol(r, log.yaw, n, true, 0, YAW_RES - 1);
    readCol(r, log.fwd, n, false, -MOVE_MAX, MOVE_MAX);
    readCol(r, log.right, n, false, -MOVE_MAX, MOVE_MAX);
    readCol(r, log.bits, n, false, 0, format === FORMAT ? 15 : 7);
    if (r.i !== b.length) return null;
    const flags: GhostFlags = { touch: (fl & 1) !== 0, easy: (fl & 2) !== 0 };
    if (format === FORMAT_OLD) flags.moves = false;
    return { log, flags };
  } catch {
    return null;
  }
}

// ---- link string: deflate-raw (CompressionStream) + base64url -----------------------------------------

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(t);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); throw new Error("ghost: too large"); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function toBase64Url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The `g=` string of a challenge link. */
export async function packGhost(log: GhostLog, flags: GhostFlags): Promise<string> {
  return packBytes(encodeBytes(log, flags));
}
export async function packBytes(bytes: Uint8Array): Promise<string> {
  return toBase64Url(await pipe(bytes, new CompressionStream("deflate-raw"), 1 << 20));
}

/** Inverse of packGhost; null for anything malformed (never throws). */
export async function unpackGhost(s: string): Promise<{ log: GhostLog; flags: GhostFlags } | null> {
  const z = fromBase64Url(s);
  if (!z) return null;
  try {
    return decodeBytes(await pipe(z, new DecompressionStream("deflate-raw"), 256 * 1024));
  } catch {
    return null;
  }
}

// ---- replay ----------------------------------------------------------------------------------------

/**
 * A recorded run replayed through its own Round (same seed, pair, difficulty and flags): the ghost is a
 * second, render-only player sim with its own runner and rng, so it never touches the live round.
 */
export class GhostRun {
  readonly round: Round;
  readonly log: GhostLog;
  readonly touch: boolean;
  /** The record ran out before a catch (a replay that diverged, or a truncated record). */
  ended = false;
  private readonly f = emptyInput();
  private readonly rec = emptyRec();

  constructor(round: Round, log: GhostLog, touch: boolean) {
    this.round = round;
    this.log = log;
    this.touch = touch;
  }

  get done(): boolean {
    return this.round.over || this.ended;
  }

  /** One fixed step in lockstep with the live round (countdown included). Returns false once done. */
  step(): boolean {
    const r = this.round;
    if (this.done) return false;
    if (r.phase === "chase") {
      const i = r.chaseSteps;
      if (i >= this.log.n) { this.ended = true; return false; }
      buildFrame(this.f, this.log.get(i, this.rec), r.player.v, this.touch, r.tuning.runSpeed);
    }
    r.step(this.f);
    return true;
  }

  /** Up to `n` steps (verification in slices); true once done. */
  advance(n: number): boolean {
    for (let i = 0; i < n; i++) if (!this.step()) return true;
    return this.done;
  }

  /** The replay caught him on exactly its last recorded step, at the claimed time (0.1 s link rounding). */
  verifies(claimed: number): boolean {
    const r = this.round;
    return r.phase === "caught" && r.chaseSteps === this.log.n && Math.abs(r.stats.catchTime - claimed) <= 0.051;
  }
}
