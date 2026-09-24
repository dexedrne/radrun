// Test helpers: the prototype fixture level as a 3D CityModel, and a tiny assert-close.
import { CityIndex, type CityModel, type Solid } from "../src/world/cityModel.ts";
import type { SimWorld } from "../src/sim/player.ts";
import { LEVEL } from "./fixtures/proto/level.ts";

/** The 2D prototype level extruded to 3D: roofs are 10 m deep boxes centred on z = 0. */
export function protoModel(): CityModel {
  const solids: Solid[] = LEVEL.roofs.map((r, i) => ({
    id: i, kind: "roof", landable: true, x0: r.x0, z0: -5, x1: r.x1, z1: 5, top: r.top,
  }));
  const hooks = LEVEL.anchors.map((a, i) => ({ id: i, x: a.x, y: a.y, z: 0, src: "manual" as const }));
  return {
    version: 1,
    config: null as unknown as CityModel["config"],
    bounds: { x0: -30, z0: -5, x1: 150, z1: 5 },
    lowestRoof: Math.min(...LEVEL.roofs.map(r => r.top)),
    solids,
    hooks,
    adjacency: [],
    junctionCandidates: [],
    spawn: { roofId: 0, x: 0, y: LEVEL.roofs[0].top + 0.9, z: 0, yaw: 0 },
    hash: "proto",
  };
}

export function protoWorld(): SimWorld {
  const model = protoModel();
  return { index: new CityIndex(model), hooks: model.hooks, lowestRoof: model.lowestRoof, runner: null };
}
