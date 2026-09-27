// The Spider-tag session outside React (one per ?tag page): the camera rig, the input latch, the fixed stepper and
// the current TagMatch. Offline it steps the match itself with bots in the other slots; online a NetLink (the lazy
// net chunk: rollback + transport) owns the stepping and calls back fresh() for each new step. Either way the local
// slot's input is a quantised record packed into the 40-bit word (net/wire.ts), exactly what goes over the wire.
import { createBody, emptyInput, EV_FALL, type Body, type InputFrame, type SimWorld } from "../sim/player.ts";
import { FixedStepper } from "../sim/stepper.ts";
import type { CameraTuning, Tuning } from "../sim/tuning.ts";
import { CityIndex, type CityModel } from "../world/cityModel.ts";
import { InputLatch } from "../input/input.ts";
import { createRig, rigFace, rigLook, type Rig } from "../camera/rig.ts";
import type { Vec3 } from "../sim/math.ts";
import { emptyRec, roundTuning } from "./ghost.ts";
import { packWord } from "../net/wire.ts";
import { TagMatch, type TagSlot } from "./tagMatch.ts";
import { TagBot, type BotLevel } from "./tagBot.ts";

/** What an online session provides (net/session.ts implements it). */
export interface NetLink {
  readonly local: number;
  readonly match: TagMatch;
  /** How many new steps to run this frame (the relay clock), given the frame delta. */
  stepsFor(delta: number): number;
  /** Render interpolation alpha after this frame's steps. */
  readonly alpha: number;
  /** Queue the local slot's word for the next step and advance one step (rollback included). False = stalled. */
  step(word: number): boolean;
  /** The match result is final (every input up to the horn is confirmed). */
  readonly final: boolean;
  /** How long (ms) the match has been waiting for the other player's inputs (0 = it is not). */
  readonly waitMs: number;
}

