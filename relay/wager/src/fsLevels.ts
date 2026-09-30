// The level files for Node (the stand-in, the tools and the tests): read from the repo's public/levels.
import fs from "node:fs";
import type { CityModel } from "../../../src/world/cityModel.ts";
import type { LevelFiles } from "./sims.ts";

const lv = (f: string) => new URL(`../../../public/levels/${f}`, import.meta.url);

export const fsLevels: LevelFiles = {
  tuning: async () => JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8")),
  model: async (d: string) => JSON.parse(fs.readFileSync(lv(d === "downtown" ? "city.model.json" : `${d}/city.model.json`), "utf8")) as CityModel,
};
