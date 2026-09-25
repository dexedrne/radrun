// Test helpers: the prototype fixture level as a 3D CityModel, and round 9's synthetic tall cities (a
// canyon avenue under towers, a wall-gap notch, a roof with props) built with main's deriveModel, so the
// movement tests never depend on the world builder's districts.
import { CityIndex, type CityModel, type Solid } from "../src/world/cityModel.ts";
import { deriveModel } from "../src/world/derive.ts";
import { DEFAULT_CONFIG } from "../src/world/generate.ts";
import { mulberry32 } from "../src/sim/math.ts";
import type { SimWorld } from "../src/sim/player.ts";
import { LEVEL } from "./fixtures/proto/level.ts";

/** The 2D prototype level extruded to 3D: roofs are 10 m deep boxes centred on z = 0. */
export function protoModel(): CityModel {
  const solids: Solid[] = LEVEL.roofs.map((r, i) => ({
    id: i, kind: "roof", landable: true, x0: r.x0, z0: -5, x1: r.x1, z1: 5, top: r.top,
  }));
  return {
    version: 1,
    config: null as unknown as CityModel["config"],
    bounds: { x0: -30, z0: -5, x1: 150, z1: 5 },
    lowestRoof: Math.min(...LEVEL.roofs.map(r => r.top)),
    solids,
    hooks: [],
    adjacency: [],
    junctionCandidates: [],
    spawn: { roofId: 0, x: 0, y: LEVEL.roofs[0].top + 0.9, z: 0, yaw: 0 },
    hash: "proto",
  };
}

export function protoWorld(): SimWorld {
  const model = protoModel();
  return { index: new CityIndex(model), runner: null };
}

const roof = (x0: number, z0: number, x1: number, z1: number, top: number): Omit<Solid, "id"> => ({ kind: "roof", landable: true, x0, z0, x1, z1, top });
const tower = (x0: number, z0: number, x1: number, z1: number, top: number): Omit<Solid, "id"> => ({ kind: "tower", landable: false, x0, z0, x1, z1, top });

/** Ids of the hand-placed solids in tallModel() (deriveModel keeps the input order). */
export const TALL = {
  /** South row (z 0..18): ~50 m roofs alternating with 76-80 m towers along the avenue (alleys 4 m). */
  south: [0, 1, 2, 3, 4, 5],
  /** North row (z 40..58): towers 80-90 m alternating with 60-64 m roofs. */
  north: [6, 7, 8, 9, 10, 11],
  /** The avenue runs along +x between z = 18 and z = 40 (22 m). */
  streetZ0: 18,
  streetZ1: 40,
  /** Wall-gap notch: roofs a (x 140..155) and b (x 164..180) flush against wall w's +z face (z = 12). */
  gapWall: 12,
  gapA: 13,
  gapB: 14,
  /** Props roof (top 40, x 200..230, z 0..30): a 1.2 m vault prop and a 2.8 m climb prop. */
  propRoof: 15,
  vaultProp: 16,
  climbProp: 17,
} as const;

/**
 * Round 9 synthetic tall city (spec §9.5): a 22 m canyon between ~50 m roofs and 80-90 m towers, a wall-gap
 * notch and a roof with a vault prop and a climb prop. No balloons.
 */
export function tallModel(): CityModel {
  const xs = [[0, 18], [22, 40], [44, 62], [66, 84], [88, 106], [110, 128]];
  const south: [boolean, number][] = [[false, 50], [true, 76], [false, 51], [true, 80], [false, 50], [true, 78]];
  const north: [boolean, number][] = [[true, 80], [false, 62], [true, 90], [false, 64], [true, 85], [false, 60]];
  const input: Omit<Solid, "id">[] = [];
  xs.forEach(([a, b], i) => input.push(south[i][0] ? tower(a, 0, b, 18, south[i][1]) : roof(a, 0, b, 18, south[i][1])));
  xs.forEach(([a, b], i) => input.push(north[i][0] ? tower(a, 40, b, 58, north[i][1]) : roof(a, 40, b, 58, north[i][1])));
  input.push(tower(140, 0, 180, 12, 60)); // 12: the wall
  input.push(roof(140, 12, 155, 26, 50)); // 13: a
  input.push(roof(164, 12, 180, 26, 50)); // 14: b
  input.push(roof(200, 0, 230, 30, 40)); // 15: props roof
  input.push(roof(210, 8, 211.5, 22, 41.2)); // 16: vault prop (1.2 m)
  input.push(roof(218, 8, 221, 22, 42.8)); // 17: climb prop (2.8 m)
  return deriveModel({ ...DEFAULT_CONFIG, autoHooks: false }, input as Solid[]);
}

export function tallWorld(model = tallModel()): SimWorld {
  return { index: new CityIndex(model), runner: null };
}

/**
 * A synthetic block city meeting the world builder's G1-G2 rules (spec §4.3): n x n blocks of 2 x 2 buildings
 * (12 m, alleys 4 m, streets 18 m); in every block one building is an 85-110 m tower, the others 44-47 m
 * roofs (alley steps <= 1.2 m hops or 1.2-3.5 m climbs), so every street edge has an anchor well above it.
 */
export function tallBlocks(seed = 7, n = 4): CityModel {
  const rand = mulberry32(seed);
  const input: Omit<Solid, "id">[] = [];
  const B = 12, A = 4, S = 18, pitch = 2 * B + A + S;
  for (let bz = 0; bz < n; bz++) for (let bx = 0; bx < n; bx++) {
    const t = Math.floor(rand() * 4);
    const base = 44 + Math.floor(rand() * 3);
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const x0 = bx * pitch + i * (B + A), z0 = bz * pitch + j * (B + A);
      if (i + 2 * j === t) input.push(tower(x0, z0, x0 + B, z0 + B, 85 + Math.floor(rand() * 26)));
      else input.push(roof(x0, z0, x0 + B, z0 + B, base + [0, 0, 1, 2.5][Math.floor(rand() * 4)]));
    }
  }
  return deriveModel({ ...DEFAULT_CONFIG, seed, street: S, alley: A, building: B, autoHooks: false }, input as Solid[]);
}
