// George's follow model (spec §10 + errata 10). Purely visual: not solid, not in the sim state or its
// hash, never affects balance. A deterministic function of the player's snapshot history, stepped
// inside the fixed 120 Hz step (outside the Round). Determinism rule: + - * /, sqrt, min/max/abs/floor.
import type { CityModel } from "../world/cityModel.ts";

export const GEORGE = {
  cap: 240, // 2 s of 120 Hz snapshots
  delay: 60, // D = 0.5 s
  tangentHalf: 6,
  side: 0.9,
  wRate: 1 / 18,
  inset: 0.4,
  speedSmooth: 1 / 12,
  dt: 1 / 120,
  halfHeight: 0.9,
  idleBelow: 0.2,
  walkBelow: 1.2,
  trotBelow: 3.5,
  rateMin: 0.7,
  rateMax: 1.6,
  jumpFor: 0.35,
  landFor: 0.25,
  happyFor: 1.6,
} as const;

export type GeorgeClip = "Sit_Idle" | "Idle" | "Walk" | "Trot" | "Run" | "Jump" | "Leap_Air" | "Land" | "Happy" | "Sulk";

/** One player snapshot: body point, grounded, on-rope, roof id. */
export type GeorgeSample = { x: number; y: number; z: number; grounded: boolean; rope: boolean; roofId: number };

/** Ground speed of each locomotion clip in metres per second at rate 1 (placeholder values). */
export type ClipSpeeds = { Walk: number; Trot: number; Run: number };

export class George {
  readonly model: CityModel;
  readonly speeds: ClipSpeeds;
  private readonly bx = new Float64Array(GEORGE.cap);
  private readonly by = new Float64Array(GEORGE.cap);
  private readonly bz = new Float64Array(GEORGE.cap);
  private readonly bg = new Uint8Array(GEORGE.cap);
  private readonly br = new Int32Array(GEORGE.cap);
  private head = 0;
  count = 0;
  // Output (current and previous step, for render interpolation).
  x = 0; y = 0; z = 0;
  px = 0; py = 0; pz = 0;
  /** Facing (unit horizontal). */
  fx = 0; fz = 1;
  speed = 0;
  w = 1;
  tx = 0; tz = 1;
  clip: GeorgeClip = "Sit_Idle";
  rate = 1;
  /** Seconds in the current one-shot (Jump / Land / Happy), else 0. */
  shotT = 0;
  airborne = false;
  sitting = true;
  beat: "" | "sit" | "happy" | "sulk" = "sit";
  lastGroundX = 0; lastGroundY = 0; lastGroundZ = 0; lastGroundRoof = -1;

  constructor(model: CityModel, speeds: ClipSpeeds = { Walk: 1.0, Trot: 2.6, Run: 6.5 }) {
    this.model = model;
    this.speeds = speeds;
  }

  /** Clamp (x, z) into roof `roofId` inset GEORGE.inset; returns the roof top or NaN if unknown. */
  private clampRoof(roofId: number, out: { x: number; z: number }): number {
    const s = this.model.solids[roofId];
    if (!s) return NaN;
    const i = GEORGE.inset;
    out.x = Math.min(Math.max(out.x, s.x0 + i), s.x1 - i);
    out.z = Math.min(Math.max(out.z, s.z0 + i), s.z1 - i);
    return s.top;
  }

  /**
   * Place George beside a point (round start, respawn): `p` = the player's body point on `roofId`, `(dx, dz)`
   * = the direction the player faces (L = its left). Clears the buffer; he sits until it refills.
   */
  place(px: number, py: number, pz: number, roofId: number, dx: number, dz: number): void {
    let l = Math.sqrt(dx * dx + dz * dz);
    if (l < 1e-9) { dx = 0; dz = 1; l = 1; }
    this.tx = dx / l; this.tz = dz / l;
    const q = { x: px + this.tz * GEORGE.side, z: pz - this.tx * GEORGE.side };
    const top = this.clampRoof(roofId, q);
    this.x = this.px = q.x;
    this.z = this.pz = q.z;
    this.y = this.py = top === top ? top : py - GEORGE.halfHeight;
    this.fx = this.tx; this.fz = this.tz;
    this.head = 0;
    this.count = 0;
    this.speed = 0;
    this.w = 1;
    this.airborne = false;
    this.sitting = true;
    this.clip = "Sit_Idle";
    this.rate = 1;
    this.shotT = 0;
    this.lastGroundX = this.x; this.lastGroundY = this.y; this.lastGroundZ = this.z; this.lastGroundRoof = roofId;
  }

  private at(age: number): number {
    return (this.head - 1 - age + GEORGE.cap * 2) % GEORGE.cap;
  }

