// Spider-tag (multiplayer design §2.1, §3.3): up to 8 Radbros on the round-12 movement, one of them holding the bag.
// Touch a runner (the 1.5 m / 1.8 m tag test), web him at the red ring (Yoink) or yank onto him (ZIP in yank range)
// and the bag passes: the new bagholder is web-tangled for tagFreeze s and can't tag the one who passed it straight
// back for tagBack s. Score = seconds holding the bag; lowest wins at the horn (ties: fewer falls, then more tags).
//
// One match step (fixed order, so every client computes the same future from the same inputs):
//   1. targets: the (unfrozen) holder's Yoink / yank target is the nearest runner by chaseDist on PRE-step positions
//      (ties -> the lower slot; the tag-back player is skipped); everyone else has none. Each slot's SimWorld.runner
//      is a copy of that target, so the slot order of step 2 does not matter.
//   2. bodies: each slot steps from the frame rebuilt from its 40-bit input word (net/wire.ts); a frozen or
//      fall-locked body gets its move and buttons zeroed (it keeps its aim; gravity still applies).
//   3. tags on POST-step positions: the holder against each runner in ascending slot order; the first hit passes.
//   4. falls: respawn on the last safe roof, then fallLock s with no input.
//   5. clock: the holder's bag clock +1, the match clock -1; the match ends at zero.
// Everything is integers or sim doubles; the hash covers every body and every match field. The determinism rule of
// sim/player.ts applies (no trig, no allocation in step()).
import { Fnv1a, Rand, type Vec3 } from "../sim/math.ts";
import {
  chaseDist, copyBody, createBody, hashBody, stepBody, EV_FALL, EV_YANK_END, RING_RUNNER,
  type Body, type InputFrame, type SimWorld,
} from "../sim/player.ts";
import { ROUND, type Tuning } from "../sim/tuning.ts";
import { CityIndex, type CityModel } from "../world/cityModel.ts";
import { buildFrame, emptyRec, roundTuning, type InputRec } from "./ghost.ts";
import { respawnNear, type RadbroId } from "./round.ts";
import { unpackWord } from "../net/wire.ts";
import { emptyInput } from "../sim/player.ts";

/** The tag table (multiplayer design §7 `tag` group; in the match hash). Mutable so tools and tests can sweep it. */
export const TAG = {
  tagRadius: 1.5,
  tagDy: 1.8,
  yoink: true,
  yoinkRange: 3.5,
  /** Round 12's yank (ZIP with the runner in range: a homing zip onto him); 0 = off. */
  yankRange: 9,
  tagFreeze: 1.5,
  tagBack: 3,
  fallLock: 1.0,
  seconds1v1: 180,
  secondsGroup: 240,
  spawnMinDist: 40,
  itSpawnDist: 60,
};
export type TagTable = typeof TAG;

export const MAX_SLOTS = 8;
export const TAG_COUNTDOWN_STEPS = 360;
/** Touch play: +1 m Yoink (as in single-player). */
const TOUCH_YOINK = 1;

export type TagSlot = { radbro: RadbroId; touch?: boolean; easy?: boolean; name?: string };

export type TagOptions = {
  model: CityModel;
  index?: CityIndex;
  /** The base player tuning (tuning.json); each slot gets roundTuning() with its own touch / easy flags. */
  tuning: Tuning;
  slots: TagSlot[];
  seed: number;
  /** Match length (s); default 1v1 seconds1v1, groups secondsGroup. */
  seconds?: number;
  tag?: Partial<TagTable>;
  /** false = no 3 s countdown (tests, tools). */
  countdown?: boolean;
};

export const PH_COUNTDOWN = 0;
export const PH_PLAY = 1;
export const PH_OVER = 2;

/** Match event bits of the last step (presentation only; not hashed). */
export const TV_GO = 1;
export const TV_TAG = 2;
export const TV_FALL = 4;
export const TV_END = 8;

export const TAG_KIND_TOUCH = 1;
export const TAG_KIND_YOINK = 2;
export const TAG_KIND_YANK = 3;

export type Spawn = { roofId: number; x: number; y: number; z: number; yaw: number };

/** A rollback snapshot: every body plus the match fields (preallocated; see TagMatch.newSnap / save / load). */
export type TagSnap = { bodies: Body[]; ints: Int32Array };

