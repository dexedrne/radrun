// The play session (title attract mode + rounds) outside React: one per page, never remounted.
// Owns the input latch, camera rig, fixed stepper and the current Round; restart = a fresh Round with a
// new seed (nothing reloads). Also drives the optional test bot (?bot=follow|yoink), records every real
// round's input (game/ghost.ts) and steps a challenge ghost in lockstep with the round.
import { emptyInput, EV_LAND, RING_RUNNER, type Body, type InputFrame, type SimWorld } from "../sim/player.ts";
import { FixedStepper } from "../sim/stepper.ts";
import { TOUCH, type CameraTuning, type Difficulty, type DifficultyTable, type Tuning } from "../sim/tuning.ts";
import { CityIndex, type CityModel } from "../world/cityModel.ts";
import type { Pack } from "../route/trackPack.ts";
import { PHASE_ROPE } from "../route/trackPack.ts";
import { InputLatch } from "../input/input.ts";
import { createRig, rigFace, rigLook, type Rig } from "../camera/rig.ts";
import type { Vec3 } from "../sim/math.ts";
import { Round, RV_RESPAWN, RV_CAUGHT, RV_ESCAPED, type RadbroId } from "./round.ts";
import { Bot, SwingBot, type BotOptions } from "./bots.ts";
import { George } from "../sidekick/george.ts";
import { GEORGE_SPEEDS } from "../app/george.config.ts";
import { GhostLog, GhostRun, buildFrame, emptyRec, recFromFrame, roundTuning, type GhostFlags, type GhostSpec } from "./ghost.ts";

export type Mode = "title" | "round";

