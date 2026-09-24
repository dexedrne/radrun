// Page boot: fetch the sim model + tuning, build the (single) Sandbox game outside React.
import { Sandbox } from "../game/sandbox.ts";
import { applyTuningJson, type TuningJson } from "../sim/tuning.ts";
import type { CityModel } from "../world/cityModel.ts";


let game: Sandbox | null = null;
let booting: Promise<Sandbox> | null = null;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(`${url}?v=${Date.now()}`);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export function bootGame(): Promise<Sandbox> {
  if (game) return Promise.resolve(game);
  booting ??= (async () => {
    const [model, tuningJson] = await Promise.all([
      getJson<CityModel>("/levels/city.model.json"),
      getJson<TuningJson>("/levels/tuning.json"),
    ]);
    if (!model) throw new Error("levels/city.model.json missing: run npm run gen-city");
    const { player, camera } = applyTuningJson(tuningJson, m => console.info(m));
    game = new Sandbox(model, player, camera);
    return game;
  })();
  return booting;
}

export const getGame = (): Sandbox | null => game;
