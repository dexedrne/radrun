// Test 5 (bake + graph checks on the committed pack) and a slice of test 7 (runner dwell rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodePack } from "../src/route/trackPack.ts";
import { bake, BAKE, type BakeReport } from "../src/route/bake.ts";
import { forcedUTurns, stronglyConnected } from "../src/route/graph.ts";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { Runner, RE_DEPART, RE_TAUNT, RM_TURN, RM_EDGE } from "../src/runner/runner.ts";
import { Rand } from "../src/sim/math.ts";
import type { CityModel } from "../src/world/cityModel.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8")));
const packBytes = fs.readFileSync(lv("runner.pack.bin"));
const pack = decodePack(packBytes);
const report: BakeReport = JSON.parse(fs.readFileSync(lv("bake.report.json"), "utf8"));

test("committed pack matches the city and passes the bake checks", () => {
  assert.equal(pack.header.city, model.hash, "runner.pack.bin is stale: run npm run level");
  assert.equal(report.pack, pack.hash);
  const refs = pack.edges.map(e => ({ from: e.from, to: e.to }));
  assert.ok(pack.junctions.length >= 8, `${pack.junctions.length} junctions`);
  assert.ok(stronglyConnected(pack.junctions.length, refs), "graph not strongly connected");
  assert.deepEqual(forcedUTurns(refs), []);
  assert.equal(report.checks.walkStalls, 0);
  const kept = report.edges.filter(e => e.kept);
  assert.equal(kept.length, pack.edges.length);
  for (const e of kept) {
    for (const h of e.hops) {
      assert.ok(h.window >= (h.kind === "alley" ? BAKE.alleyWindow : BAKE.swingWindow), `${h.kind} window ${h.window}`);
      assert.ok(h.margin >= 1.5, `landing margin ${h.margin}`);
    }
    assert.ok(e.residual < 0.05, `snap ${e.residual}`);
  }
  // Every edge starts and ends exactly on its junctions (canonical rest state).
  for (const e of pack.edges) {
    const s = e.samples, last = (e.count - 1) * 5;
    assert.deepEqual([s[0], s[1], s[2]], [0, 0, 0]);
    const a = pack.junctions[e.from], b = pack.junctions[e.to];
    assert.deepEqual([s[last], s[last + 1], s[last + 2]], [Math.round((b.x - a.x) * 100), Math.round((b.y - a.y) * 100), Math.round((b.z - a.z) * 100)]);
  }
});

test("a fresh bake reproduces the committed pack byte for byte, in < 60 s", () => {
  const t0 = Date.now();
  const r = bake(model, tuning.player);
  assert.ok(Date.now() - t0 < 60000);
  assert.equal(r.report.pack, pack.hash, "fresh bake differs: run npm run level and commit");
});

test("runner dwell: taunt only when d > 35; head turn starts exactly 36 steps before the edge", () => {
  const params = { ...tuning.difficulty.normal };
  for (const far of [true, false]) {
    const r = new Runner(pack, params, new Rand(1), 0, pack.out[0][0]);
    const player = { x: 0, y: 0, z: 0 };
    let turnStart = -1, departs = 0, taunts = 0;
    for (let i = 0; i < 6000 && departs < 3; i++) {
      // Player either far away (> 35 m) or 25 m behind him.
      const d = far ? 60 : 25;
      player.x = r.p.x - d; player.y = r.p.y; player.z = r.p.z;
      const before = r.mode;
      r.step(player, d);
      if (r.events & RE_TAUNT) taunts++;
      if (r.mode === RM_TURN && before !== RM_TURN) turnStart = i;
      if (r.events & RE_DEPART) {
        departs++;
        assert.equal(r.mode, RM_EDGE);
        if (turnStart >= 0) assert.equal(i - turnStart, 36, "head turn must lead the first edge step by 36 steps");
      }
    }
    assert.ok(departs >= 3);
    if (far) assert.ok(taunts >= 2); else assert.equal(taunts, 0);
  }
});
