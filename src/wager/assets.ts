// SPIDER-TAG wager client: the sim this page runs, per district (docs/WAGER.md §5.2). The page's own district comes
// from the booted game; another district's city model is fetched for its hash (offers there) or for a replay (the
// verify page). The tuning and the tag table are the page's (tuning.json is shared by every district).
import { TAG, type TagTable } from "../game/tagMatch.ts";
import { NET_VERSION, type Compat } from "../net/wire.ts";
import { BUILD_ID } from "../net/build.ts";
import { LINK_VERSION } from "../ui/prefs.ts";
import type { Tuning } from "../sim/tuning.ts";
import type { CityModel } from "../world/cityModel.ts";
import { isDistrictId, levelUrl } from "../world/districts.ts";
import { simCompat, tuningHash, type SimAssets } from "./replay.ts";
import type { SimCompat } from "./eip712.ts";

const models = new Map<string, Promise<CityModel>>();

/** A district's city model (cached). */
export function districtModel(district: string, own?: { district: string; model: CityModel }): Promise<CityModel> {
  if (own && own.district === district) return Promise.resolve(own.model);
  if (!isDistrictId(district)) return Promise.reject(new Error(`unknown district ${district}`));
  let p = models.get(district);
  if (!p) {
    p = fetch(levelUrl(district, "city.model.json")).then(r => {
      if (!r.ok) throw new Error(`couldn't load the ${district} city (${r.status})`);
      return r.json() as Promise<CityModel>;
    });
    p.catch(() => models.delete(district));
    models.set(district, p);
  }
  return p;
}

/** The replay / referee inputs for a district with this page's tuning and tag table. */
export async function simAssets(district: string, tuning: Tuning, own?: { district: string; model: CityModel }): Promise<SimAssets> {
  return { model: await districtModel(district, own), tuning, tag: { ...TAG } as Partial<TagTable> };
}

/** This page's sim for a district (compare with the relay's RelayConfig.sims[district]). */
export async function mySim(district: string, tuning: Tuning, own?: { district: string; model: CityModel }): Promise<SimCompat> {
  return simCompat(await simAssets(district, tuning, own));
}

export const sameSim = (a: SimCompat | undefined, b: SimCompat | undefined): boolean =>
  !!a && !!b && a.v === b.v && a.selftest >>> 0 === b.selftest >>> 0 && a.tuning === b.tuning && a.city === b.city;

/** The room's `hello.compat` (the online Compat: the relay compares its v, city and tuning with the referee's sim). */
export const roomCompat = (model: CityModel, tuning: Tuning): Compat =>
  ({ v: NET_VERSION, build: BUILD_ID, link: LINK_VERSION, city: model.hash, tuning: tuningHash(tuning, { ...TAG }) });
