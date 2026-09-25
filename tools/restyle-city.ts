// npm run restyle-city -- [--map downtown|market|docks|towers|vertigo | --all]: re-applies the city look from
// src/world/toPrefab.ts to a hand-edited city.json WITHOUT touching gameplay geometry: the materials table
// (known ids are overwritten - the street texture per the district's block pitch - extra ids kept), the
// facade / tower-glass / prop material rules for nodes that still use one of those materials, and the
// roof-cap trims (thickness CAP_T). Solids and config are left alone, so city.model.json and the runner
// bake stay valid (the test "committed city.json ... matches city.model.json" checks it).
import fs from "node:fs";
import path from "node:path";
import type { GameObject, Prefab } from "react-three-game";
import { CAP_T, cityMaterials, facadeFor, propMaterial, towerMaterial } from "../src/world/toPrefab.ts";
import { modelFromCityPrefab } from "../src/world/level.ts";
import { DISTRICT_IDS, isDistrictId } from "../src/world/districts.ts";
import { districtCity } from "./level.ts";

const argv = process.argv;
const mi = argv.indexOf("--map");
const ids = argv.includes("--all") ? [...DISTRICT_IDS] : [mi > 0 ? argv[mi + 1] : "downtown"];
for (const id of ids) if (!isDistrictId(id)) throw new Error(`restyle-city: unknown --map ${id}`);

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const props = (n: GameObject, key: string) => n.components?.[key]?.properties as Record<string, unknown> | undefined;
const TOWER_LOOKS = new Set(["tower", "towerB", "mast"]);
const PROP_LOOKS = new Set(["propMetal", "propHut", "propCrate", "propContainer", "propContainerB", "stand"]);

for (const id of ids) {
  const cityPath = districtCity(id);
  const city: Prefab = JSON.parse(fs.readFileSync(cityPath, "utf8"));
  const { model } = modelFromCityPrefab(city);
  const before = model.hash;
  const byNode = new Map(model.solids.map(s => [s.node, s]));
  city.materials = { ...(city.materials ?? {}), ...cityMaterials(model.config) };
  let looks = 0, caps = 0;
  const walk = (n: GameObject) => {
    const kind = (props(n, "data")?.data as { kind?: string } | undefined)?.kind;
    const mat = props(n, "material");
    const solid = byNode.get(n.id);
    const cur = String(mat?.materialId ?? "");
    if (mat && solid && kind === "roof" && cur.startsWith("facade")) { mat.materialId = facadeFor(solid.id); looks++; }
    if (mat && solid && kind === "tower" && TOWER_LOOKS.has(cur)) { mat.materialId = towerMaterial(solid); looks++; }
    if (mat && solid && kind === "prop" && PROP_LOOKS.has(cur)) { mat.materialId = propMaterial(solid, model.solids, model.config.propSet === "docks"); looks++; }
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
    console.error(`restyle-city: ${id}: model hash changed (${before} -> ${after}); not written`);
    process.exitCode = 1;
    continue;
  }
  fs.writeFileSync(cityPath, JSON.stringify(city, null, 1) + "\n");
  console.log(`restyle-city: ${path.relative(process.cwd(), cityPath)}: ${Object.keys(city.materials).length} materials, ${looks} looks, ${caps} caps (model hash ${after} unchanged)`);
}
