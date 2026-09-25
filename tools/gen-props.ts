// npm run gen-props -- [--map downtown|market|docks|towers|vertigo | --all] [--seed 99]: (re)writes the
// "rooftop-props" group of a district's decor.json from its city.model.json. Everything else in decor.json
// is kept. Edit the result by hand in ?editor=decor; re-run after `npm run level` if the layout changed.
//
// Round 9: "what you see is solid". Every rooftop obstacle you can touch (AC units, bulkheads, crates,
// containers) is a solid kind "prop" in city.json now (world/generate.ts), so decor only dresses what
// nobody stands on: a water tower or an antenna on each tower top, and a jib + cab on each Docks
// crane mast. Decor is never read by the sim or the bake.
// Draw calls: boxes share "metal" / "crane" (box:[1,1,1]); tanks and tank roofs add one instanced batch each.
import fs from "node:fs";
import path from "node:path";
import type { GameObject, Prefab } from "react-three-game";
import type { CityModel, Solid } from "../src/world/cityModel.ts";
import { boxNode } from "../src/world/toPrefab.ts";
import { DISTRICTS, DISTRICT_IDS, isDistrictId, type DistrictId } from "../src/world/districts.ts";
import { mulberry32 } from "../src/sim/math.ts";

export const PROPS_GROUP = "rooftop-props";
const r2 = (v: number) => Math.round(v * 100) / 100;

const cyl = (id: string, pos: number[], scale: number[], args: number[], materialId: string): GameObject => ({
  id,
  components: {
    transform: { type: "Transform", properties: { position: pos.map(r2), scale: scale.map(r2) } },
    geometry: { type: "Geometry", properties: { geometryType: "cylinder", args } },
    material: { type: "Material", properties: { materialId } },
    mesh: { type: "Mesh", properties: { castShadow: false, receiveShadow: false } },
  },
});
const group = (id: string, pos: number[], children: GameObject[], data: Record<string, unknown>, scale = 1, yaw = 0): GameObject => ({
  id,
  components: {
    transform: { type: "Transform", properties: { position: pos.map(r2), ...(yaw ? { rotation: [0, r2(yaw), 0] } : {}), ...(scale !== 1 ? { scale: [r2(scale), r2(scale), r2(scale)] } : {}) } },
    data: { type: "Data", properties: { data } },
  },
  children,
});

const TANK = [0.5, 0.5, 1, 14], CONE = [0.01, 0.5, 1, 14];
function waterTower(id: string, x: number, y: number, z: number, s: number): GameObject {
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b], k) => boxNode(`${id}-leg-${k}`, [a * 0.85, 1.1, b * 0.85], [0.16, 2.2, 0.16], "metal"));
  return group(id, [x, y, z], [
    ...legs,
    boxNode(`${id}-deck`, [0, 2.25, 0], [2.3, 0.1, 2.3], "metal"),
    cyl(`${id}-tank`, [0, 3.45, 0], [2.5, 2.3, 2.5], TANK, "tankWood"),
    cyl(`${id}-roof`, [0, 5.05, 0], [2.8, 0.9, 2.8], CONE, "tankRoof"),
  ], { kind: "waterTower" }, s);
}
function antenna(id: string, x: number, y: number, z: number, h: number): GameObject {
  return group(id, [x, y, z], [
    boxNode(`${id}-mast`, [0, h / 2, 0], [0.18, h, 0.18], "metal"),
    boxNode(`${id}-bar`, [0, h * 0.8, 0], [1.6, 0.09, 0.09], "metal"),
  ], { kind: "antenna" });
}
/** A crane on a 4 x 4 m mast: cab, a long jib out over the street one way, a short counter-jib the other. */
function crane(id: string, s: Solid, yaw: number, jib: number): GameObject {
  const x = (s.x0 + s.x1) / 2, z = (s.z0 + s.z1) / 2;
  return group(id, [x, s.top, z], [
    boxNode(`${id}-cab`, [0, 1.6, 0], [3.2, 3.2, 3.2], "crane"),
    boxNode(`${id}-jib`, [0, 3.6, jib / 2], [1.4, 1.2, jib], "crane"),
    boxNode(`${id}-counter`, [0, 3.6, -5], [1.8, 1.4, 10], "crane"),
    boxNode(`${id}-weight`, [0, 2.6, -9], [2.6, 2.4, 2.4], "metal"),
  ], { kind: "crane" }, 1, yaw);
}

