// One wager round on the relay (docs/WAGER.md §5.1, §5.3): the input pipeline and the referee's canonical match.
//
//  - Sealed release. Step s of either slot is released (to the other client, and to the referee) only once BOTH
//    slots' step-s words are in, received or filled: nobody ever sees the opponent's step-s input before their own
//    step-s input is committed.
//  - Deadlines on the relay clock. The word for step s from slot k must arrive by
//    startAtMs + s x 8.333 ms + late[k] (late = lateMs + min(one-way, maxOneWayAllowMs), from relay-measured round
//    trips only). A missed deadline is filled with predictWord(the slot's previous word): held keys stay, presses drop.
//    A word for a filled step is dropped and counted; an INPUT overlapping filled steps is taken from the first
//    unfilled step.
//  - The referee. As steps are sealed the canonical TagMatch steps along (2-8 µs a step), so the result exists at the
//    horn with no burst of work. Its buffers are exactly the words the match consumed: that is the round's log.
//  - Evidence for the flags (flags.ts): Yoink reaction times, aim error at Yoink / yank presses and while chasing,
//    web-press intervals, arrival slack and fills. Aim is measured against what the player's own client showed when it
//    sampled the word, not the canonical state: the relay knows which opponent steps it had released to that client by
//    then, so it rebuilds the client's predicted view from a snapshot (a few steps of re-simulation per sample). An
//    aimbot aims exactly at its own view; over a network the canonical error would hide it.
import { PH_PLAY, TAG_KIND_YOINK, TV_TAG, type TagMatch, type TagSnap } from "../../../src/game/tagMatch.ts";
import { RING_RUNNER, chaseDist } from "../../../src/sim/player.ts";
import { quantYaw } from "../../../src/game/ghost.ts";
import { predictWord } from "../../../src/net/wire.ts";
import { roundMatch, roundResult, type SimAssets } from "../../../src/wager/replay.ts";
import { wordsToBase64, type RoundLog, type RoundResult } from "../../../src/wager/log.ts";
import { FLAG_LIMITS, type SideMetrics } from "./flags.ts";

export const STEP_MS = 1000 / 120;
/** Words are 41-bit (net/wire.ts); anything above is dropped so the log stays canonical. */
const WORD_MOD = 2 ** 41;
const LO = 4294967296;
const B_WEB_PRESSED = 2;

export const W_NONE = 0;
export const W_RECV = 1;
export const W_FILL = 2;

/** A contiguous stretch of one slot's words of one kind (received words, or a fill run of one repeated word). */
export type Run = { slot: number; first: number; words: number[]; filled: boolean };

export type RoundSetup = {
  assets: SimAssets;
  round: number;
  seed: number;
  slotOfA: 0 | 1;
  roundSeconds: number;
  /** Roster Radbro per sim slot (cosmetic: the sim never reads it). */
  radbros: [string, string];
  inputDelay: number;
  startAtMs: number;
  /** Deadline slack per sim slot (ms). */
  late: [number, number];
  aheadSteps: number;
  /** Relay-measured one-way latency per sim slot (ms): for rebuilding what each client saw. */
  oneWay?: [number, number];
};

/** Snapshots kept for rebuilding a client's view (steps). */
const VIEW_RING = 128;
/** A client samples a word up to this long before it sends it (the session batches INPUTs: 25-40 ms). */
const VIEW_BATCH_MS = 45;
/** Chase-tracking samples: every this many steps. */
const TRACK_EVERY = 2;

type Evidence = { reactions: number[]; aimErr: number[]; intervals: number[]; slackMs: number[]; track: number[] };
/** Tracking-error histogram bins (yaw units; the last bin holds everything wider). */
export const TRACK_BINS = 64;

