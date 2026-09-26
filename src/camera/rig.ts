// Spring-arm third-person camera maths (spec §8). Pure. The camera only affects the sim through the
// aim vector (= camera forward) recorded in each InputFrame.
// Convention: yaw 0 looks down -Z; forward = (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch).
import type { Vec3 } from "../sim/math.ts";
import type { CameraTuning } from "../sim/tuning.ts";

export const PITCH_MIN = -0.5235987755982988; // -30 deg
export const PITCH_MAX = 0.9599310885968813; // +55 deg
/** The body's half width (m): a wall the Radbro runs on is this far behind his centre. */
const BODY_HALF = 0.35;
/** rigUpdate's scratch arm direction. */
const DIR: Vec3 = { x: 0, y: 0, z: 0 };

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
  /**
   * Round 11: the arm's eased yaw / pitch offsets (rad) around the look point: when a facade pulls the arm in under
   * armMin, the camera swings round to where it has room (and off the web line) instead of sitting on the wall.
   */
  dodgeYaw: number;
  dodgePitch: number;
  /** Round 11: the camera's distance to the Radbro's chest (m) this frame (the close-camera fade reads it). */
  bodyDist: number;
};

export function createRig(yaw: number, pitch = 0.12): Rig {
  const r: Rig = {
    yaw, pitch, sy: 0, cy: 1, fwd: { x: 0, y: 0, z: -1 }, arm: 6, fov: 62, kickT: 0,
    pos: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, armUsed: 6, side: 1, wallOff: 0, wallNx: 0, wallNz: 0,
    dodgeYaw: 0, dodgePitch: 0, bodyDist: 6,
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
  /** Round 11: the web line (hand -> anchor) while on the rope: the camera keeps webClear m off it. */
  web?: { ax: number; ay: number; az: number; bx: number; by: number; bz: number } | null;
};

/** Round 11: the arm directions (yaw, pitch offsets, rad) tried when the arm is pulled in under armMin. */
const DODGES: ReadonlyArray<readonly [number, number]> = [
  [0, 0.35], [0.45, 0], [-0.45, 0], [0.45, 0.35], [-0.45, 0.35], [0, 0.7], [0.9, 0], [-0.9, 0], [0.9, 0.35], [-0.9, 0.35], [1.4, 0.2], [-1.4, 0.2],
];

/** Distance from point c to segment a-b. */
function segDist(cx: number, cy: number, cz: number, w: NonNullable<RigInput["web"]>): number {
  const dx = w.bx - w.ax, dy = w.by - w.ay, dz = w.bz - w.az;
  const l2 = dx * dx + dy * dy + dz * dz || 1;
  let t = ((cx - w.ax) * dx + (cy - w.ay) * dy + (cz - w.az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = w.ax + dx * t - cx, py = w.ay + dy * t - cy, pz = w.az + dz * t - cz;
  return Math.sqrt(px * px + py * py + pz * pz);
}

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
  // Arm length free along the arm at yaw / pitch offsets (the camera stops 0.3 m short of the first facade), and
  // a penalty when that camera spot sits on the web line.
  const arm = r.arm, web = s.web ?? null, webClear = cam.webClear;
  const armAt = (oy: number, op: number, out: Vec3): number => {
    const y = r.yaw + oy, pp = Math.min(PITCH_MAX, r.pitch + op), cp = Math.cos(pp);
    out.x = Math.sin(y) * cp; out.y = -Math.sin(pp); out.z = Math.cos(y) * cp;
    if (!hit) return arm;
    const t = hit(bx, ty, bz, bx + out.x * arm, ty + out.y * arm, bz + out.z * arm);
    return t >= 0 ? Math.max(0.6, t * arm - 0.3) : arm;
  };
  const onWeb = (d: Vec3, l: number): boolean => web !== null && webClear > 0 && segDist(bx + d.x * l, ty + d.y * l, bz + d.z * l, web) < webClear;
  // The room a camera spot gives: the arm, or less when that spot is nearer the Radbro's chest (the look point leans
  // up to ropeBiasMax toward the pivot on the rope, so a short arm along the lean can end right at his head).
  const cx = s.p.x, cy = s.p.y + 0.3, cz = s.p.z;
  const room = (d: Vec3, l: number): number => {
    const ex = bx + d.x * l - cx, ey = ty + d.y * l - cy, ez = bz + d.z * l - cz;
    const c = Math.sqrt(ex * ex + ey * ey + ez * ez);
    return c < l ? c : l;
  };
  const need = Math.min(cam.armMin, arm);
  let wantY = r.dodgeYaw, wantP = r.dodgePitch;
  if (hit && cam.armMin > 0) {
    const l0 = armAt(0, 0, DIR);
    if (room(DIR, l0) >= need && !onWeb(DIR, l0)) { wantY = 0; wantP = 0; }
    else {
      const lc = armAt(r.dodgeYaw, r.dodgePitch, DIR);
      if (room(DIR, lc) < need || onWeb(DIR, lc)) {
        // Blocked (or on the web): the free direction nearest the aim wins.
        let best = -Infinity;
        for (const [oy, op] of DODGES) {
          const l = armAt(oy, op, DIR);
          const sc = Math.min(room(DIR, l), arm) - (onWeb(DIR, l) ? arm : 0) - 1.2 * (oy < 0 ? -oy : oy) - 1.5 * op;
          if (sc > best) { best = sc; wantY = oy; wantP = op; }
        }
      }
    }
  }
  // Eased at dodgeRate; 4x as fast while the room sits under half of armMin (a facade right behind the Radbro).
  const lNow = hit !== null && cam.armMin > 0 ? armAt(r.dodgeYaw, r.dodgePitch, DIR) : arm;
  const cramped = hit !== null && cam.armMin > 0 && room(DIR, lNow) < 0.5 * need;
  const ke = Math.min(1, cam.dodgeRate * dt * (cramped ? 4 : 1));
  r.dodgeYaw += (wantY - r.dodgeYaw) * ke;
  r.dodgePitch += (wantP - r.dodgePitch) * ke;
  const used = armAt(r.dodgeYaw, r.dodgePitch, DIR);
  r.armUsed = used;
  r.pos.x = bx + DIR.x * used;
  r.pos.y = ty + DIR.y * used;
  r.pos.z = bz + DIR.z * used;
  // Round 11: on a wall run (and just off a wall) the camera itself keeps wallCam m off the wall's face (the face is
  // the body's half width behind the Radbro), eased in with the look point's offset, so it never rides the facade.
  if (cam.wallCam > 0 && cam.wallAway > 0 && r.wallOff > 1e-3) {
    const f = Math.min(1, r.wallOff / cam.wallAway);
    const off = (r.pos.x - s.p.x) * r.wallNx + (r.pos.z - s.p.z) * r.wallNz + BODY_HALF;
    // (Far behind the wall's plane the camera is round the wall's end, not on its face: leave it there.)
    if (off > -cam.wallCam && off < cam.wallCam) {
      let push = (cam.wallCam - off) * f;
      // (Never through another facade: stop 0.3 m short of one.)
      const t = hit ? hit(r.pos.x, r.pos.y, r.pos.z, r.pos.x + r.wallNx * push, r.pos.y, r.pos.z + r.wallNz * push) : -1;
      if (t >= 0) push = Math.max(0, t * push - 0.3);
      r.pos.x += r.wallNx * push;
      r.pos.z += r.wallNz * push;
    }
  }
  { const ex = r.pos.x - cx, ey = r.pos.y - cy, ez = r.pos.z - cz; r.bodyDist = Math.sqrt(ex * ex + ey * ey + ez * ez); }

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
