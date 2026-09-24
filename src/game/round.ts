// One chase round (spec §3, §7, §20): seeded setup (start junction, first edge, player spawn), then a
// fixed-step orchestration: player stepBody (or a bot's kinematic override) -> rubber band + runner ->
// Yoink / tag / fall / timer checks -> stats. Pure TS outside React; the determinism rule applies.
import { Fnv1a, Rand, type Vec3 } from "../sim/math.ts";
import {
  chaseDist, cloneBody, copyBody, createBody, hashBody, pickTarget, stepBody, EV_FALL, RING_NONE, RING_RUNNER,
  type Body, type InputFrame, type SimWorld,
} from "../sim/player.ts";
import { DT, ROUND, type Difficulty, type DifficultyParams, type Tuning } from "../sim/tuning.ts";
import { CityIndex, type CityModel } from "../world/cityModel.ts";
import type { Pack } from "../route/trackPack.ts";
import { Runner } from "../runner/runner.ts";

export type RadbroId = "652" | "4764" | "2564";
export const RADBROS: readonly RadbroId[] = ["652", "4764", "2564"];

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
};

export const COUNTDOWN_STEPS = 360;

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
  /** Clock remaining, seconds. */
  clock: number = ROUND.seconds;
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
    this.tuning = { ...o.tuning, yoinkRange: o.params.yoinkRange };
    this.rng = new Rand(o.seed);
    const pack = o.pack;
    const nj = pack.junctions.length;
    this.startJunction = Math.floor(this.rng.next() * nj);
    const outs = pack.out[this.startJunction];
    const first = outs[Math.floor(this.rng.next() * outs.length)];
    this.runner = new Runner(pack, { ...o.params }, this.rng, this.startJunction, first);
    this.spawn = playerSpawn(this.model, pack, this.startJunction, first, 22 + 4 * this.rng.next());
    this.player = createBody(this.spawn.x, this.spawn.y, this.spawn.z, this.spawn.roofId);
    this.prevPlayer = cloneBody(this.player);
    this.prevRunner.x = this.runner.p.x; this.prevRunner.y = this.runner.p.y; this.prevRunner.z = this.runner.p.z;
    this.world = { index: this.index, hooks: this.model.hooks, lowestRoof: this.model.lowestRoof, runner: { p: this.runner.p, roofId: -1 } };
    this.phase = o.countdown === false ? "chase" : "countdown";
    this.countdown = o.countdown === false ? 0 : COUNTDOWN_STEPS;
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
      st.catchTime = ROUND.seconds - this.clock;
      this.events |= RV_CAUGHT | (yoink ? RV_YOINK : 0);
      return;
    }

    // 5. Fall: respawn on the last safe roof at the point nearest him, -3 s.
    if (b.events & EV_FALL) {
      st.falls++;
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

  hash(): string {
    const h = new Fnv1a();
    hashBody(this.player, h);
    this.runner.hash(h);
    h.f64(this.clock).i32(this.chaseSteps).i32(this.countdown).str(this.phase).i32(this.stats.falls).i32(this.stats.maxChain);
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
export function playerSpawn(model: CityModel, pack: Pack, junction: number, firstEdge: number, dist: number): { roofId: number; x: number; y: number; z: number; yaw: number } {
  const j = pack.junctions[junction];
  const e = pack.edges[firstEdge];
  const jr = j.roof;
  const inset = ROUND.respawnInset;
  // Ideal point: `dist` m behind him, opposite his first edge's exit; take the roof whose (inset)
  // footprint gets closest to it.
  const qx = j.x - e.exitX * dist, qz = j.z - e.exitZ * dist;
  let best = -1, bestS = Infinity, x = j.x, z = j.z;
  // Adjacent roofs first; any other landable roof only if it gets > 3 m closer (e.g. a tower is in the way).
  const adjacent = new Set<number>();
  for (const a of model.adjacency) if (a.a === jr || a.b === jr) adjacent.add(a.a === jr ? a.b : a.a);
  for (const s of model.solids) {
    const other = s.id;
    if (!s.landable || other === jr) continue;
    const cx = Math.min(Math.max(qx, s.x0 + inset), s.x1 - inset);
    const cz = Math.min(Math.max(qz, s.z0 + inset), s.z1 - inset);
    const dq = Math.sqrt((cx - qx) * (cx - qx) + (cz - qz) * (cz - qz));
    const dd = adjacent.has(other) ? dq : dq + 3;
    if (dd < bestS - 1e-9 || (dd < bestS + 1e-9 && other < best)) { bestS = dd; best = other; x = cx; z = cz; }
  }
  const roof = model.solids[best >= 0 ? best : jr];
  // yaw convention (camera/rig.ts): forward = (-sin yaw, -cos yaw). Cosmetic, outside the sim.
  const yaw = Math.atan2(-(j.x - x), -(j.z - z));
  return { roofId: roof.id, x, y: roof.top + 0.9, z, yaw };
}
