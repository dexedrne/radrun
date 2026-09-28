// The procedural air poses (app/airPose.ts): the weights ease in and out, a perfect release starts a flip that ends on
// time, the dive turns the body along the velocity, and the limb aims land where the pose wants them on a rig with any
// rest rotations (the Radbro rigs differ); a zero weight leaves the clip's pose alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bone, Group, Quaternion, Vector3, Euler } from "three";
import { AIR, airBones, airFlip, airInput, airRoot, newAirPose, poseBones, stepAirPose, type AirPoseIn } from "../src/app/airPose.ts";
import { mulberry32 } from "../src/sim/math.ts";

/** A Mixamo-named skeleton with random rest rotations (children offset along the parent's +y, like the Radbro GLBs). */
function rig(seed: number): { root: Group; model: Group; bone: (n: string) => Bone } {
  const r = mulberry32(seed);
  const root = new Group(), model = new Group();
  root.add(model);
  const bones = new Map<string, Bone>();
  const mk = (name: string, parent: Group | Bone, off: [number, number, number]) => {
    const b = new Bone();
    b.name = name;
    b.position.set(...off);
    b.quaternion.setFromEuler(new Euler((r() - 0.5) * 2, (r() - 0.5) * 2, (r() - 0.5) * 2));
    parent.add(b);
    bones.set(name, b);
    return b;
  };
  const hips = mk("Hips", model, [0, 0.9, 0]);
  const spine = mk("Spine", hips, [0, 0.3, 0]);
  mk("neck", spine, [0, 0.25, 0]);
  for (const s of ["Left", "Right"]) {
    const arm = mk(`${s}Arm`, spine, [s === "Left" ? 0.15 : -0.15, 0.2, 0]);
    const fore = mk(`${s}ForeArm`, arm, [0, 0.25, 0]);
    mk(`${s}Hand`, fore, [0, 0.22, 0]);
    const up = mk(`${s}UpLeg`, hips, [s === "Left" ? 0.1 : -0.1, -0.05, 0]);
    const leg = mk(`${s}Leg`, up, [0, 0.4, 0]);
    mk(`${s}Foot`, leg, [0, 0.4, 0]);
  }
  root.updateMatrixWorld(true);
  return { root, model, bone: n => bones.get(n)! };
}

const inp = (o: Partial<AirPoseIn>): AirPoseIn => ({ dt: 1 / 60, dive: false, fall: false, glide: false, hanging: false, arc: 0, perfect: false, near: false, ...o });

test("glide spreads both arms and legs and eases out on release", () => {
  const a = newAirPose(), r = rig(6);
  for (let i = 0; i < 60; i++) stepAirPose(a, inp({ glide: true }));
  assert.ok(a.glide > 0.95 && a.sky < 0.05);
  airBones(a, poseBones(r.model), r.root, false);
  const left = dirOf(r.bone("LeftArm"), r.bone("LeftForeArm"));
  const right = dirOf(r.bone("RightArm"), r.bone("RightForeArm"));
  assert.ok(left.x * right.x < 0, "arms spread to opposite sides");
  for (let i = 0; i < 60; i++) stepAirPose(a, inp({}));
  assert.ok(a.glide < 0.05);
});
const dirOf = (a: Bone, b: Bone) => b.getWorldPosition(new Vector3()).sub(a.getWorldPosition(new Vector3())).normalize();

test("air pose weights: the dive and the skydive ease in, let go near the ground; a perfect release flips, once, on time", () => {
  const a = newAirPose();
  for (let i = 0; i < 60; i++) stepAirPose(a, inp({ dive: true }));
  assert.ok(a.dive > 0.99 && a.sky < 0.01);
  for (let i = 0; i < 10; i++) stepAirPose(a, inp({ dive: true, near: true }));
  assert.ok(a.dive < 0.2, `near the ground the dive lets go (${a.dive.toFixed(2)})`);
  for (let i = 0; i < 90; i++) stepAirPose(a, inp({ fall: true }));
  assert.ok(a.sky > 0.97);
  stepAirPose(a, inp({ perfect: true }));
  assert.equal(a.flipT, 0);
  assert.equal(a.flipKind, 0);
  let n = 0;
  while (a.flipT >= 0 && n < 200) { stepAirPose(a, inp({})); n++; }
  assert.ok(Math.abs(n / 60 - AIR.flipFor) < 0.05, `flip ${(n / 60).toFixed(2)} s`);
  stepAirPose(a, inp({ perfect: true }));
  assert.equal(a.flipKind, 1, "every other one a twirl");
  // On a web: the tuck follows the arc (full at the bottom).
  for (let i = 0; i < 120; i++) stepAirPose(a, inp({ hanging: true, arc: 1 }));
  assert.ok(a.swing > 0.99 && a.tuck > 0.99 && a.flipT < 0);
  for (let i = 0; i < 120; i++) stepAirPose(a, inp({ hanging: true, arc: 0.6 }));
  assert.ok(a.tuck < 0.01);
});