export type TagSetup = { slots: TagSlot[]; seed: number; seconds?: number; bots?: BotLevel };

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class TagGame {
  readonly model: CityModel;
  readonly index: CityIndex;
  tuning: Tuning;
  camera: CameraTuning;
  simTuning: Tuning;
  readonly rig: Rig;
  readonly input = new InputLatch();
  readonly stepper = new FixedStepper();
  private readonly noInput: InputFrame = emptyInput();
  mode: "menu" | "match" = "menu";
  match: TagMatch | null = null;
  link: NetLink | null = null;
  setup: TagSetup | null = null;
  local = 0;
  bots: (TagBot | null)[] = [];
  /** The local slot driven by a bot (demo / headless checks). */
  auto: TagBot | null = null;
  paused = false;
  touch = false;
  runId = 0;
  /** Per-frame: the local body's sim events, every slot's events (fresh steps only), the match events. */
  frameEvents = 0;
  slotEvents: number[] = [];
  matchEvents = 0;
  /** Interpolated body points (render) per slot, and the local one. */
  renderPs: Vec3[] = [];
  readonly renderP: Vec3 = { x: 0, y: 0, z: 0 };
  menuT = 0;
  /** Seconds since the match began / since the horn. */
  matchT = 0;
  overT = 0;
  private readonly rec = emptyRec();
  private words: number[] = [];
  private readonly idleBody: Body;
  private readonly idleWorld: SimWorld;

  constructor(model: CityModel, tuning: Tuning, camera: CameraTuning) {
    this.model = model;
    this.index = new CityIndex(model);
    this.tuning = tuning;
    this.camera = camera;
    this.simTuning = { ...tuning };
    const sp = model.spawn;
    this.idleBody = createBody(sp.x, sp.y, sp.z, sp.roofId);
    this.idleWorld = { index: this.index, runner: null };
    this.rig = createRig(sp.yaw);
  }

  // ---- ViewGame ----------------------------------------------------------------------------------------------
  get body(): Body {
    return this.match ? this.match.bodies[this.local] : this.idleBody;
  }
  get world(): SimWorld {
    return this.match ? this.match.worlds[this.local] : this.idleWorld;
  }
  /** The frame your Radbro stepped with last (FxView's zip preview reads its aim). */
  get frameInput(): InputFrame {
    return this.match ? this.match.frames[this.local] : this.noInput;
  }

  /** Offline: you in slot 0, bots in the rest. */
  startOffline(s: TagSetup): void {
    this.setup = s;
    this.link = null;
    this.local = 0;
    this.begin(new TagMatch({ model: this.model, index: this.index, tuning: this.tuning, slots: s.slots, seed: s.seed, seconds: s.seconds }));
    this.bots = s.slots.map((_, i) => (i === this.local ? null : new TagBot(this.match!, i, (s.seed * 131 + i * 7919) >>> 0, s.bots ?? "normal")));
  }

  /** Online: the link owns the match and the stepping. */
  startOnline(link: NetLink): void {
    this.link = link;
    this.local = link.local;
    this.bots = [];
    this.begin(link.match);
  }

  private begin(m: TagMatch): void {
    this.match = m;
    this.mode = "match";
    this.runId++;
    this.paused = false;
    this.matchT = this.overT = 0;
    this.stepper.reset();
    this.input.clear();
    this.words = new Array(m.n).fill(0);
    this.slotEvents = new Array(m.n).fill(0);
    this.renderPs = m.bodies.map(b => ({ x: b.p.x, y: b.p.y, z: b.p.z }));
    this.simTuning = m.tunings[this.local];
    this.auto = this.autoLevel ? new TagBot(m, this.local, (m.opts.seed ^ 0x5eed) >>> 0, this.autoLevel) : null;
    const sp = m.spawns[this.local];
    this.rig.yaw = sp.yaw;
    this.rig.pitch = 0.08;
    rigLook(this.rig, 0, 0, 0, false);
    this.snapRender();
  }

  /** ?tag&bot: the local slot plays itself at this level (headless checks, demos). */
  autoLevel: BotLevel | null = null;

  /** Rematch offline: same slots, a new seed. */
  rematch(seed: number): void {
    if (this.setup && !this.link) this.startOffline({ ...this.setup, seed });
  }

  toMenu(): void {
    this.mode = "menu";
    this.match = null;
    this.link = null;
    this.bots = [];
    this.auto = null;
    this.paused = false;
  }

  private snapRender(): void {
    const m = this.match;
    if (!m) return;
    for (let i = 0; i < m.n; i++) { const p = m.bodies[i].p, r = this.renderPs[i]; r.x = p.x; r.y = p.y; r.z = p.z; }
    const l = this.renderPs[this.local];
    this.renderP.x = l.x; this.renderP.y = l.y; this.renderP.z = l.z;
  }

  /** The local slot's word for the next step (bot-driven under ?bot). */
  localWord(): number {
    const m = this.match!;
    if (this.auto) return this.auto.next(m);
    this.input.sample(this.rec, this.rig.yaw, this.rig.pitch);
    return packWord(this.rec);
  }

  /** A new (not re-simulated) step happened: collect its events for the views and the HUD. */
  fresh(): void {
    const m = this.match!;
    for (let i = 0; i < m.n; i++) this.slotEvents[i] |= m.bodies[i].events;
    this.frameEvents |= m.bodies[this.local].events;
    this.matchEvents |= m.events;
    this.auto?.after();
  }

  /** Once per rendered frame: look, fixed steps, interpolation. Returns the steps run. */
  frame(delta: number): number {
    const [dx, dy] = this.input.takeLook();
    this.frameEvents = this.matchEvents = 0;
    this.slotEvents.fill(0);
    const m = this.match;
    if (this.mode === "menu" || !m) { this.menuT += delta; return 0; }
    // The pad's right stick (rad, already scaled): the same camera, so the same yaw / pitch in the input word.
    const [px, py] = this.input.takePadLook();
    if (!this.paused) { rigLook(this.rig, dx, dy, this.camera.sensitivity, this.camera.invertY); if (px !== 0 || py !== 0) rigLook(this.rig, px, py, 1, false); }
    if (this.paused && !this.link) return 0;
    this.matchT += delta;
    if (m.over) this.overT += delta;
    // Q / RMB: ease the camera toward the holder (running) or your target (holding the bag).
    const look = this.lookTarget();
    if (look >= 0 && (this.input.towardRunner || (this.auto && m.phase === 1))) {
      const p = m.bodies[this.local].p, q = m.bodies[look].p;
      rigFace(this.rig, q.x - p.x, q.z - p.z, this.auto ? 4 : 8, delta);
    }
    let n: number;
    const link = this.link;
    if (link) {
      n = link.stepsFor(delta);
      for (let i = 0; i < n; i++) if (!link.step(this.localWord())) break;
    } else {
      n = m.over ? 0 : this.stepper.frame(delta);
      for (let i = 0; i < n && !m.over; i++) this.stepOffline();
    }
    if (this.frameEvents & EV_FALL) {
      if (look >= 0) { const p = m.bodies[this.local].p, q = m.bodies[look].p; rigFace(this.rig, q.x - p.x, q.z - p.z, Infinity, 0); }
    }
    const a = m.over ? 1 : link ? link.alpha : this.stepper.alpha;
    for (let i = 0; i < m.n; i++) {
      const p = m.bodies[i].p, q = m.prev[i].p, r = this.renderPs[i];
      r.x = q.x + (p.x - q.x) * a; r.y = q.y + (p.y - q.y) * a; r.z = q.z + (p.z - q.z) * a;
    }
    const l = this.renderPs[this.local];
    this.renderP.x = l.x; this.renderP.y = l.y; this.renderP.z = l.z;
    return n;
  }

  private stepOffline(): void {
    const m = this.match!, w = this.words;
    for (let i = 0; i < m.n; i++) w[i] = i === this.local ? this.localWord() : this.bots[i]!.next(m);
    m.stepWords(w);
    for (const b of this.bots) b?.after();
    this.fresh();
  }

  /** Who the camera turns to: running, the holder; holding the bag, your target (else the nearest runner). */
  lookTarget(): number {
    const m = this.match;
    if (!m) return -1;
    if (m.holder !== this.local) return m.holder;
    if (m.target[this.local] >= 0) return m.target[this.local];
    let best = -1, bd = Infinity;
    const p = m.bodies[this.local].p;
    for (let i = 0; i < m.n; i++) {
      if (i === this.local) continue;
      const q = m.bodies[i].p, d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** The slot standing first when the match is over. */
  get winner(): number {
    return this.match ? this.match.standings()[0] : -1;
  }

  /** Scripted shots: the menu orbit and the results orbit round the winner. */
  scriptedCamera(eye: Vec3, at: Vec3, rigEye: Vec3, rigAt: Vec3): boolean {
    const b = this.model.bounds;
    if (this.mode === "menu" || !this.match) {
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, a = this.menuT * 0.045;
      eye.x = cx + Math.cos(a) * 210; eye.y = 105; eye.z = cz + Math.sin(a) * 210;
      at.x = cx; at.y = 18; at.z = cz;
      return true;
    }
    const m = this.match;
    if (m.over) {
      const w = this.renderPs[this.winner] ?? this.renderP;
      const k = smooth(this.overT / 0.8);
      const ang = this.rig.yaw + this.overT * 0.35;
      const ex = w.x + Math.sin(ang) * 6.5, ey = w.y + 2.4, ez = w.z + Math.cos(ang) * 6.5;
      eye.x = rigEye.x + (ex - rigEye.x) * k; eye.y = rigEye.y + (ey - rigEye.y) * k; eye.z = rigEye.z + (ez - rigEye.z) * k;
      at.x = rigAt.x + (w.x - rigAt.x) * k; at.y = rigAt.y + (w.y - rigAt.y) * k; at.z = rigAt.z + (w.z - rigAt.z) * k;
      return true;
    }
    return false;
  }

  /** Touch play: wider aim cone (and +1 m Yoink) from the next match. */
  setTouch(on: boolean): void {
    this.touch = on;
  }

  retune(): void {
    this.input.easyGrab = this.camera.easyGrab;
    if (!this.match) this.simTuning = roundTuning(this.tuning, { touch: this.touch, easy: this.camera.easyGrab });
  }
}
