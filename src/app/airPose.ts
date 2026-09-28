// Procedural air poses (docs/specs/2026-09-27-web-slinger-swing.md §4), layered over the clip packs on the same rig, view
// only (nothing here feeds back into the sim):
//   dive     head-first: the body along the velocity, arms swept back along it, legs together;
//   skydive  a long fall: belly down, arms and legs spread, knees bent, a little flutter;
//   swing    on a web: knees tucked through the bottom of the arc, legs and the free (left) arm reaching out at its ends
//            (the right arm is the web arm: the hand stays on the web);
//   flip     a perfect release: a tucked front flip, or every other one a twirl.
// The root pass orients the whole body (dive / skydive / the flip's turn); the bone pass, after the mixer, aims the limbs
// (each upper and lower limb bone turned so it points where the pose wants it, in the body's frame: rig-agnostic, it
// only needs the Mixamo-style bone names every Radbro rig has) and blends by the eased weights, so the clip underneath
// still shows through as the weights fade.
import { Quaternion, Vector3, Matrix4, type Bone, type Object3D } from "three";
import type { ActorRig } from "./ActorsView.tsx";

export type PoseBones = {
  spine?: Bone; neck?: Bone;
  lArm?: Bone; lFore?: Bone; lHand?: Bone; rArm?: Bone; rFore?: Bone; rHand?: Bone;
  lUp?: Bone; lLeg?: Bone; lFoot?: Bone; rUp?: Bone; rLeg?: Bone; rFoot?: Bone;
};

export function poseBones(model: Object3D): PoseBones {
  const find = (name: string): Bone | undefined => {
    let out: Bone | undefined;
    model.traverse(o => { if (!out && o.name === name) out = o as Bone; });
    return out;
  };
  return {
    spine: find("Spine"), neck: find("neck"),
    lArm: find("LeftArm"), lFore: find("LeftForeArm"), lHand: find("LeftHand"),
    rArm: find("RightArm"), rFore: find("RightForeArm"), rHand: find("RightHand"),
    lUp: find("LeftUpLeg"), lLeg: find("LeftLeg"), lFoot: find("LeftFoot"),
    rUp: find("RightUpLeg"), rLeg: find("RightLeg"), rFoot: find("RightFoot"),
  };
}

/** Eased pose weights and the flip clock of one character. */
export type AirPose = {
  dive: number;
  sky: number;
  /** Swing layer: its weight and, of it, the tuck share (1 = the bottom of the arc, 0 = its ends). */
  swing: number;
  tuck: number;
  /** Seconds into the current flip (< 0: none), which kind (0 front flip, 1 twirl) and how many so far. */
  flipT: number;
  flipKind: number;
  flips: number;
  /** Seconds since mounted (the skydive flutter). */
  t: number;
};
export const newAirPose = (): AirPose => ({ dive: 0, sky: 0, swing: 0, tuck: 0, flipT: -1, flipKind: 0, flips: 0, t: 0 });

export type AirPoseIn = {
  dt: number;
  /** Head-first dive on (the sim's diveOn). */
  dive: boolean;
  /** A long fall with nothing else going on (no web, zip, wall or ledge), falling fast with room below. */
  fall: boolean;
  /** Hanging from a web (rope or corner) and, then, the cosine of the web's angle from straight down (1 = the bottom). */
  hanging: boolean;
  arc: number;
  /** A perfect release this frame (starts a flip / twirl). */
  perfect: boolean;
  /** Close above the ground: every air pose lets go (the feet come down for the landing). */
  near: boolean;
};

/** Pose timing: flip length (s), ease rates in / out (1/s). */
export const AIR = {
  flipFor: 0.62,
  diveIn: 7, diveOut: 9, skyIn: 2.6, skyOut: 7, nearOut: 14, swingIn: 6, swingOut: 8, tuckRate: 5,
  /** The swing's tuck: from this cosine from straight down (full at tuckFull). */
  tuckFrom: 0.82, tuckFull: 0.97,
  /** The skydive's head-up tilt (rad) and flutter (rad-ish amplitude, rad/s). */
  skyTilt: 0.22, flutter: 0.08, flutterRate: 7,
} as const;

const ease = (w: number, want: number, rateIn: number, rateOut: number, dt: number) =>
  w + (want - w) * Math.min(1, (want > w ? rateIn : rateOut) * dt);

