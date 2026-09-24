// Test 4 (city lint) on the committed city.json, plus the generator -> prefab -> model round trip and
// the editability rule (moving a building in city.json changes the derived model).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generate, DEFAULT_CONFIG } from "../src/world/generate.ts";
import { toPrefab } from "../src/world/toPrefab.ts";
import { modelFromCityPrefab } from "../src/world/level.ts";
import { lintModel } from "../src/world/derive.ts";
import { prefabBatchStats } from "../src/world/fromPrefab.ts";
import type { CityModel } from "../src/world/cityModel.ts";

const read = (f: string) => JSON.parse(fs.readFileSync(new URL(`../public/levels/${f}`, import.meta.url), "utf8"));

test("committed city.json lints clean and matches city.model.json", () => {
  const city = read("city.json");
  const { model } = modelFromCityPrefab(city);
  const lint = lintModel(model);
  assert.deepEqual(lint.errors, []);
  const committed: CityModel = read("city.model.json");
  assert.equal(committed.hash, model.hash, "city.model.json is stale: run npm run level");
  const s = prefabBatchStats(city);
  assert.ok(s.geometrySignatures <= 3, `geometry signatures ${s.geometrySignatures}`);
  assert.ok(s.batchKeys <= 12, `batch keys ${s.batchKeys}`);
  const d = prefabBatchStats(read("decor.json"));
  // Decor: <= 6 batch keys (the draw-call budget) plus one per painted ad board (round 4, four per
  // district); the node budget grew with the rooftop props (gen-props).
  assert.ok(d.nodes <= 320 && d.batchKeys <= 10, `decor ${JSON.stringify(d)}`);
});

test("generator output survives the prefab round trip and lints clean", () => {
  const { model, skyline } = generate(DEFAULT_CONFIG);
  const again = modelFromCityPrefab(toPrefab(model, skyline)).model;
  assert.equal(again.solids.length, model.solids.length);
  assert.equal(again.hooks.length, model.hooks.length);
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
