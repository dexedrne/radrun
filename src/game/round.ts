// One chase round (spec §3, §7, §20): seeded setup (start junction, first edge, player spawn), then a
// fixed-step orchestration: player stepBody (or a bot's kinematic override) -> rubber band + runner ->
// Yoink / tag / fall / timer checks -> stats. Pure TS outside React; the determinism rule applies.
import { Fnv1a, Rand, hash01, type Vec3 } from "../sim/math.ts";
import {
  chaseDist, cloneBody, copyBody, createBody, hashBody, pickTarget, stepBody, EV_FALL, RING_NONE, RING_RUNNER,
  type Body, type InputFrame, type SimWorld,
} from "../sim/player.ts";
import { DT, MECH, ROUND, type Difficulty, type DifficultyParams, type Tuning } from "../sim/tuning.ts";
import { M_LOWGRAV, M_NOYOINK, M_ONELIFE, M_POPS, M_SIXTY, M_WIND } from "./mutators.ts";
import { CityIndex, type CityModel } from "../world/cityModel.ts";
import type { Pack } from "../route/trackPack.ts";
import { Runner } from "../runner/runner.ts";
import { DISTRICTS, type ChaseTweak, type DistrictId } from "../world/districts.ts";

export type RadbroId = "652" | "4764" | "2564" | "723";
export const RADBROS: readonly RadbroId[] = ["652", "4764", "2564", "723"];

export type RoundPhase = "countdown" | "chase" | "caught" | "escaped";

// Per-step round event bits (UI / FX; not part of the hash).
export const RV_GO = 1;
export const RV_FALL = 2;
export const RV_CAUGHT = 4;
export const RV_ESCAPED = 8;
export const RV_YOINK = 16;
export const RV_RESPAWN = 32;

/** Kinematic override for bots (spec §20 item 9): replaces stepBody's integration for one step. */
export type Kinematic = { p: Vec3; v: Vec3; grounded: boolean; phase: number; roofId: number };

export type RoundStats = {
  maxChain: number;
  topSpeed: number;
  falls: number;
  closest: number;
  catchKind: "tag" | "yoink" | "";
  /** Seconds from GO to the catch (fall penalties included), or 0. */
  catchTime: number;
};

export type RoundOptions = {
  model: CityModel;
  index?: CityIndex;
  pack: Pack;
  difficulty: Difficulty;
  params: DifficultyParams;
  tuning: Tuning;
  chaser: RadbroId;
  runner: RadbroId;
  seed: number;
  /** Skip the 3 s countdown (bots, balance, tests). */
  countdown?: boolean;
  /** Added to the difficulty's Yoink range (touch play: +1 m). */
  yoinkBonus?: number;
  /**
   * Practice (title -> PRACTICE): free roam from the seed's usual spawn roof (the city's own spawn is the
   * Milady's balloon stand), no runner (never stepped, not targetable), no clock, no countdown, falls
   * respawn without the -3 s. Same setup and rng draws as a real round with that seed.
   */
  practice?: boolean;
  /** Round 4 mutator bits (game/mutators.ts); 0 = the classic round. */
  mutators?: number;
  /**
   * The district the model belongs to: its chase tweak (spawn distance, first edge, runner deltas;
   * world/districts.ts) applies. Missing = Downtown / the classic round.
   */
  district?: DistrictId;
  /** Explicit chase tweak (tools sweep it); overrides the district's. */
  chase?: ChaseTweak;
};

export const COUNTDOWN_STEPS = 360;

/** One wind gust in chase steps: [start, end) with a unit direction (8 compass points). */
export type Gust = { start: number; end: number; dx: number; dz: number };
const S2 = 0.7071067811865476;
const WIND_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [S2, S2], [0, 1], [-S2, S2], [-1, 0], [-S2, -S2], [0, -1], [S2, -S2]];

/** The round's gust schedule: its own rng (the round rng draws are untouched), whole chase + slack. */
export function windSchedule(seed: number): Gust[] {
  const rng = new Rand((seed ^ 0x5bd1e995) >>> 0);
  const out: Gust[] = [];
  const steps = (s: number) => Math.round(s * 120);
  let t = steps(MECH.windGapMin * 0.5 + rng.next() * MECH.windGapMin * 0.5);
  const limit = steps(ROUND.seconds + 10);
  while (t < limit) {
    const d = WIND_DIRS[Math.floor(rng.next() * 8) & 7];
    const len = steps(MECH.windGust);
    out.push({ start: t, end: t + len, dx: d[0], dz: d[1] });
    t += len + steps(MECH.windGapMin + rng.next() * (MECH.windGapMax - MECH.windGapMin));
  }
  return out;
}

