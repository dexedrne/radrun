// npm run gen-city -- [--map downtown|market|docks|towers|vertigo | --all] [--seed 7] [--street 14] [--force]
//   [--decor] [--no-bake]
// Generates a district ONCE into its level dir (Downtown: public/levels/, others: public/levels/<id>/) as
// city.json (the editable source of truth; never overwritten unless --force), seeds decor.json (and the
// shared tuning.json) if missing (--decor rewrites decor.json), then runs `npm run level` for that
// district (city.json -> city.model.json -> runner bake; --no-bake skips the bake).
import fs from "node:fs";
import path from "node:path";
import type { GameObject, Prefab } from "react-three-game";
import { generate, STAND_NODE } from "../src/world/generate.ts";
import { DISTRICTS, DISTRICT_IDS, isDistrictId, type DistrictId } from "../src/world/districts.ts";
import { boxNode, toPrefab } from "../src/world/toPrefab.ts";
import { adFace, adMaterials, DISTRICT_ADS } from "../src/world/billboards.ts";
import { modelFromCityPrefab } from "../src/world/level.ts";
import { propHost } from "../src/world/derive.ts";
import { tuningToJson, PLAYER, CAMERA } from "../src/sim/tuning.ts";
import type { CityModel, Solid } from "../src/world/cityModel.ts";
import { LEVELS, runLevel } from "./level.ts";
import { withRooftopProps } from "./gen-props.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const force = process.argv.includes("--force");
const doBake = !process.argv.includes("--no-bake");
const map = arg("map") ?? "downtown";
const maps: DistrictId[] = process.argv.includes("--all") ? [...DISTRICT_IDS] : isDistrictId(map) ? [map] : [];
if (!maps.length) throw new Error(`gen-city: unknown --map ${map}`);

function genDistrict(id: DistrictId): number {
  const cfg = { ...DISTRICTS[id].config };
  if (arg("seed")) cfg.seed = Number(arg("seed"));
  if (arg("street")) cfg.street = Number(arg("street"));

  const dir = path.resolve(LEVELS, "..", DISTRICTS[id].dir);
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
    const { decor } = withRooftopProps(defaultDecor(model, id), model);
    fs.writeFileSync(decorPath, JSON.stringify(decor, null, 1) + "\n");
    console.log(`gen-city: wrote ${path.relative(process.cwd(), decorPath)} (placeholder decor)`);
  }

  const tuningPath = path.join(LEVELS, "tuning.json");
  if (!fs.existsSync(tuningPath)) {
    fs.writeFileSync(tuningPath, JSON.stringify(tuningToJson(PLAYER, CAMERA), null, 2) + "\n");
    console.log(`gen-city: wrote ${path.relative(process.cwd(), tuningPath)}`);
  }

  return runLevel(cityPath, undefined, doBake);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** A vertical face of a tower: centre on the face, outward normal, width along it. */
type Face = { t: Solid; x: number; z: number; nx: number; nz: number; w: number };

/**
 * Default decor (hand-edit it afterwards in ?editor=decor). Round 9, "what you see is solid": nothing
 * decorative stands on a roof you can run on except the Milady's balloon stand, whose counter is the solid
 * prop STAND_NODE (city.json). Painted billboards and banners hang flush on tower faces, turned to the
 * district centre, a few floors above the roofs around them; the tower tops get the rooftop-props group
 * (tools/gen-props.ts). Budget: <= 320 nodes, <= 10 batch keys.
 */
