// npm run billboards: put the painted ads (src/world/billboards.ts) on every district's existing
// decor.json without regenerating it (hand edits elsewhere are kept): adds the eight ad materials and
// turns each billboard-<i>-face into an ad board (DISTRICT_ADS order). Boards that already show an ad
// keep theirs, so re-running is safe after picking other ads in ?editor=decor.
import fs from "node:fs";
import path from "node:path";
import type { GameObject, Prefab } from "react-three-game";
import { DISTRICTS, DISTRICT_IDS } from "../src/world/districts.ts";
import { adFace, adMaterials, DISTRICT_ADS } from "../src/world/billboards.ts";

const PUBLIC = path.resolve(import.meta.dirname, "..", "public");

for (const id of DISTRICT_IDS) {
  const file = path.join(PUBLIC, DISTRICTS[id].dir, "decor.json");
  const decor = JSON.parse(fs.readFileSync(file, "utf8")) as Prefab;
  decor.materials = { ...decor.materials, ...adMaterials() };
  let changed = 0;
  const walk = (n: GameObject): GameObject => {
    const m = /^billboard-(\d+)-face$/.exec(n.id);
    if (m && n.components?.sign) {
      const ads = DISTRICT_ADS[id];
      changed++;
      return adFace(n.id, ads[Number(m[1]) % ads.length]);
    }
    return n.children ? { ...n, children: n.children.map(walk) } : n;
  };
  decor.root = walk(decor.root);
  fs.writeFileSync(file, JSON.stringify(decor, null, 1) + "\n");
  console.log(`${id}: ${changed} billboard(s) -> ads, ${Object.keys(decor.materials).length} materials`);
}
