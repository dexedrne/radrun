// Round 14 gamepads: the pad writes the same InputLatch as the keyboard / mouse / touch, so it records the same
// quantised input word (ghosts, share links and the online rollback depend on it); the stick shaping, the trigger
// hysteresis, the menu repeat, the spatial menu navigation and the prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InputLatch } from "../src/input/input.ts";
import { LAYOUT, LS_UP, LookShaper, NavRepeat, PAD, PAD_DEFAULTS, PB, PadButtons, padKind, padToLatch, radial, type PadSnap } from "../src/input/gamepad.ts";
import { emptyRec } from "../src/game/ghost.ts";
import { packWord } from "../src/net/wire.ts";
import { pickNext, type Rect } from "../src/ui/padNav.ts";
import { PAD_NAMES, TOKEN_RE, keysOf, padPlain, plainKeys, radrunPadControls, radrunPadHud, RADRUN_PAD_GUIDE } from "../src/ui/padPrompts.ts";

(globalThis as { location?: unknown }).location ??= { search: "" };
const { hintText } = await import("../src/ui/hints.ts");
const { RADRUN } = await import("../src/radbro/bridge.ts");

/** A standard-mapping pad: 4 axes, 18 buttons (analog values for the triggers). */
function snap(axes: number[] = [0, 0, 0, 0], held: Partial<Record<keyof typeof PB, number>> = {}): PadSnap {
  const buttons = Array.from({ length: 18 }, () => ({ pressed: false, value: 0 }));
  for (const [k, v] of Object.entries(held)) buttons[PB[k as keyof typeof PB]] = { pressed: (v ?? 0) > 0.5, value: v ?? 0 };
  return { id: "test pad", index: 0, axes, buttons };
}

/** Feed one poll's pad state into a latch (a fresh tracker per call keeps the previous state in `b`). */
function feed(l: InputLatch, b: PadButtons, s: PadSnap, look = new LookShaper()): void {
  b.update(s);
  padToLatch(l, s, b, look, PAD_DEFAULTS, 1 / 60);
}

test("pad kind from the id: DualSense / DualShock = PlayStation glyphs, Xbox and unknown pads = Xbox glyphs", () => {
  assert.equal(padKind("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"), "ps");
  assert.equal(padKind("Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)"), "ps");
  assert.equal(padKind("054c-0ce6-Sony Interactive Entertainment DualSense Wireless Controller"), "ps");
  assert.equal(padKind("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"), "xbox");
  assert.equal(padKind("045e-02ea-Microsoft X-Box One S pad"), "xbox");
  assert.equal(padKind("8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 6006)"), "xbox");
});

test("radial dead zone keeps the direction, rescales past the dead zone and curves the response", () => {
  assert.deepEqual(radial(0.05, 0.05, 0.12), [0, 0]);
  const [x, y] = radial(0.7, 0.7, 0.12); // |v| 0.99 -> 0.99 of the way out after the rescale
  assert.ok(Math.abs(x - y) < 1e-12 && x > 0.68 && Math.sqrt(x * x + y * y) <= 1 + 1e-12);
  const [fx] = radial(1, 0, 0.12);
  assert.equal(fx, 1);
  // just past the dead zone = just above zero (no jump), and monotonic
  let prev = 0;
  for (let v = 0.13; v <= 1; v += 0.01) { const [m] = radial(v, 0, 0.12, PAD.lookExp); assert.ok(m >= prev); prev = m; }
  assert.ok(radial(0.13, 0, 0.12)[0] < 0.02);
  // the curve: half tilt looks slower than linear
  assert.ok(radial(0.56, 0, 0.12, PAD.lookExp)[0] < radial(0.56, 0, 0.12)[0]);
});

