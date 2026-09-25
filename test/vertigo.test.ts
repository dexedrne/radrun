// Round 7: drop hops (walk off a roof onto a much lower one: graph + bake validation), sky hooks (higher
// balloon clusters with a longer grab range) and the Vertigo district's committed bake.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CityIndex, type CityModel, type Solid } from "../src/world/cityModel.ts";
import { deriveModel, skyHooks } from "../src/world/derive.ts";
import { DEFAULT_CONFIG, generate } from "../src/world/generate.ts";
import { buildLinks, GRAPH } from "../src/route/graph.ts";
import { EdgeBot, newParams, PH_DONE, PH_FAIL } from "../src/route/bot.ts";
import { BAKE, type BakeReport } from "../src/route/bake.ts";
import { decodePack, PHASE_AIR, PHASE_GROUND, sampleEdge } from "../src/route/trackPack.ts";
import { applyTuningJson, ROUND, runnerFrom } from "../src/sim/tuning.ts";
import { createBody, emptyInput, pickTarget, RING_NONE, type SimWorld } from "../src/sim/player.ts";
import { DISTRICTS, DISTRICT_IDS } from "../src/world/districts.ts";

const { player } = applyTuningJson(JSON.parse(fs.readFileSync(new URL("../public/levels/tuning.json", import.meta.url), "utf8")));
const file = (id: (typeof DISTRICT_IDS)[number], f: string) => new URL(`../public/${DISTRICTS[id].dir}${f}`, import.meta.url);

/** Two 12 x 12 roofs across a 4 m alley along x: A (top ta) then B (top tb). */
function pairModel(ta: number, tb: number): CityModel {
  const solids: Solid[] = [
    { id: 0, kind: "roof", landable: true, x0: 0, z0: 0, x1: 12, z1: 12, top: ta },
    { id: 1, kind: "roof", landable: true, x0: 16, z0: 0, x1: 28, z1: 12, top: tb },
  ];
  return deriveModel({ ...DEFAULT_CONFIG, autoHooks: false }, solids);
}

function runDrop(model: CityModel, pace: number): EdgeBot {
  const [a, b] = model.solids;
  const link = buildLinks(model).get(0)!.find(l => l.to === 1)!;
  const world: SimWorld = { index: new CityIndex(model), hooks: model.hooks, lowestRoof: model.lowestRoof, runner: null };
  const params = newParams(1);
  params[0].pace = pace;
  const bot = new EdgeBot(model, world, runnerFrom(player), {
    from: { roof: 0, x: 6, y: a.top + 0.9, z: 6 }, to: { roof: 1, x: 22, y: b.top + 0.9, z: 6 }, links: [link],
  }, params);
  bot.runToEnd();
  return bot;
}

test("drop hops: an alley >= 6 m down links as a drop, the climb back is not linked", () => {
  const m = pairModel(40, 20);
  const links = buildLinks(m);
  const down = links.get(0)!.find(l => l.to === 1);
  assert.equal(down?.kind, "drop");
  assert.equal(links.get(1)!.some(l => l.to === 0), false, "20 m climb is never a link");
  // Small steps stay alley hops both ways (1 m), a 3 m step down is an alley hop (jump), not a drop.
  assert.equal(buildLinks(pairModel(21, 20)).get(0)!.find(l => l.to === 1)?.kind, "alley");
  assert.equal(buildLinks(pairModel(21, 20)).get(1)!.find(l => l.to === 0)?.kind, "alley");
  assert.equal(buildLinks(pairModel(23, 20)).get(0)!.find(l => l.to === 1)?.kind, "alley");
  assert.ok(GRAPH.dropMin === 6);
});