function defaultDecor(model: CityModel, id: DistrictId): Prefab {
  const b = model.bounds;
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const nodes: GameObject[] = [];
  const group = (nid: string, pos: number[], yaw: number, children: GameObject[], data?: Record<string, unknown>, scale?: number[]): GameObject => ({
    id: nid,
    components: {
      transform: { type: "Transform", properties: { position: pos.map(r2), rotation: [0, r2(yaw), 0], ...(scale ? { scale } : {}) } },
      ...(data ? { data: { type: "Data", properties: { data } } } : {}),
    },
    children,
  });
  const sign = (nid: string, pos: number[], yaw: number, text: string, w: number, h: number, colors: [string, string, string]): GameObject => ({
    id: nid,
    components: {
      transform: { type: "Transform", properties: { position: pos.map(r2), rotation: [0, r2(yaw), 0] } },
      sign: { type: "Sign", properties: { text, width: w, height: h, background: colors[0], color: colors[1], border: colors[2] } },
      data: { type: "Data", properties: { data: { kind: "sign" } } },
    },
  });
  const ball = (nid: string, pos: [number, number, number], s: number, materialId: string): GameObject => ({
    id: nid,
    components: {
      transform: { type: "Transform", properties: { position: pos, scale: [s, s * 1.15, s] } },
      geometry: { type: "Geometry", properties: { geometryType: "sphere", args: [0.5, 12, 10] } },
      material: { type: "Material", properties: { materialId } },
      mesh: { type: "Mesh", properties: { castShadow: false, receiveShadow: false } },
    },
  });

  // 1. The Milady's balloon stand on its counter (Data kind "miladyStand": origin = counter base centre on
  // the roof, +Z = the counter front, which faces the roof centre; she stands behind it).
  const counter = model.solids.find(s => s.node === STAND_NODE);
  const host = counter && propHost(model.solids, counter);
  if (counter && host) {
    const sx = (counter.x0 + counter.x1) / 2, sz = (counter.z0 + counter.z1) / 2;
    const hx = (host.x0 + host.x1) / 2 - sx, hz = (host.z0 + host.z1) / 2 - sz;
    const [fx, fz] = Math.abs(hx) > Math.abs(hz) ? [Math.sign(hx), 0] : [0, Math.sign(hz) || 1];
    const d = Math.min(counter.x1 - counter.x0, counter.z1 - counter.z0);
    nodes.push(group("balloon-stand", [sx, host.top, sz], Math.atan2(fx, fz), [
      sign("stand-sign", [0, 0.6, d / 2 + 0.01], 0, "BALLOONS\n1 ETH", 2.2, 0.9, ["#fff4d6", "#b0124f", "#b0124f"]),
      ball("stand-balloon-a", [-0.8, 2.5, -0.3], 0.8, "balloonA"),
      ball("stand-balloon-b", [0.7, 2.9, -0.2], 0.9, "balloonB"),
    ], { kind: "miladyStand" }));
  }

  // Tower faces (no crane masts), towers in farthest-point order from the centre-most one, each tower's
  // faces best-facing-the-centre first; billboards take the first slots, banners the next.
  const towers = model.solids.filter(s => s.kind === "tower" && (s.x1 - s.x0 > 5 || s.z1 - s.z0 > 5));
  const mid = (s: Solid) => [(s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2];
  const order: Solid[] = [];
  if (towers.length) {
    order.push(towers.reduce((a, s) => ((mid(s)[0] - cx) ** 2 + (mid(s)[1] - cz) ** 2 < (mid(a)[0] - cx) ** 2 + (mid(a)[1] - cz) ** 2 ? s : a)));
    while (order.length < towers.length) {
      let best = towers[0], bestD = -1;
      for (const s of towers) {
        if (order.includes(s)) continue;
        const d = Math.min(...order.map(o => (mid(o)[0] - mid(s)[0]) ** 2 + (mid(o)[1] - mid(s)[1]) ** 2));
        if (d > bestD) { bestD = d; best = s; }
      }
      order.push(best);
    }
  }
  const facesOf = (t: Solid): Face[] => {
    const [mx, mz] = mid(t);
    const all: Face[] = [
      { t, x: t.x1, z: mz, nx: 1, nz: 0, w: t.z1 - t.z0 }, { t, x: t.x0, z: mz, nx: -1, nz: 0, w: t.z1 - t.z0 },
      { t, x: mx, z: t.z1, nx: 0, nz: 1, w: t.x1 - t.x0 }, { t, x: mx, z: t.z0, nx: 0, nz: -1, w: t.x1 - t.x0 },
    ];
    return all.sort((p, q) => (q.nx * (cx - q.x) + q.nz * (cz - q.z)) - (p.nx * (cx - p.x) + p.nz * (cz - p.z)));
  };
  const slots: Face[] = [];
  for (let k = 0; k < 4; k++) for (const t of order) slots.push(facesOf(t)[k]);
  /** Height of the roofs a face looks at (within 40 m in front of it). */
  const roofsIn = (f: Face) => {
    let h = 0;
    for (const s of model.solids) {
      if (s.kind !== "roof") continue;
      const dx = Math.max(0, s.x0 - f.x, f.x - s.x1), dz = Math.max(0, s.z0 - f.z, f.z - s.z1);
      if (dx * dx + dz * dz <= 40 * 40 && (s.x0 + s.x1 - 2 * f.x) * f.nx + (s.z0 + s.z1 - 2 * f.z) * f.nz > 0) h = Math.max(h, s.top);
    }
    return h;
  };

  // 2. Painted billboards (round 4 art: src/world/billboards.ts) flush on tower faces, scaled to the face.
  DISTRICT_ADS[id].forEach((ad, i) => {
    const f = slots[i];
    if (!f) return;
    const s = Math.min(2.5, (f.w - 1) / 7.3);
    const y = Math.min(f.t.top - 6 - 3.3 * s, roofsIn(f) + 7);
    nodes.push(group(`billboard-${i}`, [f.x + f.nx * 0.02, y - 4.7 * s + 1.65 * s, f.z + f.nz * 0.02], Math.atan2(f.nx, f.nz), [
      adFace(`billboard-${i}-face`, ad),
      boxNode(`billboard-${i}-back`, [0, 4.7, 0.05], [7.3, 3.3, 0.1], "metal"),
    ], { kind: "billboard" }, [r2(s), r2(s), 1]));
  });
  // 3. Tower banners, a little higher up the same canyons.
  const BANNER: Array<[string, boolean, [string, string, string]]> = [
    ["HODL", true, ["#b0124f", "#fff4d6", "#f2c14e"]],
    ["FEW UNDERSTAND", false, ["#16161d", "#f2c14e", "#f2c14e"]],
    ["NGMI", true, ["#ffffff", "#e5484d", "#e5484d"]],
    ["PROBABLY NOTHING", false, ["#6ec6ff", "#16161d", "#16161d"]],
    ["LFG", true, ["#7cdb6a", "#16161d", "#16161d"]],
    ["NOT FINANCIAL ADVICE", false, ["#fff4d6", "#1c2a6b", "#1c2a6b"]],
  ];
  BANNER.forEach(([text, vertical0, colors], i) => {
    const f = slots[DISTRICT_ADS[id].length + i];
    if (!f) return;
    const vertical = vertical0 || f.w < 12;
    const w = vertical ? 3.2 : 10.5, h = vertical ? 13 : 2.8;
    const y = Math.min(f.t.top - 4 - h / 2, roofsIn(f) + 16 + h / 2);
    nodes.push(sign(`banner-${i}`, [f.x + f.nx * 0.08, y, f.z + f.nz * 0.08], Math.atan2(f.nx, f.nz), text, w, h, colors));
  });
  return {
    id: "decor",
    name: "Rug Run decor",
    materials: {
      metal: { color: "#9aa3ad", roughness: 0.7, metalness: 0 },
      balloonA: { color: "#ff5a7a", roughness: 0.4, metalness: 0 },
      balloonB: { color: "#ffd23f", roughness: 0.4, metalness: 0 },
      ...adMaterials(),
    },
    root: { id: "decor-root", children: nodes },
  };
}

let failures = 0;
for (const id of maps) failures += genDistrict(id);
process.exitCode = failures ? 1 : 0;
