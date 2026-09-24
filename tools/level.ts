// npm run level: public/levels/city.json (editable source of truth) -> public/levels/city.model.json.
// Prints the city lint. The runner bake (-> runner.pack.bin) joins this pipeline in M2.
//   node tools/level.ts [--city public/levels/city.json]
import fs from "node:fs";
import path from "node:path";
import { modelFromCityPrefab } from "../src/world/level.ts";
import { lintModel } from "../src/world/derive.ts";
import { prefabBatchStats } from "../src/world/fromPrefab.ts";
import { applyTuningJson } from "../src/sim/tuning.ts";

export const LEVELS = path.resolve(import.meta.dirname, "..", "public", "levels");

export function runLevel(cityPath = path.join(LEVELS, "city.json"), outPath = path.join(LEVELS, "city.model.json")): number {
  const prefab = JSON.parse(fs.readFileSync(cityPath, "utf8"));
  const { model, warnings } = modelFromCityPrefab(prefab);
  let aimRadius = 17;
  const tuningPath = path.join(path.dirname(cityPath), "tuning.json");
  if (fs.existsSync(tuningPath)) aimRadius = applyTuningJson(JSON.parse(fs.readFileSync(tuningPath, "utf8"))).player.aimRadius;
  const lint = lintModel(model, aimRadius);
  fs.writeFileSync(outPath, JSON.stringify(model) + "\n");
  const cityStats = prefabBatchStats(prefab);
  console.log(`level: ${path.relative(process.cwd(), cityPath)} -> ${path.relative(process.cwd(), outPath)} (hash ${model.hash})`);
  console.log(`  ${JSON.stringify(lint.stats)}`);
  console.log(`  city.json: ${cityStats.nodes} nodes, ${cityStats.geometrySignatures} geometry signature(s), ${cityStats.batchKeys} batch keys`);
  const decorPath = path.join(path.dirname(cityPath), "decor.json");
  if (fs.existsSync(decorPath)) {
    const d = prefabBatchStats(JSON.parse(fs.readFileSync(decorPath, "utf8")));
    console.log(`  decor.json: ${d.nodes} nodes, ${d.batchKeys} batch keys (budget 40 / 6)`);
  }
  for (const w of warnings.concat(lint.warnings)) console.log(`  warn: ${w}`);
  for (const e of lint.errors.slice(0, 30)) console.log(`  LINT: ${e}`);
  if (lint.errors.length > 30) console.log(`  ... ${lint.errors.length - 30} more lint errors`);
  console.log("  bake: runner.pack.bin is produced here from M2 on (not built yet)");
  return lint.errors.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--city");
  runLevel(i > 0 ? path.resolve(process.argv[i + 1]) : undefined);
}