test("drop hops: the walk-off pace window lands >= 1.5 m inside with no wall contact; too slow falls short", () => {
  const m = pairModel(40, 20);
  const ok: number[] = [];
  for (let pace = BAKE.dropPaceMin; pace <= 100; pace++) {
    const bot = runDrop(m, pace);
    if (bot.phase === PH_DONE) {
      ok.push(pace);
      assert.ok(bot.results[0].margin >= 1.5, `pace ${pace}: margin ${bot.results[0].margin}`);
      assert.equal(bot.results[0].landRoof, 1);
    }
  }
  assert.ok(ok.length >= BAKE.dropWindow, `window ${ok.length} points`);
  // Contiguous window.
  assert.equal(ok[ok.length - 1] - ok[0] + 1, ok.length);
  const slow = runDrop(m, BAKE.dropPaceMin);
  assert.equal(slow.phase, PH_FAIL);
  assert.match(slow.fail, /fell|wall contact|landing margin|landed on roof/, "too slow: short of the lower roof");
});

test("sky hooks: a longer grab range than street balloons, and only where the config asks", () => {
  const solids: Solid[] = [{ id: 0, kind: "roof", landable: true, x0: -6, z0: -6, x1: 6, z1: 6, top: 40 }];
  const model = deriveModel({ ...DEFAULT_CONFIG, autoHooks: false }, solids, [{ x: 12, y: 60, z: 0 }]);
  // The manual hook is 23 m away: out of the 17 m aim radius.
  const b = createBody(0, 40.9, 0, 0);
  const inp = { ...emptyInput(), aimX: 1, aimY: 0, aimZ: 0 };
  const world: SimWorld = { index: new CityIndex(model), hooks: model.hooks, lowestRoof: 40, runner: null };
  assert.equal(pickTarget(b, inp, player, world), RING_NONE);
  // Same spot as a sky hook (reach 30): ringed.
  const sky = model.hooks.map(h => ({ ...h, src: "sky" as const, reach: 30 }));
  assert.equal(pickTarget(b, inp, player, { ...world, hooks: sky }), 0);
  // Derived: Towers and Vertigo carry sky hooks 15-35 m over the tallest nearby roof; the others none.
  for (const id of DISTRICT_IDS) {
    const m: CityModel = JSON.parse(fs.readFileSync(file(id, "city.model.json"), "utf8"));
    const list = m.hooks.filter(h => h.src === "sky");
    if (id === "towers" || id === "vertigo") assert.ok(list.length >= 10, `${id}: ${list.length} sky hooks`);
    else assert.equal(list.length, 0, id);
    const cfg = m.config.sky;
    for (const h of list) {
      assert.equal(h.reach, cfg!.reach);
      let top = -1;
      for (const s of m.solids) {
        if (!s.landable) continue;
        const dx = h.x < s.x0 ? s.x0 - h.x : h.x > s.x1 ? h.x - s.x1 : 0, dz = h.z < s.z0 ? s.z0 - h.z : h.z > s.z1 ? h.z - s.z1 : 0;
        if (dx <= cfg!.radius && dz <= cfg!.radius) top = Math.max(top, s.top);
      }
      assert.ok(h.y - top >= cfg!.min - 1e-9 && h.y - top <= cfg!.max + 1e-9, `${id} sky hook ${h.id}: ${h.y - top} m above`);
    }
  }
  // The generator agrees with the committed Vertigo model (sky hooks included).
  const gen = generate(DISTRICTS.vertigo.config).model;
  assert.deepEqual(skyHooks(gen.config, gen.solids).length > 0, true);
});

