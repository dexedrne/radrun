// Page boot: fetch the sim model + tuning, build the (single) Sandbox game outside React.
import { Sandbox } from "../game/sandbox.ts";
import { applyTuningJson, type TuningJson } from "../sim/tuning.ts";
import type { CityModel } from "../world/cityModel.ts";
import { PlayGame } from "../game/play.ts";
import { decodePack } from "../route/trackPack.ts";
import { applyGeorgeJson } from "./george.config.ts";


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
    const { player, camera, difficulty } = applyTuningJson(tuningJson, m => console.info(m));
    applyGeorgeJson(tuningJson?.george, m => console.info(m));
    game = new Sandbox(model, player, camera);
    game.difficulty = difficulty;
    return game;
  })();
  return booting;
}

export const getGame = (): Sandbox | null => game;

let play: Promise<PlayGame> | null = null;

/** Play page boot: city.model.json + runner.pack.bin + tuning.json -> the (single) PlayGame. */
export function bootPlay(): Promise<PlayGame> {
  play ??= (async () => {
    const [model, tuningJson, packBuf] = await Promise.all([
      getJson<CityModel>("/levels/city.model.json"),
      getJson<TuningJson>("/levels/tuning.json"),
      fetch(`/levels/runner.pack.bin?v=${Date.now()}`).then(r => (r.ok ? r.arrayBuffer() : null), () => null),
    ]);
    if (!model) throw new Error("levels/city.model.json missing: run npm run level");
    if (!packBuf) throw new Error("levels/runner.pack.bin missing: run npm run level");
    const pack = decodePack(packBuf);
    if (pack.header.city !== model.hash) console.warn(`[rug-run] runner.pack.bin was baked for city ${pack.header.city}, model is ${model.hash}: run npm run level`);
    const { player, camera, difficulty } = applyTuningJson(tuningJson, m => console.info(m));
    applyGeorgeJson(tuningJson?.george, m => console.info(m));
    return new PlayGame(model, pack, player, camera, difficulty);
  })();
  return play;
}
