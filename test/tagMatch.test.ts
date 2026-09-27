// Spider-tag match sim (src/game/tagMatch.ts; DESIGN §2.1, §3.3) on the committed Downtown city: spawns, roles and
// the holder, touch / Yoink passes, the 1.5 s web tangle, no tag-back for 3 s, bag clocks and the horn, falls, the
// state hash and snapshots.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { respawnNear } from "../src/game/round.ts";
import {
  PH_OVER, PH_PLAY, TAG, TAG_KIND_TOUCH, TAG_KIND_YOINK, TV_END, TV_FALL, TV_TAG, TagMatch, type TagSlot,
} from "../src/game/tagMatch.ts";
import { MOVE_RES, emptyRec, recFromInput } from "../src/game/ghost.ts";
import { packWord } from "../src/net/wire.ts";
import { chaseDist, type Body } from "../src/sim/player.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8"))).player;
const index = new CityIndex(model);

const SLOTS: TagSlot[] = [{ radbro: "652" }, { radbro: "4764" }, { radbro: "2564" }, { radbro: "723" }];
const mk = (n = 2, seed = 1, seconds?: number) => new TagMatch({ model, index, tuning, slots: SLOTS.slice(0, n), seed, seconds, countdown: false });

/** A word: facing yaw (camera convention: forward = (-sin, -cos)), move forward `fwd` (0..1), buttons. */
function word(yaw = 0, fwd = 0, o: { jump?: boolean; webPressed?: boolean; webHeld?: boolean; zip?: boolean } = {}): number {
  return packWord(recFromInput(emptyRec(), yaw, fwd, 0, !!o.jump, !!o.webPressed, !!o.webHeld, !!o.zip));
}
const idle = (n: number) => new Array(n).fill(word());
const yawTo = (a: Body, b: Body) => Math.atan2(-(b.p.x - a.p.x), -(b.p.z - a.p.z));

/** The biggest roof (room for two bodies side by side). */
const bigRoof = model.solids.filter(s => s.kind === "roof" && s.landable).sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0))[0];
function place(m: TagMatch, slot: number, dx: number, dz = 0): void {
  const cx = (bigRoof.x0 + bigRoof.x1) / 2, cz = (bigRoof.z0 + bigRoof.z1) / 2;
  const b = m.bodies[slot];
  respawnNear(b, model, bigRoof.id, { x: cx + dx, y: 0, z: cz + dz }, 1, m.tunings[slot].halfHeight);
}

test("spawns: distinct roofs, the holder at least itSpawnDist from everyone, seeded", () => {
  for (const n of [2, 4]) for (const seed of [1, 2, 3, 99]) {
    const m = mk(n, seed);
    const roofs = new Set(m.spawns.map(s => s.roofId));
    assert.equal(roofs.size, n, `distinct roofs n=${n} seed=${seed}`);
    const h = m.spawns[m.holder];
    for (let i = 0; i < n; i++) {
      if (i === m.holder) continue;
      const s = m.spawns[i];
      assert.ok(Math.hypot(s.x - h.x, s.z - h.z) >= TAG.itSpawnDist - 1e-9, `holder distance n=${n} seed=${seed} slot ${i}`);
      assert.ok(model.solids[s.roofId].landable);
    }
    const again = mk(n, seed);
    assert.deepEqual(again.spawns, m.spawns);
    assert.equal(again.holder, m.holder);
  }
  // Different seeds pick different holders / roofs at least sometimes.
  const set = new Set([1, 2, 3, 4, 5, 6].map(s => `${mk(2, s).holder}:${mk(2, s).spawns[0].roofId}`));
  assert.ok(set.size > 1);
});

test("countdown: 3 s of no movement, then play", () => {
  const m = new TagMatch({ model, index, tuning, slots: SLOTS.slice(0, 2), seed: 4 });
  const p0 = { ...m.bodies[0].p };
  for (let i = 0; i < 360; i++) m.stepWords([word(0, 1), word(0, 1)]);
  assert.equal(m.phase, PH_PLAY);
  assert.deepEqual(m.bodies[0].p, p0);
  assert.equal(m.bag[m.holder], 0);
  m.stepWords(idle(2));
  assert.equal(m.bag[m.holder], 1);
});

test("touch tag passes the bag; the new holder is tangled 1.5 s; no tag back for 3 s", () => {
  const m = mk(2, 7);
  const h = m.holder, r = 1 - h;
  place(m, h, 0);
  place(m, r, 1.2);
  m.updateTargets();
  assert.equal(m.target[h], r);
  assert.equal(m.target[r], -1);
  m.stepWords(idle(2));
  assert.ok(m.events & TV_TAG);
  assert.equal(m.holder, r);
  assert.equal(m.lastTagKind, TAG_KIND_TOUCH);
  assert.equal(m.tags[h], 1);
  assert.equal(m.freeze[r], Math.round(TAG.tagFreeze * 120));
  assert.equal(m.tagBackSlot, h);
  // Tangled: full forward input for 1.5 s moves nothing (the old holder runs away along +x meanwhile).
  const p0 = { ...m.bodies[r].p };
  const away = word(-Math.PI / 2, 1); // +x
  for (let i = 0; i < 179; i++) {
    const w = [0, 0];
    w[r] = word(0, 1); w[h] = away;
    m.stepWords(w);
  }
  assert.ok(Math.hypot(m.bodies[r].p.x - p0.x, m.bodies[r].p.z - p0.z) < 1e-9, "frozen body moved");
  assert.ok(m.freeze[r] > 0);
  // Put them together again: no tag back while tagBack runs; it passes back the step it runs out.
  place(m, h, 0); place(m, r, 0.8);
  const tagStep = m.lastTagStep;
  while (m.holder === r && m.step < tagStep + 1000) m.stepWords(idle(2));
  assert.equal(m.holder, h);
  assert.equal(m.step - tagStep, Math.round(TAG.tagBack * 120));
});

