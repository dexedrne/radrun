// CityModel (+ skyline) -> r3g 0.0.113 prefab JSON (city.json). Every building, cap, skyline box,
// ground and water slab is a UNIT box scaled by its Transform, so they all share one geometry
// signature (box:[1,1,1]) and batch into a handful of instanced draws. Solids carry Data {kind} tags
// so `npm run level` can read an edited city.json back into the sim model (fromPrefab.ts).
import type { GameObject, Prefab, PrefabMaterial } from "react-three-game";
import type { CityConfig, CityModel, Solid } from "./cityModel.ts";
import type { DecoBox } from "./generate.ts";

/** Repeating textures are mapped in world space in the game (src/app/cityLook.tsx): repeatCount = tiles
 *  per metre. Facade tiles are 16 x 24 m (8 bays of 2 m, 8 floors of 3 m); tools/gen-textures.ts. */
const FACADE_TILE: [number, number] = [0.0625, 0.041667];
const tex = (texture: string, repeatCount: [number, number]) => ({ texture, repeat: true, repeatCount });

export const CITY_MATERIALS: Record<string, PrefabMaterial> = {
  facadeA: { name: "slate grid", color: "#8a9ac0", roughness: 0.9, metalness: 0, ...tex("/textures/facade_grid.png", FACADE_TILE) },
  facadeB: { name: "terracotta brick", color: "#d9927a", roughness: 0.95, metalness: 0, ...tex("/textures/facade_brick.png", FACADE_TILE) },
  facadeC: { name: "teal grid", color: "#78b0b2", roughness: 0.9, metalness: 0, ...tex("/textures/facade_grid.png", FACADE_TILE) },
  facadeD: { name: "sand brick", color: "#e0c9a0", roughness: 0.95, metalness: 0, ...tex("/textures/facade_brick.png", FACADE_TILE) },
  facadeE: { name: "lilac grid", color: "#ab96c9", roughness: 0.9, metalness: 0, ...tex("/textures/facade_grid.png", FACADE_TILE) },
  roofCap: { name: "roof", color: "#d8cbb4", roughness: 0.95, metalness: 0, ...tex("/textures/roof.png", [0.25, 0.25]) },
  tower: { name: "tower glass", color: "#8ba2cf", roughness: 0.6, metalness: 0, ...tex("/textures/facade_glass.png", FACADE_TILE) },
  skyline: { name: "skyline", materialType: "basic", color: "#b3c3dc", ...tex("/textures/facade_grid.png", [0.03125, 0.020833]) },
  ground: { name: "streets", color: "#c4c6d0", roughness: 1, metalness: 0, ...tex("/textures/street.png", [0.0238095, 0.0238095]) },
  water: { name: "water", materialType: "basic", color: "#4f9dbf", ...tex("/textures/water.png", [0.0625, 0.0625]) },
};

/** Five facade looks, spread by a small hash of the solid id. */
export const FACADES = ["facadeA", "facadeB", "facadeC", "facadeD", "facadeE"];
export function facadeFor(id: number): string {
  let x = Math.imul(id + 0x9e37, 0x27d4eb2d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return FACADES[(x >>> 0) % FACADES.length];
}

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

/** Roof cap (the surface you run on + a coping band down the facade), metres; top sits 2 cm above the roof. */
export const CAP_T = 0.8;

/** A solid as a unit box plus a roof-cap child (local coordinates, so it follows edits). */
export function solidNode(s: Solid, nodeId: string): GameObject {
  const w = s.x1 - s.x0, d = s.z1 - s.z0, h = s.top;
  const facade = s.kind === "tower" ? "tower" : facadeFor(s.id);
  const cap = boxNode(
    `${nodeId}-cap`,
    [0, 0.5 - (CAP_T / 2 - 0.02) / h, 0],
    [1 + 0.3 / w, CAP_T / h, 1 + 0.3 / d],
    "roofCap",
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