// Layout of the match fields in TagSnap.ints (then 5 per slot: bag, freeze, lock, tags, falls).
const I_STEP = 0, I_PHASE = 1, I_COUNTDOWN = 2, I_CLOCK = 3, I_HOLDER = 4, I_TB_SLOT = 5, I_TB_STEPS = 6;
const I_LAST_STEP = 7, I_LAST_FROM = 8, I_LAST_TO = 9, I_LAST_KIND = 10, I_SLOTS = 11, PER_SLOT = 5;

type Target = { p: Vec3; roofId: number };

export class TagMatch {
  readonly opts: TagOptions;
  readonly n: number;
  readonly model: CityModel;
  readonly index: CityIndex;
  readonly tag: TagTable;
  readonly slots: readonly TagSlot[];
  /** Per-slot tuning (touch aim cone / easy grab; the holder's Yoink and yank ranges come from the tag table). */
  readonly tunings: Tuning[];
  readonly worlds: SimWorld[];
  readonly bodies: Body[];
  /** Bodies before the last step (render interpolation; not match state). */
  readonly prev: Body[];
  readonly spawns: Spawn[];
  /** The frames the last step used (the holder's webPressed = the Yoink press). */
  readonly frames: InputFrame[];
  private readonly rec: InputRec = emptyRec();
  private readonly targetBuf: Target[];
  /** The holder at the start of the match. */
  readonly firstHolder: number;
  readonly seconds: number;
  readonly totalSteps: number;
  readonly freezeSteps: number;
  readonly tagBackSteps0: number;
  readonly fallLockSteps: number;

  // ---- match state (all in the hash and the snapshot) ----
  /** Steps run since the match was created (countdown included). */
  step = 0;
  phase = PH_COUNTDOWN;
  countdown = 0;
  /** Match clock, steps left. */
  clock = 0;
  holder = 0;
  readonly bag: Int32Array;
  readonly freeze: Int32Array;
  readonly lock: Int32Array;
  readonly tags: Int32Array;
  readonly falls: Int32Array;
  tagBackSlot = -1;
  tagBackSteps = 0;
  lastTagStep = -1;
  lastTagFrom = -1;
  lastTagTo = -1;
  lastTagKind = 0;

  /** Derived each step from the state: each slot's target (-1 none). */
  readonly target: Int32Array;
  /** Match event bits of the last step. */
  events = 0;

  constructor(o: TagOptions) {
    const n = o.slots.length;
    if (n < 2 || n > MAX_SLOTS) throw new Error(`Spider-tag needs 2-${MAX_SLOTS} players, got ${n}`);
    this.opts = o;
    this.n = n;
    this.model = o.model;
    this.index = o.index ?? new CityIndex(o.model);
    this.tag = { ...TAG, ...o.tag };
    this.slots = o.slots;
    const t = this.tag;
    this.tunings = o.slots.map(s => ({
      ...roundTuning(o.tuning, { touch: !!s.touch, easy: !!s.easy }),
      yoink: t.yoink,
      yoinkRange: t.yoinkRange + (s.touch ? TOUCH_YOINK : 0),
      yankRange: t.yankRange,
    }));
    this.seconds = o.seconds ?? (n === 2 ? t.seconds1v1 : t.secondsGroup);
    this.totalSteps = Math.round(this.seconds * 120);
    this.freezeSteps = Math.round(t.tagFreeze * 120);
    this.tagBackSteps0 = Math.round(t.tagBack * 120);
    this.fallLockSteps = Math.round(t.fallLock * 120);
    this.bag = new Int32Array(n);
    this.freeze = new Int32Array(n);
    this.lock = new Int32Array(n);
    this.tags = new Int32Array(n);
    this.falls = new Int32Array(n);
    this.target = new Int32Array(n).fill(-1);
    this.targetBuf = o.slots.map(() => ({ p: { x: 0, y: 0, z: 0 }, roofId: -1 }));
    this.frames = o.slots.map(() => emptyInput());

    const rng = new Rand(o.seed);
    this.firstHolder = Math.floor(rng.next() * n);
    this.holder = this.firstHolder;
    this.spawns = tagSpawns(this.model, n, this.firstHolder, rng, this.tag, this.tunings[0].halfHeight);
    this.bodies = this.spawns.map(s => createBody(s.x, s.y, s.z, s.roofId));
    this.prev = this.spawns.map(s => createBody(s.x, s.y, s.z, s.roofId));
    this.worlds = o.slots.map(() => ({ index: this.index, runner: null }));
    this.clock = this.totalSteps;
    const cd = o.countdown !== false;
    this.phase = cd ? PH_COUNTDOWN : PH_PLAY;
    this.countdown = cd ? TAG_COUNTDOWN_STEPS : 0;
    this.updateTargets();
  }