export class RoundReferee {
  readonly round: number;
  readonly seed: number;
  readonly slotOfA: 0 | 1;
  readonly inputDelay: number;
  readonly startAtMs: number;
  readonly late: [number, number];
  readonly endStep: number;
  readonly match: TagMatch;
  /** Index s = step s (index 0 is the empty word before step 1). */
  readonly words: [Float64Array, Float64Array];
  readonly kind: [Uint8Array, Uint8Array];
  /** Per slot: every step up to this one is known (received or filled). */
  readonly have: [number, number];
  /** Per slot: the highest step with any word (received out of order included). */
  readonly top: [number, number];
  /** Both slots are known up to here; the referee's match is at this step. */
  sealedTo = 0;
  readonly fills: [number, number] = [0, 0];
  /** Fills while the player was connected (a dropped player's fills are the disconnect, not lateness). */
  readonly fillsOnline: [number, number] = [0, 0];
  readonly lateDrops: [number, number] = [0, 0];
  readonly bad: [number, number] = [0, 0];
  /** The referee's state hash every 60 sealed steps (to place a client's first divergence). */
  readonly hashes = new Map<number, number>();
  private readonly aheadSteps: number;
  private readonly ev: [Evidence, Evidence] = [
    { reactions: [], aimErr: [], intervals: [], slackMs: [], track: new Array(TRACK_BINS).fill(0) },
    { reactions: [], aimErr: [], intervals: [], slackMs: [], track: new Array(TRACK_BINS).fill(0) },
  ];
  private readonly redSince: [number, number] = [-1, -1];
  private readonly lastPress: [number, number] = [-1, -1];
  private readonly pair = [0, 0];
  private readonly vpair = [0, 0];
  /** Relay ms each received word arrived (0 = filled, or inside the input delay). */
  private readonly arrived: [Float64Array, Float64Array];
  /** Relay ms each step was sealed, i.e. released to both clients (non-decreasing). */
  private readonly sealedAt: Float64Array;
  private readonly oneWay: [number, number];
  private readonly snaps: TagSnap[];
  private readonly snapStep: Int32Array;
  private view: TagMatch | null = null;
  private readonly setup: RoundSetup;
  /** CPU spent stepping the canonical match (ms) and steps stepped, for the measurements. */
  simMs = 0;
  simSteps = 0;

  constructor(o: RoundSetup) {
    this.round = o.round;
    this.seed = o.seed >>> 0;
    this.slotOfA = o.slotOfA;
    this.inputDelay = o.inputDelay;
    this.startAtMs = o.startAtMs;
    this.late = o.late;
    this.aheadSteps = o.aheadSteps;
    this.match = roundMatch(o.assets, this.seed, o.roundSeconds, o.radbros);
    this.endStep = this.match.endStep;
    const n = this.endStep + 1;
    this.words = [new Float64Array(n), new Float64Array(n)];
    this.kind = [new Uint8Array(n), new Uint8Array(n)];
    // Steps 1..inputDelay are the empty word for both slots (net/rollback.ts): known from the start.
    for (let s = 1; s <= Math.min(this.inputDelay, this.endStep); s++) this.kind[0][s] = this.kind[1][s] = W_RECV;
    this.have = [Math.min(this.inputDelay, this.endStep), Math.min(this.inputDelay, this.endStep)];
    this.top = [this.have[0], this.have[1]];
    this.setup = o;
    this.oneWay = o.oneWay ?? [0, 0];
    this.arrived = [new Float64Array(n), new Float64Array(n)];
    this.sealedAt = new Float64Array(n);
    this.snaps = Array.from({ length: VIEW_RING }, () => this.match.newSnap());
    this.snapStep = new Int32Array(VIEW_RING).fill(-1);
  }

  /** The relay-clock deadline (ms) of step s for a slot. */
  deadline(slot: number, s: number): number {
    return this.startAtMs + s * STEP_MS + this.late[slot];
  }

  /** The step the relay clock is at. */
  relayStep(now: number): number {
    return Math.floor((now - this.startAtMs) / STEP_MS);
  }

