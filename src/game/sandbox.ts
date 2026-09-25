// Free-roam swinging world (?sandbox): player body + fixed stepper + camera rig + input latch, no
// runner. Lives outside React (one instance per page, keyed by runId) so restarts never remount the
// canvas. Pure TS apart from reading the latch; SimDriver calls frame() once per rendered frame.
import { copyBody, createBody, emptyInput, resetMoves, stepBody, cloneBody, EV_BONK, EV_FALL, EV_ATTACH, type Body, type InputFrame, type SimWorld } from "../sim/player.ts";
import { FixedStepper } from "../sim/stepper.ts";
import { HOLD_DELAY_EASY, type CameraTuning, type DifficultyTable, type Tuning } from "../sim/tuning.ts";
import { CityIndex, type CityModel } from "../world/cityModel.ts";
import { InputLatch } from "../input/input.ts";
import { createRig, rigFace, rigLook, type Rig } from "../camera/rig.ts";
import type { Vec3 } from "../sim/math.ts";

export type SandboxStats = { topSpeed: number; maxChain: number; falls: number; bonks: number; swings: number; steps: number; parkour: number };

/** Put a body back on a roof: the point clamped `inset` m inside the roof footprint, at rest. */
export function respawnOnRoof(b: Body, model: CityModel, roofId: number, x: number, z: number, inset: number, halfHeight: number): void {
  const s = model.solids[roofId] ?? model.solids[model.spawn.roofId];
  const cx = Math.min(Math.max(x, s.x0 + inset), s.x1 - inset);
  const cz = Math.min(Math.max(z, s.z0 + inset), s.z1 - inset);
  b.p.x = cx; b.p.y = s.top + halfHeight; b.p.z = cz;
  b.v.x = b.v.y = b.v.z = 0;
  b.grounded = true;
  b.roofId = s.id;
  resetMoves(b);
  b.lastSafeRoof = s.id;
  b.lastSafe.x = cx; b.lastSafe.y = b.p.y; b.lastSafe.z = cz;
}

export class Sandbox {
  readonly model: CityModel;
  readonly world: SimWorld;
  /** Editable tuning (tuning.json / ?tune). */
  tuning: Tuning;
  camera: CameraTuning;
  /** Difficulty table loaded from tuning.json (kept so ?tune Save preserves it). */
  difficulty: DifficultyTable | null = null;
  /** What the sim actually runs: tuning + the easy-grab scheme (holdDelay 0.12, no zip). */
  simTuning: Tuning;
  readonly body: Body;
  readonly prev: Body;
  readonly stepper = new FixedStepper();
  readonly rig: Rig;
  readonly input = new InputLatch();
  readonly frameInput: InputFrame = emptyInput();
  readonly stats: SandboxStats = { topSpeed: 0, maxChain: 0, falls: 0, bonks: 0, swings: 0, steps: 0, parkour: 0 };
  /** Events OR-ed over the steps of the last frame (FX / camera). */
  frameEvents = 0;
  /** Interpolated body point for rendering. */
  readonly renderP: Vec3 = { x: 0, y: 0, z: 0 };
  paused = false;
  runId = 0;
  /** Tests: never run more than this many steps in total. */
  stepLimit = Infinity;

  constructor(model: CityModel, tuning: Tuning, camera: CameraTuning) {
    this.model = model;
    const index = new CityIndex(model);
    this.world = { index, runner: null };
    this.tuning = tuning;
    this.camera = camera;
    this.simTuning = { ...tuning };
    this.retune();
    const sp = model.spawn;
    this.body = createBody(sp.x, sp.y, sp.z, sp.roofId);
    this.prev = cloneBody(this.body);
    this.rig = createRig(sp.yaw);
    this.snapRender();
  }

  /** Recompute the effective sim tuning after tuning/camera edits. */
  retune(): void {
    const easy = this.camera.easyGrab;
    this.simTuning = { ...this.tuning, holdDelay: easy ? Math.max(this.tuning.holdDelay, HOLD_DELAY_EASY) : this.tuning.holdDelay, zip: easy ? false : this.tuning.zip };
    this.input.easyGrab = easy;
  }

  restart(): void {
    const sp = this.model.spawn;
    respawnOnRoof(this.body, this.model, sp.roofId, sp.x, sp.z, 1, this.tuning.halfHeight);
    this.body.ringId = -1;
    copyBody(this.prev, this.body);
    this.rig.yaw = sp.yaw;
    rigLook(this.rig, 0, 0, 0, false);
    this.stepper.reset();
    this.runId++;
    this.snapRender();
  }

  /** One fixed step with the latched input. */
  step(): void {
    const b = this.body;
    copyBody(this.prev, b);
    const r = this.rig;
    this.input.consume(this.frameInput, r.sy, r.cy, r.fwd.x, r.fwd.y, r.fwd.z);
    stepBody(b, this.frameInput, this.simTuning, this.world);
    this.frameEvents |= b.events;
    const st = this.stats;
    st.steps++;
    const sp = Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z);
    if (sp > st.topSpeed) st.topSpeed = sp;
    if (b.chainCount > st.maxChain) st.maxChain = b.chainCount;
    if (b.events & EV_ATTACH) st.swings++;
    if (b.events & EV_BONK) st.bonks++;
    st.parkour = b.parkour;
    if (b.events & EV_FALL) {
      st.falls++;
      respawnOnRoof(b, this.model, b.lastSafeRoof, b.lastSafe.x, b.lastSafe.z, 1, this.tuning.halfHeight);
      copyBody(this.prev, b); // no interpolation streak across the respawn
    }
  }

  /** Called once per rendered frame: mouse look, fixed steps, interpolation. */
  frame(delta: number): number {
    const [dx, dy] = this.input.takeLook();
    rigLook(this.rig, dx, dy, this.camera.sensitivity, this.camera.invertY);
    this.frameEvents = 0;
    if (this.paused) return 0;
    const n = Math.min(this.stepper.frame(delta), this.stepLimit - this.stats.steps);
    for (let i = 0; i < n; i++) this.step();
    const a = this.stepper.alpha;
    const p = this.prev.p, c = this.body.p;
    this.renderP.x = p.x + (c.x - p.x) * a;
    this.renderP.y = p.y + (c.y - p.y) * a;
    this.renderP.z = p.z + (c.z - p.z) * a;
    return n;
  }

  snapRender(): void {
    this.renderP.x = this.body.p.x; this.renderP.y = this.body.p.y; this.renderP.z = this.body.p.z;
  }

  faceDir(dx: number, dz: number): void {
    rigFace(this.rig, dx, dz, Infinity, 0);
  }
}
