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
