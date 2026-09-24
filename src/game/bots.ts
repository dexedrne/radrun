// Balance / browser-test bots (spec §16 test 9, §20 item 9). Pure; shared by tools/balance, tests and
// app/dev/BotDriver. They drive round.step() through a kinematic override.
//  - follower: from the player spawn straight to the runner's start junction, then along his recorded
//    trail at k x (owning edge's along-path speed x difficulty base), copying grounded/phase/roofId.
//  - camper: straight to the junction nearest the player spawn, then waits there.
// Aim = horizontal unit vector chest -> runner chest. yoink: press web on each step after one whose
// snapshot had ringId = RUNNER.
import { RING_RUNNER, type InputFrame } from "../sim/player.ts";
import { DT } from "../sim/tuning.ts";
import { PHASE_AIR, PHASE_GROUND } from "../route/trackPack.ts";
import type { Kinematic, Round } from "./round.ts";

export type BotKind = "follow" | "camper";
export type BotOptions = { kind: BotKind; k: number; yoink: boolean };

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
  }

  /** Record the runner's pose into the trail (call once per step, after round.step). */
  private record(round: Round): void {
    const r = round.runner;
    const last = this.trail[this.trail.length - 1];
    if (last) {
      const dx = r.p.x - last.x, dy = r.p.y - last.y, dz = r.p.z - last.z;
      if (dx * dx + dy * dy + dz * dz < 1e-8) return;
    }
    this.trail.push({ x: r.p.x, y: r.p.y, z: r.p.z, grounded: r.pose.phase === PHASE_GROUND, phase: r.pose.phase, roofId: r.roofId, speed: r.edgeSpeed });
  }

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

export type BotRun = { caught: boolean; kind: string; time: number; steps: number; falls: number; closest: number };

/** Run a whole round with a bot (no countdown). */
export function runBotRound(round: Round, opts: BotOptions, inp: InputFrame): BotRun {
  const bot = new Bot(round, opts);
  let guard = 0;
  while (!round.over && guard++ < 20000) {
    const ov = bot.next(round, inp);
    round.step(inp, ov);
    bot.after(round);
  }
  return { caught: round.phase === "caught", kind: round.stats.catchKind, time: round.stats.catchTime, steps: round.chaseSteps, falls: round.stats.falls, closest: round.stats.closest };
}