test("Vertigo: big height range, drop hops in his route, falls land clean", () => {
  const model: CityModel = JSON.parse(fs.readFileSync(file("vertigo", "city.model.json"), "utf8"));
  const report: BakeReport = JSON.parse(fs.readFileSync(file("vertigo", "bake.report.json"), "utf8"));
  const pack = decodePack(fs.readFileSync(file("vertigo", "runner.pack.bin")));
  const roofs = model.solids.filter(s => s.landable).map(s => s.top);
  assert.ok(Math.min(...roofs) <= 25 && Math.max(...roofs) >= 85, `roofs ${Math.min(...roofs)}-${Math.max(...roofs)} m`);
  assert.ok(model.solids.filter(s => s.kind === "tower").length >= 3, "needle towers");
  const kept = report.edges.filter(e => e.kept);
  const drops = kept.flatMap(e => e.hops).filter(h => h.kind === "drop");
  assert.ok(drops.length >= 8, `${drops.length} drop hops kept`);
  for (const h of drops) {
    assert.ok(h.window >= BAKE.dropWindow, `drop window ${h.window}`);
    assert.ok(h.margin >= 1.5, `drop margin ${h.margin}`);
    assert.ok(model.solids[h.from].top - model.solids[h.to].top >= GRAPH.dropMin);
  }
  assert.equal(report.checks.drops, drops.length);
  // His junctions span a real height range, and his baked tracks include long falls (>= 20 m airborne drop).
  const ys = pack.junctions.map(j => j.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) >= 30, `junction heights ${Math.min(...ys)}-${Math.max(...ys)}`);
  let longest = 0;
  const pose = { x: 0, y: 0, z: 0, phase: 0, ref: -1 };
  for (const e of pack.edges) {
    let airTop = -Infinity;
    for (let t = 0; t <= e.duration; t += 1 / 60) {
      sampleEdge(e, t, pose);
      if (pose.phase === PHASE_AIR) airTop = Math.max(airTop, pose.y);
      else if (pose.phase === PHASE_GROUND && airTop > -Infinity) { longest = Math.max(longest, airTop - pose.y); airTop = -Infinity; }
      else airTop = -Infinity;
    }
  }
  assert.ok(longest >= 20, `longest fall ${longest.toFixed(1)} m`);
});

test("Vertigo round: he starts high, you spawn near his height (never next to him, off his first edge), runnerLow tracks his lowest roof", async () => {
  const { Round } = await import("../src/game/round.ts");
  const { difficulty } = applyTuningJson(JSON.parse(fs.readFileSync(new URL("../public/levels/tuning.json", import.meta.url), "utf8")));
  const model: CityModel = JSON.parse(fs.readFileSync(file("vertigo", "city.model.json"), "utf8"));
  const pack = decodePack(fs.readFileSync(file("vertigo", "runner.pack.bin")));
  const high = pack.junctions.map(j => j.y).sort((a, b) => b - a);
  const tw = DISTRICTS.vertigo.chase!;
  for (let seed = 1; seed <= 30; seed++) {
    const r = new Round({ model, pack, difficulty: "normal", params: difficulty.normal, tuning: player, chaser: "652", runner: "4764", seed, countdown: false, district: "vertigo" });
    const j = pack.junctions[r.startJunction];
    assert.ok(j.y >= high[tw.startHigh! - 1], `seed ${seed}: starts at ${j.y} m`);
    assert.ok(r.spawn.y - j.y >= -8, `seed ${seed}: spawn ${(r.spawn.y - j.y).toFixed(1)} m below him`);
    assert.ok(Math.hypot(r.spawn.x - j.x, r.spawn.z - j.z) >= 18, `seed ${seed}: spawn too close`);
    // ...and clear of his first edge's route (the spiral can turn back past a spawn).
    const e = pack.edges[r.runner.next];
    for (let t = 0; t <= e.duration; t += 0.25) {
      const q = sampleEdge(e, t, { x: 0, y: 0, z: 0, phase: 0, ref: -1 });
      assert.ok(Math.hypot(q.x - r.spawn.x, q.z - r.spawn.z) >= ROUND.spawnClearRoute - 1e-9, `seed ${seed}: spawn on his route`);
    }
    assert.equal(r.stats.runnerLow, model.solids[j.roof].top);
    let low = r.stats.runnerLow;
    const inp = emptyInput();
    for (let i = 0; i < 120 * 40 && !r.over; i++) {
      r.step(inp);
      if (r.runner.roofId >= 0) low = Math.min(low, model.solids[r.runner.roofId].top);
    }
    assert.equal(r.stats.runnerLow, low);
  }
});
