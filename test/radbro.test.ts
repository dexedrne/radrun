// The radbro.fun bridge (src/radbro/bridge.ts): message shapes, framed-only, the ready-request answer,
// the first-click focus + audio unlock, and the chase -> portal result mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RADRUN, chaseResult, createBridge, isFramed, readyMessage, requestLock, resultMessage, type BridgeWindow } from "../src/radbro/bridge.ts";

type Listener = { type: string; fn: (e: unknown) => void; once: boolean };

function fakeWindow(framed: boolean) {
  const sent: Array<{ m: unknown; origin: string }> = [];
  const parent = { postMessage: (m: unknown, origin: string) => sent.push({ m, origin }) };
  const ls: Listener[] = [];
  let focused = 0;
  const w: BridgeWindow & { parent: unknown } = {
    parent,
    addEventListener: (type, fn, opts) => ls.push({ type, fn: fn as (e: unknown) => void, once: typeof opts === "object" && !!opts.once }),
    removeEventListener: (type, fn) => { const i = ls.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) ls.splice(i, 1); },
    focus: () => { focused++; },
  };
  if (!framed) w.parent = w;
  const fire = (type: string, e: unknown) => {
    for (const l of [...ls]) if (l.type === type) { l.fn(e); if (l.once) ls.splice(ls.indexOf(l), 1); }
  };
  return { w, sent, parent, fire, listeners: ls, focused: () => focused };
}

test("radbro: not framed = inert (no messages, no listeners)", () => {
  const f = fakeWindow(false);
  assert.equal(isFramed(f.w), false);
  const b = createBridge(RADRUN, f.w, { onFirstGesture: () => assert.fail("no gesture hook unframed") });
  assert.equal(b.active, false);
  b.ready();
  b.result("clear", 12);
  assert.equal(f.sent.length, 0);
  assert.equal(f.listeners.length, 0);
});

test("radbro: framed posts game-ready on start, with the full payload", () => {
  const f = fakeWindow(true);
  assert.equal(isFramed(f.w), true);
  const b = createBridge(RADRUN, f.w);
  assert.equal(b.active, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].origin, "*");
  const m = f.sent[0].m as Record<string, unknown>;
  assert.deepEqual(Object.keys(m).sort(), ["controls", "game", "hint", "objective", "title", "type", "viewport"]);
  assert.equal(m.type, "radbro:game-ready");
  assert.equal(m.game, "radrun");
  assert.equal(m.title, "RadRun");
  assert.ok(typeof m.objective === "string" && m.objective.length > 10);
  assert.ok(typeof m.hint === "string" && m.hint.length > 10);
  assert.ok(Array.isArray(m.controls) && m.controls.length >= 4 && m.controls.every(c => typeof c === "string"));
  // the portal's play guide takes the controls as one comma-separated string: no commas inside an entry
  assert.ok((m.controls as string[]).every(c => !c.includes(",")));
  assert.deepEqual(m.viewport, { width: 1280, height: 720 });
  b.dispose();
});

test("radbro: answers game-ready-request from the parent only", () => {
  const f = fakeWindow(true);
  createBridge(RADRUN, f.w);
  f.fire("message", { source: f.parent, data: { type: "radbro:game-ready-request" } });
  assert.equal(f.sent.length, 2);
  assert.equal((f.sent[1].m as { type: string }).type, "radbro:game-ready");
  f.fire("message", { source: {}, data: { type: "radbro:game-ready-request" } }); // someone else
  f.fire("message", { source: f.parent, data: { type: "something-else" } });
  f.fire("message", { source: f.parent, data: null });
  f.fire("message", { source: f.parent, data: "radbro:game-ready-request" });
  assert.equal(f.sent.length, 2);
});

test("radbro: game-result shapes (run / clear / gameover; score rounded, bad scores left out)", () => {
  const f = fakeWindow(true);
  const b = createBridge(RADRUN, f.w);
  b.result("run");
  b.result("clear", 23.456);
  b.result("gameover");
  b.result("clear", Number.NaN);
  assert.deepEqual(f.sent.slice(1).map(s => s.m), [
    { type: "radbro:game-result", game: "radrun", status: "run" },
    { type: "radbro:game-result", game: "radrun", status: "clear", score: 23.46 },
    { type: "radbro:game-result", game: "radrun", status: "gameover" },
    { type: "radbro:game-result", game: "radrun", status: "clear" },
  ]);
  assert.deepEqual(resultMessage("radrun", "clear", null), { type: "radbro:game-result", game: "radrun", status: "clear" });
  assert.deepEqual(resultMessage("radrun", "clear", 0), { type: "radbro:game-result", game: "radrun", status: "clear", score: 0 });
});

test("radbro: the first pointer press focuses the frame and unlocks the audio, once", () => {
  const f = fakeWindow(true);
  let unlocks = 0;
  createBridge(RADRUN, f.w, { onFirstGesture: () => { unlocks++; } });
  f.fire("pointerdown", {});
  f.fire("pointerdown", {});
  assert.equal(unlocks, 1);
  assert.equal(f.focused(), 1);
});

test("radbro: dispose removes the listeners", () => {
  const f = fakeWindow(true);
  const b = createBridge(RADRUN, f.w);
  b.dispose();
  assert.equal(f.listeners.length, 0);
  f.fire("message", { source: f.parent, data: { type: "radbro:game-ready-request" } });
  assert.equal(f.sent.length, 1);
});

test("radbro: a catch is a clear (catch time, or a campaign run's stars); an escape is a gameover", () => {
  assert.deepEqual(chaseResult({ caught: true, time: 41.2, campaign: null }), { status: "clear", score: 41.2 });
  assert.deepEqual(chaseResult({ caught: true, time: 41.2, campaign: { got: [true, false, true] } }), { status: "clear", score: 2 });
  assert.deepEqual(chaseResult({ caught: false, time: 0, campaign: null }), { status: "gameover" });
});

test("radbro: readyMessage copies (the payload can't be mutated through a sent message)", () => {
  const m = readyMessage(RADRUN);
  m.controls.push("x");
  m.viewport.width = 1;
  assert.notEqual(RADRUN.controls.at(-1), "x");
  assert.equal(RADRUN.viewport.width, 1280);
});

test("radbro: requestLock swallows a refused pointer lock (thrown or rejected)", async () => {
  const unhandled: unknown[] = [];
  const on = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", on);
  try {
    requestLock(null);
    requestLock({ requestPointerLock: () => { throw new Error("no permission"); } } as unknown as Element);
    requestLock({ requestPointerLock: () => Promise.reject(new Error("WrongDocumentError")) } as unknown as Element);
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", on);
  }
});

test("radbro: framed on an iPhone = no swipe-up overlay / home-screen tip (iphoneTab false)", async () => {
  const { iphoneTab } = await import("../src/input/touch.ts");
  const g = globalThis as Record<string, unknown>;
  const had = { window: g.window, matchMedia: g.matchMedia, nav: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }, configurable: true });
  g.matchMedia = () => ({ matches: false });
  try {
    const self: Record<string, unknown> = {};
    self.parent = self;
    g.window = self;
    assert.equal(iphoneTab(), true);
    g.window = { parent: {} };
    assert.equal(iphoneTab(), false);
  } finally {
    g.window = had.window;
    g.matchMedia = had.matchMedia;
    if (had.nav) Object.defineProperty(globalThis, "navigator", had.nav);
  }
});