  /** One fixed step with the player's snapshot for this step. */
  step(s: GeorgeSample): void {
    this.px = this.x; this.py = this.y; this.pz = this.z;
    const h = this.head;
    this.bx[h] = s.x; this.by[h] = s.y; this.bz[h] = s.z;
    this.bg[h] = s.grounded && !s.rope ? 1 : 0;
    this.br[h] = s.roofId;
    this.head = (h + 1) % GEORGE.cap;
    if (this.count < GEORGE.cap) this.count++;
    const dt = GEORGE.dt;
    if (this.shotT > 0) this.shotT += dt;

    if (this.count <= GEORGE.delay || this.beat === "sit") {
      // Not enough history yet (or a sitting beat): sit where he is.
      this.sitting = true;
      this.speed = 0;
      this.pickClip(false, false);
      return;
    }
    this.sitting = false;
    const si = this.at(GEORGE.delay);
    // Tangent from the samples around s (clamped to what exists), else keep the previous one.
    const ia = this.at(Math.max(0, GEORGE.delay - GEORGE.tangentHalf));
    const ib = this.at(Math.min(this.count - 1, GEORGE.delay + GEORGE.tangentHalf));
    const dx = this.bx[ia] - this.bx[ib], dz = this.bz[ia] - this.bz[ib];
    const dl = Math.sqrt(dx * dx + dz * dz);
    if (dl >= 0.05) { this.tx = dx / dl; this.tz = dz / dl; }
    const grounded = this.bg[si] === 1;
    this.w += grounded ? GEORGE.wRate : -GEORGE.wRate;
    if (this.w > 1) this.w = 1;
    if (this.w < 0) this.w = 0;
    // L = (tz, 0, -tx), the path's left.
    const q = { x: this.bx[si] + GEORGE.side * this.w * this.tz, z: this.bz[si] - GEORGE.side * this.w * this.tx };
    let y = this.by[si] - GEORGE.halfHeight;
    if (grounded) {
      const top = this.clampRoof(this.br[si], q);
      if (top === top) y = top;
    }
    const wasAir = this.airborne;
    this.airborne = !grounded;
    this.x = q.x; this.y = y; this.z = q.z;
    if (grounded) { this.lastGroundX = q.x; this.lastGroundY = y; this.lastGroundZ = q.z; this.lastGroundRoof = this.br[si]; }
    const mx = this.x - this.px, mz = this.z - this.pz;
    const inst = Math.sqrt(mx * mx + mz * mz) / dt;
    this.speed += (inst - this.speed) * GEORGE.speedSmooth;
    const ml = Math.sqrt(mx * mx + mz * mz);
    if (ml > 1e-4) { this.fx = mx / ml; this.fz = mz / ml; }
    this.pickClip(!wasAir && this.airborne, wasAir && !this.airborne);
  }

  /** The player fell: George waits at his last grounded point, sitting (hidden by the fade). */
  fall(): void {
    this.x = this.px = this.lastGroundX;
    this.y = this.py = this.lastGroundY;
    this.z = this.pz = this.lastGroundZ;
    this.sitting = true;
    this.count = 0;
    this.head = 0;
    this.clip = "Sit_Idle";
  }

  setBeat(b: "" | "sit" | "happy" | "sulk"): void {
    if (b === this.beat) return;
    this.beat = b;
    if (b === "happy") { this.clip = "Happy"; this.shotT = GEORGE.dt; this.rate = 1; }
    else if (b === "sulk") { this.clip = "Sulk"; this.shotT = 0; this.rate = 1; }
  }

  private pickClip(tookOff: boolean, landed: boolean): void {
    if (this.beat === "happy") {
      if (this.shotT > GEORGE.happyFor) { this.clip = "Sit_Idle"; this.shotT = 0; }
      return;
    }
    if (this.beat === "sulk") { this.clip = "Sulk"; return; }
    if (this.sitting) { this.clip = "Sit_Idle"; this.rate = 1; return; }
    if (tookOff) { this.clip = "Jump"; this.shotT = GEORGE.dt; this.rate = 1; return; }
    if (landed) { this.clip = "Land"; this.shotT = GEORGE.dt; this.rate = 1; return; }
    if (this.clip === "Jump" && this.airborne && this.shotT < GEORGE.jumpFor) return;
    if (this.airborne) { this.clip = "Leap_Air"; this.shotT = 0; this.rate = 1; return; }
    if (this.clip === "Land" && this.shotT > 0 && this.shotT < GEORGE.landFor) return;
    this.shotT = 0;
    const v = this.speed;
    const pick = (c: GeorgeClip, gs: number) => {
      this.clip = c;
      const r = v / gs;
      this.rate = r < GEORGE.rateMin ? GEORGE.rateMin : r > GEORGE.rateMax ? GEORGE.rateMax : r;
    };
    if (v < GEORGE.idleBelow) { this.clip = "Idle"; this.rate = 1; }
    else if (v < GEORGE.walkBelow) pick("Walk", this.speeds.Walk);
    else if (v < GEORGE.trotBelow) pick("Trot", this.speeds.Trot);
    else pick("Run", this.speeds.Run);
  }
}