test("the pad records the same input word as the keyboard and mouse", () => {
  const yaw = 0.7, pitch = 0.2;
  const keys = new InputLatch(), pad = new InputLatch(), b = new PadButtons();
  keys.press("KeyW"); keys.press("Space"); keys.mouseDown(0);
  feed(pad, b, snap([0, -1, 0, 0], { SOUTH: 1, R2: 1 }));
  const rk = keys.sample(emptyRec(), yaw, pitch), rp = pad.sample(emptyRec(), yaw, pitch);
  assert.deepEqual(rp, rk);
  assert.equal(packWord(rp), packWord(rk));
  // held on the next step (Space / R2 still down), the presses consumed
  feed(pad, b, snap([0, -1, 0, 0], { SOUTH: 1, R2: 1 }));
  assert.deepEqual(pad.sample(emptyRec(), yaw, pitch), keys.sample(emptyRec(), yaw, pitch));
  // full diagonal tilt = W + D exactly (out to the square at the rim)
  const k2 = new InputLatch(), p2 = new InputLatch();
  k2.press("KeyW"); k2.press("KeyD");
  feed(p2, new PadButtons(), snap([Math.SQRT1_2, -Math.SQRT1_2, 0, 0]));
  assert.deepEqual(p2.sample(emptyRec(), yaw), k2.sample(emptyRec(), yaw));
  // zip (R1 and L2), slide tap + hold (Circle) = E and C
  for (const zip of ["R1", "L2"] as const) {
    const k3 = new InputLatch(), p3 = new InputLatch(), b3 = new PadButtons();
    k3.press("KeyE"); k3.press("KeyC");
    feed(p3, b3, snap(undefined, { [zip]: 1, EAST: 1 }));
    assert.deepEqual(p3.sample(emptyRec(), yaw), k3.sample(emptyRec(), yaw));
    k3.release("KeyE");
    feed(p3, b3, snap(undefined, { EAST: 1 }));
    assert.deepEqual(p3.sample(emptyRec(), yaw), k3.sample(emptyRec(), yaw));
  }
  // L1 / R3 = Q (look at him)
  const p4 = new InputLatch(); feed(p4, new PadButtons(), snap(undefined, { L1: 1 }));
  assert.equal(p4.towardRunner, true);
  // easy grab: Cross is Space (press = jump + web, hold = web held)
  const k5 = new InputLatch(), p5 = new InputLatch();
  k5.easyGrab = p5.easyGrab = true;
  k5.press("Space");
  feed(p5, new PadButtons(), snap(undefined, { SOUTH: 1 }));
  assert.deepEqual(p5.sample(emptyRec(), yaw), k5.sample(emptyRec(), yaw));
});

test("half tilt is half speed, inside the dead zone nothing, and a cleared latch never re-presses a held button", () => {
  const l = new InputLatch(), b = new PadButtons();
  feed(l, b, snap([0, -0.5, 0, 0]));
  const r = l.sample(emptyRec(), 0);
  assert.ok(r.fwd > 20 && r.fwd < 40, `fwd ${r.fwd}`);
  feed(l, b, snap([0.08, -0.08, 0, 0]));
  assert.deepEqual([l.sample(emptyRec(), 0).fwd, l.sample(emptyRec(), 0).right], [0, 0]);
  // hold Circle, the latch is cleared (a blur, a new round): no fresh slide press, still held
  feed(l, b, snap(undefined, { EAST: 1 }));
  l.sample(emptyRec(), 0);
  l.clear();
  feed(l, b, snap(undefined, { EAST: 1 }));
  const r2 = l.sample(emptyRec(), 0);
  assert.equal(r2.bits & 16, 0); // B_SLIDE (press) not set
  assert.equal(r2.bits & 32, 32); // B_SLIDE_HELD
});

test("right stick turns the camera by rate x sensitivity (invert Y flips pitch); the frame applies it", () => {
  const l = new InputLatch(), look = new LookShaper();
  const b = new PadButtons();
  const s = snap([0, 0, 1, 0]);
  b.update(s);
  padToLatch(l, s, b, look, PAD_DEFAULTS, 0.1);
  const [x, y] = l.takePadLook();
  assert.ok(Math.abs(x - PAD.lookYaw * 0.1) < 1e-9 && y === 0);
  assert.deepEqual(l.takePadLook(), [0, 0]);
  const up = snap([0, 0, 0, -1]);
  padToLatch(l, up, b, new LookShaper(), { ...PAD_DEFAULTS, sens: 2 }, 0.1);
  assert.ok(Math.abs(l.takePadLook()[1] + PAD.lookPitch * 0.2) < 1e-9);
  padToLatch(l, up, b, new LookShaper(), { ...PAD_DEFAULTS, invertY: true }, 0.1);
  assert.ok(l.takePadLook()[1] > 0);
});

