// CityModel (+ skyline) -> r3g 0.0.113 prefab JSON (city.json). Every building, cap, skyline box,
// ground and water slab is a UNIT box scaled by its Transform, so they all share one geometry
// signature (box:[1,1,1]) and batch into a handful of instanced draws. Solids carry Data {kind} tags
// so `npm run level` can read an edited city.json back into the sim model (fromPrefab.ts).
import type { GameObject, Prefab, PrefabMaterial } from "react-three-game";
import type { CityConfig, CityModel, Solid } from "./cityModel.ts";
import type { DecoBox } from "./generate.ts";

export const CITY_MATERIALS: Record<string, PrefabMaterial> = {
  facadeA: { color: "#5b6b8c", roughness: 0.92, metalness: 0 },
  facadeB: { color: "#7a6a8f", roughness: 0.92, metalness: 0 },
  facadeC: { color: "#4f7f86", roughness: 0.92, metalness: 0 },
  roofCap: { color: "#d8cbb4", roughness: 0.95, metalness: 0 },
  tower: { color: "#3d4a72", roughness: 0.85, metalness: 0 },
  skyline: { materialType: "basic", color: "#a9bcd6" },
  ground: { color: "#343845", roughness: 1, metalness: 0 },
  water: { materialType: "basic", color: "#5a9fb8" },
};

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function boxNode(
  id: string,
  pos: [number, number, number],
  scale: [number, number, number],
  materialId: string,
  data?: Record<string, unknown>,
  children?: GameObject[],
): GameObject {
  const node: GameObject = {
    id,
    components: {
      transform: { type: "Transform", properties: { position: pos.map(r6), scale: scale.map(r6) } },
      geometry: { type: "Geometry", properties: { geometryType: "box", args: [1, 1, 1] } },
      material: { type: "Material", properties: { materialId } },
      mesh: { type: "Mesh", properties: { castShadow: false, receiveShadow: false } },
    },
  };
  if (data) node.components!.data = { type: "Data", properties: { data } };
  if (children?.length) node.children = children;
  return node;
}

const group = (id: string, children: GameObject[], data?: Record<string, unknown>): GameObject => {
  const node: GameObject = {
    id,
    components: { transform: { type: "Transform", properties: { position: [0, 0, 0] } } },
    children,
  };
  if (data) node.components!.data = { type: "Data", properties: { data } };
  return node;
};

const CAP_T = 0.4;

/** A solid as a unit box plus a roof-cap child (local coordinates, so it follows edits). */
export function solidNode(s: Solid, nodeId: string): GameObject {
  const w = s.x1 - s.x0, d = s.z1 - s.z0, h = s.top;
  const facade = s.kind === "tower" ? "tower" : ["facadeA", "facadeB", "facadeC"][(s.id * 7 + (s.id >> 2)) % 3];
  const cap = boxNode(
    `${nodeId}-cap`,
    [0, 0.5 - (CAP_T / 2 - 0.02) / h, 0],
    [1 + 0.3 / w, CAP_T / h, 1 + 0.3 / d],
    s.kind === "tower" ? "skyline" : "roofCap",
    { kind: "trim" },
  );
  return boxNode(nodeId, [r3((s.x0 + s.x1) / 2), r3(h / 2), r3((s.z0 + s.z1) / 2)], [r3(w), r3(h), r3(d)], facade, { kind: s.kind }, [cap]);
}

export function toPrefab(model: CityModel, skyline: DecoBox[]): Prefab {
  const b = model.bounds;
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const buildings = model.solids.filter(s => s.kind === "roof").map(s => solidNode(s, `b-${s.id}`));
  const towers = model.solids.filter(s => s.kind === "tower").map(s => solidNode(s, `t-${s.id}`));
  const sky = skyline.map((k, i) => boxNode(`sky-${i}`, [k.x, k.h / 2, k.z], [k.w, k.h, k.d], "skyline", { kind: "skyline" }));
  const config: CityConfig = model.config;
  return {
    id: "city",
    name: "Rug Run city",
    materials: CITY_MATERIALS,
    root: {
      id: "city-root",
      components: {
        data: { type: "Data", properties: { data: { kind: "city", config } } },
      },
      children: [
        boxNode("ground", [cx, -0.1, cz], [b.x1 - b.x0 + 40, 0.2, b.z1 - b.z0 + 40], "ground", { kind: "ground" }),
        boxNode("water", [cx, -0.6, cz], [2400, 0.2, 2400], "water", { kind: "water" }),
        group("buildings", buildings),
        group("towers", towers),
        group("skyline", sky),
        group("hooks", []),
      ],
    },
  };
}
