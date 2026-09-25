// city.json -> CityModel (the `npm run level` pipeline, also used by tests). Pure; no file I/O.
import type { Prefab } from "react-three-game";
import type { CityModel } from "./cityModel.ts";
import { deriveModel } from "./derive.ts";
import { readCityPrefab } from "./fromPrefab.ts";
import { DEFAULT_CONFIG } from "./generate.ts";

export function modelFromCityPrefab(prefab: Prefab): { model: CityModel; warnings: string[] } {
  const read = readCityPrefab(prefab);
  const warnings = [...read.warnings];
  if (!read.config) warnings.push("city.json has no root Data {kind: 'city', config}; using defaults");
  const config = { ...DEFAULT_CONFIG, ...(read.config ?? {}) };
  if (!read.solids.length) throw new Error("city.json has no Data kind 'roof'/'tower'/'prop' nodes");
  return { model: deriveModel(config, read.solids), warnings };
}
