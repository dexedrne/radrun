// npm run gen-city -- [--seed 7] [--street 14] [--force]
// Generates the district ONCE into public/levels/city.json (the editable source of truth; never
// overwritten unless --force), seeds decor.json and tuning.json if they are missing, then runs
// `npm run level` (city.json -> city.model.json).
import fs from "node:fs";
import path from "node:path";
import type { GameObject, Prefab } from "react-three-game";
import { DEFAULT_CONFIG, generate } from "../src/world/generate.ts";
import { boxNode, toPrefab } from "../src/world/toPrefab.ts";
import { modelFromCityPrefab } from "../src/world/level.ts";
import { tuningToJson, PLAYER, CAMERA } from "../src/sim/tuning.ts";
import type { CityModel } from "../src/world/cityModel.ts";
import { LEVELS, runLevel } from "./level.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const force = process.argv.includes("--force");
const cfg = { ...DEFAULT_CONFIG };
if (arg("seed")) cfg.seed = Number(arg("seed"));
if (arg("street")) cfg.street = Number(arg("street"));

fs.mkdirSync(LEVELS, { recursive: true });
const cityPath = path.join(LEVELS, "city.json");
if (fs.existsSync(cityPath) && !force) {
  console.log(`gen-city: ${path.relative(process.cwd(), cityPath)} exists (hand-edited source of truth) - not overwritten; pass --force to regenerate`);
} else {
  const { model, skyline } = generate(cfg);
  fs.writeFileSync(cityPath, JSON.stringify(toPrefab(model, skyline), null, 1) + "\n");
  console.log(`gen-city: wrote ${path.relative(process.cwd(), cityPath)} (seed ${cfg.seed}, street ${cfg.street} m, ${model.solids.length} solids)`);
}

const decorPath = path.join(LEVELS, "decor.json");
if (!fs.existsSync(decorPath) || (force && process.argv.includes("--decor"))) {
  const { model } = modelFromCityPrefab(JSON.parse(fs.readFileSync(cityPath, "utf8")));
  fs.writeFileSync(decorPath, JSON.stringify(defaultDecor(model), null, 1) + "\n");
  console.log(`gen-city: wrote ${path.relative(process.cwd(), decorPath)} (placeholder decor)`);
}

const tuningPath = path.join(LEVELS, "tuning.json");
if (!fs.existsSync(tuningPath)) {
  fs.writeFileSync(tuningPath, JSON.stringify(tuningToJson(PLAYER, CAMERA), null, 2) + "\n");
  console.log(`gen-city: wrote ${path.relative(process.cwd(), tuningPath)}`);
}

runLevel(cityPath);

/** Placeholder decor near the spawn: AC units, antennas, a billboard frame and the balloon stand. */
function defaultDecor(model: CityModel): Prefab {
  const roofs = model.solids.filter(s => s.landable);
  const sp = model.spawn;
  const near = roofs
    .map(s => ({ s, d: ((s.x0 + s.x1) / 2 - sp.x) ** 2 + ((s.z0 + s.z1) / 2 - sp.z) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)
    .map(e => e.s);
  const nodes: GameObject[] = [];
  near.forEach((s, i) => {
    const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
    nodes.push(boxNode(`ac-${i}`, [s.x0 + 2.2, s.top + 0.6, s.z1 - 2.2], [1.6, 1.2, 1.2], "metal", { kind: "ac" }));
    if (i % 2 === 0) nodes.push(boxNode(`antenna-${i}`, [s.x1 - 1.5, s.top + 2.5, s.z0 + 1.5], [0.15, 5, 0.15], "metal", { kind: "antenna" }));
    if (i === 1 || i === 4) {
      nodes.push(boxNode(`billboard-${i}`, [cx, s.top + 4, s.z0 + 0.6], [8, 3.5, 0.3], "billboard", { kind: "billboard", text: i === 1 ? "WAGMI" : "gm" }));
      nodes.push(boxNode(`billboard-${i}-leg`, [cx, s.top + 1.1, s.z0 + 0.6], [0.3, 2.2, 0.3], "metal", { kind: "billboardLeg" }));
    }
  });
  const stand = near[2] ?? near[0];
  nodes.push(boxNode("balloon-stand", [(stand.x0 + stand.x1) / 2, stand.top + 0.55, (stand.z0 + stand.z1) / 2], [2.4, 1.1, 1.2], "stand", { kind: "miladyStand" }));
  return {
    id: "decor",
    name: "Rug Run decor",
    materials: {
      metal: { color: "#9aa3ad", roughness: 0.7, metalness: 0 },
      billboard: { color: "#f2c14e", roughness: 0.9, metalness: 0 },
      stand: { color: "#e86a92", roughness: 0.9, metalness: 0 },
    },
    root: { id: "decor-root", children: nodes },
  };
}