test("Yoink: the red ring on the target + a web press passes the bag inside yoinkRange, not outside", () => {
  for (const [dist, want] of [[TAG.yoinkRange - 0.3, true], [TAG.yoinkRange + 0.5, false]] as const) {
    const m = mk(2, 11);
    const h = m.holder, r = 1 - h;
    place(m, h, 0); place(m, r, dist);
    m.updateTargets();
    const w = [0, 0];
    w[h] = word(yawTo(m.bodies[h], m.bodies[r]), 0, { webPressed: true, webHeld: true });
    w[r] = word();
    m.stepWords(w);
    assert.equal(m.holder === r, want, `dist ${dist}`);
    if (want) assert.equal(m.lastTagKind, TAG_KIND_YOINK);
  }
});

test("targets: nearest runner on pre-step positions, the tag-back player skipped; runners have none", () => {
  const m = mk(4, 3);
  const h = m.holder;
  const others = [0, 1, 2, 3].filter(i => i !== h);
  place(m, h, 0); place(m, others[0], 12); place(m, others[1], -8); place(m, others[2], 0, 20);
  m.updateTargets();
  assert.equal(m.target[h], others[1]);
  for (const o of others) { assert.equal(m.target[o], -1); assert.equal(m.worlds[o].runner, null); }
  m.tagBackSlot = others[1]; m.tagBackSteps = 10;
  m.updateTargets();
  assert.equal(m.target[h], others[2]);
  assert.ok(chaseDist(m.worlds[h].runner!.p, m.bodies[others[2]].p) < 1e-12);
});

test("bag clocks, the horn and the standings", () => {
  const m = mk(3, 5, 2);
  const h = m.holder;
  let steps = 0;
  while (!m.over && steps < 1000) { m.stepWords(idle(3)); steps++; }
  assert.equal(steps, 240);
  assert.equal(m.phase, PH_OVER);
  assert.ok(m.events & TV_END);
  assert.equal(m.bag[h], 240);
  assert.equal(m.bagSeconds(h), 2);
  assert.equal(m.clock, 0);
  const st = m.standings();
  assert.equal(st[st.length - 1], h, "the one who held it all match is last");
  const h0 = m.hash();
  m.stepWords(idle(3));
  assert.equal(m.hash(), h0, "nothing steps after the horn");
});

test("falls: a runner below the fail floor respawns on his last safe roof and is locked for fallLock", () => {
  const m = mk(2, 8);
  const r = 1 - m.holder;
  const b = m.bodies[r];
  const safe = b.lastSafeRoof;
  b.grounded = false; b.roofId = -1; b.p.y = 1.5; b.v.y = -20;
  m.stepWords(idle(2));
  assert.ok(m.events & TV_FALL);
  assert.equal(m.falls[r], 1);
  assert.equal(b.roofId, safe);
  assert.ok(b.grounded);
  assert.equal(m.lock[r], Math.round(TAG.fallLock * 120));
  const p0 = { ...b.p };
  for (let i = 0; i < 60; i++) { const w = [0, 0]; w[r] = word(0, 1); m.stepWords(w); }
  assert.ok(Math.hypot(b.p.x - p0.x, b.p.z - p0.z) < 1e-9, "locked body moved");
});

test("hash and snapshots: equal inputs -> equal hashes; save / load replays the same future", () => {
  const rnd = (i: number, s: number) => word(((i * 37 + s * 11) % 64) / 10, ((i + s) % 7) / 6, { jump: (i + s) % 97 === 0, webHeld: (i + s) % 150 < 60, webPressed: (i + s) % 150 === 0 });
  const a = mk(3, 21), b = mk(3, 21);
  for (let i = 0; i < 400; i++) { const w = [rnd(i, 0), rnd(i, 1), rnd(i, 2)]; a.stepWords(w); b.stepWords(w); }
  assert.equal(a.hash(), b.hash());
  const snap = a.newSnap();
  a.save(snap);
  const h400 = a.hash();
  for (let i = 400; i < 700; i++) a.stepWords([rnd(i, 0), rnd(i, 1), rnd(i, 2)]);
  const h700 = a.hash();
  a.load(snap);
  assert.equal(a.hash(), h400);
  for (let i = 400; i < 700; i++) a.stepWords([rnd(i, 0), rnd(i, 1), rnd(i, 2)]);
  assert.equal(a.hash(), h700);
  // The match fields are in the hash.
  a.bag[0]++;
  assert.notEqual(a.hash(), h700);
});

test("tuning per slot: touch widens the Yoink by 1 m; the holder's tuning carries the tag table", () => {
  const m = new TagMatch({ model, index, tuning, slots: [{ radbro: "652", touch: true }, { radbro: "4764" }], seed: 1, countdown: false });
  assert.equal(m.tunings[0].yoinkRange, TAG.yoinkRange + 1);
  assert.equal(m.tunings[1].yoinkRange, TAG.yoinkRange);
  assert.equal(m.tunings[1].yankRange, TAG.yankRange);
  assert.ok(MOVE_RES > 0);
});
