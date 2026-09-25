// The runner at runtime (spec §7): variable-speed playback of baked edges plus junction dwells
// (look-back 0.15 s or a taunt when d > 35 m, branch choice, 36-step head turn, depart), the
// away-branch policy with Irwin-Hall noise, cornered, flinch and the panic budget (rubberBand.ts).
// Pure TS, fixed step, no allocation in step(); determinism rule applies.
import { Fnv1a, type Rand, type Vec3 } from "../sim/math.ts";
import { DT } from "../sim/tuning.ts";
import { PHASE_GROUND, sampleEdge, type Pack, type TrackPose } from "../route/trackPack.ts";
import { createBand, stepBand, type Band, type BandParams } from "./rubberBand.ts";

export type RunnerParams = BandParams & { base: number; sigma: number; taunt: number };

export const RM_EDGE = 0;
export const RM_LOOK = 1;
export const RM_TAUNT = 2;
export const RM_TURN = 3;

// Per-step event bits.
export const RE_ARRIVE = 1;
export const RE_DEPART = 2;
export const RE_TAUNT = 4;
export const RE_CORNERED = 8;
export const RE_PANIC = 16;
export const RE_GASSED = 32;
export const RE_BRANCH = 64;

export const RUNNER_RULES = {
  lookSteps: 18, // 0.15 s
  turnSteps: 36, // 0.3 s
  tauntAbove: 35,
  lookAtBelow: 20,
  flinchBelow: 30,
  flinchDot: 0.3,
  flinchLook: 1, // seconds of track ahead
  awayW: 1,
  farW: 0.6,
  farCap: 60,
  recentW: 0.8,
  backW: 2,
  corneredScore: -0.5,
  corneredBelow: 10,
} as const;

export class Runner {
  readonly pack: Pack;
  readonly params: RunnerParams;
  readonly rng: Rand;
  mode = RM_TURN;
  edge = -1;
  /** Track time on the current edge, seconds of baked time. */
  t = 0;
  junction: number;
  prevJunction = -1;
  dwell: number = RUNNER_RULES.turnSteps;
  next: number;
  picks: [number, number] = [-1, -1];
  readonly band: Band;
  readonly pose: TrackPose = { x: 0, y: 0, z: 0, phase: PHASE_GROUND, ref: -1 };
  /** Body point (= pose xyz) and the roof under him (-1 when airborne) for Yoink line of sight. */
  readonly p: Vec3 = { x: 0, y: 0, z: 0 };
  roofId = -1;
  rate = 1;
  events = 0;
  /** Horizontal exit direction of the chosen edge while turning (head-turn tell), else 0,0. */
  headX = 0;
  headZ = 0;
  /** Look-back at the player this dwell (d < 20 m on arrival). */
  lookAt = false;
  lastScore = 0;
  /**
   * Round 7 descending chase (district chase tweak `down`; 0 = the classic policy): edges that end lower
   * score higher, by down x (drop / 20 m) clamped to +-1.
   */
  down = 0;
  private ahead: TrackPose = { x: 0, y: 0, z: 0, phase: 0, ref: -1 };

  constructor(pack: Pack, params: RunnerParams, rng: Rand, startJunction: number, firstEdge: number) {
    this.pack = pack;
    this.params = params;
    this.rng = rng;
    this.junction = startJunction;
    this.next = firstEdge;
    this.band = createBand(params);
    this.placeAtJunction(startJunction);
    const e = pack.edges[firstEdge];
    this.headX = e.exitX;
    this.headZ = e.exitZ;
  }

  private placeAtJunction(j: number): void {
    const jn = this.pack.junctions[j];
    this.pose.x = this.p.x = jn.x;
    this.pose.y = this.p.y = jn.y;
    this.pose.z = this.p.z = jn.z;
    this.pose.phase = PHASE_GROUND;
    this.pose.ref = jn.roof;
    this.roofId = jn.roof;
  }

  get airborne(): boolean {
    return this.pose.phase !== PHASE_GROUND;
  }

  /** Current edge's along-path speed (m/s of baked time), or the next edge's while dwelling. */
  get edgeSpeed(): number {
    const e = this.pack.edges[this.mode === RM_EDGE ? this.edge : this.next];
    return e ? e.speed : 9;
  }

  /** Does his next second of track head at the player? */
  private headsAt(player: Vec3): boolean {
    if (this.mode !== RM_EDGE) return false;
    const e = this.pack.edges[this.edge];
    sampleEdge(e, this.t + RUNNER_RULES.flinchLook, this.ahead);
    const dx = this.ahead.x - this.p.x, dz = this.ahead.z - this.p.z;
    const px = player.x - this.p.x, pz = player.z - this.p.z;
    const dl = Math.sqrt(dx * dx + dz * dz), pl = Math.sqrt(px * px + pz * pz);
    if (dl < 1e-6 || pl < 1e-6) return false;
    return (dx * px + dz * pz) / (dl * pl) > RUNNER_RULES.flinchDot;
  }

