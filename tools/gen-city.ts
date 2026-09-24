// npm run gen-city -- [--map downtown|market|docks|towers] [--seed 7] [--street 14] [--force] [--decor]
// (--decor rewrites decor.json only). Generates a district ONCE into its level dir (Downtown:
// public/levels/, others: public/levels/<id>/) as city.json (the editable source of truth; never
// overwritten unless --force), seeds decor.json (and the shared tuning.json) if missing, then runs
// `npm run level` for that district (city.json -> city.model.json -> runner bake).
import fs from "node:fs";
import path from "node:path";
import type { GameObject, Prefab } from "react-three-game";
import { generate } from "../src/world/generate.ts";
import { DISTRICTS, isDistrictId } from "../src/world/districts.ts";
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
const map = arg("map") ?? "downtown";
if (!isDistrictId(map)) throw new Error(`gen-city: unknown --map ${map}`);
const cfg = { ...DISTRICTS[map].config };
if (arg("seed")) cfg.seed = Number(arg("seed"));
if (arg("street")) cfg.street = Number(arg("street"));

const dir = path.resolve(LEVELS, "..", DISTRICTS[map].dir);
fs.mkdirSync(dir, { recursive: true });
const cityPath = path.join(dir, "city.json");
if (fs.existsSync(cityPath) && !force) {
  console.log(`gen-city: ${path.relative(process.cwd(), cityPath)} exists (hand-edited source of truth) - not overwritten; pass --force to regenerate`);
} else {
  const { model, skyline } = generate(cfg);
  fs.writeFileSync(cityPath, JSON.stringify(toPrefab(model, skyline), null, 1) + "\n");
  console.log(`gen-city: wrote ${path.relative(process.cwd(), cityPath)} (seed ${cfg.seed}, street ${cfg.street} m, ${model.solids.length} solids)`);
}

