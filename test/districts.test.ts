// Round 4 districts: every district's committed level files load, the city lint (round 9 geometry rules
// G1-G8) has no errors, each district keeps its character, and - once its runner pack is baked for its
// city model - the pack passes the graph / bake checks and a seeded round runs. Round 9 rebuilt the cities
// before the sim that plays them landed, so the pack checks skip (with the reason) while a pack predates
// its city; the integration re-bake turns them back on.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodePack } from "../src/route/trackPack.ts";
import { forcedUTurns, stronglyConnected } from "../src/route/graph.ts";
import type { BakeReport } from "../src/route/bake.ts";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { lintModel, RULES } from "../src/world/derive.ts";
import type { CityModel } from "../src/world/cityModel.ts";
import { DISTRICTS, DISTRICT_IDS, districtFromSearch, type DistrictId } from "../src/world/districts.ts";
import { Round } from "../src/game/round.ts";
import { chaseDist } from "../src/sim/player.ts";
import { emptyInput } from "../src/sim/player.ts";

const tuningJson = JSON.parse(fs.readFileSync(new URL("../public/levels/tuning.json", import.meta.url), "utf8"));
const { player, difficulty } = applyTuningJson(tuningJson);
const file = (id: DistrictId, f: string) => new URL(`../public/${DISTRICTS[id].dir}${f}`, import.meta.url);
const model = (id: DistrictId): CityModel => JSON.parse(fs.readFileSync(file(id, "city.model.json"), "utf8"));
const pack = (id: DistrictId) => decodePack(fs.readFileSync(file(id, "runner.pack.bin")));
/** Skip reason while a district's runner pack was baked for an older city (false = baked for this one). */
const stale = (id: DistrictId): string | false => {
  try {
    return pack(id).header.city === model(id).hash ? false : `${id}: runner.pack.bin predates this city - run npm run level -- --map ${id}`;
  } catch (e) {
    return `${id}: runner.pack.bin unreadable (${(e as Error).message}) - run npm run level -- --map ${id}`;
  }
};
const anyStale = DISTRICT_IDS.map(stale).find(Boolean) ?? false;

for (const id of DISTRICT_IDS) {
  test(`district ${id}: the city lints clean (G1-G8)`, () => {
    const m = model(id);
    const lint = lintModel(m);
    assert.deepEqual(lint.errors, [], `${id}: lint errors`);
    assert.deepEqual(m.hooks, [], "no balloons");
    assert.ok(m.junctionCandidates.length >= RULES.junctions);
    const roofs = m.solids.filter(s => s.kind === "roof").map(s => s.top);
    assert.ok(Math.min(...roofs) >= RULES.landMin && Math.max(...roofs) <= RULES.landMax);
    assert.ok(Math.max(...m.solids.map(s => s.top)) <= RULES.towerTop);
    assert.ok(DISTRICTS[id].look.fogFar >= 700, "fog reaches the canyons");
  });

  test(`district ${id}: pack and bake report agree and pass the checks`, { skip: stale(id) }, () => {
    const m = model(id);
    const p = pack(id);
    const report: BakeReport = JSON.parse(fs.readFileSync(file(id, "bake.report.json"), "utf8"));
    assert.equal(p.header.city, m.hash, `${id}: runner.pack.bin is stale - run npm run level -- --map ${id}`);
    assert.equal(report.pack, p.hash);
    const refs = p.edges.map(e => ({ from: e.from, to: e.to }));
    assert.ok(p.junctions.length >= 6, `${id}: ${p.junctions.length} junctions`);
    assert.ok(stronglyConnected(p.junctions.length, refs), `${id}: graph not strongly connected`);
    assert.deepEqual(forcedUTurns(refs), []);
    assert.equal(report.checks.walkStalls, 0);
  });

  test(`district ${id}: a seeded round counts down, chases and steps without errors`, { skip: stale(id) }, () => {
    const r = new Round({ model: model(id), pack: pack(id), difficulty: "normal", params: difficulty.normal, tuning: player, chaser: "652", runner: "4764", seed: 12345 });
    const inp = emptyInput();
    for (let i = 0; i < 360 + 600; i++) r.step(inp);
    assert.equal(r.phase, "chase");
    assert.ok(r.d > 0 && isFinite(r.d));
  });
}