/** Wind acceleration factor (0..1, ramped) of a gust at chase step `s`. */
export function gustLevel(g: Gust, s: number): number {
  if (s < g.start || s >= g.end) return 0;
  const ramp = Math.max(1, Math.round(MECH.windRamp * 120));
  const a = (s - g.start) / ramp, b = (g.end - s) / ramp;
  return Math.min(1, a, b);
}

export class Round {
  readonly opts: RoundOptions;
  readonly model: CityModel;
  readonly index: CityIndex;
  readonly pack: Pack;
  readonly tuning: Tuning;
  readonly rng: Rand;
  readonly runner: Runner;
  readonly player: Body;
  readonly prevPlayer: Body;
  readonly world: SimWorld;
  readonly spawn: { roofId: number; x: number; y: number; z: number; yaw: number };
  readonly startJunction: number;
  phase: RoundPhase;
  countdown: number;
  /** Clock remaining, seconds (90, or 60 under the sixty mutator). */
  clock: number = ROUND.seconds;
  /** The clock this round started with. */
  readonly clock0: number;
  /** Mutator bits of this round. */
  readonly mutators: number;
  /** Wind gusts (wind mutator; empty otherwise) and the gust index the current step looks at. */
  readonly gusts: Gust[] = [];
  private gustI = 0;
  chaseSteps = 0;
  /** Chase distance d this step. */
  d = 0;
  events = 0;
  readonly stats: RoundStats = { maxChain: 0, topSpeed: 0, falls: 0, closest: Infinity, catchKind: "", catchTime: 0 };
  /** Runner pose before this step (render interpolation). */
  readonly prevRunner: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(o: RoundOptions) {
    this.opts = o;
    this.model = o.model;
    this.index = o.index ?? new CityIndex(o.model);
    this.pack = o.pack;
    const mut = (this.mutators = o.mutators ?? 0);
    const tw = o.chase ?? (o.district ? DISTRICTS[o.district].chase : undefined);
    const params = { ...o.params };
    const add = tw?.add?.[o.difficulty];
    if (add) for (const k of Object.keys(add) as (keyof DifficultyParams)[]) params[k] += add[k] ?? 0;
    this.tuning = { ...o.tuning, yoinkRange: params.yoinkRange + (o.yoinkBonus ?? 0) };
    if (mut & M_LOWGRAV) this.tuning.gravity = o.tuning.gravity * MECH.lowGravity;
    if (mut & M_NOYOINK) this.tuning.yoink = false;
    this.clock = this.clock0 = mut & M_SIXTY ? MECH.sixtyClock : ROUND.seconds;
    this.rng = new Rand(o.seed);
    const pack = o.pack;
    const nj = pack.junctions.length;
    this.startJunction = Math.floor(this.rng.next() * nj);
    const outs = pack.out[this.startJunction];
    const first = outs[Math.floor(this.rng.next() * outs.length)];
    // Same rng draws with or without a tweak (the tweak only moves the spawn and the runner numbers).
    const spawnMin = tw?.spawnMin ?? 22, spawnSpan = tw?.spawnSpan ?? 4, other = tw?.spawnOther ?? 3;
    this.runner = new Runner(pack, params, this.rng, this.startJunction, first);
    this.spawn = playerSpawn(this.model, pack, this.startJunction, first, spawnMin + spawnSpan * this.rng.next(), other);
    this.player = createBody(this.spawn.x, this.spawn.y, this.spawn.z, this.spawn.roofId);
    this.prevPlayer = cloneBody(this.player);
    this.prevRunner.x = this.runner.p.x; this.prevRunner.y = this.runner.p.y; this.prevRunner.z = this.runner.p.z;
    this.world = { index: this.index, hooks: this.model.hooks, lowestRoof: this.model.lowestRoof, runner: o.practice ? null : { p: this.runner.p, roofId: -1 } };
    if (mut & M_POPS) {
      const n = this.model.hooks.length;
      const fragile = new Uint8Array(n);
      for (let i = 0; i < n; i++) fragile[i] = hash01(o.seed, i, 0x70707, 1) < MECH.popShare ? 1 : 0;
      this.world.fragile = fragile;
      this.world.hookDown = new Int32Array(n);
      this.world.popSteps = Math.round(MECH.popRespawn * 120);
    }
    if (mut & M_WIND) {
      this.world.wind = { x: 0, z: 0 };
      this.gusts.push(...windSchedule(o.seed));
    }
    const cd = o.countdown !== false && !o.practice;
    this.phase = cd ? "countdown" : "chase";
    this.countdown = cd ? COUNTDOWN_STEPS : 0;
    this.d = chaseDist(this.player.p, this.runner.p);
  }

