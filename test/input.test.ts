// Touch controls write the same InputLatch as the keyboard and mouse, so the sim sees the same
// InputFrame (spec §4 "Touch").
import { test } from "node:test";
import assert from "node:assert/strict";
import { InputLatch } from "../src/input/input.ts";
import { emptyInput } from "../src/sim/player.ts";

const frame = (l: InputLatch, yaw = 0.7) => ({ ...l.consume(emptyInput(), Math.sin(yaw), Math.cos(yaw), 0.3, 0.1, -0.9) });

test("touch stick + WEB + JUMP produce the same InputFrame as W + LMB + Space", () => {
  const keys = new InputLatch(), touch = new InputLatch();
  keys.press("KeyW"); keys.press("Space"); keys.mouseDown(0);
  touch.setStick(0, 1); touch.touchJump(); touch.touchWebDown();
  assert.deepEqual(frame(touch), frame(keys));
  // held on the next step, edges consumed
  assert.deepEqual(frame(touch), frame(keys));
  keys.mouseUp(0); touch.touchWebUp();
  assert.deepEqual(frame(touch), frame(keys));
  // a diagonal thumb matches W + D (normalised), dead zone = no move
  const k2 = new InputLatch(), t2 = new InputLatch();
  k2.press("KeyW"); k2.press("KeyD");
  t2.setStick(Math.SQRT1_2, Math.SQRT1_2);
  const a = frame(k2), b = frame(t2);
  assert.ok(Math.abs(a.moveX - b.moveX) < 1e-12 && Math.abs(a.moveZ - b.moveZ) < 1e-12);
  t2.setStick(0.1, 0.05);
  const c = frame(t2);
  assert.ok(c.moveX === 0 && c.moveZ === 0);
});