  get over(): boolean {
    return this.sealedTo >= this.endStep;
  }

  /** Words from a client for steps firstStep.. (the socket's slot, stamped by the relay). */
  receive(slot: number, firstStep: number, words: ArrayLike<number>, now: number): { taken: number; late: number; bad: number } {
    const K = this.kind[slot], W = this.words[slot], ev = this.ev[slot];
    const limit = Math.min(this.endStep, this.relayStep(now) + this.aheadSteps);
    let taken = 0, late = 0, bad = 0;
    for (let i = 0; i < words.length; i++) {
      const s = firstStep + i;
      if (s < 1 || s > limit) { bad++; continue; }
      const k = K[s];
      if (k === W_FILL) { late++; continue; }
      if (k === W_RECV) continue; // a repeat (or the empty steps inside the input delay)
      const w = words[i];
      W[s] = Number.isInteger(w) && w >= 0 ? w % WORD_MOD : 0;
      K[s] = W_RECV;
      this.arrived[slot][s] = now;
      ev.slackMs.push(this.deadline(slot, s) - now);
      if (s > this.top[slot]) this.top[slot] = s;
      taken++;
    }
    this.lateDrops[slot] += late;
    this.bad[slot] += bad;
    this.extend(slot);
    return { taken, late, bad };
  }

  private extend(slot: number): void {
    const K = this.kind[slot];
    let h = this.have[slot];
    while (h < this.endStep && K[h + 1] !== W_NONE) h++;
    this.have[slot] = h;
  }

  /**
   * Fill every step whose deadline has passed and whose word is missing. `online[slot]` = the player is connected
   * (for the late-inputs evidence). Returns the fill runs made, per slot.
   */
  fillDue(now: number, online: [boolean, boolean]): Run[] {
    const out: Run[] = [];
    for (let slot = 0; slot < 2; slot++) {
      const K = this.kind[slot], W = this.words[slot];
      let run: Run | null = null;
      for (;;) {
        this.extend(slot);
        const s = this.have[slot] + 1;
        if (s > this.endStep || this.deadline(slot, s) > now) break;
        const w = predictWord(W[s - 1]);
        W[s] = w;
        K[s] = W_FILL;
        this.fills[slot]++;
        if (online[slot]) this.fillsOnline[slot]++;
        if (s > this.top[slot]) this.top[slot] = s;
        this.have[slot] = s;
        if (run && run.first + run.words.length === s && run.words[0] === w) run.words.push(w);
        else { run = { slot, first: s, words: [w], filled: true }; out.push(run); }
      }
    }
    return out;
  }

  /** Release every step both slots now have, stepping the referee's match. Returns the new sealed range or null. */
  seal(now = 0): { from: number; to: number } | null {
    const from = this.sealedTo + 1;
    const [K0, K1] = this.kind;
    const t0 = performance.now();
    while (this.sealedTo < this.endStep && K0[this.sealedTo + 1] !== W_NONE && K1[this.sealedTo + 1] !== W_NONE) {
      this.sealedAt[this.sealedTo + 1] = now;
      this.stepOne(this.sealedTo + 1);
    }
    if (this.sealedTo < from) return null;
    this.simMs += performance.now() - t0;
    this.simSteps += this.sealedTo - from + 1;
    return { from, to: this.sealedTo };
  }