/** One render frame of the pose state machine (weights, flip clock). */
export function stepAirPose(a: AirPose, i: AirPoseIn): void {
  a.t += i.dt;
  const out = i.near ? AIR.nearOut : 0;
  a.dive = ease(a.dive, i.dive && !i.hanging && !i.near ? 1 : 0, AIR.diveIn, out || AIR.diveOut, i.dt);
  a.sky = ease(a.sky, i.fall && !i.dive && !i.hanging && !i.near ? 1 : 0, AIR.skyIn, out || AIR.skyOut, i.dt);
  a.swing = ease(a.swing, i.hanging ? 1 : 0, AIR.swingIn, AIR.swingOut, i.dt);
  const t = i.hanging ? Math.max(0, Math.min(1, (i.arc - AIR.tuckFrom) / (AIR.tuckFull - AIR.tuckFrom))) : a.tuck;
  a.tuck += (t - a.tuck) * Math.min(1, AIR.tuckRate * i.dt);
  if (i.perfect && !i.hanging) { a.flipT = 0; a.flipKind = a.flips % 2; a.flips++; }
  else if (a.flipT >= 0) {
    a.flipT += i.dt;
    if (a.flipT >= AIR.flipFor || i.hanging || i.near) a.flipT = -1;
  }
}

/** The flip's bell (0 -> 1 -> 0 over the flip): how much the tuck pose shows. */
const flipBell = (a: AirPose) => (a.flipT < 0 ? 0 : Math.sin((Math.PI * a.flipT) / AIR.flipFor));
/** Anything in the air pose moving the root this frame (the view rotates the root's offset with it). */
export const airRootWeight = (a: AirPose): number => Math.max(a.dive, a.sky, a.flipT >= 0 ? 1 : 0);

const V = { u: new Vector3(), f: new Vector3(), x: new Vector3(), h: new Vector3(), m: new Matrix4(), q: new Quaternion(), qf: new Quaternion(), ax: new Vector3() };

/** out = the rotation whose model up is `u` and model forward (belly) is `f` (both unit, perpendicular). */
function basis(u: Vector3, f: Vector3, out: Quaternion): Quaternion {
  V.x.crossVectors(u, f).normalize();
  V.m.makeBasis(V.x, u, f);
  return out.setFromRotationMatrix(V.m);
}

/** Fall speeds / heights for the skydive and the landing (m/s, m). */
const FALL_VY = -7, FALL_CLEAR = 4.5, NEAR_MIN = 2.2, NEAR_T = 0.09;

/**
 * This frame's pose input from what the view knows: `air` = airborne with nothing else going on (no web, zip, wall or
 * ledge), `hang` = the point hung from (rope anchor / corner post) or null, `clearance` = the feet's height over the
 * ground below. Fills and returns `out`.
 */
export function airInput(out: AirPoseIn, dt: number, dive: boolean, air: boolean, hang: { x: number; y: number; z: number } | null,
  p: { x: number; y: number; z: number }, vy: number, clearance: number, perfect: boolean): AirPoseIn {
  out.dt = dt;
  out.dive = dive;
  out.fall = air && vy < FALL_VY && clearance > FALL_CLEAR;
  out.hanging = hang !== null;
  if (hang) {
    const dx = hang.x - p.x, dy = hang.y - p.y, dz = hang.z - p.z, l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    out.arc = l > 1e-6 ? dy / l : 0;
  } else out.arc = 0;
  out.perfect = perfect;
  out.near = (air || dive) && vy < 0 && clearance < Math.max(NEAR_MIN, -vy * NEAR_T);
  return out;
}

/**
 * The -5 root placement with the air pose: `q` (the view's target orientation) turned toward the dive / skydive, eased
 * into rig.qBase (14 /s, as before), the flip on top (not eased); the root sits at `pos` (the body point + the view's
 * eased offset), or, while an air pose turns the body, round the body point (its origin 0.9 m down the body's axis).
 */