/** Catch slow-mo (spec §3, §8) and the flying-rug timeline (seconds of endT). */
export const SLOWMO = { seconds: 1.2, scale: 0.35 } as const;
export const RUG = { arrive: 0.8, hop: 0.45 } as const;
/** endT at which RESULTS appears: after the slow-mo catch beat / the rug tracking shot. */
export const RESULTS_AFTER = { caught: 1.3, escaped: 2.6 } as const;

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
  /** George's follow model (visual only; stepped in the fixed step, outside the Round and its hash). */
  readonly george: George;
  readonly stepper = new FixedStepper();
  readonly frameInput: InputFrame = emptyInput();
  mode: Mode = "title";
  round: Round;
  setup: RoundSetup;
  runId = 0;
  paused = false;
  /** Touch play: wider aim cone, +1 m Yoink, velocity-biased aim (spec §4 "Touch"). */
  touch = false;
  /** Practice (title -> PRACTICE): the current round is a runner-less free roam (Round practice). */
  practice = false;
  bot: Bot | SwingBot | null = null;
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
  /** Real seconds since the round ended (endT runs at the slow-mo rate). */
  endReal = 0;
  titleT = 0;
  /** Render-time scale: 0.35 for the 1.2 s catch slow-mo, else 1 (mixers and FX use it). */
  timeScale = 1;
  /** Horizontal facing hints for the views. */
  runnerVel: Vec3 = { x: 0, y: 0, z: 0 };

  // ---- ghosts (game/ghost.ts) ----
  /** This round's input record (real rounds; bot rounds only with recordBot). */
  readonly log = new GhostLog();
  recording = false;
  /** ?bot=chase&rec: the swinging bot's rounds go through the ghost codec too (e2e). */
  recordBot = false;
  /** What the current round was created with (touch: aim cone, +1 m Yoink, aim bias; easy grab). */
  roundFlags: GhostFlags = { touch: false, easy: false };
  /** The ghost being raced this round (null = none) and the spec Retry re-races. */
  ghost: GhostRun | null = null;
  ghostSpec: GhostSpec | null = null;
  /** Ghost render state: interpolated body point and the ghost's sim event bits of the last frame. */
  readonly ghostP: Vec3 = { x: 0, y: 0, z: 0 };
  ghostEvents = 0;
  private readonly rec = emptyRec();
  private ghostIndex: CityIndex | null = null;

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
    this.george = new George(model, GEORGE_SPEEDS);
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
    this.simTuning = roundTuning(this.tuning, { easy, touch: this.touch });
    this.input.easyGrab = easy;
  }

  /** Switch touch play on/off; takes effect from the next round. */
  setTouch(on: boolean): void {
    if (this.touch === on) return;
    this.touch = on;
    this.retune();
  }

  private makeRound(s: RoundSetup): Round {
    return new Round({
      model: this.model, index: this.index, pack: this.pack, difficulty: s.difficulty, params: this.difficulty[s.difficulty],
      tuning: this.simTuning ?? this.tuning, chaser: s.chaser, runner: s.runner, seed: s.seed, countdown: true,
      yoinkBonus: this.touch ? TOUCH.yoinkBonus : 0, practice: this.practice,
    });
  }

  /**
   * A ghost's own Round (same setup and flags as the recorded one, its own CityIndex, runner and rng).
   * countdown = true for the lockstep ghost, false for the title's verification replay.
   */
  makeGhostRun(g: GhostSpec, countdown: boolean): GhostRun {
    this.ghostIndex ??= new CityIndex(this.model);
    const round = new Round({
      model: this.model, index: this.ghostIndex, pack: this.pack, difficulty: g.difficulty, params: this.difficulty[g.difficulty],
      tuning: roundTuning(this.tuning, g.flags), chaser: g.chaser, runner: g.runner, seed: g.seed, countdown,
      yoinkBonus: g.flags.touch ? TOUCH.yoinkBonus : 0,
    });
    return new GhostRun(round, g.log, g.flags.touch);
  }

  /**
   * Start a round (PLAY, Retry) or, with practice = true, free roam (PRACTICE). Keeps the canvas, prefab
   * and caches. `ghost` (its setup must be `s`) replays beside you.
   */
  startRound(s: RoundSetup, practice = false, ghost: GhostSpec | null = null): void {
    this.setup = s;
    this.practice = practice;
    this.retune();
    this.roundFlags = { touch: this.touch, easy: this.camera.easyGrab };
    this.round = this.makeRound(s);
    this.log.n = 0;
    this.recording = !practice && (!this.botOptions || (this.recordBot && this.botOptions.kind === "swing"));
    this.ghostSpec = practice ? null : ghost;
    this.ghost = this.ghostSpec ? this.makeGhostRun(this.ghostSpec, true) : null;
    this.ghostEvents = 0;
    if (this.ghost) { const gp = this.ghost.round.player.p; this.ghostP.x = gp.x; this.ghostP.y = gp.y; this.ghostP.z = gp.z; }
    this.mode = "round";
    this.runId++;
    this.roundT = 0;
    this.endT = 0;
    this.endReal = 0;
    this.timeScale = 1;
    this.stepper.reset();
    this.input.clear();
    this.rig.yaw = this.round.spawn.yaw;
    this.rig.pitch = this.botOptions ? -0.25 : 0.08; // the bot camera sits higher and looks down past the stand-in
    rigLook(this.rig, 0, 0, 0, false);
    const bo = this.botOptions;
    this.bot = bo ? (bo.kind === "swing" ? new SwingBot(this.round, s.seed) : new Bot(this.round, bo)) : null;
    const sp = this.round.spawn, rp = this.round.runner.p;
    this.george.beat = practice ? "" : "sit";
    if (practice) this.george.place(sp.x, sp.y, sp.z, sp.roofId, -Math.sin(sp.yaw), -Math.cos(sp.yaw));
    else this.george.place(sp.x, sp.y, sp.z, sp.roofId, rp.x - sp.x, rp.z - sp.z);
    this.snap();
  }

  /** ?tune "respawn": a fresh round with the same setup. */
  restart(): void {
    if (this.mode === "round") this.retry();
  }

  /** Retry: same pair and difficulty, new seed (practice: back to the start roof; a ghost race: its round again). */
  retry(seed = randomSeed()): void {
    const g = this.ghostSpec;
    this.startRound({ ...this.setup, seed: g ? g.seed : seed }, this.practice, g);
  }

  toTitle(): void {
    this.mode = "title";
    this.paused = false;
    this.practice = false;
    this.bot = null;
    this.ghost = null;
    this.ghostSpec = null;
  }

  private snap(): void {
    const b = this.round.player.p, r = this.round.runner.p;
    this.renderP.x = b.x; this.renderP.y = b.y; this.renderP.z = b.z;
    this.runnerP.x = r.x; this.runnerP.y = r.y; this.runnerP.z = r.z;
  }

  private step(): void {
    const round = this.round;
    const rig = this.rig;
    const f = this.frameInput, rec = this.rec;
    const chase = round.phase === "chase";
    if (this.bot && chase) {
      const ov = this.bot.next(round, f);
      if (this.recording && !ov) {
        // ?bot=chase&rec: through the codec like a player (the bot's frame is quantised).
        recFromFrame(rec, f);
        buildFrame(f, rec, round.player.v, this.roundFlags.touch, round.tuning.runSpeed);
        this.log.push(rec);
      }
      round.step(f, ov);
      this.bot.after(round);
    } else if (this.input.script) {
      // Scripted input (?bot=swing autoplay): raw frames, never recorded.
      this.input.consume(f, rig.sy, rig.cy, rig.fwd.x, rig.fwd.y, rig.fwd.z);
      round.step(f);
    } else {
      // Players: the step's input is a quantised record and the frame is rebuilt from it, so the
      // recorded run replays bit-exactly (game/ghost.ts). Touch biases the aim toward where you are
      // going (buildFrame), so a thumb-aimed camera still rings the balloon ahead.
      this.input.sample(rec, rig.yaw);
      buildFrame(f, rec, round.player.v, this.roundFlags.touch, round.tuning.runSpeed);
      if (this.recording && chase) this.log.push(rec);
      round.step(f);
    }
    // The ghost: its own round, one step in lockstep (never touches this round).
    const gh = this.ghost;
    if (gh && gh.step()) this.ghostEvents |= gh.round.player.events;
    this.frameEvents |= round.player.events;
    this.roundEvents |= round.events;
    this.runnerEvents |= round.runner.events;
    if ((round.events & RV_RESPAWN) && !this.practice) {
      const p = round.player.p, r = round.runner.p;
      rigFace(rig, r.x - p.x, r.z - p.z, Infinity, 0);
    }
    // George: beats from the round phase; snapshots every step; placed beside you on respawn.
    const g = this.george;
    g.setBeat(round.phase === "countdown" ? "sit" : round.phase === "caught" ? "happy" : round.phase === "escaped" ? "sulk" : "");
    const b = round.player;
    if (round.events & RV_RESPAWN) g.place(b.p.x, b.p.y, b.p.z, b.roofId, -rig.sy, -rig.cy);
    else g.step({ x: b.p.x, y: b.p.y, z: b.p.z, grounded: b.grounded, rope: b.ropeHook >= 0, roofId: b.roofId });
  }

  /** Once per rendered frame: look, fixed steps, interpolation. Returns steps run. */
  frame(delta: number): number {
    const [dx, dy] = this.input.takeLook();
    this.frameEvents = this.roundEvents = this.runnerEvents = this.ghostEvents = 0;
    if (this.mode === "title") {
      this.titleT += delta;
      return 0;
    }
    const round = this.round;
    if (!this.paused) rigLook(this.rig, dx, dy, this.camera.sensitivity, this.camera.invertY);
    if (this.paused) return 0;
    this.roundT += delta;
    // Catch: 1.2 s of 0.35x slow-mo (spec §3), then normal speed.
    this.timeScale = round.phase === "caught" && this.endReal < SLOWMO.seconds ? SLOWMO.scale : 1;
    if (round.over) { this.endReal += delta; this.endT += delta * this.timeScale; }
    // Q / RMB: ease the camera toward him at 8/s; bots always face him.
    const p = round.player.p, r = round.runner.p;
    if ((this.input.towardRunner || this.bot) && round.phase === "chase" && !this.practice) rigFace(this.rig, r.x - p.x, r.z - p.z, this.bot ? 4 : 8, delta);
    const n = round.over ? 0 : this.stepper.frame(delta);
    for (let i = 0; i < n && !round.over; i++) this.step();
    if (round.over) this.georgeEnd(delta * this.timeScale);
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
    const g = this.ghost;
    if (g) {
      const ga = g.done || round.over ? 1 : a, gp = g.round.player.p, gq = g.round.prevPlayer.p;
      this.ghostP.x = gq.x + (gp.x - gq.x) * ga;
      this.ghostP.y = gq.y + (gp.y - gq.y) * ga;
      this.ghostP.z = gq.z + (gp.z - gq.z) * ga;
    }
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
    // Escape: the rug swoops in under him (RUG.arrive s), then he rides it up and away.
    if (round.phase === "escaped") {
      const t = Math.max(0, this.endT - RUG.arrive);
      const e = round.runner.pack.edges[round.runner.mode === 0 ? round.runner.edge : round.runner.next];
      const ex = e ? e.exitX : 1, ez = e ? e.exitZ : 0;
      const lift = smooth(Math.min(1, this.endT / RUG.arrive)) * RUG.hop;
      this.runnerP.y = r.y + lift + t * t * 1.6;
      this.runnerP.x = r.x + ex * t * t * 3.2;
      this.runnerP.z = r.z + ez * t * t * 3.2;
    }
    return n;
  }

  /**
   * After the round (the sim no longer steps): George trots over to sit beside you (catch: beside the
   * waltzing pair, Happy first; escape: Sulk next to you).
   */
  private georgeEnd(dt: number): void {
    const g = this.george, round = this.round;
    const p = round.player.p, r = this.runnerP;
    const caught = round.phase === "caught";
    let dx = r.x - p.x, dz = r.z - p.z;
    const dl = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= dl; dz /= dl;
    const bx = caught ? (p.x + r.x) / 2 : p.x, bz = caught ? (p.z + r.z) / 2 : p.z;
    const tx = bx + dz * 1.3, tz = bz - dx * 1.3, ty = p.y - 0.9;
    g.px = g.x; g.py = g.y; g.pz = g.z;
    const mx = tx - g.x, mz = tz - g.z;
    const md = Math.sqrt(mx * mx + mz * mz);
    if (md > 0.08) {
      // Run over, slowing to a trot / walk for the last metre.
      const v = Math.min(4, 0.4 + md * 2);
      const k = Math.min(1, (v * dt) / md);
      g.x += mx * k; g.z += mz * k;
      g.y += (ty - g.y) * Math.min(1, 8 * dt);
      g.fx = mx / md; g.fz = mz / md;
      g.sitting = false;
      g.beat = "";
      g.shotT = 0;
      g.gait(v);
      return;
    }
    g.y = ty;
    g.sitting = true;
    if (!caught) { g.beat = "sulk"; g.clip = "Sulk"; return; }
    if (g.beat !== "happy") { g.beat = "happy"; g.clip = "Happy"; g.shotT = 1e-3; }
    g.shotT += dt;
    if (g.shotT > 1.6) g.clip = "Sit_Idle";
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
    if (round.phase === "escaped" && this.endT < RESULTS_AFTER.escaped) {
      // Rug escape tracking shot: from behind your shoulder, follow him riding off.
      const p = this.renderP;
      let dx = r.x - p.x, dz = r.z - p.z;
      const dl = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= dl; dz /= dl;
      const k = smooth(this.endReal / 0.5);
      const ex = p.x - dx * 5 - dz * 1.2, ey = p.y + 2.2, ez = p.z - dz * 5 + dx * 1.2;
      eye.x = rigEye.x + (ex - rigEye.x) * k; eye.y = rigEye.y + (ey - rigEye.y) * k; eye.z = rigEye.z + (ez - rigEye.z) * k;
      at.x = rigAt.x + (r.x - rigAt.x) * k; at.y = rigAt.y + (r.y + 0.3 - rigAt.y) * k; at.z = rigAt.z + (r.z - rigAt.z) * k;
      return true;
    }
    if (round.over) {
      const p = this.renderP;
      const esc = round.phase === "escaped";
      const mx = esc ? p.x : (p.x + r.x) / 2, my = esc ? p.y : (p.y + r.y) / 2, mz = esc ? p.z : (p.z + r.z) / 2;
      // Catch: a faster sweep during the slow-mo, then a slow orbit (real time).
      const a = this.rig.yaw + this.endReal * 0.3 + (esc ? 0 : 0.9 * Math.min(this.endReal, SLOWMO.seconds));
      const rad = esc ? 9 : 5.5 + Math.min(1.5, this.endReal);
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
