// Round 4 districts (docs/specs/2026-09-24-round4-depth.md §1): one registry for the generator
// configs, where each district's level files live, and its look. Downtown keeps the original files in
// public/levels/ (old links and tests); the others live in public/levels/<id>/. One district per page:
// switching district is a navigation (?map=<id>), so the PlayGame / canvas invariants stay untouched.
import type { CityConfig } from "./cityModel.ts";
import { DEFAULT_CONFIG } from "./generate.ts";
import type { Difficulty, DifficultyParams } from "../sim/tuning.ts";

export type DistrictId = "downtown" | "market" | "docks" | "towers" | "vertigo";
export const DISTRICT_IDS: readonly DistrictId[] = ["downtown", "market", "docks", "towers", "vertigo"];

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

/**
 * Per-district chase tweak (round 6 balance): the same runner AI and difficulty table everywhere, with
 * these nudges so every district lands in the same swinger bands as Downtown (tools/balance --all).
 * Missing = the classic round (Downtown).
 */
export type ChaseTweak = {
  /** Player spawn distance behind him: spawnMin + spawnSpan x rng (m; classic 22 + 4). */
  spawnMin?: number;
  spawnSpan?: number;
  /** A non-adjacent spawn roof must get this much closer to the ideal point to win (m; classic 3). */
  spawnOther?: number;
  /** Added to the difficulty table's runner parameters, per difficulty. */
  add?: Partial<Record<Difficulty, Partial<DifficultyParams>>>;
  /**
   * Round 7 descending chase: he starts on one of his `startHigh` highest junctions (same rng draw), and
   * his branch choice favours edges that end lower (`down` x the drop / 20 m, clamped to +-1).
   */
  startHigh?: number;
  down?: number;
  /** Round 7: a spawn roof more than 3 m below his start roof counts this many m further per m below. */
  spawnBelow?: number;
};

export type District = {
  id: DistrictId;
  name: string;
  blurb: string;
  /** Level file directory under public/ ("levels/" for Downtown, "levels/<id>/" otherwise). */
  dir: string;
  /** Sky panorama under public/ (round 4 art; the gradient shows until it loads). */
  sky: string;
  config: CityConfig;
  look: DistrictLook;
  chase?: ChaseTweak;
};

// Round 9 (docs/specs/2026-09-25-round9-movement.md §4.2): 40-230 m canyon districts, no balloons. Web
// anchors are the buildings themselves, so the configs set heights, towers, anchor coverage (G1), wall gaps
// (G4) and solid rooftop props (G3). Fog reaches >= 700 m so the canyons read; the skyline ring stands at
// 420-650 m.
const DOWNTOWN_LOOK: DistrictLook = {
  skyHorizon: "#d3dcea", skyMid: "#98bde6", skyZenith: "#4c83d0", fog: "#d3dcea", fogNear: 220, fogFar: 760,
  sun: "#fff4e0", sunIntensity: 1.5, hemiSky: "#e3eeff", hemiGround: "#6b5d7a", hemiIntensity: 1.25,
};