  /** Branch score of edge `ei` for a player at `player` (sigma * noise added by the caller). */
  scoreEdge(ei: number, player: Vec3): number {
    const R = RUNNER_RULES;
    const e = this.pack.edges[ei];
    let ax = this.p.x - player.x, az = this.p.z - player.z;
    const al = Math.sqrt(ax * ax + az * az);
    if (al > 1e-6) { ax /= al; az /= al; } else { ax = 0; az = 0; }
    const end = this.pack.junctions[e.to];
    const dx = end.x - player.x, dy = end.y - player.y, dz = end.z - player.z;
    const far = Math.min(Math.sqrt(dx * dx + dy * dy + dz * dz), R.farCap) / R.farCap;
    let s = R.awayW * (e.exitX * ax + e.exitZ * az) + R.farW * far;
    if (this.picks[0] === ei || this.picks[1] === ei) s -= R.recentW;
    if (e.to === this.prevJunction) s -= R.backW;
    if (this.down > 0) {
      const drop = (this.pack.junctions[e.from].y - end.y) / 20;
      s += this.down * (drop < -1 ? -1 : drop > 1 ? 1 : drop);
    }
    return s;
  }

  /** Away-branch choice (argmax of score + sigma * Irwin-Hall noise). */
  chooseBranch(player: Vec3, d: number): number {
    const outs = this.pack.out[this.junction];
    let best = outs[0], bestS = -Infinity;
    for (let i = 0; i < outs.length; i++) {
      const s = this.scoreEdge(outs[i], player) + this.params.sigma * this.rng.gauss();
      if (s > bestS) { bestS = s; best = outs[i]; }
    }
    this.lastScore = bestS;
    if (bestS < RUNNER_RULES.corneredScore && d < RUNNER_RULES.corneredBelow) this.events |= RE_CORNERED;
    this.events |= RE_BRANCH;
    return best;
  }

  /** One fixed step: rubber band, then playback / dwell. `d` = chase distance to the player. */
  step(player: Vec3, d: number): void {
    this.events = 0;
    const wasPanic = this.band.panic, wasGassed = this.band.gassed;
    const flinch = d < RUNNER_RULES.flinchBelow && this.headsAt(player);
    this.rate = stepBand(this.band, this.params, d, flinch, this.airborne, DT);
    if (this.band.panic && !wasPanic) this.events |= RE_PANIC;
    if (this.band.gassed && !wasGassed) this.events |= RE_GASSED;

    if (this.mode !== RM_EDGE) {
      this.dwell--;
      if (this.dwell > 0) return;
      if (this.mode === RM_LOOK || this.mode === RM_TAUNT) {
        this.next = this.chooseBranch(player, d);
        const e = this.pack.edges[this.next];
        this.headX = e.exitX;
        this.headZ = e.exitZ;
        this.mode = RM_TURN;
        this.dwell = RUNNER_RULES.turnSteps;
        this.lookAt = false;
        return;
      }
      // RM_TURN done: depart; this step is the first step of the outgoing edge.
      this.mode = RM_EDGE;
      this.edge = this.next;
      this.picks[1] = this.picks[0];
      this.picks[0] = this.edge;
      this.t = 0;
      this.headX = this.headZ = 0;
      this.events |= RE_DEPART;
    }
    const e = this.pack.edges[this.edge];
    this.t += DT * this.rate * this.params.base;
    if (this.t >= e.duration) {
      this.prevJunction = this.junction;
      this.junction = e.to;
      this.placeAtJunction(e.to);
      this.t = e.duration;
      this.events |= RE_ARRIVE;
      if (d > RUNNER_RULES.tauntAbove) {
        this.mode = RM_TAUNT;
        this.dwell = Math.floor(this.params.taunt * 120 + 0.5);
        this.events |= RE_TAUNT;
      } else {
        this.mode = RM_LOOK;
        this.dwell = RUNNER_RULES.lookSteps;
        this.lookAt = d < RUNNER_RULES.lookAtBelow;
      }
      return;
    }
    sampleEdge(e, this.t, this.pose);
    this.p.x = this.pose.x;
    this.p.y = this.pose.y;
    this.p.z = this.pose.z;
    this.roofId = this.pose.phase === PHASE_GROUND ? this.pose.ref : -1;
  }

  hash(h: Fnv1a = new Fnv1a()): Fnv1a {
    h.i32(this.mode).i32(this.edge).f64(this.t).i32(this.junction).i32(this.prevJunction).i32(this.dwell).i32(this.next);
    h.i32(this.picks[0]).i32(this.picks[1]).f64(this.band.m).f64(this.band.budget).i32(this.band.gassed ? 1 : 0);
    h.f64(this.p.x).f64(this.p.y).f64(this.p.z).i32(this.roofId).i32(this.rng.s);
    return h;
  }
}
