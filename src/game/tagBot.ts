// Spider-tag bots: the round-12 SwingBot (the full kit: swings, zips, charged leaps, the yank, tech releases) driven by
// role. Holding the bag it chases its match target (the nearest runner); running it swings to a flee roof: a
// junction roof far from the holder, not past him, re-picked every 1.5 s or when reached / cut off.
//
// The SwingBot reads a Round (its player body, "the runner" = where it is going, the tuning, the world). A small view
// object stands in for that Round; the bot never writes to it. Its input goes through the 41-bit word like a human's,
// so a bot slot replays and runs online exactly like a player slot. Deterministic: no Math.random, sqrt-only maths.
import { SwingBot } from "./bots.ts";
import { RM_LOOK } from "../runner/runner.ts";
import { chaseDist, emptyInput, WALL_UP, type Body, type InputFrame, type SimWorld } from "../sim/player.ts";
import type { Tuning } from "../sim/tuning.ts";
import type { CityIndex, CityModel } from "../world/cityModel.ts";
import type { Vec3 } from "../sim/math.ts";
import { emptyRec, recFromFrame } from "./ghost.ts";
import { packWord } from "../net/wire.ts";
import type { Round } from "./round.ts";
import type { TagMatch } from "./tagMatch.ts";

/**
 * Bot levels (offline Spider-tag): a runner bot only starts fleeing once the holder is within `alert` m (after `react`
 * steps); until then it stands and watches him. Holding the bag every level chases flat out.
 */
export type BotLevel = "chill" | "normal" | "sharp";
export const BOT_LEVELS: Record<BotLevel, { alert: number; react: number; moves: boolean; tech: boolean }> = {
  /** The classic swinger (no zip / leap / tech), flees once you are within 45 m. */
  chill: { alert: 45, react: 45, moves: false, tech: false },
  /** The full kit, flees within 75 m. */
  normal: { alert: 75, react: 20, moves: true, tech: false },
  /** The full kit plus the tech timing (perfect releases, rebounds, dives, long yanks); always on the run. */
  sharp: { alert: Infinity, react: 0, moves: true, tech: true },
};
/** Holding the bag, a bot aims this many seconds ahead of its target (up to leadMax s, at leadPer m per s of lead). */
export const CHASE = { leadMax: 1.0, leadPer: 25, leadFrom: 15 };

/**
 * Holding the bag, a climb up a wall that tops out more than climbAbove m over its target is a detour (the swing bot
 * goes over a tower that is in the way): it kicks off sideways, toward him, and goes round instead.
 */
export const UNSTICK = { climbAbove: 15, kickOut: 0.6 };

/** Flee planning (mutable for tools). */
export const FLEE = {
  /** Re-pick the flee roof this often (steps), when this close to it (m) or when the holder is closer to it than you. */
  every: 180,
  reached: 14,
  /** Candidate roofs this far from you (m). */
  near: 25,
  far: 110,
  /** Score = distance from the holder - awayMe x distance from you. */
  awayMe: 0.6,
  /** Never a roof in the holder's direction (cosine between "to it" and "to him" above this). */
  cone: 0.25,
};

type View = {
  model: CityModel;
  index: CityIndex;
  tuning: Tuning;
  world: SimWorld;
  player: Body;
  runner: { p: Vec3; roofId: number; mode: number; pack: null; headX: number; headZ: number };
  prevRunner: Vec3;
  opts: { seed: number };
};

export class TagBot {
  readonly slot: number;
  private readonly view: View;
  private readonly chaser: SwingBot;
  private readonly runner: SwingBot;
  private bot: SwingBot;
  private readonly frame: InputFrame = emptyInput();
  private readonly rec = emptyRec();
  private readonly goal: Vec3 = { x: 0, y: 0, z: 0 };
  private goalRoof = -1;
  private replan = 0;
  private wasHolder = false;
  private readonly cands: number[];
  readonly level: BotLevel;
  /** Steps the holder has been inside the alert radius (fleeing starts at level.react). */
  private alerted = 0;
  private fleeing = false;

