// Test 4 (city lint) on the committed city.json, plus the generator -> prefab -> model round trip, the
// editability rule (moving a building in city.json changes the derived model) and the round 9 geometry
// rules that are derived from the solids (props, wall gaps, no balloons).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generate, DEFAULT_CONFIG, STAND_NODE } from "../src/world/generate.ts";
import { toPrefab } from "../src/world/toPrefab.ts";
import { modelFromCityPrefab } from "../src/world/level.ts";
import { deriveModel, lintModel, propHost, RULES } from "../src/world/derive.ts";
import { prefabBatchStats } from "../src/world/fromPrefab.ts";
import type { CityModel, Solid } from "../src/world/cityModel.ts";

const read = (f: string) => JSON.parse(fs.readFileSync(new URL(`../public/levels/${f}`, import.meta.url), "utf8"));

test("committed city.json lints clean and matches city.model.json", () => {
  const city = read("city.json");
  const { model } = modelFromCityPrefab(city);
  const lint = lintModel(model);
  assert.deepEqual(lint.errors, []);
  const committed: CityModel = read("city.model.json");
  assert.equal(committed.hash, model.hash, "city.model.json is stale: run npm run level");
  const s = prefabBatchStats(city);
  // One unit box for everything; one instanced draw per material (5 facades, roof cap, 2 tower glasses,
  // mast, props, skyline, ground, water).
  assert.ok(s.geometrySignatures <= 3, `geometry signatures ${s.geometrySignatures}`);
  assert.ok(s.batchKeys <= 16, `batch keys ${s.batchKeys}`);
  const d = prefabBatchStats(read("decor.json"));
  // Decor: the stand, four painted ad boards (one batch each), banners and the tower-top dressing.
  assert.ok(d.nodes <= 320 && d.batchKeys <= 10, `decor ${JSON.stringify(d)}`);
});

test("generator output survives the prefab round trip (same ids, same hash) and lints clean", () => {
  const { model, skyline } = generate(DEFAULT_CONFIG);
  const again = modelFromCityPrefab(toPrefab(model, skyline)).model;
  assert.equal(again.solids.length, model.solids.length);
  assert.equal(again.hash, model.hash);
  assert.deepEqual(again.wallGaps, model.wallGaps);
  assert.deepEqual(lintModel(again).errors, []);
  for (const s of again.solids) assert.ok(s.x1 > s.x0 && s.z1 > s.z0 && s.top > 0);
});

test("editing city.json (moving a building) changes the derived model", () => {
  const city = read("city.json");
  const before = modelFromCityPrefab(city).model;
  const buildings = city.root.children.find((c: { id: string }) => c.id === "buildings");
  buildings.children[0].components.transform.properties.position[1] += 1; // centre up 1 m ...
  buildings.children[0].components.transform.properties.scale[1] += 2; // ... and 2 m taller: still ground-rooted, top +2
  const after = modelFromCityPrefab(city).model;
  assert.notEqual(after.hash, before.hash);
  const s0 = after.solids.find(s => s.node === buildings.children[0].id)!;
  const b0 = before.solids.find(s => s.node === buildings.children[0].id)!;
  assert.equal(s0.top, b0.top + 2);
});

test("no balloons: the model has no hooks and a 'hook' node in city.json is ignored with a warning", () => {
  const city = read("city.json");
  city.root.children.push({
    id: "old-balloon",
    components: {
      transform: { type: "Transform", properties: { position: [10, 60, 10] } },
      data: { type: "Data", properties: { data: { kind: "hook" } } },
    },
  });
  const { model, warnings } = modelFromCityPrefab(city);
  assert.equal("hooks" in model, false);
  assert.ok(warnings.some(w => w.includes("old-balloon") && w.includes("hook")), warnings.join("; "));
  assert.equal(model.hash, modelFromCityPrefab(read("city.json")).model.hash, "a hook node changes nothing");
});

test("props: solid, landable, on one roof, out of adjacency / junctions / spawn; the stand is one of them", () => {
  const m: CityModel = read("city.model.json");
  const props = m.solids.filter(s => s.kind === "prop");
  assert.ok(props.length >= m.solids.filter(s => s.kind === "roof").length, `${props.length} props`);
  for (const p of props) {
    assert.equal(p.landable, true);
    const host = propHost(m.solids, p)!;
    assert.ok(host, `prop ${p.id} has a roof`);
    const h = p.top - host.top;
    assert.ok((h >= RULES.vault[0] - 1e-9 && h <= RULES.vault[1] + 1e-9) || (h >= RULES.climb[0] - 1e-9 && h <= RULES.climb[1] + 1e-9), `prop ${p.id}: ${h} m`);
  }
  const ids = new Set(props.map(p => p.id));
  assert.ok(!m.adjacency.some(e => ids.has(e.a) || ids.has(e.b)));
  assert.ok(!m.junctionCandidates.some(id => ids.has(id)));
  assert.ok(!ids.has(m.spawn.roofId));
  const stand = m.solids.find(s => s.node === STAND_NODE);
  assert.ok(stand && stand.kind === "prop", "the Milady's stand counter is a solid prop");
  // A prop pushed to its roof's edge breaks G3.
  const moved = m.solids.map(s => ({ ...s }));
  const p = moved.find(s => s.kind === "prop" && s.node !== STAND_NODE)!;
  const host = propHost(moved, p)!;
  const w = p.x1 - p.x0;
  p.x0 = host.x0 + 0.5; p.x1 = p.x0 + w;
  assert.ok(lintModel(deriveModel(m.config, moved)).errors.some(e => e.startsWith("G3")));
});

test("wall gaps are derived by rule: two flush roofs, an 8-11 m notch and a wall >= 3 m above both", () => {
  const roof = (id: number, x0: number, z0: number, x1: number, z1: number, top: number): Solid => ({ id, kind: "roof", landable: true, x0, z0, x1, z1, top });
  // A (0..16) and B (25..41) along x, both flush against W's face at z = 23.5; W 10 m taller.
  const base = [roof(0, 0, 0, 16, 23.5, 50), roof(1, 25, 0, 41, 23.5, 50.5), roof(2, 0, 23.5, 41, 42, 60)];
  const m = deriveModel(DEFAULT_CONFIG, base);
  assert.deepEqual(m.wallGaps, [{ a: 0, b: 1, wall: 2, axis: "x", dir: 1, edge: 16, far: 25, face: 23.5, side: -1 }]);
  // Not flush (B stops 1 m short of the wall), too wide a notch, or a wall too low: no wall gap.
  assert.deepEqual(deriveModel(DEFAULT_CONFIG, [base[0], { ...base[1], z1: 22.5 }, base[2]]).wallGaps, []);
  assert.deepEqual(deriveModel(DEFAULT_CONFIG, [base[0], { ...base[1], x0: 28, x1: 44 }, { ...base[2], x1: 45 }]).wallGaps, []);
  assert.deepEqual(deriveModel(DEFAULT_CONFIG, [base[0], base[1], { ...base[2], top: 52 }]).wallGaps, []);
  // Downtown's committed model has some, and they pass G4.
  const d: CityModel = read("city.model.json");
  assert.ok((d.wallGaps ?? []).length >= 3, `${d.wallGaps?.length} wall gaps`);
});
