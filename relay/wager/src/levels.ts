// The level files bundled into the wager Worker: tuning.json and the city model of every district the relay can
// referee (docs/WAGER.md §4.1). Each model is its own lazy import, parsed the first time a series in it needs it.
import type { CityModel } from "../../../src/world/cityModel.ts";
import type { LevelFiles } from "./sims.ts";
import tuning from "../../../public/levels/tuning.json" with { type: "json" };

const MODELS: Record<string, () => Promise<{ default: unknown }>> = {
  downtown: () => import("../../../public/levels/city.model.json", { with: { type: "json" } }),
  market: () => import("../../../public/levels/market/city.model.json", { with: { type: "json" } }),
  docks: () => import("../../../public/levels/docks/city.model.json", { with: { type: "json" } }),
  towers: () => import("../../../public/levels/towers/city.model.json", { with: { type: "json" } }),
  vertigo: () => import("../../../public/levels/vertigo/city.model.json", { with: { type: "json" } }),
};

export const bundledLevels: LevelFiles = {
  tuning: async () => tuning,
  model: async (d: string) => {
    const load = MODELS[d];
    if (!load) throw new Error(`no city model for ${d}`);
    return (await load()).default as CityModel;
  },
};
