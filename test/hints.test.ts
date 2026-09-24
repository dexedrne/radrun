// First-run tips (ui/hints.ts, round 3): each tip shows at the moment it matters and goes once done;
// swing -> fling -> chain chain on; the red ring on him preempts; seen tips never come back until
// "show tips again". Runs the engine headless (no localStorage in Node: prefs fall back silently).
import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { location?: unknown }).location ??= { search: "" };
const { Hints, hintText } = await import("../src/ui/hints.ts");
const { useUi } = await import("../src/ui/store.ts");

type S = Parameters<InstanceType<typeof Hints>["tick"]>[1];
const base: S = { active: true, grounded: true, rope: false, ring: "none", chain: 0, touch: false, easyGrab: false };
const shown = () => useUi.getState().hint?.id ?? null;

test("tips: swing -> fling -> chain, then nothing; the red ring preempts; reset shows them again", () => {
  const h = new Hints();
  h.reset();
  const tick = (s: Partial<S>, n = 1) => { for (let i = 0; i < n; i++) h.tick(0.1, { ...base, ...s }); };
  tick({}, 12); // > 1 s active, nothing ringed
  assert.equal(shown(), null);
  tick({ ring: "hook" });
  assert.equal(shown(), "swing");
  assert.match(useUi.getState().hint!.text, /hold LMB/);
  tick({ grounded: false, rope: true, ring: "attached", chain: 1 });
  assert.equal(shown(), "fling");
  tick({ grounded: false, rope: false, ring: "none", chain: 1 });
  assert.equal(shown(), "chain");
  tick({ grounded: false, rope: true, ring: "attached", chain: 2 });
  tick({ grounded: false, rope: false, ring: "hook", chain: 3 });
  assert.equal(shown(), null);
  tick({ grounded: false, rope: false, ring: "hook", chain: 0 }, 5);
  assert.equal(shown(), null, "seen tips stay gone");
  tick({ ring: "runner" });
  assert.equal(shown(), "yoink");
  tick({ ring: "runner" }, 16);
  assert.equal(shown(), null);
  h.reset();
  tick({}, 12);
  tick({ ring: "hook" });
  assert.equal(shown(), "swing");
  h.tick(0.1, { ...base, active: false });
  assert.equal(shown(), null, "hidden while paused / off-round");
});

test("tip wording follows the scheme: touch WEB, easy grab Space, mouse LMB", () => {
  assert.match(hintText("swing", true, false), /WEB/);
  assert.match(hintText("fling", false, true), /Space/);
  assert.match(hintText("yoink", false, false), /click/);
  assert.match(hintText("yoink", true, false), /tap WEB/);
});