  get over(): boolean {
    return this.phase === PH_OVER;
  }

  /** The step at which the match ends (countdown included). */
  get endStep(): number {
    return (this.opts.countdown !== false ? TAG_COUNTDOWN_STEPS : 0) + this.totalSteps;
  }

  /** Is `slot` web-tangled or fall-locked (no input) right now? */
  stuck(slot: number): boolean {
    return this.freeze[slot] > 0 || this.lock[slot] > 0;
  }

  /**
   * Step 1: each slot's target on the current (pre-step) positions, written into its SimWorld. Idempotent (bots call
   * it before choosing their input). A slot that loses its target mid-yank ends the yank (the sim reads the target).
   */
  updateTargets(): void {
    const n = this.n, B = this.bodies, h = this.holder;
    let best = -1, bestD = Infinity;
    if (this.phase === PH_PLAY && this.freeze[h] === 0) {
      for (let i = 0; i < n; i++) {
        if (i === h || (i === this.tagBackSlot && this.tagBackSteps > 0)) continue;
        const d = chaseDist(B[h].p, B[i].p);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    for (let i = 0; i < n; i++) {
      const tgt = i === h ? best : -1;
      this.target[i] = tgt;
      const w = this.worlds[i];
      if (tgt >= 0) {
        const buf = this.targetBuf[i], q = B[tgt];
        buf.p.x = q.p.x; buf.p.y = q.p.y; buf.p.z = q.p.z;
        buf.roofId = q.grounded ? q.roofId : -1;
        w.runner = buf;
      } else {
        w.runner = null;
        const b = B[i];
        if (b.yankOn) { b.yankOn = false; b.yankCd = this.tunings[i].yankCooldown; }
      }
    }
  }

  /** One fixed 120 Hz step from one 40-bit input word per slot (net/wire.ts). */
  stepWords(words: ArrayLike<number>): void {
    const n = this.n;
    for (let i = 0; i < n; i++) copyBody(this.prev[i], this.bodies[i]);
    this.events = 0;
    if (this.phase === PH_OVER) return;
    this.step++;
    if (this.phase === PH_COUNTDOWN) {
      this.countdown--;
      if (this.countdown <= 0) { this.phase = PH_PLAY; this.events |= TV_GO; this.updateTargets(); }
      return;
    }

    // 1. Targets (pre-step positions).
    this.updateTargets();

    // 2. Bodies.
    const rec = this.rec;
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i], k = this.tunings[i], f = this.frames[i];
      unpackWord(words[i], rec);
      buildFrame(f, rec, b.v, !!this.slots[i].touch, k.runSpeed);
      const frozen = this.freeze[i] > 0, locked = this.lock[i] > 0;
      if (frozen) this.freeze[i]--;
      if (locked) this.lock[i]--;
      if (frozen || locked) {
        f.moveX = 0; f.moveZ = 0;
        f.jumpPressed = f.webHeld = f.webPressed = f.zipPressed = f.slidePressed = f.slideHeld = false;
      }
      stepBody(b, f, k, this.worlds[i]);
    }
    if (this.tagBackSteps > 0 && --this.tagBackSteps === 0) this.tagBackSlot = -1;

    // 3. Tags (post-step positions): touch, Yoink (the red ring on his target + a web press) or the yank's arrival.
    const h = this.holder, hb = this.bodies[h];
    if (this.freeze[h] === 0 && this.lock[h] === 0) {
      const t = this.tag, r2 = t.tagRadius * t.tagRadius;
      const yoink = hb.ringId === RING_RUNNER && this.frames[h].webPressed ? this.target[h] : -1;
      for (let i = 0; i < n; i++) {
        if (i === h || (i === this.tagBackSlot && this.tagBackSteps > 0)) continue;
        const q = this.bodies[i].p;
        const dx = hb.p.x - q.x, dz = hb.p.z - q.z, dy = hb.p.y - q.y;
        const touch = dx * dx + dz * dz <= r2 && (dy < 0 ? -dy : dy) <= t.tagDy;
        if (touch || yoink === i) {
          this.pass(h, i, yoink === i ? TAG_KIND_YOINK : hb.yankOn || (hb.events & EV_YANK_END) !== 0 ? TAG_KIND_YANK : TAG_KIND_TOUCH);
          break;
        }
      }
    }

    // 4. Falls.
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i];
      if (!(b.events & EV_FALL)) continue;
      this.falls[i]++;
      respawnNear(b, this.model, b.lastSafeRoof, b.lastSafe, ROUND.respawnInset, this.tunings[i].halfHeight);
      copyBody(this.prev[i], b);
      this.lock[i] = this.fallLockSteps;
      this.events |= TV_FALL;
    }

    // 5. Clock.
    this.bag[this.holder]++;
    this.clock--;
    if (this.clock <= 0) {
      this.clock = 0;
      this.phase = PH_OVER;
      this.events |= TV_END;
    }
    this.updateTargets();
  }

  private pass(from: number, to: number, kind: number): void {
    this.holder = to;
    this.freeze[to] = this.freezeSteps;
    this.tagBackSlot = from;
    this.tagBackSteps = this.tagBackSteps0;
    this.tags[from]++;
    this.lastTagStep = this.step;
    this.lastTagFrom = from;
    this.lastTagTo = to;
    this.lastTagKind = kind;
    this.events |= TV_TAG;
  }

  /** Bag seconds of a slot. */
  bagSeconds(slot: number): number {
    return this.bag[slot] / 120;
  }

  /** Seconds of match clock left. */
  get clockSeconds(): number {
    return this.clock / 120;
  }

  /** Slots best first: least bag time, then fewer falls, then more tags, then the lower slot. */
  standings(): number[] {
    const out = Array.from({ length: this.n }, (_, i) => i);
    out.sort((a, b) => this.bag[a] - this.bag[b] || this.falls[a] - this.falls[b] || this.tags[b] - this.tags[a] || a - b);
    return out;
  }

  /** FNV-1a over every body and every match field (u32). */
  hash(): number {
    const h = new Fnv1a();
    for (const b of this.bodies) hashBody(b, h);
    h.i32(this.step).i32(this.phase).i32(this.countdown).i32(this.clock).i32(this.holder).i32(this.tagBackSlot).i32(this.tagBackSteps);
    h.i32(this.lastTagStep).i32(this.lastTagFrom).i32(this.lastTagTo).i32(this.lastTagKind);
    for (let i = 0; i < this.n; i++) h.i32(this.bag[i]).i32(this.freeze[i]).i32(this.lock[i]).i32(this.tags[i]).i32(this.falls[i]);
    return h.h >>> 0;
  }

  hashHex(): string {
    return this.hash().toString(16).padStart(8, "0");
  }

  /** Per-slot body hashes (a desync report shows which body diverged first). */
  slotHashes(): number[] {
    return this.bodies.map(b => hashBody(b).h >>> 0);
  }

  newSnap(): TagSnap {
    return { bodies: this.bodies.map(() => createBody(0, 0, 0, -1)), ints: new Int32Array(I_SLOTS + PER_SLOT * this.n) };
  }

  save(s: TagSnap): void {
    for (let i = 0; i < this.n; i++) copyBody(s.bodies[i], this.bodies[i]);
    const a = s.ints;
    a[I_STEP] = this.step; a[I_PHASE] = this.phase; a[I_COUNTDOWN] = this.countdown; a[I_CLOCK] = this.clock; a[I_HOLDER] = this.holder;
    a[I_TB_SLOT] = this.tagBackSlot; a[I_TB_STEPS] = this.tagBackSteps;
    a[I_LAST_STEP] = this.lastTagStep; a[I_LAST_FROM] = this.lastTagFrom; a[I_LAST_TO] = this.lastTagTo; a[I_LAST_KIND] = this.lastTagKind;
    for (let i = 0, o = I_SLOTS; i < this.n; i++, o += PER_SLOT) {
      a[o] = this.bag[i]; a[o + 1] = this.freeze[i]; a[o + 2] = this.lock[i]; a[o + 3] = this.tags[i]; a[o + 4] = this.falls[i];
    }
  }

  load(s: TagSnap): void {
    for (let i = 0; i < this.n; i++) { copyBody(this.bodies[i], s.bodies[i]); copyBody(this.prev[i], s.bodies[i]); }
    const a = s.ints;
    this.step = a[I_STEP]; this.phase = a[I_PHASE]; this.countdown = a[I_COUNTDOWN]; this.clock = a[I_CLOCK]; this.holder = a[I_HOLDER];
    this.tagBackSlot = a[I_TB_SLOT]; this.tagBackSteps = a[I_TB_STEPS];
    this.lastTagStep = a[I_LAST_STEP]; this.lastTagFrom = a[I_LAST_FROM]; this.lastTagTo = a[I_LAST_TO]; this.lastTagKind = a[I_LAST_KIND];
    for (let i = 0, o = I_SLOTS; i < this.n; i++, o += PER_SLOT) {
      this.bag[i] = a[o]; this.freeze[i] = a[o + 1]; this.lock[i] = a[o + 2]; this.tags[i] = a[o + 3]; this.falls[i] = a[o + 4];
    }
    this.events = 0;
    this.updateTargets();
  }
}

