// Spring-arm third-person camera maths (spec §8). Pure. The camera only affects the sim through the
// aim vector (= camera forward) recorded in each InputFrame.
// Convention: yaw 0 looks down -Z; forward = (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch).
import type { Vec3 } from "../sim/math.ts";
import type { CameraTuning } from "../sim/tuning.ts";

export const PITCH_MIN = -0.5235987755982988; // -30 deg
export const PITCH_MAX = 0.9599310885968813; // +55 deg

export type Rig = {
  yaw: number;
  pitch: number;
  /** Cached sin/cos of yaw and the forward vector (updated by rigLook). */
  sy: number;
  cy: number;
  fwd: Vec3;
  arm: number;
  fov: number;
  kickT: number;
  /** Output: camera position and look target. */
  pos: Vec3;
  target: Vec3;
  /** Distance actually used after collision (fade the local character below 2 m). */
  armUsed: number;
  /** Over-the-shoulder side: +1 right, -1 left (eased; a wall run on the right flips it off the wall). */
  side: number;
  /** Round 10: how far (m, eased) the look point sits off the facade beside you, and that facade's normal. */
  wallOff: number;
  wallNx: number;
  wallNz: number;
};

export function createRig(yaw: number, pitch = 0.12): Rig {
  const r: Rig = {
    yaw, pitch, sy: 0, cy: 1, fwd: { x: 0, y: 0, z: -1 }, arm: 6, fov: 62, kickT: 0,
    pos: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, armUsed: 6, side: 1, wallOff: 0, wallNx: 0, wallNz: 0,
  };
  rigLook(r, 0, 0, 0, false);
  return r;
}

/** Apply mouse deltas (px) and refresh the forward vector. */
export function rigLook(r: Rig, dx: number, dy: number, sensitivity: number, invertY: boolean): void {
  r.yaw -= dx * sensitivity;
  r.pitch += (invertY ? dy : -dy) * sensitivity;
  if (r.pitch < PITCH_MIN) r.pitch = PITCH_MIN;
  if (r.pitch > PITCH_MAX) r.pitch = PITCH_MAX;
  if (r.yaw > Math.PI) r.yaw -= 2 * Math.PI;
  if (r.yaw < -Math.PI) r.yaw += 2 * Math.PI;
  r.sy = Math.sin(r.yaw);
  r.cy = Math.cos(r.yaw);
  const cp = Math.cos(r.pitch);
  r.fwd.x = -r.sy * cp;
  r.fwd.y = Math.sin(r.pitch);
  r.fwd.z = -r.cy * cp;
}

/** Ease yaw toward a world direction (Q / RMB toward the runner, respawn snap with rate = Infinity). */
export function rigFace(r: Rig, dx: number, dz: number, rate: number, dt: number): void {
  const want = Math.atan2(-dx, -dz);
  let d = want - r.yaw;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const k = rate === Infinity ? 1 : Math.min(1, rate * dt);
  r.yaw += d * k;
  rigLook(r, 0, 0, 0, false);
}

export type RigInput = {
  p: Vec3;
  speed: number;
  grounded: boolean;
  /** The swing pivot while on the rope, else null. */
  hook: Vec3 | null;
  landed: boolean;
  /** Round 9: wall-running (the arm uses armWall) and that wall's outward normal (the shoulder stays off it). */
  wall?: boolean;
  wallNx?: number;
  wallNz?: number;
  /**
   * Round 10: a facade right beside you (wall-running, or just off one: webbing off a wall run), its outward
   * normal in wallNx / wallNz. The look point eases wallAway m off it, the shoulder stays on the open side.
   */
  nearWall?: boolean;
};

/** segmentHit(a, b) -> parametric t in [0,1] of the first solid hit, or -1. */
export type SegmentHit = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => number;

