// npm run gen-props: (re)writes the "rooftop-props" group of public/levels/decor.json - AC units, water
// towers and antennas on roofs and towers. Decor is never read by the sim or the bake, so the props are
// never solid; they are placed deterministically in roof corners, clear of the runner's baked ground
// path (runner.pack.bin) and of the other decor (stand, billboards). Everything else in decor.json is
// kept. Edit them by hand in ?editor=decor; re-run after `npm run level` if the layout changed.
//   node tools/gen-props.ts [--seed 99]
// Draw calls: boxes share "metal" (box:[1,1,1]); tanks and tank roofs add one instanced batch each.
import fs from "node:fs";
import path from "node:path";
import type { GameObject, Prefab } from "react-three-game";
import type { CityModel, Solid } from "../src/world/cityModel.ts";
import { decodePack, PHASE_GROUND, SAMPLE_STRIDE } from "../src/route/trackPack.ts";
import { boxNode } from "../src/world/toPrefab.ts";
import { LEVELS } from "./level.ts";

const GROUP_ID = "rooftop-props";
const seedArg = process.argv.indexOf("--seed");
const SEED = seedArg > 0 ? Number(process.argv[seedArg + 1]) : 99;

const model: CityModel = JSON.parse(fs.readFileSync(path.join(LEVELS, "city.model.json"), "utf8"));
const pack = decodePack(fs.readFileSync(path.join(LEVELS, "runner.pack.bin")));
const decorPath = path.join(LEVELS, "decor.json");
const decor: Prefab = JSON.parse(fs.readFileSync(decorPath, "utf8"));

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const r2 = (v: number) => Math.round(v * 100) / 100;

// Occupied circles (x, z, radius): the runner's ground path, then the other decor, then placed props.
type Circle = { x: number; z: number; r: number };
const path2: Array<[number, number]> = [];
for (const e of pack.edges) {
  for (let i = 0; i < e.count; i++) {
    const o = i * SAMPLE_STRIDE;
    if (e.samples[o + 3] !== PHASE_GROUND) continue;
    path2.push([e.origin.x + e.samples[o] / 100, e.origin.z + e.samples[o + 2] / 100]);
  }
}
for (const j of pack.junctions) path2.push([j.x, j.z]);
const occupied: Circle[] = [];
for (const n of decor.root.children ?? []) {
  if (n.id === GROUP_ID) continue;
  const p = n.components?.transform?.properties?.position as number[] | undefined;
  if (p) occupied.push({ x: p[0], z: p[2], r: n.id.startsWith("billboard") || n.id === "balloon-stand" ? 4.5 : 1.2 });
}
const PATH_MARGIN = 1.6;
function clear(x: number, z: number, r: number): boolean {
  for (const [px, pz] of path2) if ((px - x) ** 2 + (pz - z) ** 2 < (r + PATH_MARGIN) ** 2) return false;
  for (const c of occupied) if ((c.x - x) ** 2 + (c.z - z) ** 2 < (c.r + r + 0.6) ** 2) return false;
  return true;
}

const cyl = (id: string, pos: number[], scale: number[], args: number[], materialId: string): GameObject => ({
  id,
  components: {
    transform: { type: "Transform", properties: { position: pos.map(r2), scale: scale.map(r2) } },
    geometry: { type: "Geometry", properties: { geometryType: "cylinder", args } },
    material: { type: "Material", properties: { materialId } },
    mesh: { type: "Mesh", properties: { castShadow: false, receiveShadow: false } },
  },
});
const group = (id: string, pos: number[], children: GameObject[], data: Record<string, unknown>, scale = 1): GameObject => ({
  id,
  components: {
    transform: { type: "Transform", properties: { position: pos.map(r2), ...(scale !== 1 ? { scale: [r2(scale), r2(scale), r2(scale)] } : {}) } },
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
    boxNode(`${id}-mast`, [0, h / 2, 0], [0.12, h, 0.12], "metal"),
    boxNode(`${id}-bar`, [0, h * 0.8, 0], [1.3, 0.07, 0.07], "metal"),
  ], { kind: "antenna" });
}

