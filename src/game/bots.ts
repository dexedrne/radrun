// Balance / browser-test bots (spec §16 test 9, §20 item 9). Pure; shared by tools/balance, tests and
// app/dev/BotDriver. The follower and camper drive round.step() through a kinematic override:
//  - follower: from the player spawn straight to the runner's start junction, then along his recorded
//    trail at k x (owning edge's along-path speed x difficulty base), copying grounded/phase/roofId.
//  - camper: straight to the junction nearest the player spawn, then waits there.
// Aim = horizontal unit vector chest -> runner chest. yoink: press web on each step after one whose
// snapshot had ringId = RUNNER.
// The swinger (SwingBot, round 3) plays with the REAL player sim instead: see below.
import { chaseDist, emptyZipAim, pickRing, zipTarget, EV_BONK, EV_LAND, RING_RUNNER, type InputFrame } from "../sim/player.ts";
import { emptyAnchor } from "../world/cityQuery.ts";
import { DT } from "../sim/tuning.ts";
import { Rand, type Vec3 } from "../sim/math.ts";
import { PHASE_AIR, PHASE_GROUND, sampleEdge, type TrackPose } from "../route/trackPack.ts";
import { RM_EDGE, RM_TURN } from "../runner/runner.ts";
import type { CityModel } from "../world/cityModel.ts";
import type { Kinematic, Round } from "./round.ts";

export type BotKind = "follow" | "camper" | "swing";
/** k: follower speed factor (follow / camper); ignored by the swinger. */
/** moves (swing bot): also double-jumps off drops and web-zips toward him (tools/balance "+moves" rows). */
export type BotOptions = { kind: BotKind; k: number; yoink: boolean; moves?: boolean };

type TrailPt = { x: number; y: number; z: number; grounded: boolean; phase: number; roofId: number; speed: number };

export class Bot {
  readonly opts: BotOptions;
  readonly ov: Kinematic;
  private trail: TrailPt[] = [];
  /** Index of the trail point behind the bot and the metres travelled past it. */
  private i = 0;
  private u = 0;
  private leg: "straight" | "trail" | "wait" = "straight";
  private tx = 0;
  private ty = 0;
  private tz = 0;
  private tRoof = -1;
  private lastRing = -1;

  constructor(round: Round, opts: BotOptions) {
    this.opts = opts;
    const p = round.player.p;
    this.ov = { p: { x: p.x, y: p.y, z: p.z }, v: { x: 0, y: 0, z: 0 }, grounded: true, phase: PHASE_GROUND, roofId: round.player.roofId };
    const pack = round.pack;
    let j = round.startJunction;
    if (opts.kind === "camper") {
      let best = Infinity;
      pack.junctions.forEach((jn, i) => {
        const dx = jn.x - p.x, dz = jn.z - p.z;
        const d = dx * dx + dz * dz;
        if (d < best) { best = d; j = i; }
      });
    }
    const jn = pack.junctions[j];
    this.tx = jn.x; this.ty = jn.y; this.tz = jn.z; this.tRoof = jn.roof;
    // Round 11: with a head start he is already down his first run: the follower heads for where he is (his trail
    // starts there).
    const r = round.runner;
    if (opts.kind === "follow" && r.mode === RM_EDGE) { this.tx = r.p.x; this.ty = r.p.y; this.tz = r.p.z; this.tRoof = r.roofId; }
  }