test("round 9 districts keep their character", () => {
  const tops = (m: CityModel, k: string) => m.solids.filter(s => s.kind === k).map(s => s.top);
  const down = model("downtown"), market = model("market"), docks = model("docks"), towers = model("towers"), vert = model("vertigo");
  // Downtown: 40-80 m podiums in canyons, landmark towers 140+ m, wall gaps.
  assert.ok(Math.min(...tops(down, "roof")) >= 28 && Math.max(...tops(down, "roof")) <= 84);
  assert.ok(tops(down, "tower").filter(t => t >= 140).length >= 6);
  assert.ok((down.wallGaps ?? []).length >= 3);
  // Night Market: low and dense, lots of props, the most wall gaps, few anchors (G1 only warns there).
  assert.ok(Math.max(...tops(market, "roof")) <= 45 && tops(market, "tower").length <= 8);
  assert.ok(market.solids.filter(s => s.kind === "prop").length >= 2 * tops(market, "roof").length);
  assert.ok((market.wallGaps ?? []).length >= (down.wallGaps ?? []).length);
  assert.ok(lintModel(market).warnings.some(w => w.startsWith("G1")));
  // Docks: low sheds under six 4 x 4 m crane masts.
  assert.ok(Math.max(...tops(docks, "roof")) <= 26);
  assert.equal(docks.solids.filter(s => s.kind === "tower" && s.x1 - s.x0 === 4 && s.z1 - s.z0 === 4).length, 6);
  // The Towers: the deepest canyons.
  assert.ok(Math.min(...tops(towers, "roof")) >= 55 && Math.max(...tops(towers, "tower")) >= 200);
  // Vertigo: the spiral, five 150-220 m needles.
  assert.equal(tops(vert, "tower").length, 5);
  for (const t of tops(vert, "tower")) assert.ok(t >= 150 && t <= 220);
});

test("districts: the page district comes from ?map= or a link's m=, else Downtown", () => {
  assert.equal(districtFromSearch(""), "downtown");
  assert.equal(districtFromSearch("?map=towers"), "towers");
  assert.equal(districtFromSearch("?v=2&m=docks&c=652"), "docks");
  assert.equal(districtFromSearch("?map=nope"), "downtown");
});

test("chase tweak: Downtown / no district is the classic round; a tweak keeps the rng draws and changes only its knobs", { skip: stale("downtown") }, () => {
  const m = model("downtown");
  const p = pack("downtown");
  const base = { model: m, pack: p, difficulty: "normal" as const, params: difficulty.normal, tuning: player, chaser: "652" as const, runner: "4764" as const, countdown: false };
  for (const seed of [1, 7, 24, 36]) {
    const a = new Round({ ...base, seed }), b = new Round({ ...base, seed, district: "downtown" });
    assert.equal(a.hash(), b.hash(), "Downtown has no tweak");
    const c = new Round({ ...base, seed, chase: { spawnMin: 30, spawnSpan: 0, spawnOther: 0, add: { normal: { yoinkRange: -1, gStar: 5 } } } });
    assert.equal(c.rng.s, a.rng.s, "same number of rng draws");
    assert.equal(c.startJunction, a.startJunction);
    assert.equal(c.runner.next, a.runner.next, "same first edge");
    assert.equal(c.tuning.yoinkRange, a.tuning.yoinkRange - 1);
    assert.equal(c.runner.params.gStar, a.runner.params.gStar + 5);
    assert.ok(chaseDist(c.player.p, c.runner.p) >= chaseDist(a.player.p, a.runner.p) - 1e-9 || c.spawn.roofId !== a.spawn.roofId);
  }
});

test("chase tweak: every district's tweak builds valid rounds (first edge leaves the start junction)", { skip: anyStale }, () => {
  for (const id of DISTRICT_IDS) {
    const m = model(id);
    const p = pack(id);
    for (const d of ["chill", "normal", "degen"] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const r = new Round({ model: m, pack: p, difficulty: d, params: difficulty[d], tuning: player, chaser: "652", runner: "4764", seed, countdown: false, district: id });
        assert.ok(p.out[r.startJunction].includes(r.runner.next), `${id} ${d} seed ${seed}`);
        assert.ok(r.tuning.yoinkRange > 2 && r.runner.params.base > 0.5, `${id} ${d}: sane runner parameters`);
      }
    }
  }
});