export function rigUpdate(r: Rig, dt: number, s: RigInput, cam: CameraTuning, hit: SegmentHit | null): void {
  // Arm length by state, blended at armBlend/s.
  const armTarget = s.hook ? cam.armRope : s.wall ? cam.armWall : s.grounded ? cam.armGround : cam.armAir;
  r.arm += (armTarget - r.arm) * Math.min(1, cam.armBlend * dt);

  // Target = chest; on the rope lean ropeBias of the way toward the pivot, at most ropeBiasMax m (W10).
  let tx = s.p.x, ty = s.p.y + 0.3, tz = s.p.z;
  // Round 10: next to a facade the look point eases off it, so the arm behind has room (webbing off a wall
  // run used to pull the camera into the Radbro's hair, or behind the wall).
  const nearWall = (s.wall || s.nearWall) === true;
  r.wallOff += ((nearWall ? cam.wallAway : 0) - r.wallOff) * Math.min(1, 6 * dt);
  if (r.wallOff > 1e-3) {
    if (nearWall) { r.wallNx = s.wallNx ?? 0; r.wallNz = s.wallNz ?? 0; }
    tx += r.wallNx * r.wallOff; tz += r.wallNz * r.wallOff;
  }
  if (s.hook) {
    const hx = s.hook.x - tx, hy = s.hook.y - ty, hz = s.hook.z - tz;
    const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
    const lean = Math.min(cam.ropeBias * hl, cam.ropeBiasMax);
    if (hl > 1e-6) { tx += (hx / hl) * lean; ty += (hy / hl) * lean; tz += (hz / hl) * lean; }
  }
  // Over-the-shoulder: the look target and the arm both shift 0.6 m to the right, so the view
  // direction is exactly the aim (forward) and the character sits left of the reticle.
  const rx = r.cy, rz = -r.sy; // right vector (horizontal)
  // Wall run with the wall on the right: the shoulder moves to the left (the 0.6 m offset would put the
  // look target inside the facade and the arm's collision would pull the camera into it).
  const sideWant = nearWall && rx * (s.wallNx ?? 0) + rz * (s.wallNz ?? 0) < -0.2 ? -1 : 1;
  r.side += (sideWant - r.side) * Math.min(1, 8 * dt);
  // The shoulder offset never reaches into a facade (it is pulled in to 0.3 m short of one).
  let sh = cam.shoulder * r.side;
  if (hit && (sh > 1e-3 || sh < -1e-3)) {
    const t = hit(tx, ty, tz, tx + rx * sh * 1.6, ty, tz + rz * sh * 1.6);
    if (t >= 0) {
      const room = t * 1.6 * (sh < 0 ? -sh : sh) - 0.3;
      sh = room <= 0 ? 0 : sh * Math.min(1, room / (sh < 0 ? -sh : sh));
    }
  }
  const bx = tx + rx * sh, bz = tz + rz * sh;
  r.target.x = bx; r.target.y = ty; r.target.z = bz;
  let dx = -r.fwd.x * r.arm, dy = -r.fwd.y * r.arm, dz = -r.fwd.z * r.arm;
  let used = r.arm;
  if (hit) {
    // From the (clear) look point back along the arm: the camera stops 0.3 m short of the first facade.
    const t = hit(bx, ty, bz, bx + dx, ty + dy, bz + dz);
    if (t >= 0) {
      const want = Math.max(0.6, t * r.arm - 0.3);
      const f = want / r.arm;
      dx *= f; dy *= f; dz *= f;
      used = want;
    }
  }
  r.armUsed = used;
  r.pos.x = bx + dx;
  r.pos.y = ty + dy;
  r.pos.z = bz + dz;

  // FOV: widen with speed (unless reduced motion), eased; -3 deg landing kick for 0.1 s.
  const span = Math.max(1e-3, cam.fovSpeedHi - cam.fovSpeedLo);
  const boost = cam.reducedMotion ? 0 : cam.fovBoost * Math.min(1, Math.max(0, (s.speed - cam.fovSpeedLo) / span));
  const want = cam.fov + boost;
  r.fov += (want - r.fov) * Math.min(1, cam.fovEase * dt);
  if (s.landed && !cam.reducedMotion) r.kickT = 0.1;
  r.kickT = Math.max(0, r.kickT - dt);
  r.fov = Math.max(20, r.fov);
}

/** FOV actually rendered this frame (includes the landing kick). */
export const rigFov = (r: Rig): number => r.fov - (r.kickT > 0 ? 3 : 0);