  get over(): boolean {
    return this.phase === "caught" || this.phase === "escaped";
  }

  /** One fixed 120 Hz step. `ov` = a bot's kinematic override (null for real input). */
  step(inp: InputFrame, ov: Kinematic | null = null): void {
    this.events = 0;
    const b = this.player;
    copyBody(this.prevPlayer, b);
    const r = this.runner;
    this.prevRunner.x = r.p.x; this.prevRunner.y = r.p.y; this.prevRunner.z = r.p.z;
    if (this.phase === "countdown") {
      this.countdown--;
      if (this.countdown <= 0) { this.phase = "chase"; this.events |= RV_GO; }
      return;
    }
    if (this.phase !== "chase") return;
    this.chaseSteps++;
    this.updateWind();
    if (this.opts.practice) { this.stepPractice(inp); return; }
    const w = this.world;
    w.runner!.roofId = r.roofId;

    // 1. Player.
    if (ov) {
      b.events = 0;
      b.step++;
      b.t += DT;
      b.ringId = pickTarget(b, inp, this.tuning, w);
      b.p.x = ov.p.x; b.p.y = ov.p.y; b.p.z = ov.p.z;
      b.v.x = ov.v.x; b.v.y = ov.v.y; b.v.z = ov.v.z;
      b.grounded = ov.grounded;
      b.roofId = ov.roofId;
      b.ropeHook = -1;
      if (ov.grounded) { b.lastSafeRoof = ov.roofId; b.lastSafe.x = ov.p.x; b.lastSafe.y = ov.p.y; b.lastSafe.z = ov.p.z; }
    } else {
      stepBody(b, inp, this.tuning, w);
    }
    const yoink = b.ringId === RING_RUNNER && inp.webPressed;

    // 2. Runner (rubber band on d before he moves).
    this.d = chaseDist(b.p, r.p);
    r.step(b.p, this.d);
    this.d = chaseDist(b.p, r.p);

    // 3. Stats.
    const st = this.stats;
    const sp = Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z);
    if (sp > st.topSpeed) st.topSpeed = sp;
    if (b.chainCount > st.maxChain) st.maxChain = b.chainCount;
    if (this.d < st.closest) st.closest = this.d;

    // 4. Catch: Yoink (red ring + press on this step) or tag.
    const dx = b.p.x - r.p.x, dz = b.p.z - r.p.z, dy = b.p.y - r.p.y;
    const tag = dx * dx + dz * dz <= ROUND.tagRadius * ROUND.tagRadius && (dy < 0 ? -dy : dy) <= ROUND.tagDy;
    if (yoink || tag) {
      this.phase = "caught";
      st.catchKind = yoink ? "yoink" : "tag";
      st.catchTime = this.clock0 - this.clock;
      this.events |= RV_CAUGHT | (yoink ? RV_YOINK : 0);
      return;
    }

    // 5. Fall: respawn on the last safe roof at the point nearest him, -3 s (one life: he rugs you).
    if (b.events & EV_FALL) {
      st.falls++;
      if (this.mutators & M_ONELIFE) {
        this.phase = "escaped";
        this.events |= RV_FALL | RV_ESCAPED;
        return;
      }
      this.clock -= ROUND.respawnPenalty;
      respawnNear(b, this.model, b.lastSafeRoof, r.p, ROUND.respawnInset, this.tuning.halfHeight);
      copyBody(this.prevPlayer, b);
      this.events |= RV_FALL | RV_RESPAWN;
    }