  private stepOne(s: number): void {
    const m = this.match, pair = this.pair;
    pair[0] = this.words[0][s];
    pair[1] = this.words[1][s];
    // Pre-step: the holder, his target and their positions, and whose ring was already red.
    const h = m.holder, tgt = m.target[h];
    const hp = m.bodies[h].p;
    const hx = hp.x, hz = hp.z;
    const tx = tgt >= 0 ? m.bodies[tgt].p.x : 0, tz = tgt >= 0 ? m.bodies[tgt].p.z : 0;
    const wasYank = m.bodies[h].yankOn;
    const red0 = m.bodies[0].ringId === RING_RUNNER, red1 = m.bodies[1].ringId === RING_RUNNER;
    // The state before this step, for rebuilding views later.
    const k = (s - 1) % VIEW_RING;
    m.save(this.snaps[k]);
    this.snapStep[k] = s - 1;
    // Tracking: while the holder chases his target within reach (free to move), how exactly does he aim at it?
    if (tgt >= 0 && m.phase === PH_PLAY && m.freeze[h] === 0 && m.lock[h] === 0 && s % TRACK_EVERY === 0 && chaseDist(hp, m.bodies[tgt].p) <= FLAG_LIMITS.trackRange) {
      const e = this.viewAim(h, s);
      if (e !== null) this.ev[h].track[Math.min(TRACK_BINS - 1, Math.round(e))]++;
    }
    m.stepWords(pair);
    this.sealedTo = s;
    if (s % 60 === 0) this.hashes.set(s, m.hash() >>> 0);
    // Web presses (every slot): intervals for the periodicity check.
    const prevPress = [this.lastPress[0], this.lastPress[1]];
    for (let i = 0; i < 2; i++) {
      const lo = pair[i] % LO;
      if (((lo >>> 26) & B_WEB_PRESSED) !== 0) {
        if (this.lastPress[i] > 0) this.ev[i].intervals.push(s - this.lastPress[i]);
        this.lastPress[i] = s;
      }
    }
    // A Yoink by the holder: reaction from the ring turning red, and the aim error of the press.
    if ((m.events & TV_TAG) !== 0 && m.lastTagKind === TAG_KIND_YOINK && m.lastTagFrom === h && m.lastTagStep === s && tgt >= 0) {
      const wasRed = h === 0 ? red0 : red1;
      const react = wasRed && this.redSince[h] >= 0 ? s - this.redSince[h] : 0;
      const spam = prevPress[h] > 0 && s - prevPress[h] <= FLAG_LIMITS.reactionSpamSteps;
      if (!spam) this.ev[h].reactions.push(react);
      this.ev[h].aimErr.push(this.viewAim(h, s) ?? yawError(pair[h], hx, hz, tx, tz));
    } else if (!wasYank && m.bodies[h].yankOn && tgt >= 0) {
      this.ev[h].aimErr.push(this.viewAim(h, s) ?? yawError(pair[h], hx, hz, tx, tz));
    }
    // Red-ring streaks (post-step ring, what the player sees next).
    for (let i = 0; i < 2; i++) {
      const red = m.bodies[i].ringId === RING_RUNNER;
      if (!red) this.redSince[i] = -1;
      else if (this.redSince[i] < 0) this.redSince[i] = s;
    }
  }