export function placeRoot(rig: ActorRig, q: Quaternion, pos: Vector3, hanging: boolean, vx: number, vy: number, vz: number, dt: number): void {
  airRoot(rig.air, rig.yaw, vx, vy, vz, q);
  rig.qBase.slerp(q, Math.min(1, 14 * dt));
  const rq = rig.root.quaternion.copy(rig.qBase);
  airFlip(rig.air, rq);
  const w = hanging ? 0 : airRootWeight(rig.air);
  if (w > 1e-3) {
    V.h.set(0, -0.9, 0).applyQuaternion(rq).add(rig.p);
    pos.lerp(V.h, w);
  }
  rig.root.position.copy(pos);
}

/**
 * Root orientation: `q` (the view's own: yaw, rope tilt, wall roll) turned toward the dive (model up along the velocity,
 * the belly toward the ground) and the skydive (level, belly down, head a little up, facing `yaw`) by their weights.
 * In place.
 */
export function airRoot(a: AirPose, yaw: number, vx: number, vy: number, vz: number, q: Quaternion): void {
  const hx = Math.sin(yaw), hz = Math.cos(yaw);
  if (a.dive > 1e-3) {
    const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (l > 1) V.u.set(vx / l, vy / l, vz / l); else V.u.set(0, -1, 0);
    // Belly: the ground side across the body; a straight-down dive faces the way it was going.
    V.f.set(0, -1, 0).addScaledVector(V.u, V.u.y);
    if (V.f.lengthSq() < 0.04) V.f.set(hx, 0, hz).addScaledVector(V.u, -(V.u.x * hx + V.u.z * hz));
    V.f.normalize();
    q.slerp(basis(V.u, V.f, V.q), a.dive);
  }
  if (a.sky > 1e-3) {
    const c = Math.cos(AIR.skyTilt), s = Math.sin(AIR.skyTilt);
    V.u.set(hx * c, s, hz * c);
    V.f.set(hx * s, -c, hz * s);
    q.slerp(basis(V.u, V.f, V.q), a.sky * (1 - a.dive));
  }
}

/** The flip on top of the root's orientation (a front flip about the body's side axis, or a twirl about its long axis). */
export function airFlip(a: AirPose, q: Quaternion): void {
  if (a.flipT >= 0) {
    const x = a.flipT / AIR.flipFor, e = x * x * (3 - 2 * x);
    // About the model's +x (its left; a positive turn tips the head forward: a front flip), or its +y (the twirl).
    if (a.flipKind === 0) V.ax.set(1, 0, 0); else V.ax.set(0, 1, 0);
    V.qf.setFromAxisAngle(V.ax, 2 * Math.PI * e);
    q.multiply(V.qf);
  }
}

type Dir = readonly [number, number, number];
/** Limb directions in the body frame as (right, up, forward) for the right side (the left mirrors right). */
const POSES: Record<"dive" | "sky" | "tuck" | "reach" | "flip" | "twirl", Partial<Record<"arm" | "fore" | "up" | "leg" | "chest", Dir>>> = {
  dive: { arm: [0.3, -1, -0.3], fore: [0.2, -1, -0.2], up: [0.06, -1, -0.12], leg: [0.03, -1, -0.25], chest: [0, 1, -0.15] },
  sky: { arm: [0.8, 0.45, -0.35], fore: [0.35, 0.8, -0.45], up: [0.35, -0.9, -0.15], leg: [0.15, -0.45, -0.9], chest: [0, 1, -0.3] },
  // (swing: the legs and the free left arm only)
  tuck: { arm: [0.35, -0.5, 0.6], fore: [0.1, 0.4, 0.9], up: [0.12, -0.45, 0.9], leg: [0.05, -1, 0.1] },
  reach: { arm: [0.9, 0.05, 0.2], fore: [0.85, 0.2, 0.3], up: [0.08, -1, 0.35], leg: [0.05, -1, 0.2] },
  flip: { arm: [0.25, -0.3, 0.9], fore: [-0.1, -0.6, 0.6], up: [0.1, 0.3, 0.95], leg: [0.05, -1, -0.1] },
  twirl: { arm: [0.15, -1, 0.1], fore: [0.1, -1, 0.1], up: [0.02, -1, 0], leg: [0.02, -1, 0] },
};

const B = { r: new Vector3(), u: new Vector3(), f: new Vector3(), q: new Quaternion(), d: new Vector3(), a: new Vector3(), b: new Vector3(), pq: new Quaternion(), wq: new Quaternion(), full: new Quaternion(), id: new Quaternion() };