const props: GameObject[] = [];
const count = { waterTower: 0, ac: 0, antenna: 0 };
/** Corner spots of a roof, inset by `inset` m, in a random order. */
function corners(s: Solid, inset: number): Array<[number, number]> {
  const c: Array<[number, number]> = [[s.x0 + inset, s.z0 + inset], [s.x1 - inset, s.z0 + inset], [s.x1 - inset, s.z1 - inset], [s.x0 + inset, s.z1 - inset]];
  for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
  return c;
}
function tryPlace(s: Solid, inset: number, r: number, make: (x: number, z: number) => GameObject): boolean {
  for (const [x, z] of corners(s, inset)) {
    if (!clear(x, z, r)) continue;
    occupied.push({ x, z, r });
    props.push(make(x, z));
    return true;
  }
  return false;
}

const top = (s: Solid) => s.top + 0.02; // roof-cap surface
for (const s of model.solids) {
  const id = s.node ?? `s${s.id}`;
  if (s.kind === "tower") {
    // Towers are never landed on: a water tower or an antenna pair on every one.
    if (rand() < 0.5) {
      const x = (s.x0 + s.x1) / 2 + (rand() - 0.5) * 3, z = (s.z0 + s.z1) / 2 + (rand() - 0.5) * 3;
      props.push(waterTower(`wt-${id}`, x, top(s), z, 1.15)); count.waterTower++;
    } else {
      props.push(antenna(`ant-${id}-a`, s.x0 + 2, top(s), s.z0 + 2, 9 + rand() * 4));
      props.push(antenna(`ant-${id}-b`, s.x1 - 2.5, top(s), s.z1 - 3, 6 + rand() * 3));
      count.antenna += 2;
    }
    continue;
  }
  if (!s.landable) continue;
  const roll = rand();
  if (roll < 0.08) {
    const sc = 0.85 + rand() * 0.3;
    if (tryPlace(s, 2.3 * sc, 1.5 * sc, (x, z) => waterTower(`wt-${id}`, x, top(s), z, sc))) count.waterTower++;
  } else if (roll < 0.42) {
    const n = rand() < 0.3 ? 2 : 1;
    const turn = rand() < 0.5;
    for (let k = 0; k < n; k++) {
      const w = turn ? 1.1 : 1.5, d = turn ? 1.5 : 1.1, h = 0.9 + rand() * 0.4;
      if (tryPlace(s, 1.2 + k * 0.4, 1.0, (x, z) => boxNode(`ac-${id}-${k}`, [r2(x), r2(top(s) + h / 2), r2(z)], [w, r2(h), d], "metal", { kind: "ac" }))) count.ac++;
    }
  } else if (roll < 0.54) {
    if (tryPlace(s, 0.7, 0.3, (x, z) => antenna(`ant-${id}`, x, top(s), z, 3.5 + rand() * 3))) count.antenna++;
  }
}

decor.materials = {
  ...(decor.materials ?? {}),
  tankWood: { color: "#8e5f3f", roughness: 0.9, metalness: 0 },
  tankRoof: { color: "#4f4648", roughness: 0.8, metalness: 0 },
};
const kids = (decor.root.children ?? []).filter(n => n.id !== GROUP_ID);
kids.push({ id: GROUP_ID, components: { data: { type: "Data", properties: { data: { kind: "props", seed: SEED } } } }, children: props });
decor.root.children = kids;
fs.writeFileSync(decorPath, JSON.stringify(decor, null, 1) + "\n");
console.log(`gen-props: ${path.relative(process.cwd(), decorPath)}: ${count.waterTower} water towers, ${count.ac} AC units, ${count.antenna} antennas (seed ${SEED}, ${path2.length} runner path points avoided)`);
