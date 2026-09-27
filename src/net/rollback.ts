// Prediction + rollback (multiplayer design §3.4) over a TagMatch. Pure TS, no timers, no sockets: the session feeds it the
// local word each step and the other players' words as they arrive; it keeps the match at the newest step,
// predicting missing inputs (the last confirmed word, press bits cleared) and, when a confirmed word differs from
// what a step used, restoring the snapshot before that step and re-simulating up to the present.
//
// Steps are numbered like TagMatch.step: the words for step s are consumed going from step s-1 to s. Steps
// 1..inputDelay use the empty word for every slot (every peer agrees without sending them), so the local input
// sampled while the match is at step k is for step k + inputDelay + 1.
import { predictWord } from "./wire.ts";
import type { TagMatch, TagSnap } from "../game/tagMatch.ts";

export type RollbackOptions = {
  /** Steps of local input delay (0-12; multiplayer design §7 `net.inputDelay`). */
  inputDelay?: number;
  /** Never predict further ahead than this many steps past the oldest missing input (stall instead). */
  maxRollback?: number;
  /** Hash the match every this many steps (0 = never; the relay compares confirmed hashes). */
  hashEvery?: number;
};

export const NET_DEFAULTS = { inputDelay: 2, maxRollback: 24, hashEvery: 60 } as const;
/** Ring size (steps) of the input and snapshot rings: more than maxRollback + the input delay + early arrivals. */
const RING = 256;

export class Rollback {
  readonly match: TagMatch;
  readonly n: number;
  readonly local: number;
  readonly inputDelay: number;
  readonly maxRollback: number;
  readonly hashEvery: number;
  /** Per slot: the last step whose input is confirmed with no gap before it. */
  readonly confirmedTo: Int32Array;
  /** The step the next local word goes to. */
  nextLocal: number;
  /** Last step whose events went out (a re-simulated step never replays its sounds / animation events). */
  deliveredStep = 0;
  /** Called after every new (not re-simulated) step. */
  onFresh: ((step: number) => void) | null = null;

  // ---- stats ----
  rollbacks = 0;
  resimSteps = 0;
  maxDepth = 0;
  stalls = 0;
  /** depthHist[d] = rollbacks of depth d (the last bucket counts everything deeper). */
  readonly depthHist = new Int32Array(65);

  private readonly words: Float64Array[];
  private readonly have: Int32Array[];
  private readonly used: Float64Array[];
  private readonly usedStep: Int32Array[];
  private readonly lastWord: Float64Array;
  private readonly snaps: TagSnap[];
  private readonly snapStep: Int32Array;
  private readonly wbuf: number[];
  private rewindTo = Infinity;
  private readonly hashStep: Int32Array;
  private readonly hashVal: Uint32Array;
  private hashReported = 0;

  constructor(match: TagMatch, local: number, o: RollbackOptions = {}) {
    if (match.step !== 0) throw new Error("Rollback needs a fresh match (step 0)");
    this.match = match;
    this.n = match.n;
    this.local = local;
    this.inputDelay = o.inputDelay ?? NET_DEFAULTS.inputDelay;
    this.maxRollback = Math.min(o.maxRollback ?? NET_DEFAULTS.maxRollback, RING - 32);
    this.hashEvery = o.hashEvery ?? NET_DEFAULTS.hashEvery;
    const n = this.n;
    this.words = Array.from({ length: n }, () => new Float64Array(RING));
    this.have = Array.from({ length: n }, () => new Int32Array(RING).fill(-1));
    this.used = Array.from({ length: n }, () => new Float64Array(RING));
    this.usedStep = Array.from({ length: n }, () => new Int32Array(RING).fill(-1));
    this.lastWord = new Float64Array(n);
    this.confirmedTo = new Int32Array(n).fill(this.inputDelay);
    this.snaps = Array.from({ length: RING }, () => match.newSnap());
    this.snapStep = new Int32Array(RING).fill(-1);
    this.wbuf = new Array(n).fill(0);
    this.hashStep = new Int32Array(64).fill(-1);
    this.hashVal = new Uint32Array(64);
    this.nextLocal = this.inputDelay + 1;
    for (let s = 1; s <= this.inputDelay; s++) for (let i = 0; i < n; i++) { this.words[i][s % RING] = 0; this.have[i][s % RING] = s; }
  }

  /** The newest step every slot's input is confirmed for (the state up to it is final once any rewind ran). */
  get confirmed(): number {
    let c = Infinity;
    for (let i = 0; i < this.n; i++) if (this.confirmedTo[i] < c) c = this.confirmedTo[i];
    return c;
  }

