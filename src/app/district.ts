// The page's district (round 4): read once from ?map=<id> (or a ghost link's m=<id>). Switching
// district is a navigation, so everything that loads level files or picks a look reads this constant.
import { DISTRICTS, districtFromSearch, levelUrl, type District, type DistrictId } from "../world/districts.ts";

export const PAGE_DISTRICT: DistrictId = typeof location !== "undefined" ? districtFromSearch(location.search) : "downtown";
export const PAGE: District = DISTRICTS[PAGE_DISTRICT];

/** URL of one of this page's level files (city.json, decor.json, city.model.json, runner.pack.bin, ...). */
export const lv = (file: string): string => levelUrl(PAGE_DISTRICT, file);

/**
 * The URL the game fetches a level file at. Under `npm run dev` it gets a cache-buster (the editor's save rewrites
 * the files under the page). A build fetches the plain URL: the host revalidates it on every load (Vercel's default
 * must-revalidate), so it is never stale, a return visit gets a 304 instead of the whole file again (the runner
 * pack, the sim model), and it is the URL the city / decor PrefabRefs fetch too, so a second fetch of decor.json is
 * answered by the browser cache.
 */
export const levelFetchUrl = (url: string): string =>
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true ? `${url}?v=${Date.now()}` : url;

/** Navigate to another district (a full page load; keeps only the listed search params). */
export function gotoDistrict(id: DistrictId, keep: Record<string, string> = {}): void {
  const u = new URL(location.href);
  const q = new URLSearchParams();
  if (id !== "downtown") q.set("map", id);
  for (const [k, v] of Object.entries(keep)) q.set(k, v);
  const cur = new URLSearchParams(location.search);
  for (const k of ["tune", "webgl2", "autoq"]) if (cur.has(k)) q.set(k, cur.get(k) ?? "");
  u.search = q.toString() ? `?${q}` : "";
  u.hash = "";
  location.assign(u.toString());
}