test("triggers press with hysteresis; the left stick doubles as a d-pad for the menus", () => {
  const b = new PadButtons();
  b.update(snap(undefined, { R2: PAD.trigOn - 0.05 }));
  assert.equal(b.down & (1 << PB.R2), 0);
  b.update(snap(undefined, { R2: PAD.trigOn + 0.05 }));
  assert.ok(b.pressed & (1 << PB.R2));
  b.update(snap(undefined, { R2: (PAD.trigOn + PAD.trigOff) / 2 }));
  assert.ok(b.down & (1 << PB.R2)); // still held between the two thresholds
  b.update(snap(undefined, { R2: PAD.trigOff - 0.05 }));
  assert.ok(b.released & (1 << PB.R2));
  b.update(snap([0, -0.8, 0, 0]));
  assert.ok(b.pressed & (1 << LS_UP));
  assert.equal(b.fresh, false); // a stick is not a button press
});

test("menu direction: one move per press, then repeats while held", () => {
  const n = new NavRepeat();
  const down = 1 << PB.DOWN;
  assert.equal(n.next(down, 0.016), "down");
  assert.equal(n.next(down, 0.1), null);
  let moves = 0;
  for (let t = 0; t < 1; t += 0.01) if (n.next(down, 0.01)) moves++;
  assert.ok(moves >= 4 && moves <= 7, `repeats in 1 s: ${moves}`);
  assert.equal(n.next(0, 0.01), null);
  assert.equal(n.next(1 << PB.LEFT, 0.01), "left");
});

test("spatial menu navigation picks the nearest control that way, rows and columns first", () => {
  // a row of three cards, PLAY under the middle one, a small mute button top right
  const cards: Rect[] = [{ x: 100, y: 100, w: 100, h: 120 }, { x: 220, y: 100, w: 100, h: 120 }, { x: 340, y: 100, w: 100, h: 120 }];
  const play: Rect = { x: 200, y: 260, w: 140, h: 44 };
  const mute: Rect = { x: 900, y: 10, w: 40, h: 40 };
  const all = [...cards, play, mute];
  assert.equal(pickNext(cards[0], all, "right"), 1);
  assert.equal(pickNext(cards[1], all, "left"), 0);
  assert.equal(pickNext(cards[1], all, "down"), 3);
  assert.equal(pickNext(play, all, "up"), 1);
  assert.equal(pickNext(cards[2], all, "right"), 4); // the only thing that way
  assert.equal(pickNext(cards[0], all, "left"), -1);
  assert.equal(pickNext(play, all, "down"), -1);
});

test("prompts: every token has a name for both pads, the layout drives the lists, the portal guide has no commas", () => {
  for (const kind of ["ps", "xbox"] as const) for (const [k, v] of Object.entries(PAD_NAMES[kind])) assert.ok(v.length > 0, `${kind} ${k}`);
  assert.equal(PAD_NAMES.ps.SOUTH, "Cross");
  assert.equal(PAD_NAMES.xbox.R2, "RT");
  assert.equal(keysOf("zip"), LAYOUT.zip.map(b => `{${b}}`).join(" / "));
  assert.equal(padPlain("{R2} swing", "ps"), "R2 swing");
  assert.equal(padPlain("{SOUTH} jump"), "Cross / A jump");
  assert.equal(plainKeys("zip"), "R1 or L2 / RB or LT");
  const tokens = (t: string) => [...t.matchAll(TOKEN_RE)].length;
  const list = radrunPadControls();
  assert.ok(list.length >= 10 && list.every(([k]) => tokens(k) > 0));
  assert.ok(tokens(radrunPadHud(false, false)) >= 5 && tokens(radrunPadHud(true, false)) >= 5);
  for (const id of ["swing", "fling", "yoink", "djump", "zip", "charge", "wallrun", "slide"] as const) {
    const t = hintText(id, false, false, true);
    assert.ok(tokens(t) > 0 && !/LMB|Space|click|\bE\b|\bC\b/.test(t), `${id}: ${t}`);
  }
  assert.ok(RADRUN_PAD_GUIDE.every(c => !c.includes(",")));
  assert.ok(RADRUN.controls.some(c => c.startsWith("Controller")) && RADRUN.controls.every(c => !c.includes(",")));
});
