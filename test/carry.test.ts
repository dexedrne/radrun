// ui/carry.ts: the saves come over from radrun.vyvanse.beer once, at spidertag.vyvanse.beer only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CARRIED, CARRY_MSG, NEW_ORIGIN, OLD_ORIGIN, applyCarry, carryOldSaves } from "../src/ui/carry.ts";

const store = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test("applyCarry: the old values of rugrun.* / radrun.* keys win; nothing else is written", () => {
  const s = store({ "rugrun.tag": '{"radbro":"652"}', "rugrun.v1": "same" });
  const n = applyCarry(s, {
    "rugrun.tag": '{"radbro":"723"}', "rugrun.v1": "same", "rugrun.campaign.v1": '{"stars":{}}', "radrun.wager.wallet": "io.rabby",
    "other.key": "x", "rugrun.bad": 5,
  });
  assert.equal(n, 3);
  assert.equal(s.getItem("rugrun.tag"), '{"radbro":"723"}');
  assert.equal(s.getItem("radrun.wager.wallet"), "io.rabby");
  assert.equal(s.getItem("other.key"), null);
  assert.equal(s.getItem("rugrun.bad"), null);
  assert.equal(applyCarry(s, null), 0);
});

type Listener = (e: { origin: string; source: unknown; data: unknown }) => void;
function fakeWindow(origin: string, init: Record<string, string> = {}, search = "") {
  const ls = store(init);
  const frames: { src: string; contentWindow: object; removed: boolean }[] = [];
  const listeners = new Map<string, Listener>();
  let reloads = 0;
  const w = {
    location: { origin, search, reload: () => { reloads++; } },
    localStorage: ls,
    document: {
      createElement: () => {
        const f = { src: "", title: "", tabIndex: 0, style: { cssText: "" }, contentWindow: {}, removed: false, setAttribute() {}, remove() { f.removed = true; } };
        frames.push(f);
        return f;
      },
      body: { appendChild() {} },
    },
    addEventListener: (t: string, fn: Listener) => { listeners.set(t, fn); },
    removeEventListener: (t: string) => { listeners.delete(t); },
  };
  return {
    w: w as unknown as Window, ls, frames, reloads: () => reloads, listening: () => listeners.size,
    send: (e: Parameters<Listener>[0]) => listeners.get("message")?.(e),
    input: (t: string) => listeners.get(t)?.({ origin: "", source: null, data: null }),
  };
}

test("carryOldSaves: only at the new address, once; writes, marks and reloads when something came over", () => {
  const dev = fakeWindow("http://localhost:4870");
  carryOldSaves(dev.w);
  assert.equal(dev.frames.length, 0, "not in dev / previews / the old address");
  const done = fakeWindow(NEW_ORIGIN, { [CARRIED]: "1" });
  carryOldSaves(done.w);
  assert.equal(done.frames.length, 0, "already carried");

  const f = fakeWindow(NEW_ORIGIN, { "rugrun.tag": "fresh defaults" });
  carryOldSaves(f.w);
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].src, `${OLD_ORIGIN}/carry.html`);
  const items = { "rugrun.tag": "old picks", "rugrun.campaign.v1": "old stars" };
  f.send({ origin: "https://evil.example", source: f.frames[0].contentWindow, data: { type: CARRY_MSG, items } });
  f.send({ origin: OLD_ORIGIN, source: {}, data: { type: CARRY_MSG, items } });
  assert.equal(f.ls.getItem(CARRIED), null, "only the frame it opened, from the old address");
  f.send({ origin: OLD_ORIGIN, source: f.frames[0].contentWindow, data: { type: CARRY_MSG, items } });
  assert.equal(f.ls.getItem("rugrun.tag"), "old picks");
  assert.equal(f.ls.getItem("rugrun.campaign.v1"), "old stars");
  assert.equal(f.ls.getItem(CARRIED), "1");
  assert.ok(f.frames[0].removed);
  assert.equal(f.listening(), 0, "every listener removed");
  assert.equal(f.reloads(), 1);

  const empty = fakeWindow(NEW_ORIGIN);
  carryOldSaves(empty.w);
  empty.send({ origin: OLD_ORIGIN, source: empty.frames[0].contentWindow, data: { type: CARRY_MSG, items: {} } });
  assert.equal(empty.ls.getItem(CARRIED), "1");
  assert.equal(empty.reloads(), 0, "a new player: no reload");
});

test("carryOldSaves: no reload under a page already in use; the saves still come over and count from the next load", () => {
  const items = { "rugrun.tag": "old picks", "radrun.wager.wallet": "io.rabby" };
  for (const search of ["?tag&room=ABCD", "?wager&join=0xab", "?wager&match=0xab"]) {
    const f = fakeWindow(NEW_ORIGIN, {}, search);
    carryOldSaves(f.w);
    f.send({ origin: OLD_ORIGIN, source: f.frames[0].contentWindow, data: { type: CARRY_MSG, items } });
    assert.equal(f.ls.getItem("rugrun.tag"), "old picks", search);
    assert.equal(f.ls.getItem(CARRIED), "1", search);
    assert.equal(f.reloads(), 0, `${search}: a room, an invite or a series is never reloaded under`);
  }
  for (const t of ["keydown", "pointerdown", "touchstart"]) {
    const f = fakeWindow(NEW_ORIGIN, {}, "?tag");
    carryOldSaves(f.w);
    f.input(t);
    f.send({ origin: OLD_ORIGIN, source: f.frames[0].contentWindow, data: { type: CARRY_MSG, items } });
    assert.equal(f.ls.getItem("radrun.wager.wallet"), "io.rabby", t);
    assert.equal(f.reloads(), 0, `${t} before the saves arrived: no reload`);
    assert.equal(f.listening(), 0, t);
  }
  const menu = fakeWindow(NEW_ORIGIN, {}, "?tag");
  carryOldSaves(menu.w);
  menu.send({ origin: OLD_ORIGIN, source: menu.frames[0].contentWindow, data: { type: CARRY_MSG, items } });
  assert.equal(menu.reloads(), 1, "the TAG menu, untouched: reloaded once");
});