/**
 * Spawns (multiplayer design §2.4): distinct landable roofs from the city's junction candidates. The holder's roof is a seeded
 * pick; each runner then takes the roof at least itSpawnDist from the holder that keeps the most spacing from the
 * runners placed so far (capped at 2 x spawnMinDist, so nobody is sent to a far corner), preferring roofs near that
 * ring round the holder. Yaw faces the holder (the holder faces the first runner); cosmetic (camera only).
 */
export function tagSpawns(model: CityModel, n: number, holder: number, rng: Rand, t: TagTable, halfHeight: number): Spawn[] {
  let cands = model.junctionCandidates.filter(id => model.solids[id]?.kind === "roof");
  if (cands.length < n) cands = model.solids.filter(s => s.kind === "roof" && s.landable).map(s => s.id);
  const cx = (id: number) => (model.solids[id].x0 + model.solids[id].x1) / 2;
  const cz = (id: number) => (model.solids[id].z0 + model.solids[id].z1) / 2;
  const d2 = (a: number, b: number) => { const dx = cx(a) - cx(b), dz = cz(a) - cz(b); return Math.sqrt(dx * dx + dz * dz); };
  const roofs: number[] = new Array(n).fill(-1);
  roofs[holder] = cands[Math.floor(rng.next() * cands.length)];
  const used = new Set<number>([roofs[holder]]);
  const cap = 2 * t.spawnMinDist;
  for (let i = 0; i < n; i++) {
    if (i === holder) continue;
    let best = -1, bestS = -Infinity;
    for (let pass = 0; pass < 2 && best < 0; pass++) {
      for (const c of cands) {
        if (used.has(c)) continue;
        const dh = d2(c, roofs[holder]);
        if (pass === 0 && dh < t.itSpawnDist) continue;
        let dmin = Infinity;
        for (let j = 0; j < n; j++) if (j !== holder && roofs[j] >= 0) dmin = Math.min(dmin, d2(c, roofs[j]));
        const s = Math.min(dmin, cap) - 0.25 * Math.abs(dh - t.itSpawnDist * 1.2) + rng.next() * 2;
        if (s > bestS) { bestS = s; best = c; }
      }
    }
    roofs[i] = best >= 0 ? best : roofs[holder];
    used.add(roofs[i]);
  }
  const face = (from: number, to: number) => Math.atan2(-(cx(to) - cx(from)), -(cz(to) - cz(from)));
  return roofs.map((id, i) => {
    const s = model.solids[id];
    const other = i === holder ? roofs[holder === 0 ? 1 : 0] : roofs[holder];
    return { roofId: id, x: cx(id), y: s.top + halfHeight, z: cz(id), yaw: other === id ? 0 : face(id, other) };
  });
}