  /**
   * Record the runner's pose into the trail (call once per step, after round.step). Round 9: each point keeps
   * his speed along the baked track right there (m per s of baked time: the step's move over the baked time it
   * took, DT x rate x base), not the edge's average: zips (26 m/s) and runs (9 m/s) now share an edge, and a
   * follower at the average speed would gain on every run.
   */
  private record(round: Round): void {
    const r = round.runner;
    const last = this.trail[this.trail.length - 1];
    let speed = r.edgeSpeed;
    if (last) {
      const dx = r.p.x - last.x, dy = r.p.y - last.y, dz = r.p.z - last.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-8) return;
      const bt = DT * r.rate * r.params.base;
      if (r.mode === RM_EDGE && bt > 1e-9 && this.lastStep === round.chaseSteps - 1) speed = Math.sqrt(d2) / bt;
    }
    this.lastStep = round.chaseSteps;
    this.trail.push({ x: r.p.x, y: r.p.y, z: r.p.z, grounded: r.pose.phase === PHASE_GROUND, phase: r.pose.phase, roofId: r.roofId, speed });
  }
  private lastStep = -2;

  /** Fill the input (aim, web) and the kinematic override for the next round step. */
  next(round: Round, inp: InputFrame): Kinematic {
    if (this.trail.length === 0) this.record(round);
    const o = this.ov, r = round.runner, base = round.runner.params.base;
    const px = o.p.x, py = o.p.y, pz = o.p.z;
    if (this.leg === "straight") {
      const speed = this.opts.k * r.edgeSpeed * base;
      const dx = this.tx - px, dy = this.ty - py, dz = this.tz - pz;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const s = speed * DT;
      if (dl <= s) {
        o.p.x = this.tx; o.p.y = this.ty; o.p.z = this.tz;
        o.grounded = true; o.phase = PHASE_GROUND; o.roofId = this.tRoof;
        this.leg = this.opts.kind === "camper" ? "wait" : "trail";
        this.i = 0; this.u = 0;
      } else {
        o.p.x += (dx / dl) * s; o.p.y += (dy / dl) * s; o.p.z += (dz / dl) * s;
        o.grounded = false; o.phase = PHASE_AIR; o.roofId = -1;
      }
    } else if (this.leg === "trail") {
      let s = 0;
      const t = this.trail;
      if (this.i < t.length - 1) s = this.opts.k * t[this.i].speed * base * DT;
      while (s > 0 && this.i < t.length - 1) {
        const a = t[this.i], b = t[this.i + 1];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (this.u + s < L) { this.u += s; s = 0; }
        else { s -= L - this.u; this.i++; this.u = 0; }
      }
      const a = t[this.i], b = t[Math.min(this.i + 1, t.length - 1)];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const f = L > 1e-9 ? this.u / L : 0;
      o.p.x = a.x + dx * f; o.p.y = a.y + dy * f; o.p.z = a.z + dz * f;
      o.grounded = a.grounded; o.phase = a.phase; o.roofId = a.roofId;
    }
    o.v.x = (o.p.x - px) / DT; o.v.y = (o.p.y - py) / DT; o.v.z = (o.p.z - pz) / DT;

    // Aim at him (horizontal), web on the step after a red ring.
    const ax = r.p.x - o.p.x, az = r.p.z - o.p.z;
    const al = Math.sqrt(ax * ax + az * az);
    inp.moveX = 0; inp.moveZ = 0;
    inp.aimX = al > 1e-9 ? ax / al : 1; inp.aimY = 0; inp.aimZ = al > 1e-9 ? az / al : 0;
    inp.jumpPressed = false;
    const press = this.opts.yoink && this.lastRing === RING_RUNNER;
    inp.webPressed = press;
    inp.webHeld = press;
    return o;
  }

  /** Call after round.step(). */
  after(round: Round): void {
    this.lastRing = round.player.ringId;
    this.record(round);
  }
}

// ---- swinging chaser -------------------------------------------------------------------------------
// A competent swinger for balance (round 3, round 9 building anchors): it plays through the real stepBody
// (no override) with the same InputFrame a human produces. Street lanes (the street midlines) are the
// highway: it picks the cheapest one- or two-lane route to where he will be up to 1.5 s from now, webs the
// building ahead from the roof edge, lets go once past the pivot on the way up (or lets the auto-release
// fling), re-holds after a cooldown, chains, turns at crossings, and near him heads straight at him, drops
// the rope and YOINKs after a human reaction delay. Wall runs happen by themselves when a swing meets a
// facade. Seeded noise (release point, reaction time) comes from its own Rand, never the round's.
// Deterministic: sqrt-only maths.

export type Lane = { along: 0 | 1; c: number; lo: number; hi: number };

const laneCache = new WeakMap<CityModel, Lane[]>();
/** Street lanes: along 0 = runs along x at z = c, along 1 = runs along z at x = c. */
export function streetLanes(model: CityModel): Lane[] {
  const hit = laneCache.get(model);
  if (hit) return hit;
  const map = new Map<string, Lane>();
  for (const a of model.adjacency) {
    if (a.kind !== "street") continue;
    const s = model.solids[a.a];
    const c = Math.round(((a.axis === "x" ? s.x1 : s.z1) + a.gap / 2) * 100) / 100;
    const along: 0 | 1 = a.axis === "x" ? 1 : 0;
    const key = `${along}:${c}`;
    const cur = map.get(key);
    if (!cur) map.set(key, { along, c, lo: a.lo, hi: a.hi });
    else { cur.lo = Math.min(cur.lo, a.lo); cur.hi = Math.max(cur.hi, a.hi); }
  }
  const lanes = [...map.values()].sort((p, q) => p.along - q.along || p.c - q.c);
  laneCache.set(model, lanes);
  return lanes;
}

