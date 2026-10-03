// The vyvanse.beer menu hook (src/ui/vyvanse.ts): framed-by-vyvanse detection (ancestorOrigins or the referrer,
// dev parents only in dev builds, kept across in-frame reloads), and the one message it sends, to that origin only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VYVANSE_ORIGIN, createVyvanseHook, vyvanseParent, type VyvanseWindow } from "../src/ui/vyvanse.ts";

const GAME = "https://radrun.vyvanse.beer";

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m };
}

/** A fake window: `framed` false = top-level; `anc` undefined = a browser without location.ancestorOrigins. */
function fakeWindow(o: { framed?: boolean; anc?: string[]; referrer?: string; origin?: string; store?: ReturnType<typeof memStore> }) {
  const sent: Array<{ m: unknown; origin: string }> = [];
  const parent = { postMessage: (m: unknown, origin: string) => sent.push({ m, origin }) };
  const w: VyvanseWindow = {
    top: null,
    parent,
    location: { origin: o.origin ?? GAME, ...(o.anc ? { ancestorOrigins: o.anc } : {}) },
    document: { referrer: o.referrer ?? "" },
    sessionStorage: o.store ?? memStore(),
  };
  if (o.framed === false) { w.top = w; w.parent = w; } else w.top = { other: true };
  return { w, sent };
}

test("vyvanse: opened on its own = no entry, back() sends nothing", () => {
  const f = fakeWindow({ framed: false, anc: [], referrer: "https://vyvanse.beer/" });
  assert.equal(vyvanseParent(f.w, true), null);
  const h = createVyvanseHook(f.w, true);
  assert.equal(h.origin, null);
  h.back();
  assert.equal(f.sent.length, 0);
});

test("vyvanse: framed by vyvanse.beer (ancestorOrigins) posts exactly { type: 'vyvanse:menu' } to its origin", () => {
  const f = fakeWindow({ anc: [VYVANSE_ORIGIN] });
  const h = createVyvanseHook(f.w, false);
  assert.equal(h.origin, "https://vyvanse.beer");
  h.back();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], { m: { type: "vyvanse:menu" }, origin: "https://vyvanse.beer" });
  assert.notEqual(f.sent[0].origin, "*");
});

test("vyvanse: the referrer alone works (no ancestorOrigins), only for the real origin", () => {
  assert.equal(vyvanseParent(fakeWindow({ referrer: "https://vyvanse.beer/" }).w, false), VYVANSE_ORIGIN);
  assert.equal(vyvanseParent(fakeWindow({ referrer: "https://vyvanse.beer/#play/radrun" }).w, false), VYVANSE_ORIGIN);
  for (const referrer of ["https://vyvanse.beer.evil.example/", "https://evil.example/?https://vyvanse.beer/", "http://vyvanse.beer/", "https://www.vyvanse.beer/", "", "not a url"]) {
    assert.equal(vyvanseParent(fakeWindow({ referrer }).w, false), null, referrer);
  }
});

test("vyvanse: framed by radbro.fun (or anything else) = no entry, nothing sent", () => {
  for (const f of [fakeWindow({ anc: ["https://radbro.fun"], referrer: "https://radbro.fun/" }), fakeWindow({ referrer: "https://radbro.fun/play/radrun" })]) {
    const h = createVyvanseHook(f.w, true);
    assert.equal(h.origin, null);
    h.back();
    assert.equal(f.sent.length, 0);
  }
});

test("vyvanse: localhost / 127.0.0.1 parents only in dev and test builds", () => {
  for (const p of ["http://localhost:4871", "http://127.0.0.1:9000", "http://localhost"]) {
    assert.equal(vyvanseParent(fakeWindow({ anc: [p] }).w, true), p);
    assert.equal(vyvanseParent(fakeWindow({ referrer: `${p}/harness.html` }).w, true), p);
    assert.equal(vyvanseParent(fakeWindow({ anc: [p] }).w, false), null, `${p} in production`);
  }
  for (const p of ["https://localhost:4871", "http://localhost.evil.example", "http://192.168.1.5:4870"]) {
    assert.equal(vyvanseParent(fakeWindow({ anc: [p] }).w, true), null, p);
  }
  const f = fakeWindow({ anc: ["http://localhost:4871"] });
  createVyvanseHook(f.w, true).back();
  assert.deepEqual(f.sent, [{ m: { type: "vyvanse:menu" }, origin: "http://localhost:4871" }]);
});

test("vyvanse: an in-frame reload (district switch) keeps the first page's answer without ancestorOrigins", () => {
  const store = memStore();
  assert.equal(vyvanseParent(fakeWindow({ referrer: "https://vyvanse.beer/", store }).w, false), VYVANSE_ORIGIN);
  // the frame went to ?map=docks: the referrer is now the game itself
  assert.equal(vyvanseParent(fakeWindow({ referrer: `${GAME}/`, store }).w, false), VYVANSE_ORIGIN);
  // a fresh frame on radbro.fun in the same tab forgets it, and its own reloads stay inert
  assert.equal(vyvanseParent(fakeWindow({ referrer: "https://radbro.fun/", store }).w, false), null);
  assert.equal(vyvanseParent(fakeWindow({ referrer: `${GAME}/?tag=1`, store }).w, false), null);
  // with ancestorOrigins the memo is never needed: the parent is read directly
  store.setItem("rugrun.vyvanseParent", VYVANSE_ORIGIN);
  assert.equal(vyvanseParent(fakeWindow({ anc: ["https://radbro.fun"], referrer: `${GAME}/`, store }).w, false), null);
  // opened on its own, the memo means nothing
  assert.equal(vyvanseParent(fakeWindow({ framed: false, referrer: `${GAME}/`, store }).w, false), null);
});

test("vyvanse: a broken or missing session storage never throws", () => {
  const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  const f = fakeWindow({ referrer: "https://vyvanse.beer/" });
  f.w.sessionStorage = bad;
  assert.equal(vyvanseParent(f.w, false), VYVANSE_ORIGIN);
  const g = fakeWindow({ referrer: `${GAME}/` });
  g.w.sessionStorage = bad;
  assert.equal(vyvanseParent(g.w, false), null);
  const h = fakeWindow({ referrer: "https://vyvanse.beer/" });
  delete h.w.sessionStorage;
  assert.equal(vyvanseParent(h.w, false), VYVANSE_ORIGIN);
});
