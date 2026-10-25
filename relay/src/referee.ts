// Casual matches use the SAME deterministic movement, anchor, respawn and tag rules as clients.
import { TagMatch, TAG } from '../../src/game/tagMatch.ts';
import { applyTuningJson, type TuningJson } from '../../src/sim/tuning.ts';
import { CityIndex, type CityModel } from '../../src/world/cityModel.ts';
import type { RadbroId } from '../../src/game/radbros.ts';
import type { StartMsg } from '../../src/net/wire.ts';
import { bundledLevels } from '../wager/src/levels.ts';

export type RefereeFactory = (start: StartMsg) => TagMatch;
const cache = new Map<string, Promise<RefereeFactory>>();
export function loadReferee(district: string): Promise<RefereeFactory> {
  let pending = cache.get(district);
  if (!pending) { pending = buildReferee(district); cache.set(district, pending); pending.catch(() => cache.delete(district)); }
  return pending;
}
async function buildReferee(district: string): Promise<RefereeFactory> {
  const [model, json] = await Promise.all([bundledLevels.model(district), bundledLevels.tuning()]);
  const tuning = applyTuningJson(json as TuningJson).player;
  const tag = { ...TAG, ...(json as { tag?: Partial<typeof TAG> }).tag };
  const index = new CityIndex(model as CityModel);
  return s => new TagMatch({ model, index, tuning, tag, slots: s.slots.map(p => ({ ...p, radbro: p.radbro as RadbroId })), seed: s.seed, seconds: s.config.seconds });
}