/** Swinger constants (mutable so tools can sweep them; nothing in the game changes them). */
export const SWING = {
  /** Planning speeds (m/s): chained swings along a street, running on roofs. */
  laneSpeed: 16,
  runSpeed: 9,
  /** Planning: a turn at a crossing, dropping in from a roof (s). */
  turnCost: 0.6,
  entryCost: 0.3,
  /** Keep the current lane unless another route is this much faster (s). */
  switchMargin: 0.35,
  /** Half a street (m). */
  laneHalf: 7,
  /** Head straight at him when his predicted spot is this close (horizontal m) or d is below `engage`. */
  directBelow: 16,
  engage: 12,
  /** Let go of the rope this close to him (d, m) so the ring can go red. */
  dropRope: 7,
  /** Lead: up to this many seconds of his track, at `leadSpeed` m of distance per second of lead. */
  lead: 1.5,
  leadSpeed: 12,
  /** Release: once this far past the pivot along the lane (m, + noise), rising at least releaseTan x the horizontal speed. */
  releaseAhead: 0,
  releaseNoise: 0.6,
  releaseVy: -3,
  releaseTan: 0.4,
  /**
   * Round 11 (the timing lift): more than highAbove m above his predicted spot, a lane swing lets go as soon as it
   * rises (before the sweet spot: no lift), so the bot comes down to him instead of chaining ever higher.
   */
  highAbove: 6,
  /** A ringed anchor is worth a web when its pivot is this far ahead along the lane (m). */
  anchorAhead: 3,
  /** He is "up on the roofs" when this far above you (m): swings let go level with him (see upTo). */
  climbTo: 3,
  /** Steps without web after a release. */
  cooldown: 6,
  /** Round 9 (moves): climb-zip toward him when he is above and his predicted spot is within this (horizontal m). */
  climbReach: 40,
  /** Red ring -> click reaction, steps (uniform). */
  reactMin: 12,
  reactMax: 24,
  /** Take off this close to the roof edge (m). */
  edgeAt: 0.9,
  /** Vertigo: go straight at him (dropping off roofs) once he is this far below (m). */
  dropChase: 6,
  /** Vertigo air steering: nothing under the feet within landDrop m -> steer for a roof within landReach m. */
  landDrop: 8,
  landReach: 7,
  /** Vertigo: no gain on him for stuckFor steps -> the other plan (lanes / straight at him) for laneFor steps. */
  stuckFor: 360,
  laneFor: 480,
  /**
   * Round 11 stall watchdog (every district): on the rope this slowly (m/s) for ropeStallFor steps -> let go (a dead
   * pendulum under a tower never flings); still inside a stallBox m box for stallFor steps (and not closing in on him)
   * -> let go of the rope and switch plans (lanes <-> straight at him) for laneFor steps.
   */
  ropeStall: 2.5,
  ropeStallFor: 90,
  stallBox: 30,
  stallFor: 480,
  /** (A stall only counts when d did not drop by this many m since it entered the box.) */
  stallGain: 5,
  /** ...and for escapeFor steps no web at all: it runs / drops straight at him (a fall respawns it near him). */
  escapeFor: 240,
};

export type SwingStats = { swings: number; bonks: number; directSteps: number; laneSteps: number; laneSwitches: number; stalls: number };

const sign = (v: number) => (v < 0 ? -1 : 1);
const GAP_STREET = 0;
const GAP_HOP = 1;
const GAP_WALL = 2;
/** Round 7 (Vertigo): a landable roof well below across the gap. */
const GAP_DROP = 3;

export class SwingBot {
  readonly lanes: Lane[];
  readonly rng: Rand;
  readonly react: number;
  lane = -1;
  dir = 1;
  goal = 0;
  single = true;
  held = false;
  cool = 0;
  red = 0;
  relAhead: number = SWING.releaseAhead;
  readonly T: Vec3 = { x: 0, y: 0, z: 0 };
  readonly stats: SwingStats = { swings: 0, bonks: 0, directSteps: 0, laneSteps: 0, laneSwitches: 0, stalls: 0 };
  private pose: TrackPose = { x: 0, y: 0, z: 0, phase: 0, ref: -1 };
  private wasRope = false;
  /** Steps left sliding along a wall side (tower in the way), and that side's axis. */
  private blocked = 0;
  private blockAxis: 0 | 1 = 0;
  /** Round 7 (Vertigo) stuck check: closest chase distance lately, steps since it last dropped, steps left on the forced plan (+ lanes, - straight at him). */
  private bestD = Infinity;
  private since = 0;
  private laneFor = 0;
  private wasDirect = false;
  /** Round 11 stall watchdog: steps on a near-still rope; the box centre and the steps spent inside it. */
  private slowRope = 0;
  private stallX = NaN;
  private stallY = 0;
  private stallZ = 0;
  private stallN = 0;
  private stallD = 0;
  private escape = 0;

  /** Round 7: the city is a Vertigo skyline (big height steps). */
  readonly vertigo: boolean;

  /** Use the double jump + web zip + slide (balance rows only; the default bot plays the classic moves). */
  readonly moves: boolean;
  private readonly za = emptyZipAim();
  /** The anchor of the last ring() query. */
  private readonly anc = emptyAnchor();