/** The rooftop-props group for a model (deterministic from the seed). */
export function rooftopProps(model: CityModel, seed = 99): { group: GameObject; counts: Record<string, number> } {
  const rand = mulberry32(seed);
  const props: GameObject[] = [];
  const counts = { waterTower: 0, antenna: 0, crane: 0 };
  const b = model.bounds;
  const cz = (b.z0 + b.z1) / 2;
  const top = (s: Solid) => s.top + 0.02; // roof-cap surface
  for (const s of model.solids) {
    if (s.kind !== "tower") continue;
    const id = s.node ?? `s${s.id}`;
    const w = s.x1 - s.x0, d = s.z1 - s.z0;
    if (w <= 5 && d <= 5) {
      // Crane mast: jib out over the street, pointing away from the district's middle row.
      const z = (s.z0 + s.z1) / 2;
      props.push(crane(`crane-${id}`, s, z > cz ? 0 : 3.141592653589793, 22 + rand() * 10));
      counts.crane++;
      continue;
    }
    if (w < 9 || d < 9 || rand() < 0.6) {
      props.push(antenna(`ant-${id}`, s.x0 + 2, top(s), s.z0 + 2, 9 + rand() * 6));
      counts.antenna++;
    } else {
      const x = (s.x0 + s.x1) / 2 + (rand() - 0.5) * 3, z = (s.z0 + s.z1) / 2 + (rand() - 0.5) * 3;
      props.push(waterTower(`wt-${id}`, x, top(s), z, 1.3));
      counts.waterTower++;
    }
  }
  return { group: { id: PROPS_GROUP, components: { data: { type: "Data", properties: { data: { kind: "props", seed } } } }, children: props }, counts };
}

/** Materials the rooftop props use (merged into decor.json's table). */
export const PROP_MATERIALS = {
  metal: { color: "#9aa3ad", roughness: 0.7, metalness: 0 },
  crane: { color: "#e3a82b", roughness: 0.8, metalness: 0 },
  tankWood: { color: "#8e5f3f", roughness: 0.9, metalness: 0 },
  tankRoof: { color: "#4f4648", roughness: 0.8, metalness: 0 },
};

/** Replace the rooftop-props group of a decor prefab (kept: every other node). */
export function withRooftopProps(decor: Prefab, model: CityModel, seed = 99): { decor: Prefab; counts: Record<string, number> } {
  const { group: g, counts } = rooftopProps(model, seed);
  const kids = (decor.root.children ?? []).filter(n => n.id !== PROPS_GROUP);
  kids.push(g);
  return { decor: { ...decor, materials: { ...(decor.materials ?? {}), ...PROP_MATERIALS }, root: { ...decor.root, children: kids } }, counts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : undefined; };
  const seed = Number(arg("seed") ?? 99);
  const map = arg("map") ?? "downtown";
  const ids: DistrictId[] = argv.includes("--all") ? [...DISTRICT_IDS] : isDistrictId(map) ? [map] : [];
  if (!ids.length) throw new Error(`gen-props: unknown --map ${map}`);
  for (const id of ids) {
    const dir = path.resolve(import.meta.dirname, "..", "public", DISTRICTS[id].dir);
    const model: CityModel = JSON.parse(fs.readFileSync(path.join(dir, "city.model.json"), "utf8"));
    const decorPath = path.join(dir, "decor.json");
    const { decor, counts } = withRooftopProps(JSON.parse(fs.readFileSync(decorPath, "utf8")), model, seed);
    fs.writeFileSync(decorPath, JSON.stringify(decor, null, 1) + "\n");
    console.log(`gen-props: ${path.relative(process.cwd(), decorPath)}: ${counts.waterTower} water towers, ${counts.antenna} antennas, ${counts.crane} cranes (seed ${seed})`);
  }
}
