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
function fakeWindow(origin: string, init: Record<string, string> = {}) {
  const ls = store(init);
  const frames: { src: string; contentWindow: object; removed: boolean }[] = [];
  let listener: Listener | null = null;
  let reloads = 0;
  const w = {
    location: { origin, reload: () => { reloads++; } },
    localStorage: ls,
    document: {
      createElement: () => {
        const f = { src: "", title: "", tabIndex: 0, style: { cssText: "" }, contentWindow: {}, removed: false, setAttribute() {}, remove() { f.removed = true; } };
        frames.push(f);
        return f;
      },
      body: { appendChild() {} },
    },
    addEventListener: (_t: string, fn: Listener) => { listener = fn; },
    removeEventListener: () => { listener = null; },
  };
  return { w: w as unknown as Window, ls, frames, send: (e: Parameters<Listener>[0]) => listener?.(e), reloads: () => reloads };
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
  assert.equal(f.reloads(), 1);

  const empty = fakeWindow(NEW_ORIGIN);
  carryOldSaves(empty.w);
  empty.send({ origin: OLD_ORIGIN, source: empty.frames[0].contentWindow, data: { type: CARRY_MSG, items: {} } });
  assert.equal(empty.ls.getItem(CARRIED), "1");
  assert.equal(empty.reloads(), 0, "a new player: no reload");
});