  constructor(round: Round, seed: number, moves = false) {
    this.moves = moves;
    this.lanes = streetLanes(round.model);
    this.vertigo = !!round.model.config?.vertigo;
    this.rng = new Rand((seed ^ 0x51f15eed) >>> 0);
    this.react = SWING.reactMin + Math.floor(this.rng.next() * (SWING.reactMax - SWING.reactMin + 1));
    this.relAhead = SWING.releaseAhead + SWING.releaseNoise * (this.rng.next() * 2 - 1);
  }

  /** Where he will be `lead` s from now along his baked track (or where he dwells). */
  private predict(round: Round): void {
    const r = round.runner, P = round.player.p, T = this.T;
    const dx = r.p.x - P.x, dz = r.p.z - P.z;
    const tau = Math.min(SWING.lead, Math.sqrt(dx * dx + dz * dz) / SWING.leadSpeed);
    const pack = r.pack;
    if (r.mode === RM_EDGE) {
      const e = pack.edges[r.edge];
      sampleEdge(e, Math.min(e.duration, r.t + tau * r.rate * r.params.base), this.pose);
    } else if (r.mode === RM_TURN) {
      const e = pack.edges[r.next];
      sampleEdge(e, Math.max(0, tau - r.dwell * DT) * r.params.base, this.pose);
    } else {
      this.pose.x = r.p.x; this.pose.y = r.p.y; this.pose.z = r.p.z;
    }
    T.x = this.pose.x; T.y = this.pose.y; T.z = this.pose.z;
  }

  /** Cheapest one- or two-lane route to T (sets lane / goal / dir). */
  private plan(P: Vec3): void {
    const T = this.T, lanes = this.lanes;
    const V = SWING.laneSpeed, U = SWING.runSpeed, H = SWING.laneHalf;
    let best = Infinity, bl = -1, bgoal = 0, bsingle = true;
    for (let i = 0; i < lanes.length; i++) {
      const L = lanes[i];
      const pa = L.along === 0 ? P.x : P.z, pl = L.along === 0 ? P.z : P.x;
      const ta = L.along === 0 ? T.x : T.z, tl = L.along === 0 ? T.z : T.x;
      const off = Math.abs(pl - L.c);
      if (off > 24) continue;
      const entry = off > H ? (off - H) / U + SWING.entryCost : 0;
      let cost = entry + Math.abs(ta - pa) / V + Math.max(0, Math.abs(tl - L.c) - H) / U;
      let goal = ta, single = true;
      for (let j = 0; j < lanes.length; j++) {
        const M = lanes[j];
        if (M.along === L.along) continue;
        if (M.c < L.lo - 1 || M.c > L.hi + 1 || L.c < M.lo - 1 || L.c > M.hi + 1) continue;
        const c2 = entry + Math.abs(M.c - pa) / V + SWING.turnCost + Math.abs(tl - L.c) / V + Math.max(0, Math.abs(ta - M.c) - H) / U;
        if (c2 < cost) { cost = c2; goal = M.c; single = false; }
      }
      if (i === this.lane) cost -= SWING.switchMargin;
      if (cost < best) { best = cost; bl = i; bgoal = goal; bsingle = single; }
    }
    if (bl < 0) return;
    if (bl !== this.lane) this.stats.laneSwitches++;
    this.lane = bl;
    this.goal = bgoal;
    this.single = bsingle;
    const L = lanes[bl];
    const pa = L.along === 0 ? P.x : P.z;
    if (Math.abs(bgoal - pa) > 1) this.dir = sign(bgoal - pa);
  }

  /**
   * Grounded: distance to the roof edge along (mx, mz), the axis of that edge (0 = x face, 1 = z face)
   * and what lies past it: GAP_STREET (open air: zip / jump), GAP_HOP (a landable roof within 5.5 m at
   * about the same height: jump) or GAP_WALL (a tower or a much taller block: go around).
   */
  private edge(round: Round, mx: number, mz: number): { dist: number; axis: 0 | 1; gap: number } {
    const b = round.player, s = round.model.solids[b.roofId];
    if (!s) return { dist: Infinity, axis: 0, gap: GAP_STREET };
    let t = Infinity, axis: 0 | 1 = 0;
    if (mx > 1e-6) t = (s.x1 - b.p.x) / mx; else if (mx < -1e-6) t = (s.x0 - b.p.x) / mx;
    let tz = Infinity;
    if (mz > 1e-6) tz = (s.z1 - b.p.z) / mz; else if (mz < -1e-6) tz = (s.z0 - b.p.z) / mz;
    if (tz < t) { t = tz; axis = 1; }
    const ux = axis === 0 ? sign(mx) : 0, uz = axis === 1 ? sign(mz) : 0;
    const qx = b.p.x + mx * t + ux * 5.5, qz = b.p.z + mz * t + uz * 5.5;
    const top = round.index.groundBelow(qx, qz, 999);
    let gap = top > s.top + 3 ? GAP_WALL : top > s.top - 3 ? GAP_HOP : this.vertigo && top > 0.5 ? GAP_DROP : GAP_STREET;
    // Vertigo's outer ring is part of his route: past the city's edge there is nothing to swing on.
    const B = round.model.bounds;
    if (this.vertigo && (qx < B.x0 || qx > B.x1 || qz < B.z0 || qz > B.z1)) gap = GAP_WALL;
    return { dist: t, axis, gap };
  }

