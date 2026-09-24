// George's campaign hats follow the head bone's motion (app/hats.ts): upright on the body's yaw in the bind
// pose, and turned / tilted by exactly the head's rotation away from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Group, Object3D, Quaternion, Vector3 } from "three";
import { HAT_FWD, HAT_LIFT, headRestInverse, makeHats, placeHats } from "../src/app/hats.ts";

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test("hats: bind pose = the body's yaw; a head turn / nod turns the hat by the same rotation", () => {
  const root = new Group();
  const neck = new Object3D();
  neck.position.set(0, 0.3, 0.2);
  neck.rotation.set(-1.2, 0.3, 0.1); // an arbitrary rig orientation, as exported
  const head = new Object3D();
  head.position.set(0, 0.1, 0);
  root.add(neck);
  neck.add(head);
  const rest = headRestInverse(root, head);
  const hats = makeHats();
  // Bind pose, body turned: hat rotation = body yaw, sitting HAT_LIFT above + HAT_FWD ahead of the bone.
  root.rotation.y = 0.8;
  root.updateMatrixWorld(true);
  placeHats(hats, head, rest, 1);
  const yawQ = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.8);
  assert.ok(near(Math.abs(hats.quaternion.dot(yawQ)), 1));
  const hp = head.getWorldPosition(new Vector3());
  const want = new Vector3(0, HAT_LIFT, HAT_FWD).applyQuaternion(yawQ).add(hp);
  assert.ok(hats.position.distanceTo(want) < 1e-6);
  // The head nods / turns: the hat picks up exactly that extra world rotation.
  const before = hats.quaternion.clone();
  const hq0 = head.getWorldQuaternion(new Quaternion());
  head.rotation.set(0.4, -0.5, 0.2);
  root.updateMatrixWorld(true);
  placeHats(hats, head, rest, 1.16);
  const hq1 = head.getWorldQuaternion(new Quaternion());
  const delta = hq1.clone().multiply(hq0.invert()); // world-space head motion
  const expect = delta.multiply(before);
  assert.ok(near(Math.abs(hats.quaternion.dot(expect)), 1));
  assert.ok(near(hats.scale.x, 1.16));
});
