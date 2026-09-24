// Round 4 districts (docs/specs/2026-09-24-round4-depth.md §1): one registry for the generator
// configs, where each district's level files live, and its look. Downtown keeps the original files in
// public/levels/ (old links and tests); the others live in public/levels/<id>/. One district per page:
// switching district is a navigation (?map=<id>), so the PlayGame / canvas invariants stay untouched.
import type { CityConfig } from "./cityModel.ts";
import { DEFAULT_CONFIG } from "./generate.ts";

export type DistrictId = "downtown" | "market" | "docks" | "towers";
export const DISTRICT_IDS: readonly DistrictId[] = ["downtown", "market", "docks", "towers"];

/** Sky / fog / light colours (the "night" mutator darkens whatever the district uses). */
export type DistrictLook = {
  skyHorizon: string;
  skyMid: string;
  skyZenith: string;
  fog: string;
  fogNear: number;
  fogFar: number;
  sun: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
};

export type District = {
  id: DistrictId;
  name: string;
  blurb: string;
  /** Level file directory under public/ ("levels/" for Downtown, "levels/<id>/" otherwise). */
  dir: string;
  config: CityConfig;
  look: DistrictLook;
};

const DOWNTOWN_LOOK: DistrictLook = {
  skyHorizon: "#d3dcea", skyMid: "#98bde6", skyZenith: "#4c83d0", fog: "#d3dcea", fogNear: 120, fogFar: 380,
  sun: "#fff4e0", sunIntensity: 1.5, hemiSky: "#e3eeff", hemiGround: "#6b5d7a", hemiIntensity: 1.25,
};

export const DISTRICTS: Readonly<Record<DistrictId, District>> = {
  downtown: {
    id: "downtown",
    name: "Downtown",
    blurb: "The original skyline. Wide streets, balloons everywhere.",
    dir: "levels/",
    config: DEFAULT_CONFIG,
    look: DOWNTOWN_LOOK,
  },
  market: {
    id: "market",
    name: "Night Market",
    blurb: "Dense, narrow and twisty. Short hops, lots of junctions, some streets with no balloons.",
    dir: "levels/market/",
    config: {
      ...DEFAULT_CONFIG, seed: 311, blocksX: 8, blocksZ: 6, block: 23, street: 10, alley: 3, building: 10,
      mergeChance: 0.12, roofMin: 18, roofMax: 26, streetMaxDh: 3, towers: 4, towerMin: 42, towerMax: 58,
      hookAbove: 9.5, hookGapChance: 0.18, skylineCount: 46,
    },
    look: {
      skyHorizon: "#6e3a66", skyMid: "#3a2560", skyZenith: "#140f33", fog: "#4a2e57", fogNear: 70, fogFar: 300,
      sun: "#ffb4d9", sunIntensity: 0.9, hemiSky: "#b9a4ff", hemiGround: "#2a1a33", hemiIntensity: 1.05,
    },
  },
  docks: {
    id: "docks",
    name: "The Docks",
    blurb: "Low warehouses, wide streets and long flights over the water. Mind the wind.",
    dir: "levels/docks/",
    config: {
      ...DEFAULT_CONFIG, seed: 902, blocksX: 7, blocksZ: 3, block: 32, street: 15, alley: 4, building: 14,
      mergeChance: 0.35, roofMin: 12, roofMax: 20, streetMaxDh: 3.5, towers: 3, towerMin: 36, towerMax: 48,
      hookAbove: 10, skylineCount: 30,
    },
    look: {
      skyHorizon: "#f1d9bd", skyMid: "#a9c6de", skyZenith: "#5f8fbf", fog: "#dfd8cf", fogNear: 110, fogFar: 420,
      sun: "#ffe2b8", sunIntensity: 1.6, hemiSky: "#dbe9f7", hemiGround: "#4c5a66", hemiIntensity: 1.2,
    },
  },
  towers: {
    id: "towers",
    name: "The Towers",
    blurb: "Tall, steep and vertical. Big drops between roofs and towers everywhere.",
    dir: "levels/towers/",
    config: {
      ...DEFAULT_CONFIG, seed: 1453, blocksX: 7, blocksZ: 6, roofMin: 38, roofMax: 52, streetMaxDh: 3.5,
      towers: 8, towerMin: 90, towerMax: 130, hookAbove: 10, skylineCount: 50, skylineMin: 260, skylineMax: 460,
    },
    look: {
      skyHorizon: "#f6c9a8", skyMid: "#b7b6dc", skyZenith: "#3f5fa8", fog: "#e2cfc6", fogNear: 150, fogFar: 520,
      sun: "#ffd6a8", sunIntensity: 1.55, hemiSky: "#d7e2ff", hemiGround: "#5b4f6b", hemiIntensity: 1.2,
    },
  },
};

export const isDistrictId = (v: string | null | undefined): v is DistrictId => !!v && (DISTRICT_IDS as readonly string[]).includes(v);

/** The page's district: ?map=<id>, else a ghost link's m=<id>, else Downtown. */
export function districtFromSearch(search: string): DistrictId {
  const q = new URLSearchParams(search);
  const m = q.get("map") ?? q.get("m");
  return isDistrictId(m) ? m : "downtown";
}

/** Absolute URL path of a level file for a district (e.g. levelUrl("docks", "city.json")). */
export const levelUrl = (id: DistrictId, file: string): string => `/${DISTRICTS[id].dir}${file}`;

/** The shared tuning file (one for every district). */
export const TUNING_URL = "/levels/tuning.json";