  /**
   * Grounded running with (mx, mz): at the roof edge hop an alley, jump-web onto a ringed building anchor over a
   * street (aim ax, az) or jump, and slide along a wall side (towers) instead of running into it.
   */
  private ground(round: Round, inp: InputFrame, mx: number, mz: number, ax: number, az: number, alongX: number, alongZ: number): boolean {
    if (this.blocked > 0) {
      this.blocked--;
      [mx, mz] = this.slide(round, mx, mz, alongX, alongZ);
    }
    this.setMove(inp, mx, mz);
    const e = this.edge(round, inp.moveX, inp.moveZ);
    if (e.dist >= SWING.edgeAt) return false;
    if (e.gap === GAP_HOP) { inp.jumpPressed = true; return false; }
    // Round 7: he is below and a lower roof is right there: step off and drop onto it.
    if (e.gap === GAP_DROP && this.T.y < round.player.p.y - 3) return false;
    if (e.gap === GAP_WALL) {
      // Round 7 (Vertigo): an anchor that way carries you over the cliff.
      if (this.vertigo) {
        this.setAim(inp, ax, az);
        if (this.ring(round, inp) >= 0) return true;
      }
      this.blocked = 90;
      this.blockAxis = e.axis;
      [mx, mz] = this.slide(round, mx, mz, alongX, alongZ);
      this.setMove(inp, mx, mz);
      return false;
    }
    this.setAim(inp, ax, az);
    if (this.ring(round, inp) >= 0) return true;
    inp.jumpPressed = true;
    return false;
  }

  /**
   * Along a wall side (blocked axis zeroed; `along` when nothing is left). Round 7 (Vertigo): when that
   * still points into the wall (he is straight across a cliff), slide sideways toward his side instead.
   */
  private slide(round: Round, mx: number, mz: number, alongX: number, alongZ: number): [number, number] {
    if (this.blockAxis === 0) mx = 0; else mz = 0;
    if (mx * mx + mz * mz < 1e-4) { mx = alongX; mz = alongZ; }
    if (this.vertigo) {
      const P = round.player.p, T = this.T;
      if (this.blockAxis === 0 && Math.abs(mx) >= Math.abs(mz)) { mx = 0; mz = T.z - P.z < 0 ? -1 : 1; }
      else if (this.blockAxis === 1 && Math.abs(mz) >= Math.abs(mx)) { mz = 0; mx = T.x - P.x < 0 ? -1 : 1; }
    }
    return [mx, mz];
  }

  /** Aim / move helpers (horizontal unit vectors). A zero aim keeps the last one (never the latch's). */
  private ax = 1;
  private az = 0;
  private setAim(inp: InputFrame, x: number, z: number): void {
    const l = Math.sqrt(x * x + z * z);
    if (l >= 1e-9) { this.ax = x / l; this.az = z / l; }
    inp.aimX = this.ax; inp.aimY = 0; inp.aimZ = this.az;
  }
  private setMove(inp: InputFrame, x: number, z: number): void {
    const l = Math.sqrt(x * x + z * z);
    if (l < 1e-9) { inp.moveX = 0; inp.moveZ = 0; return; }
    const f = l > 1 ? 1 / l : 1;
    inp.moveX = x * f; inp.moveZ = z * f;
  }

  /**
   * He is up on the roofs above you (more than climbTo m) and this swing is rising level with him: let go now
   * so the fling carries you up onto the roofs instead of down the canyon again.
   */
  private upTo(round: Round): boolean {
    const b = round.player, P = b.p, T = this.T;
    if (b.ropeSolid < 0 || b.v.y <= 0 || T.y <= P.y + SWING.climbTo) return false;
    const hs = Math.sqrt(b.v.x * b.v.x + b.v.z * b.v.z);
    if (hs < 4) return false;
    // Rising within climbTo of his height, or near the top of this arc (the pivot's height minus a few m).
    return P.y >= T.y - SWING.climbTo || P.y >= b.ropeP.y - round.tuning.autoReleaseBelow - 2;
  }

  /** The ring the sim will compute this step with this input (its anchor in this.anc). */
  private ring(round: Round, inp: InputFrame): number {
    const b = round.player;
    this.anc.solid = -1;
    return b.ropeSolid >= 0 ? b.ropeSolid : pickRing(b, inp, round.tuning, round.world, this.anc);
  }

