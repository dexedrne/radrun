// Runner bake bot (spec §7): turns an edge plan (roof hops) + integer step parameters into InputFrames
// for stepBody (RUNNER preset). Resumable and clonable so the bake can sweep one hop's parameter from a
// checkpoint. Roof legs are straight: run to an approach point 3 m behind the takeoff, then along the
// hop axis. Alley / climb / wall-run hop: jump on step `jump` (climb: the sim's ledge grab + climb finish
// it; wall run: the lateral held just off the wall face with a small push into it). Street swing: jump on
// step `jump` (found by the edge rule), web held from jump + 1 with the link's baked anchor forced,
// released on step `release`. Zip hop (integration): the zip key on step `jump` with the link's rim anchor
// forced (the sim's ledge zip pulls him up and launches him onto the roof). Vaults over rooftop props happen
// by themselves on the legs.
// Pure TS; deterministic (sqrt-only maths, fixed order).
import { copyBody, createBody, emptyInput, stepBody, EV_FALL, EV_WALL, EV_BONK, EV_CLIMB, EV_VAULT, EV_ZIP, type Body, type InputFrame, type SimWorld } from "../sim/player.ts";
import type { Tuning } from "../sim/tuning.ts";
import type { CityModel } from "../world/cityModel.ts";
import { GRAPH, type Link, type Junction } from "./graph.ts";

export const BOT = {
  approach: 3,
  /** Street swings: jump once the body centre is this close to the takeoff edge. */
  swingJumpBefore: 0.5,
  /** Alley takeoff lateral is clamped this far inside the overlapping span. */
  alleyLatInset: 2,
  landMargin: 1.5,
  maxAirSteps: 720,
  maxLegSteps: 720,
  /** Final stop: decelerate at this rate (< groundBrake) toward the junction point. */
  stopDecel: 24,
  restDist: 0.02,
  restSpeed: 1.0,
} as const;

export const PH_APPROACH = 0;
export const PH_LINE = 1;
export const PH_AIR = 2;
export const PH_FINAL = 3;
export const PH_DONE = 4;
export const PH_FAIL = 5;

/**
 * pace (round 7 drops): walk-off speed in % of runSpeed (100 for every other hop); alt: the street swing's anchor
 * option; zip: a street hop taken as a zip across onto the far rim (its fallback when no swing bakes).
 */
export type HopParams = { lat: number; jump: number; release: number; pace: number; alt: number; zip: boolean };

/** The hop is a zip (a zip link, or a street hop on its zip fallback). */
export const zipHop = (l: Link, p: HopParams): boolean => l.kind === "zip" || (l.kind === "street" && p.zip);
/** Wall-run hops: the stick's push into the wall (fraction of full). */
export const WALL_PUSH = 0.3;

export type HopResult = { jumpStep: number; landStep: number; margin: number; landRoof: number; climbed: boolean };

export type EdgePlan = { from: Junction; to: Junction; links: Link[] };

export class EdgeBot {
  readonly plan: EdgePlan;
  readonly params: HopParams[];
  readonly body: Body;
  readonly world: SimWorld;
  readonly tuning: Tuning;
  readonly model: CityModel;
  /** Next step index to run (0-based; the body is the state after `step` steps). */
  step = 0;
  hop = 0;
  phase = PH_APPROACH;
  legSteps = 0;
  airSteps = 0;
  /** The current hop's rope has been attached and let go (never re-grab after an auto-release). */
  ropeDone = false;
  ropeAttached = false;
  autoReleased = false;
  /** Airborne after a vault on a roof leg (not a takeoff), and the current hop ended with a ledge climb. */
  vaulting = false;
  climbed = false;
  fail = "";
  results: HopResult[] = [];
  readonly input: InputFrame = emptyInput();
  /** Per-step hook: after every step (recording). */
  onStep: ((bot: EdgeBot) => void) | null = null;

  constructor(model: CityModel, world: SimWorld, tuning: Tuning, plan: EdgePlan, params: HopParams[]) {
    this.model = model;
    this.world = { ...world, forceAnchor: null };
    this.tuning = tuning;
    this.plan = plan;
    this.params = params;
    this.body = createBody(plan.from.x, plan.from.y, plan.from.z, plan.from.roof);
    if (!plan.links.length) this.phase = PH_FINAL;
  }

  clone(): EdgeBot {
    const c = new EdgeBot(this.model, this.world, this.tuning, this.plan, this.params.map(p => ({ ...p })));
    copyBody(c.body, this.body);
    c.step = this.step;
    c.hop = this.hop;
    c.phase = this.phase;
    c.legSteps = this.legSteps;
    c.airSteps = this.airSteps;
    c.ropeDone = this.ropeDone;
    c.ropeAttached = this.ropeAttached;
    c.autoReleased = this.autoReleased;
    c.vaulting = this.vaulting;
    c.climbed = this.climbed;
    c.fail = this.fail;
    c.results = this.results.map(r => ({ ...r }));
    return c;
  }

  get link(): Link {
    return this.plan.links[this.hop];
  }

