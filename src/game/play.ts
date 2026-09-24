// The play session (title attract mode + rounds) outside React: one per page, never remounted.
// Owns the input latch, camera rig, fixed stepper and the current Round; restart = a fresh Round with a
// new seed (nothing reloads). Also drives the optional test bot (?bot=follow|yoink).
import { emptyInput, EV_LAND, RING_RUNNER, type Body, type InputFrame, type SimWorld } from "../sim/player.ts";
import { FixedStepper } from "../sim/stepper.ts";
import { HOLD_DELAY_EASY, type CameraTuning, type Difficulty, type DifficultyTable, type Tuning } from "../sim/tuning.ts";
import { CityIndex, type CityModel } from "../world/cityModel.ts";
import type { Pack } from "../route/trackPack.ts";
import { PHASE_ROPE } from "../route/trackPack.ts";
import { InputLatch } from "../input/input.ts";
import { createRig, rigFace, rigLook, type Rig } from "../camera/rig.ts";
import type { Vec3 } from "../sim/math.ts";
import { Round, RV_RESPAWN, RV_CAUGHT, RV_ESCAPED, type RadbroId } from "./round.ts";
import { Bot, type BotOptions } from "./bots.ts";

export type Mode = "title" | "round";

export type RoundSetup = { chaser: RadbroId; runner: RadbroId; difficulty: Difficulty; seed: number };

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class PlayGame {
  readonly model: CityModel;
  readonly pack: Pack;
  readonly index: CityIndex;
  tuning: Tuning;
  camera: CameraTuning;
  difficulty: DifficultyTable;
  /** Effective player tuning (easy grab adjusts holdDelay / zip). */
  simTuning: Tuning;
  readonly rig: Rig;
  readonly input = new InputLatch();
  readonly stepper = new FixedStepper();
  readonly frameInput: InputFrame = emptyInput();
  mode: Mode = "title";
  round: Round;
  setup: RoundSetup;
  runId = 0;
  paused = false;
  bot: Bot | null = null;
  botOptions: BotOptions | null = null;
  /** Bits OR-ed over the steps of the last frame. */
  frameEvents = 0;
  roundEvents = 0;
  runnerEvents = 0;
  readonly renderP: Vec3 = { x: 0, y: 0, z: 0 };
  readonly runnerP: Vec3 = { x: 0, y: 0, z: 0 };
  /** Seconds since the current round began (countdown included) / ended; title clock. */
  roundT = 0;
  endT = 0;
  titleT = 0;
  /** Horizontal facing hints for the views. */
  runnerVel: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(model: CityModel, pack: Pack, tuning: Tuning, camera: CameraTuning, difficulty: DifficultyTable) {
    this.model = model;
    this.pack = pack;
    this.index = new CityIndex(model);
    this.tuning = tuning;
    this.camera = camera;
    this.difficulty = difficulty;
    this.simTuning = { ...tuning };
    this.setup = { chaser: "652", runner: "4764", difficulty: "chill", seed: 1 };
    this.round = this.makeRound(this.setup);
    this.rig = createRig(this.round.spawn.yaw);
    this.retune();
    this.snap();
  }

  // ---- ViewGame interface ----------------------------------------------------------------------
  get body(): Body {
    return this.round.player;
  }
  get world(): SimWorld {
    return this.round.world;
  }

  retune(): void {
    const easy = this.camera.easyGrab;
    this.simTuning = { ...this.tuning, holdDelay: easy ? Math.max(this.tuning.holdDelay, HOLD_DELAY_EASY) : this.tuning.holdDelay, zip: easy ? false : this.tuning.zip };
    this.input.easyGrab = easy;
  }

  private makeRound(s: RoundSetup): Round {
    return new Round({
      model: this.model, index: this.index, pack: this.pack, difficulty: s.difficulty, params: this.difficulty[s.difficulty],
      tuning: this.simTuning ?? this.tuning, chaser: s.chaser, runner: s.runner, seed: s.seed, countdown: true,
    });
  }

  /** Start a round (PLAY, Retry). Keeps the canvas, prefab and caches. */
  startRound(s: RoundSetup): void {
    this.setup = s;
    this.retune();
    this.round = this.makeRound(s);
    this.mode = "round";
    this.runId++;
    this.roundT = 0;
    this.endT = 0;
    this.stepper.reset();
    this.input.clear();
    this.rig.yaw = this.round.spawn.yaw;
    this.rig.pitch = this.botOptions ? -0.25 : 0.08; // the bot camera sits higher and looks down past the stand-in
    rigLook(this.rig, 0, 0, 0, false);
    this.bot = this.botOptions ? new Bot(this.round, this.botOptions) : null;
    this.snap();
  }

  /** ?tune "respawn": a fresh round with the same setup. */
  restart(): void {
    if (this.mode === "round") this.retry();
  }

  /** Retry: same pair and difficulty, new seed. */
  retry(seed = randomSeed()): void {
    this.startRound({ ...this.setup, seed });
  }

  toTitle(): void {
    this.mode = "title";
    this.paused = false;
    this.bot = null;
  }

  private snap(): void {
    const b = this.round.player.p, r = this.round.runner.p;
    this.renderP.x = b.x; this.renderP.y = b.y; this.renderP.z = b.z;
    this.runnerP.x = r.x; this.runnerP.y = r.y; this.runnerP.z = r.z;
  }

  private step(): void {
    const round = this.round;
    const rig = this.rig;
    this.input.consume(this.frameInput, rig.sy, rig.cy, rig.fwd.x, rig.fwd.y, rig.fwd.z);
    if (this.bot && round.phase === "chase") {
      const ov = this.bot.next(round, this.frameInput);
      round.step(this.frameInput, ov);
      this.bot.after(round);
    } else {
      round.step(this.frameInput);
    }
    this.frameEvents |= round.player.events;
    this.roundEvents |= round.events;
    this.runnerEvents |= round.runner.events;
    if (round.events & RV_RESPAWN) {
      const p = round.player.p, r = round.runner.p;
      rigFace(rig, r.x - p.x, r.z - p.z, Infinity, 0);
    }
  }

  /** Once per rendered frame: look, fixed steps, interpolation. Returns steps run. */
  frame(delta: number): number {
    const [dx, dy] = this.input.takeLook();
    this.frameEvents = this.roundEvents = this.runnerEvents = 0;
    if (this.mode === "title") {
      this.titleT += delta;
      return 0;
    }
    const round = this.round;
    if (!this.paused) rigLook(this.rig, dx, dy, this.camera.sensitivity, this.camera.invertY);
    if (this.paused) return 0;
    this.roundT += delta;
    if (round.over) this.endT += delta;
    // Q / RMB: ease the camera toward him at 8/s; bots always face him.
    const p = round.player.p, r = round.runner.p;
    if ((this.input.towardRunner || this.bot) && round.phase === "chase") rigFace(this.rig, r.x - p.x, r.z - p.z, this.bot ? 4 : 8, delta);
    const n = round.over ? 0 : this.stepper.frame(delta);
    for (let i = 0; i < n && !round.over; i++) this.step();
    const a = round.over ? 1 : this.stepper.alpha;
    const pp = round.prevPlayer.p, pr = round.prevRunner;
    this.renderP.x = pp.x + (p.x - pp.x) * a;
    this.renderP.y = pp.y + (p.y - pp.y) * a;
    this.renderP.z = pp.z + (p.z - pp.z) * a;
    const ox = this.runnerP.x, oz = this.runnerP.z;
    this.runnerP.x = pr.x + (r.x - pr.x) * a;
    this.runnerP.y = pr.y + (r.y - pr.y) * a;
    this.runnerP.z = pr.z + (r.z - pr.z) * a;
    if (delta > 0) { this.runnerVel.x = (this.runnerP.x - ox) / delta; this.runnerVel.z = (this.runnerP.z - oz) / delta; }
    // Yoink: the lasso reels him in to arm's length over 0.5 s.
    if (round.phase === "caught" && round.stats.catchKind === "yoink") {
      const t = smooth(this.endT / 0.5);
      let dx = r.x - p.x, dz = r.z - p.z;
      const dl = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= dl; dz /= dl;
      this.runnerP.x = r.x + (p.x + dx * 1.2 - r.x) * t;
      this.runnerP.y = r.y + (p.y - r.y) * t;
      this.runnerP.z = r.z + (p.z + dz * 1.2 - r.z) * t;
    }
    // Escape: he rides the rug up and away.
    if (round.phase === "escaped") {
      const t = this.endT;
      const e = round.runner.pack.edges[round.runner.mode === 0 ? round.runner.edge : round.runner.next];
      const ex = e ? e.exitX : 1, ez = e ? e.exitZ : 0;
      this.runnerP.y = r.y + 0.6 + t * t * 2.2;
      this.runnerP.x = r.x + ex * t * t * 3;
      this.runnerP.z = r.z + ez * t * t * 3;
    }
    return n;
  }

  get ringOnRunner(): boolean {
    return this.round.player.ringId === RING_RUNNER;
  }

  get runnerRopeHook(): number {
    const pose = this.round.runner.pose;
    return pose.phase === PHASE_ROPE ? pose.ref : -1;
  }

  get justEnded(): boolean {
    return (this.roundEvents & (RV_CAUGHT | RV_ESCAPED)) !== 0;
  }

  get landed(): boolean {
    return (this.frameEvents & EV_LAND) !== 0;
  }

  /**
   * Scripted camera shots (title orbit, countdown dolly, results orbit). Writes eye/at and returns true,
   * or false to use the rig. `rigEye/rigAt` = where the rig wants to be this frame.
   */
  scriptedCamera(eye: Vec3, at: Vec3, rigEye: Vec3, rigAt: Vec3): boolean {
    const b = this.model.bounds;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    if (this.mode === "title") {
      const a = this.titleT * 0.045;
      eye.x = cx + Math.cos(a) * 210; eye.y = 105; eye.z = cz + Math.sin(a) * 210;
      at.x = cx; at.y = 18; at.z = cz;
      return true;
    }
    const round = this.round;
    const r = this.runnerP;
    if (round.phase === "countdown") {
      // Open on him (front, a little above), hold, then dolly back to the shoulder.
      const t = this.roundT;
      const e = round.pack.edges[round.runner.next];
      const fx = e ? e.exitX : 0, fz = e ? e.exitZ : 1;
      // front of him = toward the player (opposite his exit)
      const sx = r.x - fx * 5 + fz * 1.5, sy = r.y + 1.4, sz = r.z - fz * 5 - fx * 1.5;
      const s = smooth((t - 1.1) / 1.7);
      eye.x = sx + (rigEye.x - sx) * s; eye.y = sy + (rigEye.y - sy) * s; eye.z = sz + (rigEye.z - sz) * s;
      const ax = r.x, ay = r.y + 0.4, az = r.z;
      at.x = ax + (rigAt.x - ax) * s; at.y = ay + (rigAt.y - ay) * s; at.z = az + (rigAt.z - az) * s;
      return true;
    }
    if (round.over) {
      const p = this.renderP;
      const esc = round.phase === "escaped";
      const mx = esc ? p.x : (p.x + r.x) / 2, my = esc ? p.y : (p.y + r.y) / 2, mz = esc ? p.z : (p.z + r.z) / 2;
      const a = this.endT * 0.35 + this.rig.yaw;
      const rad = esc ? 9 : 7;
      eye.x = mx + Math.sin(a) * rad; eye.y = my + (esc ? 4 : 2.2); eye.z = mz + Math.cos(a) * rad;
      if (esc) { at.x = (p.x + r.x) / 2; at.y = (p.y + r.y) / 2 + 1; at.z = (p.z + r.z) / 2; }
      else { at.x = mx; at.y = my; at.z = mz; }
      return true;
    }
    return false;
  }
}

export function randomSeed(): number {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  } catch {
    return Math.floor(Math.random() * 4294967296);
  }
}