  constructor(m: TagMatch, slot: number, seed: number, level: BotLevel = "sharp") {
    this.slot = slot;
    this.level = level;
    this.view = {
      model: m.model, index: m.index, tuning: m.tunings[slot], world: m.worlds[slot], player: m.bodies[slot],
      runner: { p: { x: 0, y: 0, z: 0 }, roofId: -1, mode: RM_LOOK, pack: null, headX: 0, headZ: 0 },
      prevRunner: { x: 0, y: 0, z: 0 }, opts: { seed },
    };
    const L = BOT_LEVELS[level];
    // Holding the bag every level has the full kit (the yank closes chases); running, the level's kit.
    this.chaser = new SwingBot(this.view as unknown as Round, seed, true, L.tech);
    this.runner = new SwingBot(this.view as unknown as Round, (seed ^ 0x2545f491) >>> 0, L.moves, L.tech);
    this.bot = this.runner;
    this.cands = m.model.junctionCandidates.filter(id => m.model.solids[id]?.kind === "roof");
  }

  /** The input word for the match's next step (call after the previous step, before stepWords). */
  next(m: TagMatch): number {
    const v = this.view, s = this.slot, b = m.bodies[s];
    v.player = b;
    v.world = m.worlds[s];
    m.updateTargets();
    const holder = m.holder === s;
    const r = v.runner, pr = v.prevRunner;
    pr.x = r.p.x; pr.y = r.p.y; pr.z = r.p.z;
    if (holder) {
      // Chase: its target, else (tangled, or only the tag-back player left) the nearest other Radbro.
      let t = m.target[s];
      if (t < 0) {
        let best = Infinity;
        for (let i = 0; i < m.n; i++) if (i !== s) { const d = chaseDist(b.p, m.bodies[i].p); if (d < best) { best = d; t = i; } }
      }
      const q = m.bodies[t];
      // Lead a far target along its velocity (cut the corner); close in, go at the body itself.
      const d = chaseDist(b.p, q.p);
      const lead = d > CHASE.leadFrom ? Math.min(CHASE.leadMax, (d - CHASE.leadFrom) / CHASE.leadPer) : 0;
      r.p.x = q.p.x + q.v.x * lead; r.p.y = q.p.y; r.p.z = q.p.z + q.v.z * lead;
      r.roofId = q.grounded ? q.roofId : -1;
      if (!this.wasHolder) { pr.x = r.p.x; pr.y = r.p.y; pr.z = r.p.z; }
    } else {
      // Not fleeing yet (lower levels, the holder still far): stand and watch him.
      const L = BOT_LEVELS[this.level], hp = m.bodies[m.holder].p;
      const near = chaseDist(b.p, hp) < L.alert;
      this.alerted = near ? this.alerted + 1 : 0;
      if (this.alerted > L.react) this.fleeing = true;
      else if (!near && this.fleeing && chaseDist(b.p, hp) > L.alert * 1.5) this.fleeing = false;
      if (!this.fleeing && b.grounded && !this.wasHolder) {
        const f = this.frame;
        f.moveX = f.moveZ = 0;
        f.jumpPressed = f.webHeld = f.webPressed = f.zipPressed = f.slidePressed = f.slideHeld = false;
        const dx = hp.x - b.p.x, dz = hp.z - b.p.z, dl = Math.sqrt(dx * dx + dz * dz);
        if (dl > 1e-6) { f.aimX = dx / dl; f.aimZ = dz / dl; }
        f.aimY = 0;
        this.wasHolder = false;
        recFromFrame(this.rec, f);
        return packWord(this.rec);
      }
      this.flee(m, b);
      r.p.x = this.goal.x; r.p.y = this.goal.y; r.p.z = this.goal.z;
      r.roofId = this.goalRoof;
      if (this.wasHolder) { pr.x = r.p.x; pr.y = r.p.y; pr.z = r.p.z; }
    }
    if (holder) { this.fleeing = true; this.alerted = 0; this.chaser.yankAway = m.heat > 0; }
    this.wasHolder = holder;
    this.bot = holder ? this.chaser : this.runner;
    const f = this.frame;
    this.bot.next(v as unknown as Round, f);
    if (holder && b.wallMode === WALL_UP) this.unstick(m, b, f);
    recFromFrame(this.rec, f);
    return packWord(this.rec);
  }

