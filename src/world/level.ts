// city.json -> CityModel (the `npm run level` pipeline, also used by tests). Pure; no file I/O.
import type { Prefab } from "react-three-game";
import type { CityModel } from "./cityModel.ts";
import { deriveModel, type StructureInput } from "./derive.ts";
import { readCityPrefab } from "./fromPrefab.ts";
import { DEFAULT_CONFIG } from "./generate.ts";
import { decorKeepOuts } from "./structures.ts";
import { structureKnobs } from "../sim/tuning.ts";

/** Round 12: a district's structure inputs (its knobs from STRUCTURES / tuning.json, decor.json keep-outs). */
export function structureInput(district: string, decor: unknown): StructureInput {
  return { knobs: structureKnobs(district), keepOut: decor ? decorKeepOuts(decor) : [] };
}

/** city.json -> CityModel; `structures` (round 12) derives the structures between the buildings too. */
export function modelFromCityPrefab(prefab: Prefab, structures?: StructureInput): { model: CityModel; warnings: string[] } {
  const read = readCityPrefab(prefab);
  const warnings = [...read.warnings];
  if (!read.config) warnings.push("city.json has no root Data {kind: 'city', config}; using defaults");
  const config = { ...DEFAULT_CONFIG, ...(read.config ?? {}) };
  if (!read.solids.length) throw new Error("city.json has no Data kind 'roof'/'tower'/'prop' nodes");
  return { model: deriveModel(config, read.solids, structures), warnings };
}