const decorPath = path.join(dir, "decor.json");
if (!fs.existsSync(decorPath) || process.argv.includes("--decor")) {
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

/**
 * Default decor (hand-edit it afterwards in ?editor=decor): the Milady's balloon stand on the roof
 * nearest the district centre, rooftop billboards and tower banners with Radbro / crypto jokes (the
 * "Sign" component), AC units and antennas spread over the city. Budget: <= 40 nodes, <= 6 batch keys.
 */
function defaultDecor(model: CityModel): Prefab {
  const b = model.bounds;
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const minW = model.config.building - 0.1;
  const roofs = model.solids.filter(s => s.landable && s.x1 - s.x0 >= minW && s.z1 - s.z0 >= minW);
  const mid = (s: (typeof roofs)[number]) => ({ x: (s.x0 + s.x1) / 2, z: (s.z0 + s.z1) / 2 });
  // Stand roof: nearest the centre. Then farthest-point sampling for an even spread.
  const standRoof = roofs.reduce((a, s) => ((mid(s).x - cx) ** 2 + (mid(s).z - cz) ** 2 < (mid(a).x - cx) ** 2 + (mid(a).z - cz) ** 2 ? s : a));
  const picked = [standRoof];
  while (picked.length < 14) {
    let best = roofs[0], bestD = -1;
    for (const s of roofs) {
      if (picked.includes(s)) continue;
      const m = mid(s);
      const d = Math.min(...picked.map(p => (mid(p).x - m.x) ** 2 + (mid(p).z - m.z) ** 2));
      if (d > bestD) { bestD = d; best = s; }
    }
    picked.push(best);
  }
  const nodes: GameObject[] = [];
  const group = (id: string, pos: number[], yaw: number, children: GameObject[], data?: Record<string, unknown>): GameObject => ({
    id,
    components: {
      transform: { type: "Transform", properties: { position: pos.map(r2), rotation: [0, r2(yaw), 0] } },
      ...(data ? { data: { type: "Data", properties: { data } } } : {}),
    },
    children,
  });
  const sign = (id: string, pos: number[], yaw: number, text: string, w: number, h: number, colors: [string, string, string]): GameObject => ({
    id,
    components: {
      transform: { type: "Transform", properties: { position: pos.map(r2), rotation: [0, r2(yaw), 0] } },
      sign: { type: "Sign", properties: { text, width: w, height: h, background: colors[0], color: colors[1], border: colors[2] } },
      data: { type: "Data", properties: { data: { kind: "sign" } } },
    },
  });
  const ball = (id: string, pos: [number, number, number], s: number, materialId: string): GameObject => ({
    id,
    components: {
      transform: { type: "Transform", properties: { position: pos, scale: [s, s * 1.15, s] } },
      geometry: { type: "Geometry", properties: { geometryType: "sphere", args: [0.5, 12, 10] } },
      material: { type: "Material", properties: { materialId } },
      mesh: { type: "Mesh", properties: { castShadow: false, receiveShadow: false } },
    },
  });
  // 1. The Milady's balloon stand (Data kind "miladyStand": origin = counter base centre on the roof).
  {
    const m = mid(standRoof);
    const yaw = Math.atan2(cx - m.x, cz - m.z);
    nodes.push(group("balloon-stand", [m.x, standRoof.top, m.z], yaw, [
      boxNode("stand-counter", [0, 0.55, 0], [2.4, 1.1, 1.2], "stand"),
      sign("stand-sign", [0, 0.6, 0.61], 0, "BALLOONS\n1 ETH", 2.2, 0.9, ["#fff4d6", "#b0124f", "#b0124f"]),
      ball("stand-balloon-a", [-0.8, 2.5, -0.3], 0.8, "balloonA"),
      ball("stand-balloon-b", [0.7, 2.9, -0.2], 0.9, "balloonB"),
    ], { kind: "miladyStand" }));
  }
  // 2. Rooftop billboards on the outer edge of their roof, facing the centre.
  const BILL: Array<[string, [string, string, string]]> = [
    ["WAGMI", ["#f2c14e", "#16161d", "#16161d"]],
    ["BUYING\nTHE DIP", ["#16161d", "#7cdb6a", "#7cdb6a"]],
    ["gm", ["#ff5ab4", "#ffffff", "#ffffff"]],
    ["HAVE FUN\nSTAYING POOR", ["#1c2a6b", "#ffd23f", "#ffd23f"]],
  ];
  BILL.forEach(([text, colors], i) => {
    const s = picked[1 + i];
    const m = mid(s);
    const dx = m.x - cx, dz = m.z - cz;
    const ox = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) * ((s.x1 - s.x0) / 2 - 1.5) : 0;
    const oz = Math.abs(dx) > Math.abs(dz) ? 0 : Math.sign(dz || 1) * ((s.z1 - s.z0) / 2 - 1.5);
    const yaw = Math.atan2(-Math.sign(ox), -Math.sign(oz) || (ox ? 0 : 1));
    nodes.push(group(`billboard-${i}`, [m.x + ox, s.top, m.z + oz], yaw, [
      sign(`billboard-${i}-face`, [0, 4.7, 0.13], 0, text, 7, 3, colors),
      boxNode(`billboard-${i}-back`, [0, 4.7, 0], [7.3, 3.3, 0.2], "metal"),
      boxNode(`billboard-${i}-leg`, [0, 1.55, -0.1], [0.4, 3.1, 0.3], "metal"),
    ], { kind: "billboard" }));
  });
  // 3. Tower banners on the face toward the centre.
  const BANNER: Array<[string, boolean, [string, string, string]]> = [
    ["HODL", true, ["#b0124f", "#fff4d6", "#f2c14e"]],
    ["FEW UNDERSTAND", false, ["#16161d", "#f2c14e", "#f2c14e"]],
    ["NGMI", true, ["#ffffff", "#e5484d", "#e5484d"]],
    ["PROBABLY NOTHING", false, ["#6ec6ff", "#16161d", "#16161d"]],
    ["LFG", true, ["#7cdb6a", "#16161d", "#16161d"]],
    ["NOT FINANCIAL ADVICE", false, ["#fff4d6", "#1c2a6b", "#1c2a6b"]],
  ];
  model.solids.filter(s => s.kind === "tower").slice(0, BANNER.length).forEach((t, i) => {
    const [text, vertical, colors] = BANNER[i];
    const tx = (t.x0 + t.x1) / 2, tz = (t.z0 + t.z1) / 2;
    const dx = cx - tx, dz = cz - tz;
    const alongX = Math.abs(dx) > Math.abs(dz);
    const nx = alongX ? Math.sign(dx) : 0, nz = alongX ? 0 : Math.sign(dz || 1);
    const px = alongX ? (nx > 0 ? t.x1 : t.x0) + nx * 0.08 : tx;
    const pz = alongX ? tz : (nz > 0 ? t.z1 : t.z0) + nz * 0.08;
    const w = vertical ? 3.2 : 10.5, h = vertical ? 13 : 2.8;
    nodes.push(sign(`banner-${i}`, [px, t.top - (vertical ? 9 : 5), pz], Math.atan2(nx, nz), text, w, h, colors));
  });
  // 4. AC units and antennas on the remaining picked roofs.
  picked.slice(5).forEach((s, i) => {
    if (i < 5) nodes.push(boxNode(`ac-${i}`, [r2(s.x0 + 2.2), r2(s.top + 0.6), r2(s.z1 - 2.2)], [1.6, 1.2, 1.2], "metal", { kind: "ac" }));
    if (i % 2 === 0 && i < 8) nodes.push(boxNode(`antenna-${i}`, [r2(s.x1 - 1.5), r2(s.top + 2.5), r2(s.z0 + 1.5)], [0.15, 5, 0.15], "metal", { kind: "antenna" }));
  });
  return {
    id: "decor",
    name: "Rug Run decor",
    materials: {
      metal: { color: "#9aa3ad", roughness: 0.7, metalness: 0 },
      stand: { color: "#e86a92", roughness: 0.9, metalness: 0 },
      balloonA: { color: "#ff5a7a", roughness: 0.4, metalness: 0 },
      balloonB: { color: "#ffd23f", roughness: 0.4, metalness: 0 },
    },
    root: { id: "decor-root", children: nodes },
  };
}