  /** Holding the bag, climbing a wall far higher than the target: kick off it along the wall toward him. */
  private unstick(m: TagMatch, b: Body, f: InputFrame): void {
    const top = m.model.solids[b.wallSolid]?.top ?? -Infinity;
    const q = m.bodies[m.target[this.slot] >= 0 ? m.target[this.slot] : this.nearest(m, b)].p;
    if (top < q.y + UNSTICK.climbAbove) return;
    const nx = b.wallNx, nz = b.wallNz, dx = q.x - b.p.x, dz = q.z - b.p.z;
    const sgn = dx * -nz + dz * nx >= 0 ? 1 : -1;
    let mx = -nz * sgn + nx * UNSTICK.kickOut, mz = nx * sgn + nz * UNSTICK.kickOut;
    const l = Math.sqrt(mx * mx + mz * mz) || 1;
    mx /= l; mz /= l;
    f.moveX = mx; f.moveZ = mz; f.aimX = mx; f.aimZ = mz; f.aimY = 0;
    f.jumpPressed = true; f.webPressed = f.webHeld = f.zipPressed = false;
  }

  private nearest(m: TagMatch, b: Body): number {
    let t = -1, best = Infinity;
    for (let i = 0; i < m.n; i++) if (i !== this.slot) { const d = chaseDist(b.p, m.bodies[i].p); if (d < best) { best = d; t = i; } }
    return t;
  }

  /** After the match stepped (the bot's per-step bookkeeping). */
  after(): void {
    this.bot.after(this.view as unknown as Round);
  }

  private flee(m: TagMatch, b: Body): void {
    const H = m.bodies[m.holder].p, P = b.p, model = m.model;
    const gx = this.goal.x - P.x, gz = this.goal.z - P.z;
    const hx = this.goal.x - H.x, hz = this.goal.z - H.z;
    const reached = gx * gx + gz * gz < FLEE.reached * FLEE.reached;
    const cut = hx * hx + hz * hz < gx * gx + gz * gz;
    if (this.goalRoof >= 0 && --this.replan > 0 && !reached && !cut) return;
    this.replan = FLEE.every;
    const tx = H.x - P.x, tz = H.z - P.z, tl = Math.sqrt(tx * tx + tz * tz) || 1;
    let best = -1, bestS = -Infinity, far = -1, farD = -1;
    for (const id of this.cands) {
      const s = model.solids[id];
      const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
      const dx = cx - P.x, dz = cz - P.z, dm = Math.sqrt(dx * dx + dz * dz);
      const ex = cx - H.x, ez = cz - H.z, dh = Math.sqrt(ex * ex + ez * ez);
      if (dh > farD) { farD = dh; far = id; }
      if (dm < FLEE.near || dm > FLEE.far) continue;
      if ((dx * tx + dz * tz) / (dm * tl) > FLEE.cone) continue;
      const sc = dh - FLEE.awayMe * dm;
      if (sc > bestS) { bestS = sc; best = id; }
    }
    const id = best >= 0 ? best : far;
    if (id < 0) return;
    const s = model.solids[id];
    this.goalRoof = id;
    this.goal.x = (s.x0 + s.x1) / 2; this.goal.z = (s.z0 + s.z1) / 2; this.goal.y = s.top + 0.9;
  }
}