  /** The match is over and every input up to the horn is confirmed and applied: its result is final. */
  get final(): boolean {
    return this.match.over && this.confirmed >= this.match.endStep && this.rewindTo === Infinity;
  }

  /** Queue the local slot's word (for step nextLocal); returns that step. */
  addLocal(word: number): number {
    const s = this.nextLocal++;
    this.confirm(this.local, s, word);
    return s;
  }

  /** Words from another slot (or the relay's fill) for steps firstStep, firstStep + 1, ... */
  receive(slot: number, firstStep: number, words: ArrayLike<number>): void {
    for (let k = 0; k < words.length; k++) this.confirm(slot, firstStep + k, words[k]);
  }

  private confirm(slot: number, s: number, w: number): void {
    if (s <= this.confirmedTo[slot] && this.have[slot][s % RING] === s) return; // a repeat
    if (s <= this.match.step - RING + 32) throw new Error(`input for step ${s} (slot ${slot}) is older than the rollback window`);
    if (s >= this.match.step + RING - 32) throw new Error(`input for step ${s} (slot ${slot}) is too far ahead`);
    const k = s % RING;
    this.words[slot][k] = w;
    this.have[slot][k] = s;
    if (s <= this.match.step && (this.usedStep[slot][k] !== s || this.used[slot][k] !== w) && s < this.rewindTo) this.rewindTo = s;
    let c = this.confirmedTo[slot];
    while (this.have[slot][(c + 1) % RING] === c + 1) c++;
    if (c !== this.confirmedTo[slot]) { this.confirmedTo[slot] = c; this.lastWord[slot] = this.words[slot][c % RING]; }
  }

  /**
   * Apply any pending rollback, then simulate one new step. False when there is nothing to step (the horn) or when
   * it would predict further than maxRollback past the oldest missing input (a stall).
   */
  advance(): boolean {
    this.catchUp();
    const m = this.match;
    if (m.step >= m.endStep) return false;
    const s = m.step + 1;
    if (s - this.confirmed > this.maxRollback) { this.stalls++; return false; }
    this.simulate(s);
    return true;
  }

  /** Re-simulate from the oldest step whose input changed (a no-op when nothing did). */
  catchUp(): void {
    const m = this.match;
    if (this.rewindTo > m.step) { this.rewindTo = Infinity; return; }
    const from = this.rewindTo, to = m.step;
    this.rewindTo = Infinity;
    const k = (from - 1) % RING;
    if (this.snapStep[k] !== from - 1) throw new Error(`no snapshot for step ${from - 1} (rollback of ${to - from + 1} steps)`);
    m.load(this.snaps[k]);
    const depth = to - from + 1;
    this.rollbacks++;
    this.resimSteps += depth;
    if (depth > this.maxDepth) this.maxDepth = depth;
    this.depthHist[Math.min(depth, this.depthHist.length - 1)]++;
    for (let s = from; s <= to; s++) this.simulate(s);
  }

  private simulate(s: number): void {
    const m = this.match, k = s % RING, prev = (s - 1) % RING;
    m.save(this.snaps[prev]);
    this.snapStep[prev] = s - 1;
    for (let i = 0; i < this.n; i++) {
      const w = this.have[i][k] === s ? this.words[i][k] : predictWord(this.lastWord[i]);
      this.wbuf[i] = w;
      this.used[i][k] = w;
      this.usedStep[i][k] = s;
    }
    m.stepWords(this.wbuf);
    if (this.hashEvery > 0 && s % this.hashEvery === 0) {
      const h = (s / this.hashEvery) & 63;
      this.hashStep[h] = s;
      this.hashVal[h] = m.hash();
    }
    if (s > this.deliveredStep) {
      this.deliveredStep = s;
      this.onFresh?.(s);
    }
  }

  /** Confirmed state hashes not reported yet ([step, hash] pairs, oldest first). */
  takeHashes(): [number, number][] {
    const out: [number, number][] = [];
    if (this.hashEvery <= 0) return out;
    const top = Math.min(this.confirmed, this.match.step, this.rewindTo - 1);
    for (let s = this.hashReported + this.hashEvery; s <= top; s += this.hashEvery) {
      const h = (s / this.hashEvery) & 63;
      if (this.hashStep[h] !== s) break;
      out.push([s, this.hashVal[h]]);
      this.hashReported = s;
    }
    return out;
  }

  /** Rollback depth at the given quantile (0-1) over every rollback so far. */
  depthQuantile(q: number): number {
    const total = this.rollbacks;
    if (!total) return 0;
    let acc = 0;
    for (let d = 0; d < this.depthHist.length; d++) { acc += this.depthHist[d]; if (acc >= q * total) return d; }
    return this.depthHist.length - 1;
  }
}