  /** Along-axis / lateral coordinates of the body for the current link. */
  along(): number {
    const l = this.link;
    return l.axis === "x" ? this.body.p.x : this.body.p.z;
  }
  lateral(): number {
    const l = this.link;
    return l.axis === "x" ? this.body.p.z : this.body.p.x;
  }

  /**
   * Default takeoff lateral for the current hop: alley / climb / drop straight on (clamped into the span);
   * street at the span's centre (where its anchor was baked); wall run just off the wall face.
   */
  chooseLateral(): void {
    const l = this.link;
    const p = this.params[this.hop];
    if (zipHop(l, p)) p.lat = l.axis === "x" ? l.rim!.az : l.rim!.ax;
    else if (l.kind === "street") p.lat = l.swings[Math.min(p.alt, l.swings.length - 1)]?.lat ?? (l.lo + l.hi) / 2;
    else if (l.kind === "wallrun") p.lat = l.face + l.side * (this.tuning.halfWidth + GRAPH.wallOff);
    else p.lat = Math.min(Math.max(this.lateral(), l.lo + BOT.alleyLatInset), l.hi - BOT.alleyLatInset);
  }

  private setMove(ax: number, az: number, mag: number): void {
    const l = Math.sqrt(ax * ax + az * az);
    if (l < 1e-9) { this.input.moveX = 0; this.input.moveZ = 0; return; }
    this.input.moveX = (ax / l) * mag;
    this.input.moveZ = (az / l) * mag;
  }

  /** True when the street-swing jump rule fires on the next step (line phase, near the edge). */
  swingJumpDue(): boolean {
    if (this.phase !== PH_LINE || this.link.kind !== "street" || this.params[this.hop].zip) return false;
    const l = this.link;
    return (this.along() - l.edge) * l.dir >= -BOT.swingJumpBefore;
  }