export const DISTRICTS: Readonly<Record<DistrictId, District>> = {
  downtown: {
    id: "downtown",
    name: "Downtown",
    blurb: "Canyons of glass and brick. Swing the avenues.",
    dir: "levels/",
    sky: "sky/downtown.webp",
    config: DEFAULT_CONFIG,
    look: DOWNTOWN_LOOK,
    // Round 10: the cleaner swing (swing heading, open-air pivots, the fall cone) caught him too early: a faster
    // runner (Normal 1.2x sprinting to 1.7x, Degen 1.3x) and a 4 m Degen Yoink (npm run balance -- --only swing).
    // Round 11 (the table's 3 s Degen head start, the bot that drops back down to him): Degen 1.4x with a 3.5 m Yoink.
    chase: { add: { normal: { base: 0.2, mMax: 0.2, airMax: 0.2 }, degen: { base: 0.3, yoinkRange: -1 } } },
  },
  market: {
    id: "market",
    name: "Night Market",
    blurb: "Low, dense rooftops. Vault, climb, wall-kick. Few places to web.",
    dir: "levels/market/",
    sky: "sky/market.webp",
    // The parkour district: dense low podiums whose steps favour climbs, six 55-90 m towers to swing near
    // and bare stretches between them (G1 is a warning here). Lots are 12 m (not 11) so a wall-gap block
    // (two 10 m roofs + an 8 m notch) still keeps every roof >= 10 x 10 m (G2).
    config: {
      ...DEFAULT_CONFIG, seed: 311, blocksX: 8, blocksZ: 6, block: 28, street: 12, alley: 4, building: 12,
      mergeChance: 0.12, roofMin: 18, roofMax: 32, steps: [0, 0, 1, -1, 2.5, 2.5, 3.5, 3.5, -7],
      towers: 6, towerMin: 55, towerMax: 90, towerSpread: 55, coverFix: false, coverWarn: true,
      wallGapChance: 0.3, props: 2.5, propClimb: 0.4, minRoof: 10, skylineCount: 60,
    },
    // Round 6: the dense blocks squeezed the spawn, and his twisty runs let a swinger cut corners: a longer
    // head start, and he sprints earlier and harder here. Round 9 (the zipping swing bot, npm run balance --
    // --map market): a little faster on Normal; the Degen / Chill deltas keep round 6's runner against the
    // round 9 table (degen base 1.1, Yoink 4.5; chill mMax 1.25). Round 11 (his swing routes, the bot that drops
    // back down to him): Normal 1.3x (the bot caught him in ~20 s at 1.15x).
    chase: {
      spawnMin: 26, spawnOther: 0,
      add: {
        chill: { gStar: 20, base: 0.1, mMax: 0.35, airMax: 0.35 },
        normal: { gStar: 20, base: 0.3, mMax: 0.5, airMax: 0.5 },
        degen: { gStar: 20, base: 0.2, mMax: 0.5, airMax: 0.5, yoinkRange: -1, panicBudget: 10 },
      },
    },
    look: {
      skyHorizon: "#6e3a66", skyMid: "#3a2560", skyZenith: "#140f33", fog: "#4a2e57", fogNear: 160, fogFar: 700,
      sun: "#ffb4d9", sunIntensity: 0.9, hemiSky: "#b9a4ff", hemiGround: "#2a1a33", hemiIntensity: 1.05,
    },
  },
  docks: {
    id: "docks",
    name: "The Docks",
    blurb: "Low sheds under crane masts. Long pendulums over the quay. Mind the wind.",
    dir: "levels/docks/",
    sky: "sky/docks.webp",
    // Low sheds (12-22 m), six crane masts in the quay-side intersections, three 70-100 m offices, container
    // stacks (climb) and crates (vault) on the roofs.
    config: {
      ...DEFAULT_CONFIG, seed: 902, blocksX: 7, blocksZ: 3, block: 34, street: 18, alley: 4, building: 15,
      mergeChance: 0.35, roofMin: 12, roofMax: 22, steps: [0, 0, 0, 1, -1, 2.5, 3.5, -7],
      towers: 3, towerMin: 70, towerMax: 100, towerSpread: 90, masts: { count: 6, size: 4, min: 55, max: 80 }, coverTower: [25, 40],
      wallGapChance: 0, props: 1.5, propClimb: 0.45, propSet: "docks", skylineCount: 44,
    },
    // Round 6: a longer head start (the wide blocks squeezed the spawn to ~24 m), a faster sprint and a
    // 3 m Degen Yoink. Round 9: Degen runs faster (1.3x) and gasses out after 5 s of sprint; the zipping
    // swing bot still catches him early here (median ~35 s, under the 40 s band; a longer head start only
    // made it earlier). Round 10 (his routes swing instead of zipping): Normal 0.9x sprinting to 1.7x; Degen
    // 1.4x with the table's 4.5 m Yoink and a 15 s panic budget. Round 11 (the bot that drops back down to him):
    // Degen 1.6x (it caught him in ~31 s at 1.4x).
    chase: {
      spawnMin: 26, spawnOther: 0,
      add: {
        chill: { base: -0.05, yoinkRange: 0.5 },
        normal: { gStar: 20, base: -0.1, mMax: 0.2, airMax: 0.2 },
        degen: { base: 0.5, mMax: 0.4, airMax: 0.4, panicBudget: -5 },
      },
    },
    look: {
      skyHorizon: "#f1d9bd", skyMid: "#a9c6de", skyZenith: "#5f8fbf", fog: "#dfd8cf", fogNear: 220, fogFar: 760,
      sun: "#ffe2b8", sunIntensity: 1.6, hemiSky: "#dbe9f7", hemiGround: "#4c5a66", hemiIntensity: 1.2,
    },
  },
  towers: {
    id: "towers",
    name: "The Towers",
    blurb: "The deepest canyons in town. Long ropes, big swings.",
    dir: "levels/towers/",
    sky: "sky/towers.webp",
    // The Financial District, the Manhattan showcase: 70-120 m podiums on 24 m avenues and twelve 160-230 m
    // towers (+ coverage).
    config: {
      ...DEFAULT_CONFIG, seed: 1453, blocksX: 7, blocksZ: 6, block: 44, street: 24, alley: 5, building: 19.5,
      roofMin: 70, roofMax: 120, towers: 12, towerMin: 160, towerMax: 230, towerSpread: 70,
      wallGapChance: 0.25, skylineCount: 64,
    },
    // Round 9 (the zipping swing bot on the 66-124 m canyons, npm run balance -- --map towers): a slower
    // runner than Downtown's (Degen 0.9x with a 5 m Yoink and a 10 s panic budget, so he gasses out and the
    // long chases end in a catch). Round 10 (the cleaner swing, his swing-first routes): Normal 0.85x,
    // sprinting to 1.6x, the classic 5 m Yoink; Degen 1.15x with the table's 4.5 m Yoink. Round 11 (the bot that
    // drops back down to him): Degen 1.25x (caught in ~38 s at 1.15x).
    chase: {
      add: {
        chill: { base: -0.1, mMax: -0.15, airMax: -0.15, yoinkRange: 0.5 },
        normal: { base: -0.15, mMax: 0.1, airMax: 0.1 },
        degen: { base: 0.15, gStar: 10, mMax: 0.25, airMax: 0.25, panicBudget: -10 },
      },
    },
    look: {
      skyHorizon: "#f6c9a8", skyMid: "#b7b6dc", skyZenith: "#3f5fa8", fog: "#e2cfc6", fogNear: 280, fogFar: 900,
      sun: "#ffd6a8", sunIntensity: 1.55, hemiSky: "#d7e2ff", hemiGround: "#5b4f6b", hemiIntensity: 1.2,
    },
  },
  vertigo: {
    id: "vertigo",
    name: "Vertigo",
    blurb: "A skyline of spiral ramps, 20 to 90 m up. He starts at the top: drop, dive, web the needles on the way down.",
    dir: "levels/vertigo/",
    sky: "sky/vertigo.webp",
    // Round 7: helix rings of roofs (world/generate.ts generateVertigo). Round 9: five 150-220 m needles in
    // the core; the anchors are the higher rings' cliff faces and the needles (G1 is a warning here).
    config: {
      ...DEFAULT_CONFIG, seed: 20, blocksX: 6, blocksZ: 5, block: 28, street: 14, alley: 4, building: 12,
      mergeChance: 0, roofMin: 22, roofMax: 90, towers: 0, towerMin: 150, towerMax: 220,
      coverFix: false, coverWarn: true, wallGapChance: 0, props: 1, propClimb: 0.3, skylineCount: 50,
      vertigo: {
        rings: [[22, 86], [26, 78], [30, 66], [34, 58]], streetStep: 2.6, alleyStep: 0.5,
        needles: 5, needleMin: 150, needleMax: 220, needleSize: 7, plazas: 1, mesa: [84, 90],
      },
    },
    // Descending chase: he starts on one of his 3 highest junctions and prefers edges that end lower; you
    // spawn at about his height, away from his first edge (game/round.ts playerSpawn). Round 7 made him
    // slower here (the classic swinger got lost under the cliffs); round 9's swing bot zips back up to him,
    // so Normal is faster again (1.15x) and Degen a little faster than round 7's (npm run balance -- --map
    // vertigo --only swing). He still waits for a lost chaser (mMin) and has a 4 m Normal Yoink. Round 10 (the
    // cleaner swing): Normal 1.25x; Chill no longer caught in the first seconds (1.1x, sprints from 40 m,
    // wanders less); Degen 1.15x with a 2.5 m Yoink and a longer panic budget.
    chase: {
      startHigh: 3, down: 0.6, spawnBelow: 5, spawnMin: 24,
      add: {
        chill: { base: 0.2, gStar: 20, sigma: -0.4 },
        normal: { base: 0.25, mMax: -0.3, airMax: -0.3, panicBudget: -10, yoinkRange: -1 },
        degen: { base: 0.05, mMin: -0.4, gStar: 15, mMax: -0.3, airMax: -0.3, panicBudget: 15, yoinkRange: -2 },
      },
    },
    look: {
      skyHorizon: "#e3eee9", skyMid: "#8cc8dc", skyZenith: "#27589a", fog: "#dbe8e6", fogNear: 260, fogFar: 820,
      sun: "#fff6e6", sunIntensity: 1.6, hemiSky: "#e6f4ff", hemiGround: "#56607a", hemiIntensity: 1.25,
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
