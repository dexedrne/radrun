// Round 12 WORLD (docs/specs/2026-09-26-round12-spider-tag.md §2): the structures between the buildings are
// derived by rule, pass G9-G12 in every district, and stay put when a far building is moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { CityModel } from "../src/world/cityModel.ts";
import { lintModel } from "../src/world/derive.ts";
import { modelFromCityPrefab, structureInput } from "../src/world/level.ts";
import { lintStructures, SRULES, streetRuns } from "../src/world/structures.ts";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { DISTRICTS, DISTRICT_IDS, type DistrictId } from "../src/world/districts.ts";

applyTuningJson(JSON.parse(fs.readFileSync(new URL("../public/levels/tuning.json", import.meta.url), "utf8")));
const file = (id: DistrictId, f: string) => new URL(`../public/${DISTRICTS[id].dir}${f}`, import.meta.url);
const read = (id: DistrictId, f: string) => JSON.parse(fs.readFileSync(file(id, f), "utf8"));

for (const id of DISTRICT_IDS) {
  test(`structures ${id}: committed model = a fresh derivation; G9-G12 clean; budget`, () => {
    const { model } = modelFromCityPrefab(read(id, "city.json"), structureInput(id, read(id, "decor.json")));
    const committed: CityModel = read(id, "city.model.json");
    assert.equal(committed.hash, model.hash, `${id}: city.model.json is stale - run npm run level -- --map ${id}`);
    const st = lintStructures(model);
    assert.deepEqual(st.errors, []);
    assert.deepEqual(lintModel(model).errors, []);
    assert.ok(model.rigs.length > 0 && model.rigs.length <= SRULES.maxRigs, `${id}: ${model.rigs.length} rigs`);
    const fx = model.solids.filter(s => s.kind === "fixture");
    assert.ok(fx.length <= SRULES.maxFixtures);
    // Fixtures come after every city.json solid, and never take part in the gameplay graph.
    const first = model.solids.findIndex(s => s.kind === "fixture");
    if (first >= 0) assert.ok(model.solids.slice(first).every(s => s.kind === "fixture"));
    for (const e of model.adjacency) assert.ok(model.solids[e.a].kind !== "fixture" && model.solids[e.b].kind !== "fixture");
    assert.ok(!model.junctionCandidates.some(j => model.solids[j].kind === "fixture"));
    // Nothing in an alley: every cable spans a street (>= 8 m).
    for (const g of model.rigs) assert.ok(Math.abs(g.bx - g.ax) + Math.abs(g.bz - g.az) >= 8 - 1e-6);
    // One skybridge / gantry per street run at most (checked by the lint), and the streets have runs.
    assert.ok(streetRuns(model.solids, model.adjacency).length > 0);
  });
}

test("structures: moving a building in one corner leaves the far structures and every city.json id alone", () => {
  const city = read("downtown", "city.json"), decor = read("downtown", "decor.json");
  const before = modelFromCityPrefab(city, structureInput("downtown", decor)).model;
  const buildings = city.root.children.find((c: { id: string }) => c.id === "buildings");
  // The building nearest the (x0, z0) corner grows 3 m.
  const node = buildings.children[0];
  node.components.transform.properties.position[1] += 1.5;
  node.components.transform.properties.scale[1] += 3;
  const after = modelFromCityPrefab(city, structureInput("downtown", decor)).model;
  const moved = after.solids.find(s => s.node === node.id)!;
  const n = before.solids.filter(s => s.kind !== "fixture").length;
  for (let i = 0; i < n; i++) assert.equal(after.solids[i].node, before.solids[i].node, "city.json solid ids never move");
  const far = (x: number, z: number) => Math.hypot(x - (moved.x0 + moved.x1) / 2, z - (moved.z0 + moved.z1) / 2) > 120;
  const key = (s: { x0: number; z0: number; x1: number; z1: number; top: number; sub?: string }) => `${s.sub}:${s.x0},${s.z0},${s.x1},${s.z1},${s.top}`;
  const farFx = (m: CityModel) => m.solids.filter(s => s.kind === "fixture" && far((s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2)).map(key).sort();
  const farRigs = (m: CityModel) => m.rigs.filter(g => far((g.ax + g.bx) / 2, (g.az + g.bz) / 2)).map(g => `${g.ax},${g.ay},${g.az},${g.bx},${g.by},${g.bz}`).sort();
  assert.deepEqual(farFx(after), farFx(before));
  assert.deepEqual(farRigs(after), farRigs(before));
  assert.ok(farRigs(before).length > 20);
});
