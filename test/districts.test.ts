// Round 4 districts: every district's committed level files load, its runner pack was baked for its
// city model and passes the graph / bake checks, the city lint has no errors, and a seeded round runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodePack } from "../src/route/trackPack.ts";
import { forcedUTurns, stronglyConnected } from "../src/route/graph.ts";
import type { BakeReport } from "../src/route/bake.ts";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { lintModel } from "../src/world/derive.ts";
import type { CityModel } from "../src/world/cityModel.ts";
import { DISTRICTS, DISTRICT_IDS, districtFromSearch } from "../src/world/districts.ts";
import { Round } from "../src/game/round.ts";
import { chaseDist } from "../src/sim/player.ts";
import { emptyInput } from "../src/sim/player.ts";

const tuningJson = JSON.parse(fs.readFileSync(new URL("../public/levels/tuning.json", import.meta.url), "utf8"));
const { player, difficulty } = applyTuningJson(tuningJson);
const file = (id: (typeof DISTRICT_IDS)[number], f: string) => new URL(`../public/${DISTRICTS[id].dir}${f}`, import.meta.url);

for (const id of DISTRICT_IDS) {
  test(`district ${id}: model, pack and bake report agree and pass the checks`, () => {
    const model: CityModel = JSON.parse(fs.readFileSync(file(id, "city.model.json"), "utf8"));
    const pack = decodePack(fs.readFileSync(file(id, "runner.pack.bin")));
    const report: BakeReport = JSON.parse(fs.readFileSync(file(id, "bake.report.json"), "utf8"));
    assert.equal(pack.header.city, model.hash, `${id}: runner.pack.bin is stale - run npm run level -- --map ${id}`);
    assert.equal(report.pack, pack.hash);
    const refs = pack.edges.map(e => ({ from: e.from, to: e.to }));
    assert.ok(pack.junctions.length >= 6, `${id}: ${pack.junctions.length} junctions`);
    assert.ok(stronglyConnected(pack.junctions.length, refs), `${id}: graph not strongly connected`);
    assert.deepEqual(forcedUTurns(refs), []);
    assert.equal(report.checks.walkStalls, 0);
    const lint = lintModel(model, player.aimRadius);
    assert.deepEqual(lint.errors, [], `${id}: lint errors`);
  });

  test(`district ${id}: a seeded round counts down, chases and steps without errors`, () => {
    const model: CityModel = JSON.parse(fs.readFileSync(file(id, "city.model.json"), "utf8"));
    const pack = decodePack(fs.readFileSync(file(id, "runner.pack.bin")));
    const r = new Round({ model, pack, difficulty: "normal", params: difficulty.normal, tuning: player, chaser: "652", runner: "4764", seed: 12345 });
    const inp = emptyInput();
    for (let i = 0; i < 360 + 600; i++) r.step(inp);
    assert.equal(r.phase, "chase");
    assert.ok(r.d > 0 && isFinite(r.d));
  });
}

test("districts: the page district comes from ?map= or a link's m=, else Downtown", () => {
  assert.equal(districtFromSearch(""), "downtown");
  assert.equal(districtFromSearch("?map=towers"), "towers");
  assert.equal(districtFromSearch("?v=2&m=docks&c=652"), "docks");
  assert.equal(districtFromSearch("?map=nope"), "downtown");
});

test("chase tweak: Downtown / no district is the classic round; a tweak keeps the rng draws and changes only its knobs", () => {
  const model: CityModel = JSON.parse(fs.readFileSync(file("downtown", "city.model.json"), "utf8"));
  const pack = decodePack(fs.readFileSync(file("downtown", "runner.pack.bin")));
  const base = { model, pack, difficulty: "normal" as const, params: difficulty.normal, tuning: player, chaser: "652" as const, runner: "4764" as const, countdown: false };
  for (const seed of [1, 7, 24, 36]) {
    const a = new Round({ ...base, seed }), b = new Round({ ...base, seed, district: "downtown" });
    assert.equal(a.hash(), b.hash(), "Downtown has no tweak");
    const c = new Round({ ...base, seed, chase: { spawnMin: 30, spawnSpan: 0, spawnOther: 0, add: { normal: { yoinkRange: -1, gStar: 5 } } } });
    assert.equal(c.rng.s, a.rng.s, "same number of rng draws");
    assert.equal(c.startJunction, a.startJunction);
    assert.equal(c.runner.next, a.runner.next, "same first edge");
    assert.equal(c.tuning.yoinkRange, a.tuning.yoinkRange - 1);
    assert.equal(c.runner.params.gStar, a.runner.params.gStar + 5);
    assert.ok(chaseDist(c.player.p, c.runner.p) >= chaseDist(a.player.p, a.runner.p) - 1e-9 || c.spawn.roofId !== a.spawn.roofId);
  }
});

test("chase tweak: every district's tweak builds valid rounds (first edge leaves the start junction)", () => {
  for (const id of DISTRICT_IDS) {
    const model: CityModel = JSON.parse(fs.readFileSync(file(id, "city.model.json"), "utf8"));
    const pack = decodePack(fs.readFileSync(file(id, "runner.pack.bin")));
    for (const d of ["chill", "normal", "degen"] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const r = new Round({ model, pack, difficulty: d, params: difficulty[d], tuning: player, chaser: "652", runner: "4764", seed, countdown: false, district: id });
        assert.ok(pack.out[r.startJunction].includes(r.runner.next), `${id} ${d} seed ${seed}`);
        assert.ok(r.tuning.yoinkRange > 2 && r.runner.params.base > 0.5, `${id} ${d}: sane runner parameters`);
      }
    }
  }
});