  /**
   * Rescue: falling with no roof close below and no rope - look for a ring along the velocity, toward him
   * and straight ahead (the aim that rings something wins) and grab it.
   */
  private rescue(round: Round, inp: InputFrame): boolean {
    const b = round.player, P = b.p;
    if (b.grounded || b.ropeSolid >= 0 || b.v.y > -2 || b.wallMode > 0 || b.ledgeMode > 0) return false;
    const floor = round.index.groundBelow(P.x, P.z, P.y);
    if (floor > P.y - 3) return false; // a roof right below
    // Vertigo, him far below: fall (free fall) until close to his height, then grab.
    const diving = this.vertigo && this.T.y < P.y - SWING.dropChase;
    if (diving && P.y > this.T.y + 12) return false;
    const tx = this.T.x - P.x, tz = this.T.z - P.z;
    const aims: [number, number][] = diving ? [[tx, tz], [b.v.x, b.v.z]] : [[b.v.x, b.v.z], [tx, tz], [this.ax, this.az]];
    for (const [x, z] of aims) {
      if (x * x + z * z < 1e-6) continue;
      this.setAim(inp, x, z);
      if (this.ring(round, inp) >= 0) return true;
    }
    return false;
  }

  /**
   * Round 7 (Vertigo): airborne off a rope with a long drop under the feet (an alley between cliffs):
   * steer for the nearest landable roof below within reach instead of drifting down a wall.
   */
  private steerLand(round: Round, inp: InputFrame): void {
    const b = round.player, P = b.p;
    if (b.grounded || b.ropeSolid >= 0 || b.v.y > 0) return;
    if (round.index.groundBelow(P.x, P.z, P.y) > P.y - SWING.landDrop) return;
    let best = Infinity, bx = 0, bz = 0;
    for (const s of round.model.solids) {
      if (!s.landable || s.top > P.y - 0.5) continue;
      const cx = Math.min(Math.max(P.x, s.x0 + 1.5), s.x1 - 1.5), cz = Math.min(Math.max(P.z, s.z0 + 1.5), s.z1 - 1.5);
      const h = Math.hypot(cx - P.x, cz - P.z);
      if (h > SWING.landReach) continue;
      // Nearer first; a roof about his height counts as nearer (m per m of height off his).
      const c = h + 0.15 * Math.abs(s.top - this.T.y);
      if (c < best) { best = c; bx = cx - P.x; bz = cz - P.z; }
    }
    if (best < Infinity) this.setMove(inp, bx, bz);
  }