test("air pose inputs: a skydive only in a real fall with room below; near = the last fraction of a second before the ground", () => {
  const o = inp({});
  const p = { x: 0, y: 50, z: 0 };
  assert.equal(airInput(o, 1 / 60, false, true, null, p, -12, 40, false).fall, true);
  assert.equal(airInput(o, 1 / 60, false, true, null, p, -3, 40, false).fall, false, "not falling fast");
  assert.equal(airInput(o, 1 / 60, false, false, null, p, -12, 40, false).fall, false, "on a wall / zip / web");
  assert.equal(airInput(o, 1 / 60, true, true, null, p, -40, 3, false).near, true, "a 40 m/s dive 3 m up");
  assert.equal(airInput(o, 1 / 60, true, true, null, p, -40, 10, false).near, false);
  const h = airInput(o, 1 / 60, false, false, { x: 0, y: 70, z: 0 }, p, 0, 40, false);
  assert.ok(h.hanging && Math.abs(h.arc - 1) < 1e-9, "straight under the anchor = the bottom of the arc");
});

test("dive root: the model's up runs along the velocity (head first), belly toward the ground; the flip turns a full circle", () => {
  const a = newAirPose();
  a.dive = 1;
  const q = new Quaternion();
  airRoot(a, 0, 10, -30, 0, q);
  const up = new Vector3(0, 1, 0).applyQuaternion(q), belly = new Vector3(0, 0, 1).applyQuaternion(q);
  const v = new Vector3(10, -30, 0).normalize();
  assert.ok(up.dot(v) > 0.999, "head first");
  assert.ok(belly.y < -0.2, "belly down-ish");
  a.dive = 0; a.sky = 1;
  const qs = new Quaternion();
  airRoot(a, 0, 0, -20, 0, qs);
  assert.ok(new Vector3(0, 0, 1).applyQuaternion(qs).y < -0.9, "skydive: belly down");
  // A flip at its middle is upside down, at its end back where it started.
  a.sky = 0; a.flipT = AIR.flipFor / 2; a.flipKind = 0;
  const qf = new Quaternion();
  airFlip(a, qf);
  assert.ok(new Vector3(0, 1, 0).applyQuaternion(qf).y < -0.99);
});

test("limb aims: on rigs with any rest rotations the dive sweeps the arms back along the body; weight 0 changes nothing", () => {
  for (const seed of [1, 2, 3]) {
    const { root, model, bone } = rig(seed);
    const bones = poseBones(model);
    const before = bone("RightArm").quaternion.clone();
    const a = newAirPose();
    airBones(a, bones, root, false);
    assert.ok(bone("RightArm").quaternion.equals(before), "no pose = the clip's pose");
    a.dive = 1;
    airBones(a, bones, root, false);
    // Dive arm (right side, body frame right = -x): (0.3, -1, -0.3) (right, up, forward); the left side mirrors it.
    const want = new Vector3(-0.3, -1, -0.3).normalize();
    assert.ok(dirOf(bone("RightArm"), bone("RightForeArm")).dot(want) > 0.999, `seed ${seed}: the upper arm`);
    assert.ok(dirOf(bone("LeftUpLeg"), bone("LeftLeg")).dot(new Vector3(0.06, -1, -0.12).normalize()) > 0.999, `seed ${seed}: the thigh`);
    // Hanging from a web: the swing layer never touches the web arm.
    const r2 = rig(seed), b2 = poseBones(r2.model), p2 = newAirPose();
    p2.swing = 1; p2.tuck = 1;
    const webArm = r2.bone("RightArm").quaternion.clone();
    airBones(p2, b2, r2.root, true);
    assert.ok(r2.bone("RightArm").quaternion.equals(webArm), "the web arm keeps its pose");
    assert.ok(dirOf(r2.bone("LeftUpLeg"), r2.bone("LeftLeg")).dot(new Vector3(0.12, -0.45, 0.9).normalize()) > 0.75, "knees tucked up (at the tuck's 0.85 weight)");
  }
});