  /** The last step sealed (released to the clients) at or before relay time t. */
  private releasedBy(t: number): number {
    let lo = 0, hi = this.sealedTo;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.sealedAt[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /**
   * The yaw error of slot k's word for step s against the opponent's bearing in k's own view: the client sampled
   * that word at its step s - inputDelay - 1, holding the opponent's words up to the step the relay had released to it
   * by then (known up to the batching and one-way latency, so a few candidates are tried and the smallest error
   * kept) and predicting the rest (net/rollback.ts: the last word with its presses cleared). null = no view to rebuild.
   */
  viewAim(k: number, s: number): number | null {
    const T = this.arrived[k][s];
    const t0 = s - this.inputDelay - 1;
    if (!(T > 0) || t0 < 1) return null;
    const o = 1 - k, w = this.words[k][s];
    const hi = T - 2 * this.oneWay[k];
    const cHi = Math.min(t0, this.releasedBy(hi)), cLo = Math.min(t0, this.releasedBy(hi - VIEW_BATCH_MS));
    let best = Infinity, last = -1;
    for (let i = 0; i < 3; i++) {
      const c = cLo + Math.round(((cHi - cLo) * i) / 2);
      if (c === last) continue;
      last = c;
      if (c < 0 || this.snapStep[c % VIEW_RING] !== c) continue;
      const v = (this.view ??= roundMatch(this.setup.assets, this.seed, this.setup.roundSeconds, this.setup.radbros));
      v.load(this.snaps[c % VIEW_RING]);
      const vp = this.vpair, pw = predictWord(this.words[o][c]);
      for (let x = c + 1; x <= t0; x++) {
        vp[k] = this.words[k][x];
        vp[o] = pw;
        v.stepWords(vp);
      }
      const e = yawError(w, v.bodies[k].p.x, v.bodies[k].p.z, v.bodies[o].p.x, v.bodies[o].p.z);
      if (e < best) best = e;
    }
    return best === Infinity ? null : best;
  }

  /** Runs of one slot's words over steps from..to, received and filled separately (chunked to maxWords). */
  runs(slot: number, from: number, to: number, maxWords = 128): Run[] {
    const out: Run[] = [];
    const K = this.kind[slot], W = this.words[slot];
    let cur: Run | null = null;
    for (let s = Math.max(from, this.inputDelay + 1); s <= Math.min(to, this.endStep); s++) {
      const k = K[s];
      if (k === W_NONE) { cur = null; continue; }
      const filled = k === W_FILL, w = W[s];
      const fits = cur && cur.filled === filled && cur.first + cur.words.length === s && cur.words.length < (filled ? 65_535 : maxWords) && (!filled || cur.words[0] === w);
      if (fits) cur!.words.push(w);
      else { cur = { slot, first: s, words: [w], filled }; out.push(cur); }
    }
    return out;
  }

  /** The finished round's result per player (index = side). */
  result(): RoundResult {
    return roundResult(this.match, this.slotOfA);
  }

  /** The round as logged: the words the referee consumed, steps 1..lastStep (the horn, or where it was cut short). */
  toLog(result: RoundResult | null): RoundLog {
    const last = this.sealedTo;
    return {
      round: this.round, seed: this.seed, slotOfA: this.slotOfA, inputDelay: this.inputDelay, endStep: this.endStep, lastStep: last,
      words: [wordsToBase64(this.words[0].subarray(1, last + 1)), wordsToBase64(this.words[1].subarray(1, last + 1))],
      result, fills: [this.fills[0], this.fills[1]],
    };
  }

  /** Add this round's evidence to a player's series metrics (slot -> side through slotOfA). */
  addEvidence(side: 0 | 1, m: SideMetrics, rtt: number): void {
    const slot = side === 0 ? this.slotOfA : 1 - this.slotOfA;
    const e = this.ev[slot];
    m.reactions.push(...e.reactions);
    m.aimErr.push(...e.aimErr);
    m.intervals.push(...e.intervals);
    for (let i = 0; i < TRACK_BINS; i++) m.track[i] = (m.track[i] ?? 0) + e.track[i];
    // Arrival slack is kept as a bounded sample (the median is what counts).
    for (const x of e.slackMs) { if (m.slackMs.length < 20_000) m.slackMs.push(Math.round(x * 10) / 10); }
    m.fills += this.fillsOnline[slot];
    m.steps += Math.max(0, this.sealedTo - this.inputDelay);
    if (rtt < m.rtt) m.rtt = rtt;
  }
}

/** Circular yaw error (1024 units a turn) of a word's aim against the exact bearing from (hx, hz) to (tx, tz). */
export function yawError(word: number, hx: number, hz: number, tx: number, tz: number): number {
  const yaw = (word % LO) & 0x3ff;
  const dx = tx - hx, dz = tz - hz;
  if (dx * dx + dz * dz < 1e-9) return 0;
  const want = quantYaw(Math.atan2(-dx, -dz));
  const d = Math.abs(yaw - want) % 1024;
  return Math.min(d, 1024 - d);
}