  /** Fill the input for the next round step; returns null (no kinematic override). */
  next(round: Round, inp: InputFrame): null {
    const b = round.player, r = round.runner, P = b.p;
    inp.jumpPressed = false;
    inp.webPressed = false;
    inp.aimX = this.ax; inp.aimY = 0; inp.aimZ = this.az;
    if (this.cool > 0) this.cool--;
    this.predict(round);
    const T = this.T;
    const d = chaseDist(P, r.p);
    const tx = T.x - P.x, tz = T.z - P.z, th = Math.sqrt(tx * tx + tz * tz);
    let held = false;
    let zip = false;
    // Lane planning first; with no street lane within reach (wide docks blocks) head straight at him.
    let direct = d < SWING.engage || th < SWING.directBelow;
    // Round 7 (Vertigo): the street lanes are flat plans; with him well below, head straight at him and drop.
    // Stuck (no gain on him for stuckFor steps): switch plans for a while - behind a cliff going straight
    // at him -> the street lanes; circling on the lanes -> straight at him.
    if (this.vertigo) {
      if (d < this.bestD - 2) { this.bestD = d; this.since = 0; } else this.since++;
      if (this.laneFor > 0) this.laneFor--; else if (this.laneFor < 0) this.laneFor++;
      else if (this.since > SWING.stuckFor) { this.laneFor = this.wasDirect ? SWING.laneFor : -SWING.laneFor; this.bestD = d; this.since = 0; }
      if (this.laneFor < 0 || (this.laneFor === 0 && T.y < P.y - SWING.dropChase)) direct = true;
    }
    // Round 11 stall watchdog (every district): stuck in one small box for stallFor steps -> the other plan for a
    // while (and let go of the rope below).
    let stall = false;
    const ex = P.x - this.stallX, ey = P.y - this.stallY, ez = P.z - this.stallZ, eb = SWING.stallBox / 2;
    if (d < SWING.engage || !(ex >= -eb && ex <= eb && ey >= -eb && ey <= eb && ez >= -eb && ez <= eb)) { this.stallX = P.x; this.stallY = P.y; this.stallZ = P.z; this.stallN = 0; this.stallD = d; }
    else if (++this.stallN > SWING.stallFor && d > this.stallD - SWING.stallGain) {
      stall = true;
      this.stats.stalls++;
      this.stallN = 0;
      this.laneFor = this.wasDirect ? SWING.laneFor : -SWING.laneFor;
      this.bestD = d; this.since = 0;
      this.escape = SWING.escapeFor;
    }
    if (this.escape > 0) {
      // Escape: no web, straight at him (jumping off the roof edge that way).
      this.escape--;
      this.lane = -1;
      this.setAim(inp, r.p.x - P.x, r.p.z - P.z);
      this.setMove(inp, tx, tz);
      if (b.grounded && this.edge(round, inp.moveX, inp.moveZ).dist < SWING.edgeAt) inp.jumpPressed = true;
      this.held = false;
      inp.webHeld = false;
      inp.zipPressed = false;
      inp.slidePressed = false;
      return null;
    }
    if (!this.vertigo && this.laneFor !== 0) {
      if (this.laneFor > 0) this.laneFor--; else this.laneFor++;
      if (this.laneFor < 0) direct = true;
    }
    if (!direct) { this.plan(P); if (this.lane < 0) direct = true; }
    this.wasDirect = direct;
    if (direct) {
      // ---- straight at him --------------------------------------------------------------------------
      this.stats.directSteps++;
      this.lane = -1;
      this.setAim(inp, r.p.x - P.x, r.p.z - P.z);
      this.setMove(inp, tx, tz);
      if (b.ropeSolid >= 0) {
        const h = b.ropeP;
        const past = (P.x - h.x) * tx + (P.z - h.z) * tz;
        held = !(d < SWING.dropRope || this.upTo(round) || (past >= 0 && b.v.y >= SWING.releaseVy && T.y <= P.y + SWING.climbTo));
      } else if (!b.grounded) {
        if (this.cool <= 0 && this.rescue(round, inp)) held = true;
        else this.setAim(inp, r.p.x - P.x, r.p.z - P.z);
        if (!held && this.vertigo) this.steerLand(round, inp);
      } else {
        zip = this.ground(round, inp, tx, tz, tx, tz, tx, tz);
        if (zip && th < 6) zip = false;
      }
    } else {
      // ---- down the streets -------------------------------------------------------------------------
      this.stats.laneSteps++;
      const L = this.lanes[this.lane];
      const al = L.along;
      const pa = al === 0 ? P.x : P.z, pl = al === 0 ? P.z : P.x;
      const dx = al === 0 ? this.dir : 0, dz = al === 0 ? 0 : this.dir;
      const lat = Math.min(0.8, Math.max(-0.8, (L.c - pl) * 0.25));
      const lx = al === 0 ? 0 : lat, lz = al === 0 ? lat : 0;
      this.setAim(inp, dx, dz);
      if (b.grounded) {
        // Run to the street edge a little ahead, then jump-web onto a building anchor (or hop an alley).
        const side = sign(L.c - pl);
        const tlat = L.c - side * (SWING.laneHalf - 0.2);
        const mx = al === 0 ? dx * 5 : tlat - P.x, mz = al === 0 ? tlat - P.z : dz * 5;
        zip = this.ground(round, inp, mx, mz, dx + (al === 0 ? 0 : side * 0.4), dz + (al === 0 ? side * 0.4 : 0), dx, dz);
      } else if (b.ropeSolid >= 0) {
        this.setMove(inp, dx + lx, dz + lz);
        const ha = al === 0 ? b.ropeP.x : b.ropeP.z;
        const past = (pa - ha) * this.dir;
        const hs = Math.sqrt(b.v.x * b.v.x + b.v.z * b.v.z);
        const high = P.y > T.y + SWING.highAbove;
        held = !(this.upTo(round) || (past >= this.relAhead && b.v.y > 0 && (high || b.v.y >= SWING.releaseTan * hs) && T.y <= P.y + SWING.climbTo));
      } else {
        this.setMove(inp, dx + lx, dz + lz);
        if (this.cool <= 0 && b.ledgeMode === 0) {
          if (this.ring(round, inp) >= 0) {
            const a = this.anc;
            const ha = al === 0 ? a.px : a.pz;
            if ((ha - pa) * this.dir > SWING.anchorAhead) held = true;
          }
          if (!held && this.rescue(round, inp)) held = true;
        }
        if (!held && this.vertigo) this.steerLand(round, inp);
      }
    }
    // Round 11: a near-still pendulum (hanging under the anchor) or a stall: let go.
    if (b.ropeSolid >= 0) {
      const sp = Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z);
      this.slowRope = sp < SWING.ropeStall ? this.slowRope + 1 : 0;
      if (this.slowRope > SWING.ropeStallFor || stall) { held = false; this.slowRope = 0; }
    } else this.slowRope = 0;
    // Round 9 (moves): he is up on the roofs and a ledge toward him is in zip reach - let go now, zip next step.
    const climb = this.moves && this.climbZip(round, inp);
    if (climb) held = false;
    if (this.held && !held && b.ropeSolid >= 0) {
      this.cool = SWING.cooldown;
      this.relAhead = SWING.releaseAhead + SWING.releaseNoise * (this.rng.next() * 2 - 1);
    }
    this.held = held;
    inp.webHeld = held || zip;
    inp.webPressed = zip || (held && !this.held);
    inp.zipPressed = false;
    inp.slidePressed = false;
    if (this.moves) this.useMoves(round, inp, d, held);
    if (climb) { inp.zipPressed = b.ropeSolid < 0; inp.webPressed = false; inp.webHeld = false; inp.jumpPressed = false; this.setAim(inp, this.zx, this.zz); }
    // YOINK: a red ring held for the reaction time -> click.
    if (this.ring(round, inp) === RING_RUNNER) {
      if (++this.red >= this.react) { inp.webPressed = true; inp.webHeld = true; }
    } else this.red = 0;
    return null;
  }

  /** Round 9 climb-zip aim (horizontal). */
  private zx = 1;
  private zz = 0;

  /**
   * Round 9 (moves): airborne or swinging while he is more than climbTo m above - the ledge zip toward his
   * predicted spot (a ringed rim of a roof, else a roof ledge under the aim) when it lands higher than you are.
   */
  private climbZip(round: Round, inp: InputFrame): boolean {
    const b = round.player, P = b.p, T = this.T;
    if (b.grounded || b.zipOn || b.zipCd > 0 || b.ledgeMode > 0 || T.y <= P.y + SWING.climbTo) return false;
    const tx = T.x - P.x, tz = T.z - P.z, tl = Math.sqrt(tx * tx + tz * tz);
    if (tl < 1e-6 || tl > SWING.climbReach) return false;
    const ax = inp.aimX, az = inp.aimZ;
    inp.aimX = tx / tl; inp.aimZ = tz / tl;
    this.anc.solid = -1;
    const ring = pickRing(b, inp, round.tuning, round.world, this.anc);
    const k = zipTarget(b, ring >= 0 ? this.anc : null, inp.aimX, inp.aimZ, round.tuning, round.world, this.za);
    inp.aimX = ax; inp.aimZ = az;
    if (k !== 2 || this.za.y < P.y + 1) return false;
    this.zx = tx / tl; this.zz = tz / tl;
    return true;
  }

  /**
   * Double jump when dropping with no roof close below (or a wall kick when a facade is in grace); web-zip
   * toward him (ringed anchor or a ledge) from a roof when he is on another roof 8+ m away and the zip is
   * ready; slide on landing fast (keeps the speed).
   */
  private useMoves(round: Round, inp: InputFrame, d: number, held: boolean): void {
    const b = round.player, P = b.p, r = round.runner;
    if (!b.grounded && b.ropeSolid < 0 && !b.zipOn && b.ledgeMode === 0 && b.airJumps > 0 && b.v.y < -3 && !held) {
      if (round.index.groundBelow(P.x, P.z, P.y) < P.y - 4) inp.jumpPressed = true;
    }
    if (b.grounded && (b.events & EV_LAND) && Math.sqrt(b.v.x * b.v.x + b.v.z * b.v.z) >= round.tuning.slideMinSpeed + 1) inp.slidePressed = true;
    if (b.grounded && !b.zipOn && b.zipCd <= 0 && d > 8 && r.roofId !== b.roofId) {
      const ax = this.ax, az = this.az;
      this.setAim(inp, this.T.x - P.x, this.T.z - P.z);
      const ring = this.ring(round, inp);
      if (zipTarget(b, ring >= 0 ? this.anc : null, inp.aimX, inp.aimZ, round.tuning, round.world, this.za) > 0) inp.zipPressed = true;
      else this.setAim(inp, ax, az);
    }
  }

  after(round: Round): void {
    const b = round.player;
    if (b.ropeSolid >= 0 && !this.wasRope) this.stats.swings++;
    if (b.events & EV_BONK) this.stats.bonks++;
    this.wasRope = b.ropeSolid >= 0;
  }
}

export type BotRun = { caught: boolean; kind: string; time: number; steps: number; falls: number; closest: number; swing?: SwingStats };

/** Run a whole round with a bot (no countdown). */
export function runBotRound(round: Round, opts: BotOptions, inp: InputFrame): BotRun {
  const bot = opts.kind === "swing" ? new SwingBot(round, round.opts.seed, opts.moves ?? false) : new Bot(round, opts);
  let guard = 0;
  while (!round.over && guard++ < 20000) {
    const ov = bot.next(round, inp);
    round.step(inp, ov);
    bot.after(round);
  }
  return {
    caught: round.phase === "caught", kind: round.stats.catchKind, time: round.stats.catchTime, steps: round.chaseSteps, falls: round.stats.falls, closest: round.stats.closest,
    swing: bot instanceof SwingBot ? bot.stats : undefined,
  };
}
