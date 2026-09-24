// The page's district (round 4): read once from ?map=<id> (or a ghost link's m=<id>). Switching
// district is a navigation, so everything that loads level files or picks a look reads this constant.
import { DISTRICTS, districtFromSearch, levelUrl, type District, type DistrictId } from "../world/districts.ts";

export const PAGE_DISTRICT: DistrictId = typeof location !== "undefined" ? districtFromSearch(location.search) : "downtown";
export const PAGE: District = DISTRICTS[PAGE_DISTRICT];

/** URL of one of this page's level files (city.json, decor.json, city.model.json, runner.pack.bin, ...). */
export const lv = (file: string): string => levelUrl(PAGE_DISTRICT, file);

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