/** Turn `bone` so the direction to `child` points along the unit world `dir`, by weight w (after the mixer). */
function aim(bone: Bone | undefined, child: Bone | undefined, dir: Vector3, w: number): void {
  if (!bone || !child || !bone.parent || w < 1e-3) return;
  bone.getWorldPosition(B.a);
  child.getWorldPosition(B.b);
  B.b.sub(B.a);
  if (B.b.lengthSq() < 1e-10) return;
  B.b.normalize();
  B.full.setFromUnitVectors(B.b, dir);
  B.wq.slerpQuaternions(B.id, B.full, w < 1 ? w : 1);
  // World rotation W on a bone: L' = P^-1 W P L.
  bone.parent.getWorldQuaternion(B.pq);
  B.wq.premultiply(B.q.copy(B.pq).invert()).multiply(B.pq);
  bone.quaternion.premultiply(B.wq);
  bone.updateMatrixWorld(true);
}

/** Sum of weighted pose directions for one limb part (side +1 right, -1 left), in the world; its weight. */
function blend(part: "arm" | "fore" | "up" | "leg" | "chest", side: number, ws: readonly [keyof typeof POSES, number][], wobble: number): number {
  B.d.set(0, 0, 0);
  let W = 0;
  for (const [pose, w] of ws) {
    const d = POSES[pose][part];
    if (!d || w < 1e-3) continue;
    const up = d[1] + (pose === "sky" ? wobble : 0);
    B.d.addScaledVector(B.r, d[0] * side * w).addScaledVector(B.u, up * w).addScaledVector(B.f, d[2] * w);
    W += w;
  }
  if (W < 1e-3 || B.d.lengthSq() < 1e-8) return 0;
  B.d.normalize();
  return Math.min(1, W);
}

/**
 * The bone pass (after the mixer and the view's own arm / hip turns, before the rope hand correction): the limbs aimed
 * by the pose weights in the frame of `root` (the model faces +z, its right is -x). `webArm`: the right arm holds a web
 * (left alone by the swing layer).
 */
export function airBones(a: AirPose, bones: PoseBones, root: Object3D, webArm: boolean): void {
  const flip = flipBell(a);
  const sw = a.swing;
  const ws: [keyof typeof POSES, number][] = [
    ["dive", a.dive * (1 - flip)],
    ["sky", a.sky * (1 - a.dive) * (1 - flip)],
    ["tuck", sw * a.tuck * 0.85],
    ["reach", sw * (1 - a.tuck) * 0.6],
    [a.flipKind === 0 ? "flip" : "twirl", flip],
  ];
  if (ws.every(([, w]) => w < 1e-3)) return;
  root.getWorldQuaternion(B.q);
  B.r.set(-1, 0, 0).applyQuaternion(B.q);
  B.u.set(0, 1, 0).applyQuaternion(B.q);
  B.f.set(0, 0, 1).applyQuaternion(B.q);
  const wob = AIR.flutter * Math.sin(a.t * AIR.flutterRate) * a.sky;
  // Chest first (it carries the arms), then each limb from the top down.
  let w = blend("chest", 1, ws, 0);
  if (w > 0) aim(bones.spine, bones.neck, B.d, w * 0.6);
  for (const side of [1, -1]) {
    const R = side > 0;
    // The web arm (the right, on a web) keeps its clip + hand correction: the swing layer leaves it out.
    const arms = R && webArm ? ws.map(([p, x]) => [p, p === "tuck" || p === "reach" ? 0 : x] as [keyof typeof POSES, number]) : ws;
    w = blend("arm", side, arms, side * wob);
    if (w > 0) aim(R ? bones.rArm : bones.lArm, R ? bones.rFore : bones.lFore, B.d, w);
    w = blend("fore", side, arms, side * wob);
    if (w > 0) aim(R ? bones.rFore : bones.lFore, R ? bones.rHand : bones.lHand, B.d, w);
    w = blend("up", side, ws, -side * wob);
    if (w > 0) aim(R ? bones.rUp : bones.lUp, R ? bones.rLeg : bones.lLeg, B.d, w);
    w = blend("leg", side, ws, -side * wob);
    if (w > 0) aim(R ? bones.rLeg : bones.lLeg, R ? bones.rFoot : bones.lFoot, B.d, w);
  }
}