    // 6. Clock.
    this.clock -= DT;
    if (this.clock <= 0) {
      this.clock = 0;
      this.phase = "escaped";
      this.events |= RV_ESCAPED;
    }
  }

  /** Practice step: the player only; a fall respawns on the last safe roof at no cost. */
  private stepPractice(inp: InputFrame): void {
    const b = this.player, st = this.stats;
    stepBody(b, inp, this.tuning, this.world);
    const sp = Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z);
    if (sp > st.topSpeed) st.topSpeed = sp;
    if (b.chainCount > st.maxChain) st.maxChain = b.chainCount;
    if (b.events & EV_FALL) {
      st.falls++;
      respawnNear(b, this.model, b.lastSafeRoof, b.lastSafe, ROUND.respawnInset, this.tuning.halfHeight);
      copyBody(this.prevPlayer, b);
      this.events |= RV_FALL | RV_RESPAWN;
    }
  }

  /** Wind for this chase step (the wind mutator): the ramped gust acceleration, or zero. */
  private updateWind(): void {
    const w = this.world.wind;
    if (w === undefined) return;
    const s = this.chaseSteps;
    while (this.gustI < this.gusts.length && this.gusts[this.gustI].end <= s) this.gustI++;
    const g = this.gusts[this.gustI];
    const lvl = g ? gustLevel(g, s) : 0;
    w.x = g ? g.dx * MECH.windMax * lvl : 0;
    w.z = g ? g.dz * MECH.windMax * lvl : 0;
  }

  /** Seconds until the next gust starts (Infinity when none is coming) and its direction; HUD only. */
  nextGust(): { inSeconds: number; dx: number; dz: number; level: number } | null {
    if (!this.gusts.length) return null;
    const s = this.chaseSteps;
    for (let i = this.gustI; i < this.gusts.length; i++) {
      const g = this.gusts[i];
      if (g.end <= s) continue;
      return { inSeconds: Math.max(0, (g.start - s) / 120), dx: g.dx, dz: g.dz, level: gustLevel(g, s) };
    }
    return null;
  }

  hash(): string {
    const h = new Fnv1a();
    hashBody(this.player, h);
    this.runner.hash(h);
    h.f64(this.clock).i32(this.chaseSteps).i32(this.countdown).str(this.phase).i32(this.stats.falls).i32(this.stats.maxChain);
    const down = this.world.hookDown;
    if (down !== undefined) for (let i = 0; i < down.length; i++) if (down[i] !== 0) h.i32(i).i32(down[i]);
    return h.hex();
  }
}

/** Respawn a body on `roofId` at the point nearest `near` (xz clamp into the roof inset `inset`). */
export function respawnNear(b: Body, model: CityModel, roofId: number, near: Vec3, inset: number, halfHeight: number): void {
  const s = model.solids[roofId] ?? model.solids[model.spawn.roofId];
  const x = Math.min(Math.max(near.x, s.x0 + inset), s.x1 - inset);
  const z = Math.min(Math.max(near.z, s.z0 + inset), s.z1 - inset);
  b.p.x = x; b.p.y = s.top + halfHeight; b.p.z = z;
  b.v.x = b.v.y = b.v.z = 0;
  b.grounded = true;
  b.roofId = s.id;
  b.ropeHook = -1;
  b.heldFor = b.coyote = b.jumpBuf = b.bonkT = 0;
  b.chainCount = 0;
  b.ringId = RING_NONE;
  b.lastSafeRoof = s.id;
  b.lastSafe.x = x; b.lastSafe.y = b.p.y; b.lastSafe.z = z;
}

/**
 * Player spawn (spec §3): on a roof adjacent to the start junction's roof, on the side away from his
 * first edge, about `dist` m behind him; yaw faces him (camera only).
 */
export function playerSpawn(model: CityModel, pack: Pack, junction: number, firstEdge: number, dist: number, otherPenalty = 3): { roofId: number; x: number; y: number; z: number; yaw: number } {
  const j = pack.junctions[junction];
  const e = pack.edges[firstEdge];
  const jr = j.roof;
  const inset = ROUND.respawnInset;
  // Ideal point: `dist` m behind him, opposite his first edge's exit; take the roof whose (inset)
  // footprint gets closest to it.
  const qx = j.x - e.exitX * dist, qz = j.z - e.exitZ * dist;
  let best = -1, bestS = Infinity, x = j.x, z = j.z;
  // Adjacent roofs first; any other landable roof only if it gets > otherPenalty m closer (e.g. a tower is
  // in the way; dense districts lower it so the spawn can reach past a small neighbour roof).
  const adjacent = new Set<number>();
  for (const a of model.adjacency) if (a.a === jr || a.b === jr) adjacent.add(a.a === jr ? a.b : a.a);
  for (const s of model.solids) {
    const other = s.id;
    if (!s.landable || other === jr) continue;
    const cx = Math.min(Math.max(qx, s.x0 + inset), s.x1 - inset);
    const cz = Math.min(Math.max(qz, s.z0 + inset), s.z1 - inset);
    const dq = Math.sqrt((cx - qx) * (cx - qx) + (cz - qz) * (cz - qz));
    const dd = adjacent.has(other) ? dq : dq + otherPenalty;
    if (dd < bestS - 1e-9 || (dd < bestS + 1e-9 && other < best)) { bestS = dd; best = other; x = cx; z = cz; }
  }
  const roof = model.solids[best >= 0 ? best : jr];
  // yaw convention (camera/rig.ts): forward = (-sin yaw, -cos yaw). Cosmetic, outside the sim.
  const yaw = Math.atan2(-(j.x - x), -(j.z - z));
  return { roofId: roof.id, x, y: roof.top + 0.9, z, yaw };
}
