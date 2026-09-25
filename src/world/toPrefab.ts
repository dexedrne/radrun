// CityModel (+ skyline) -> r3g 0.0.113 prefab JSON (city.json). Every building, cap, prop, skyline box,
// ground and water slab is a UNIT box scaled by its Transform, so they all share one geometry signature
// (box:[1,1,1]) and batch into a handful of instanced draws (one per material). Solids carry Data {kind}
// tags so `npm run level` can read an edited city.json back into the sim model (fromPrefab.ts).
// Round 9: no balloon group; solid rooftop props (kind "prop"); two tower glasses and crane-mast yellow.
import type { GameObject, Prefab, PrefabMaterial } from "react-three-game";
import type { CityConfig, CityModel, Solid } from "./cityModel.ts";
import type { DecoBox } from "./generate.ts";
import { STAND_NODE } from "./generate.ts";
import { propHost } from "./derive.ts";

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
  towerB: { name: "tower dark glass", color: "#6f86ad", roughness: 0.6, metalness: 0, ...tex("/textures/facade_glass.png", FACADE_TILE) },
  mast: { name: "crane mast", color: "#e3a82b", roughness: 0.8, metalness: 0 },
  propMetal: { name: "rooftop plant", color: "#a7b0ba", roughness: 0.75, metalness: 0 },
  propHut: { name: "bulkhead", color: "#cbbca6", roughness: 0.95, metalness: 0 },
  propCrate: { name: "crate", color: "#b98a57", roughness: 0.95, metalness: 0 },
  propContainer: { name: "container", color: "#b8573d", roughness: 0.85, metalness: 0 },
  propContainerB: { name: "container blue", color: "#3f73a8", roughness: 0.85, metalness: 0 },
  stand: { name: "balloon stand", color: "#e86a92", roughness: 0.9, metalness: 0 },
  skyline: { name: "skyline", materialType: "basic", color: "#b3c3dc", ...tex("/textures/facade_grid.png", [0.03125, 0.020833]) },
  ground: { name: "streets", color: "#c4c6d0", roughness: 1, metalness: 0, ...tex("/textures/street.png", [0.0238095, 0.0238095]) },
  water: { name: "water", materialType: "basic", color: "#4f9dbf", ...tex("/textures/water.png", [0.0625, 0.0625]) },
};

/** The materials table for a district: the street texture spans exactly one block pitch (its block /
 *  street split is ~2:1 like every district's lattice), so the kerbs line up with the buildings. */
export function cityMaterials(config: CityConfig): Record<string, PrefabMaterial> {
  const pitch = config.block + config.street;
  const r = Math.round((1 / pitch) * 1e7) / 1e7;
  return { ...CITY_MATERIALS, ground: { ...CITY_MATERIALS.ground, repeatCount: [r, r] } };
}

function mix(id: number): number {
  let x = Math.imul(id + 0x9e37, 0x27d4eb2d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return x >>> 0;
}

/** Five facade looks, spread by a small hash of the solid id. */
export const FACADES = ["facadeA", "facadeB", "facadeC", "facadeD", "facadeE"];
export function facadeFor(id: number): string {
  return FACADES[mix(id) % FACADES.length];
}

/** Tower look: crane masts (<= 5 m footprints) in yellow, the rest in one of two glasses. */
export function towerMaterial(s: Solid): string {
  if (s.x1 - s.x0 <= 5 && s.z1 - s.z0 <= 5) return "mast";
  return mix(s.id + 7) % 3 === 0 ? "towerB" : "tower";
}

/** Prop look from its shape: the stand counter, containers / crates (Docks), bulkheads / plant (city). */
export function propMaterial(s: Solid, solids: Solid[], docks: boolean): string {
  if (s.node === STAND_NODE) return "stand";
  const host = propHost(solids, s);
  const climb = host ? s.top - host.top > 1.8 : false;
  const long = Math.max(s.x1 - s.x0, s.z1 - s.z0);
  if (docks) return climb && long >= 2.9 ? (mix(s.id) % 2 ? "propContainerB" : "propContainer") : "propCrate";
  return climb && long >= 2 ? "propHut" : "propMetal";
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

/** A roof or tower as a unit box plus a roof-cap child (local coordinates, so it follows edits). */
export function solidNode(s: Solid, nodeId: string): GameObject {
  const w = s.x1 - s.x0, d = s.z1 - s.z0, h = s.top;
  const facade = s.kind === "tower" ? towerMaterial(s) : facadeFor(s.id);
  const cap = boxNode(
    `${nodeId}-cap`,
    [0, 0.5 - (CAP_T / 2 - 0.02) / h, 0],
    [1 + 0.3 / w, CAP_T / h, 1 + 0.3 / d],
    "roofCap",
    { kind: "trim" },
  );
  return boxNode(nodeId, [r3((s.x0 + s.x1) / 2), r3(h / 2), r3((s.z0 + s.z1) / 2)], [r3(w), r3(h), r3(d)], facade, { kind: s.kind }, [cap]);
}

/** A rooftop prop: a plain ground-rooted unit box (what you see is what you hit). */
export function propNode(s: Solid, nodeId: string, materialId: string): GameObject {
  const w = s.x1 - s.x0, d = s.z1 - s.z0, h = s.top;
  return boxNode(nodeId, [r3((s.x0 + s.x1) / 2), r3(h / 2), r3((s.z0 + s.z1) / 2)], [r3(w), r3(h), r3(d)], materialId, { kind: "prop" });
}

export function toPrefab(model: CityModel, skyline: DecoBox[]): Prefab {
  const b = model.bounds;
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const docks = model.config.propSet === "docks";
  const buildings = model.solids.filter(s => s.kind === "roof").map(s => solidNode(s, `b-${s.id}`));
  const towers = model.solids.filter(s => s.kind === "tower").map(s => solidNode(s, `t-${s.id}`));
  const props = model.solids.filter(s => s.kind === "prop")
    .map(s => propNode(s, s.node === STAND_NODE ? STAND_NODE : `p-${s.id}`, propMaterial(s, model.solids, docks)));
  const sky = skyline.map((k, i) => boxNode(`sky-${i}`, [k.x, k.h / 2, k.z], [k.w, k.h, k.d], "skyline", { kind: "skyline" }));
  const config: CityConfig = model.config;
  return {
    id: "city",
    name: "Rug Run city",
    materials: cityMaterials(config),
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
        group("props", props),
        group("skyline", sky),
      ],
    },
  };
}