  /** Run one step. */
  tick(): void {
    if (this.phase >= PH_DONE) return;
    const b = this.body, inp = this.input, k = this.tuning;
    inp.jumpPressed = false;
    inp.zipPressed = false;
    inp.webPressed = false;
    inp.webHeld = false;
    inp.aimX = 1; inp.aimY = 0; inp.aimZ = 0;
    this.world.forceAnchor = null;
    const s = this.step;

    if (this.phase === PH_APPROACH) {
      const l = this.link, p = this.params[this.hop];
      if (p.lat !== p.lat) this.chooseLateral(); // NaN = not chosen yet
      const ax = l.edge - l.dir * BOT.approach;
      const al = this.along();
      // Past the approach point already (along the hop direction) -> straight to the line phase.
      const tx = l.axis === "x" ? ax : p.lat, tz = l.axis === "x" ? p.lat : ax;
      const dx = tx - b.p.x, dz = tz - b.p.z;
      if ((al - ax) * l.dir >= -0.3 || dx * dx + dz * dz < 0.16) this.phase = PH_LINE;
      else this.setMove(dx, dz, 1);
    }
    if (this.phase === PH_LINE) {
      const l = this.link, p = this.params[this.hop];
      const err = p.lat - this.lateral();
      const c = Math.min(Math.max(err * 1.5, -0.6), 0.6);
      const mag = l.kind === "drop" ? p.pace / 100 : 1;
      if (l.axis === "x") this.setMove(l.dir, c, mag); else this.setMove(c, l.dir, mag);
      if (s === p.jump) {
        if (zipHop(l, p)) { inp.zipPressed = true; this.world.forceAnchor = l.rim; } else inp.jumpPressed = true;
      }
    } else if (this.phase === PH_AIR) {
      const l = this.link, p = this.params[this.hop];
      // Wall run: a small push into the wall (the face normal is `side` on the lateral axis).
      const push = l.kind === "wallrun" ? -l.side * WALL_PUSH : 0;
      this.input.moveX = l.axis === "x" ? l.dir : push;
      this.input.moveZ = l.axis === "x" ? push : l.dir;
      if (l.kind === "street" && !p.zip && s > p.jump && s < p.release && !this.ropeDone) {
        inp.webHeld = true;
        inp.webPressed = s === p.jump + 1;
        this.world.forceAnchor = l.swings[Math.min(p.alt, l.swings.length - 1)]?.anchor ?? l.anchor;
      }
    } else if (this.phase === PH_FINAL) {
      const j = this.plan.to;
      const dx = j.x - b.p.x, dz = j.z - b.p.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const hs = Math.sqrt(b.v.x * b.v.x + b.v.z * b.v.z);
      if (dist < BOT.restDist && hs < BOT.restSpeed) { this.phase = PH_DONE; return; }
      const want = Math.min(k.runSpeed, Math.sqrt(2 * BOT.stopDecel * dist), dist * 30);
      const top = hs > k.runSpeed ? Math.max(k.runSpeed, hs - k.carryDecay * k.dt) : k.runSpeed;
      this.setMove(dx, dz, Math.min(1, want / top));
    }

    const wasGrounded = b.grounded;
    stepBody(b, inp, k, this.world);
    this.step++;
    this.legSteps++;
    // A vault over a rooftop prop on a leg is airborne but not a takeoff.
    if (b.events & EV_VAULT) this.vaulting = true;
    else if (b.grounded) this.vaulting = false;
    if (b.events & EV_FALL) { this.fail = `fell (hop ${this.hop})`; this.phase = PH_FAIL; }
    else if (this.phase === PH_LINE || this.phase === PH_APPROACH) {
      // Drops walk off; a wall-run hop may run off the edge straight onto the wall before its jump step.
      const walkOff = this.phase === PH_LINE && (this.link.kind === "drop" || this.link.kind === "wallrun") && !b.grounded && wasGrounded && !this.vaulting;
      if (!b.grounded && ((b.events & (1 /* EV_JUMP */ | EV_ZIP)) || walkOff)) { this.phase = PH_AIR; this.airSteps = 0; this.vaulting = false; this.results[this.hop] = { jumpStep: s, landStep: -1, margin: 0, landRoof: -1, climbed: false }; }
      else if (this.vaulting) { if (this.legSteps > BOT.maxLegSteps) { this.fail = `leg timeout (hop ${this.hop})`; this.phase = PH_FAIL; } }
      else if (!b.grounded && wasGrounded && this.phase === PH_APPROACH) { this.fail = `ran off roof on approach (hop ${this.hop})`; this.phase = PH_FAIL; }
      else if (!b.grounded && this.legSteps > 60 && s > this.params[this.hop].jump + 13) { this.fail = `no takeoff (hop ${this.hop})`; this.phase = PH_FAIL; }
      else if (this.legSteps > BOT.maxLegSteps) { this.fail = `leg timeout (hop ${this.hop})`; this.phase = PH_FAIL; }
    } else if (this.phase === PH_AIR) {
      this.airSteps++;
      if (b.ropeSolid >= 0) this.ropeAttached = true;
      else if (this.ropeAttached && !this.ropeDone) { this.ropeDone = true; this.autoReleased = s < this.params[this.hop].release; }
      if (b.events & EV_CLIMB) this.climbed = true;
      // Wall contact fails a hop unless it is planned (a wall run or a ledge grab started from it).
      if ((b.events & (EV_WALL | EV_BONK)) && ((b.events & EV_BONK) || (b.wallMode === 0 && b.ledgeMode === 0))) { this.fail = `wall contact (hop ${this.hop})`; this.phase = PH_FAIL; }
      else if (b.grounded) {
        const l = this.link;
        const r = this.results[this.hop];
        r.landStep = s;
        r.landRoof = b.roofId;
        r.climbed = this.climbed;
        const sol = this.model.solids[b.roofId];
        r.margin = Math.min(b.p.x - sol.x0, sol.x1 - b.p.x, b.p.z - sol.z0, sol.z1 - b.p.z);
        if (l.kind === "wallrun") {
          // The roof's edge along the wall is not a drop-off: only the other three edges count.
          const al = l.axis === "x" ? Math.min(b.p.x - sol.x0, sol.x1 - b.p.x) : Math.min(b.p.z - sol.z0, sol.z1 - b.p.z);
          const lat = l.axis === "x" ? (l.side > 0 ? sol.z1 - b.p.z : b.p.z - sol.z0) : (l.side > 0 ? sol.x1 - b.p.x : b.p.x - sol.x0);
          r.margin = Math.min(al, lat);
        }
        if (b.roofId !== l.to) { this.fail = `landed on roof ${b.roofId} not ${l.to} (hop ${this.hop})`; this.phase = PH_FAIL; }
        // A ledge climb ends at the same spot just inside the rim: no margin rule for it (a swing, climb or
        // wall-run hop may finish by grabbing the far rim; a drop still needs the margin).
        else if (r.margin < BOT.landMargin && !(this.climbed && l.kind !== "drop")) { this.fail = `landing margin ${r.margin.toFixed(2)} (hop ${this.hop})`; this.phase = PH_FAIL; }
        else {
          this.hop++;
          this.legSteps = 0;
          this.ropeDone = this.ropeAttached = this.autoReleased = this.climbed = false;
          this.phase = this.hop < this.plan.links.length ? PH_APPROACH : PH_FINAL;
        }
      } else if (this.airSteps > BOT.maxAirSteps) { this.fail = `air timeout (hop ${this.hop})`; this.phase = PH_FAIL; }
    } else if (this.phase === PH_FINAL) {
      if (!b.grounded && !this.vaulting) { this.fail = "ran off the junction roof"; this.phase = PH_FAIL; }
      else if (this.legSteps > BOT.maxLegSteps) { this.fail = "final leg timeout"; this.phase = PH_FAIL; }
    }
    this.onStep?.(this);
  }

  /** Run until the current hop resolves (landed / failed) or the edge finishes. */
  runHop(): void {
    const h = this.hop;
    while (this.phase < PH_DONE && this.hop === h) this.tick();
  }

  runToEnd(): void {
    while (this.phase < PH_DONE) this.tick();
  }
}

export const newParams = (n: number): HopParams[] => Array.from({ length: n }, () => ({ lat: NaN, jump: -1, release: -1, pace: 100, alt: 0, zip: false }));
