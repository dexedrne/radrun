// npm run restyle-city: re-applies the city look from src/world/toPrefab.ts to the hand-edited
// public/levels/city.json WITHOUT touching gameplay geometry: the materials table (known ids are
// overwritten, extra ids kept), the facade rule for buildings that still use a facade material, and the
// roof-cap trims (thickness CAP_T). Solids, hooks and config are left alone, so city.model.json and the
// runner bake stay valid (the test "committed city.json ... matches city.model.json" checks it).
import fs from "node:fs";
import path from "node:path";
import type { GameObject, Prefab } from "react-three-game";
import { CAP_T, CITY_MATERIALS, facadeFor } from "../src/world/toPrefab.ts";
import { modelFromCityPrefab } from "../src/world/level.ts";
import { LEVELS } from "./level.ts";

const cityPath = path.join(LEVELS, "city.json");
const city: Prefab = JSON.parse(fs.readFileSync(cityPath, "utf8"));
const before = modelFromCityPrefab(city).model.hash;
city.materials = { ...(city.materials ?? {}), ...CITY_MATERIALS };

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const props = (n: GameObject, key: string) => n.components?.[key]?.properties as Record<string, unknown> | undefined;
let facades = 0, caps = 0;
const walk = (n: GameObject) => {
  const kind = (props(n, "data")?.data as { kind?: string } | undefined)?.kind;
  const mat = props(n, "material");
  if (kind === "roof" && mat && String(mat.materialId ?? "").startsWith("facade")) {
    const id = Number(/(\d+)$/.exec(n.id)?.[1] ?? NaN);
    if (Number.isFinite(id)) { mat.materialId = facadeFor(id); facades++; }
  }
  if (kind === "roof" || kind === "tower") {
    const [w, h, d] = (props(n, "transform")?.scale as number[] | undefined) ?? [1, 1, 1];
    for (const c of n.children ?? []) {
      const ck = (props(c, "data")?.data as { kind?: string } | undefined)?.kind;
      const t = props(c, "transform");
      if (ck !== "trim" || !c.id.endsWith("-cap") || !t) continue;
      t.position = [0, r6(0.5 - (CAP_T / 2 - 0.02) / h), 0];
      t.scale = [r6(1 + 0.3 / w), r6(CAP_T / h), r6(1 + 0.3 / d)];
      const cm = props(c, "material");
      if (cm && cm.materialId === "skyline") cm.materialId = "roofCap";
      caps++;
    }
  }
  for (const c of n.children ?? []) walk(c);
};
walk(city.root);
const after = modelFromCityPrefab(city).model.hash;
if (after !== before) {
  console.error(`restyle-city: model hash changed (${before} -> ${after}); not written`);
  process.exit(1);
}
fs.writeFileSync(cityPath, JSON.stringify(city, null, 1) + "\n");
console.log(`restyle-city: ${path.relative(process.cwd(), cityPath)}: ${Object.keys(CITY_MATERIALS).length} materials, ${facades} facades, ${caps} caps (model hash ${after} unchanged)`);
