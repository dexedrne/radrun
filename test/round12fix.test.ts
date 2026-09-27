// Round 12 play-test fixes: the zip fan, floating fixtures webbed on their underside, two cables per street pair,
// the thief's cable swings, and the owner's yank / Yoink ranges in every district.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CityIndex, RIG0, type CityModel, type Solid } from "../src/world/cityModel.ts";
import { deriveModel } from "../src/world/derive.ts";
import { DEFAULT_CONFIG } from "../src/world/generate.ts";
import { emptyAnchor, findAnchor } from "../src/world/cityQuery.ts";
import { createBody, emptyZipAim, zipAim, ZIP_NONE, type SimWorld } from "../src/sim/player.ts";
import { applyTuningJson, PLAYER, ROUND, RUNNER, STRUCTURES_DEFAULT, type Tuning } from "../src/sim/tuning.ts";
import { buildLinks } from "../src/route/graph.ts";
import { DISTRICTS, DISTRICT_IDS } from "../src/world/districts.ts";
import { canyonModel } from "./helpers.ts";

const K: Tuning = { ...PLAYER };
const roof = (x0: number, z0: number, x1: number, z1: number, top: number): Omit<Solid, "id"> => ({ kind: "roof", landable: true, x0, z0, x1, z1, top });

test("zip fan: falling down the canyon looking along it, nothing on the ray - the fan finds a facade within zipFanCos", () => {
  const w: SimWorld = { index: new CityIndex(canyonModel()), runner: null };
  const b = createBody(10, 25, 29, -1);
  b.grounded = false; b.v.y = -8;
  const za = emptyZipAim();
  assert.equal(zipAim(b, null, 1, 0, 0, { ...K, zipFanCos: 1 }, w, za), ZIP_NONE, "the plain ray hits nothing within zipReach");
  const kind = zipAim(b, null, 1, 0, 0, K, w, za);
  assert.ok(kind !== ZIP_NONE, "the fan finds a target");
  // Within the fan's angle of the aim (the aim pitched up by zipLift), never open sky.
  const sl = K.zipLift, cl = Math.sqrt(1 - sl * sl);
  const dx = za.hx - b.p.x, dy = za.hy - (b.p.y + 0.3), dz = za.hz - b.p.z, l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  assert.ok((dx * cl + dy * sl) / l >= K.zipFanCos - 1e-9, `within the fan (${((dx * cl + dy * sl) / l).toFixed(3)})`);
  assert.ok(l <= K.zipReach + 1e-9);
});

test("floating fixtures are webbed on their underside, the pivot the point itself (a swing under it, not into its face)", () => {
  const m = canyonModel();
  // Only the skybridge (x 160-164, bottom 20) and a far roof: nothing else to ring.
  const bridge = m.solids[3];
  const model: CityModel = { ...m, solids: [{ id: 0, kind: "roof", landable: true, x0: 400, z0: 400, x1: 410, z1: 410, top: 10 }, { ...bridge, id: 1 }], rigs: [] };
  const idx = new CityIndex(model);
  const a = emptyAnchor();
  assert.ok(findAnchor(idx, 145, 10, 29, 1, 0, 15, K, -1, -1, -1, a, K.aimCos, { x: 15, y: 0, z: 0 }));
  assert.equal(a.solid, 1);
  assert.equal(a.ay, 20, "on the underside");
  assert.equal(a.nx, 0); assert.equal(a.nz, 0);
  assert.equal(a.px, a.ax); assert.equal(a.py, a.ay); assert.equal(a.pz, a.az);
});

test("cablePairs 2: a cable near each end of a street pair's span (cableInset from the corners); 1 = one at its centre", () => {
  const solids = [roof(0, 0, 40, 18, 50), roof(0, 40, 40, 58, 50)] as Solid[];
  const knobs = { ...STRUCTURES_DEFAULT, gantry: false, skybridge: 0, tanks: 0, boards: 0, stacks: 0, cables: 1, cableTier2: 0 };
  const two = deriveModel({ ...DEFAULT_CONFIG, autoHooks: false }, solids, { knobs: { ...knobs, cablePairs: 2 }, keepOut: [] }).rigs ?? [];
  assert.deepEqual(two.map(g => g.ax).sort((p, q) => p - q), [knobs.cableInset, 40 - knobs.cableInset]);
  for (const g of two) { assert.equal(g.az, 18); assert.equal(g.bz, 40); assert.ok(g.ay <= 50 - 3 + 1e-9); }
  const one = deriveModel({ ...DEFAULT_CONFIG, autoHooks: false }, solids, { knobs: { ...knobs, cablePairs: 1 }, keepOut: [] }).rigs ?? [];
  assert.deepEqual(one.map(g => g.ax), [20]);
});

test("the thief's cable swings: a street crossing under its pair's cable gets a cable option (web after the drop, zip up)", () => {
  const solids = [roof(0, 0, 40, 18, 50), roof(0, 40, 40, 58, 50)] as Solid[];
  const m = deriveModel({ ...DEFAULT_CONFIG, autoHooks: false }, solids, { knobs: { ...STRUCTURES_DEFAULT, gantry: false, skybridge: 0, tanks: 0, boards: 0, stacks: 0, cables: 1 }, keepOut: [] });
  assert.ok((m.rigs ?? []).length >= 1);
  const link = buildLinks(m, RUNNER).get(0)!.find(l => l.to === 1 && l.kind === "street")!;
  assert.ok(link, "a street link across");
  const cab = link.swings.filter(o => o.press !== undefined);
  assert.ok(cab.length >= 1, "a cable option");
  for (const o of cab) {
    assert.ok(o.anchor.solid >= RIG0);
    const g = m.rigs![o.anchor.solid - RIG0];
    assert.equal(o.lat, g.ax, "takes off in line with the cable");
    assert.ok(o.anchor.ay < 50 - 3 + 1e-9, "the cable hangs under the roofs");
    assert.ok(link.rim, "it has the far rim to zip up to");
  }
});

test("difficulty: the owner's yank ranges (Normal 12 m, Degen 9 m, none on Chill) in every district; Yoink > 2x the tag radius", () => {
  const { difficulty } = applyTuningJson(JSON.parse(fs.readFileSync(new URL("../public/levels/tuning.json", import.meta.url), "utf8")));
  assert.equal(difficulty.chill.yankRange, 0);
  assert.equal(difficulty.normal.yankRange, 12);
  assert.equal(difficulty.degen.yankRange, 9);
  for (const id of DISTRICT_IDS) {
    for (const d of ["chill", "normal", "degen"] as const) {
      const add = DISTRICTS[id].chase?.add?.[d] ?? {};
      assert.equal(add.yankRange ?? 0, 0, `${id} ${d}: no district cut of the yank range`);
      const yoink = difficulty[d].yoinkRange + (add.yoinkRange ?? 0);
      assert.ok(yoink >= 2 * ROUND.tagRadius && yoink <= 7.5, `${id} ${d}: Yoink ${yoink} m`);
    }
  }
});
