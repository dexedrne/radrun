// npm run level: a district's city.json (editable source of truth) -> city.model.json -> runner bake
// -> runner.pack.bin + bake.report.json. Prints the city lint (round 9 geometry rules G1-G8) and the bake
// checks (never fails on dropped edges; a non-zero exit only for lint errors, failed graph checks or a bake
// that throws). Tuning is the shared public/levels/tuning.json.
//   node tools/level.ts [--map downtown|market|docks|towers|vertigo | --all | --city <path>] [--no-bake]
// --no-bake: derive + lint + write city.model.json only (the world builder's loop; packs are baked once the
// sim that plays them is in).
import fs from "node:fs";
import path from "node:path";
import { modelFromCityPrefab } from "../src/world/level.ts";
import { lintModel } from "../src/world/derive.ts";
import { prefabBatchStats } from "../src/world/fromPrefab.ts";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { bake, BAKE, type BakeReport } from "../src/route/bake.ts";
import { DISTRICTS, DISTRICT_IDS, isDistrictId } from "../src/world/districts.ts";

export const LEVELS = path.resolve(import.meta.dirname, "..", "public", "levels");

export function bakeChecksFailed(r: BakeReport): string[] {
  const bad: string[] = [];
  const c = r.checks;
  if (!c.stronglyConnected) bad.push("graph not strongly connected");
  if (c.forcedUTurns) bad.push(`${c.forcedUTurns} forced U-turn(s)`);
  if (c.walkStalls) bad.push("300 s random walk stalled");
  if (c.minSwingWindowMs < (BAKE.swingWindowMin * 1000) / 120 - 1) bad.push(`swing window ${c.minSwingWindowMs} ms < ${(BAKE.swingWindowMin * 1000) / 120}`);
  if (c.minAlleyWindowMs < (BAKE.alleyWindow * 1000) / 120 - 1) bad.push(`alley window ${c.minAlleyWindowMs} ms < ${(BAKE.alleyWindow * 1000) / 120}`);
  if (c.minLandMargin < 1.5) bad.push(`landing margin ${c.minLandMargin} < 1.5 m`);
  if (c.minDropWindow !== undefined && c.minDropWindow < BAKE.dropWindow) bad.push(`drop window ${c.minDropWindow} < ${BAKE.dropWindow} points`);
  if (c.maxSnap >= 0.05) bad.push(`junction snap ${c.maxSnap} m >= 5 cm`);
  if (r.junctions < 6) bad.push(`only ${r.junctions} junctions`);
  // (Round 11: 90 s - the dense districts try more crossing pendulums; Downtown's test bake still has to be < 60 s.)
  if (r.ms > 90000) bad.push(`bake took ${r.ms} ms > 90 s`);
  return bad;
}

export function runLevel(cityPath = path.join(LEVELS, "city.json"), outDir = path.dirname(cityPath), doBake = true): number {
  const prefab = JSON.parse(fs.readFileSync(cityPath, "utf8"));
  const { model, warnings } = modelFromCityPrefab(prefab);
  const tuningPath = path.join(LEVELS, "tuning.json");
  const tuning = applyTuningJson(fs.existsSync(tuningPath) ? JSON.parse(fs.readFileSync(tuningPath, "utf8")) : null).player;
  const lint = lintModel(model);
  const outPath = path.join(outDir, "city.model.json");
  fs.writeFileSync(outPath, JSON.stringify(model) + "\n");
  const cityStats = prefabBatchStats(prefab);
  console.log(`level: ${path.relative(process.cwd(), cityPath)} -> ${path.relative(process.cwd(), outPath)} (hash ${model.hash})`);
  console.log(`  ${JSON.stringify(lint.stats)}`);
  console.log(`  city.json: ${cityStats.nodes} nodes, ${cityStats.geometrySignatures} geometry signature(s), ${cityStats.batchKeys} batch keys`);
  const decorPath = path.join(path.dirname(cityPath), "decor.json");
  if (fs.existsSync(decorPath)) {
    const d = prefabBatchStats(JSON.parse(fs.readFileSync(decorPath, "utf8")));
    console.log(`  decor.json: ${d.nodes} nodes, ${d.batchKeys} batch keys (budget 320 / 10)`);
  }
  for (const w of warnings.concat(lint.warnings)) console.log(`  warn: ${w}`);
  for (const e of lint.errors.slice(0, 30)) console.log(`  LINT: ${e}`);
  if (lint.errors.length > 30) console.log(`  ... ${lint.errors.length - 30} more lint errors`);
  let failures = lint.errors.length;
  if (doBake) {
    let baked: ReturnType<typeof bake>;
    try {
      baked = bake(model, tuning, m => console.log(`  ${m}`));
    } catch (e) {
      console.log(`  BAKE FAILED: ${(e as Error).message ?? e}`);
      return failures + 1;
    }
    const { bytes, report } = baked;
    fs.writeFileSync(path.join(outDir, "runner.pack.bin"), bytes);
    fs.writeFileSync(path.join(outDir, "bake.report.json"), JSON.stringify(report, null, 1) + "\n");
    const kept = report.edges.filter(e => e.kept);
    const secs = kept.map(e => e.seconds);
    console.log(`  bake: ${report.junctions} junctions, ${report.kept} edges kept (${report.baked}/${report.candidates} baked), ` +
      `${(secs.reduce((a, b) => a + b, 0)).toFixed(0)} s of track, edges ${Math.min(...secs).toFixed(1)}-${Math.max(...secs).toFixed(1)} s, ` +
      `speed ${Math.min(...kept.map(e => e.speed)).toFixed(1)}-${Math.max(...kept.map(e => e.speed)).toFixed(1)} m/s, ` +
      `pack ${(report.packBytes / 1024).toFixed(0)} KB (hash ${report.pack}), ${report.ms} ms`);
    console.log(`  bake checks: ${JSON.stringify(report.checks)}`);
    const reasons = new Map<string, number>();
    for (const e of report.edges) if (!e.ok) { const r = e.reason.replace(/\d+(\.\d+)?/g, "#"); reasons.set(r, (reasons.get(r) ?? 0) + 1); }
    if (reasons.size) console.log(`  dropped: ${[...reasons].map(([r, n]) => `${n}x ${r}`).join("; ")}`);
    const bad = bakeChecksFailed(report);
    for (const b of bad) console.log(`  BAKE CHECK FAILED: ${b}`);
    failures += bad.length;
  }
  return failures;
}

/** A district's city.json path. */
export const districtCity = (id: string): string => {
  if (!isDistrictId(id)) throw new Error(`level: unknown district ${id}`);
  return path.resolve(LEVELS, "..", DISTRICTS[id].dir, "city.json");
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv;
  const doBake = !argv.includes("--no-bake");
  const i = argv.indexOf("--city"), m = argv.indexOf("--map");
  const cities = argv.includes("--all")
    ? DISTRICT_IDS.map(districtCity).filter(p => fs.existsSync(p))
    : [i > 0 ? path.resolve(argv[i + 1]) : m > 0 ? districtCity(argv[m + 1]) : path.join(LEVELS, "city.json")];
  let n = 0;
  for (const c of cities) n += runLevel(c, undefined, doBake);
  process.exitCode = n ? 1 : 0;
}
