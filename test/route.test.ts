// Test 5 (bake + graph checks on the committed pack) and a slice of test 7 (runner dwell rules). Round 9:
// street swings carry a baked building anchor, +1.2..3.5 m alley steps are climbs (ledge grab), wall gaps are
// wall-run hops, and the bake writes pack v2 (anchor table) - checked on synthetic tall cities, since the
// committed districts are re-baked when the world builder's taller cities land (INTEGRATE).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodePack, encodePack, PACK_VERSION, PHASE_LEDGE, PHASE_ROPE, PHASE_WALL, packAnchor, sampleEdge, type PackEdgeHeader } from "../src/route/trackPack.ts";
import { bake, bakeEdge, BAKE, jumpHop, recordEdge, tuningHash, type BakeReport } from "../src/route/bake.ts";
import { buildGraph, buildLinks, forcedUTurns, stronglyConnected, GRAPH } from "../src/route/graph.ts";
import type { AnchorHit } from "../src/world/cityQuery.ts";
import { EdgeBot, newParams, PH_DONE } from "../src/route/bot.ts";
import { applyTuningJson, runnerFrom } from "../src/sim/tuning.ts";
import { Runner, RE_DEPART, RE_TAUNT, RM_TURN, RM_EDGE } from "../src/runner/runner.ts";
import { Rand } from "../src/sim/math.ts";
import { CityIndex, type CityModel, type Solid, type WallGap } from "../src/world/cityModel.ts";
import { deriveModel } from "../src/world/derive.ts";
import { DEFAULT_CONFIG } from "../src/world/generate.ts";
import { TALL, tallBlocks, tallModel } from "./helpers.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8")));
const packBytes = fs.readFileSync(lv("runner.pack.bin"));
const pack = decodePack(packBytes);
const report: BakeReport = JSON.parse(fs.readFileSync(lv("bake.report.json"), "utf8"));

test("committed pack matches the city and passes the bake checks", () => {
  assert.equal(pack.header.city, model.hash, "runner.pack.bin is stale: run npm run level");
  assert.equal(report.pack, pack.hash);
  const refs = pack.edges.map(e => ({ from: e.from, to: e.to }));
  assert.ok(pack.junctions.length >= 8, `${pack.junctions.length} junctions`);
  assert.ok(stronglyConnected(pack.junctions.length, refs), "graph not strongly connected");
  assert.deepEqual(forcedUTurns(refs), []);
  assert.equal(report.checks.walkStalls, 0);
  const kept = report.edges.filter(e => e.kept);
  assert.equal(kept.length, pack.edges.length);
  for (const e of kept) {
    for (const h of e.hops) {
      assert.ok(h.window >= (jumpHop(h.kind) ? BAKE.alleyWindow : h.kind === "drop" ? BAKE.dropWindow : BAKE.swingWindow), `${h.kind} window ${h.window}`);
      if (!h.climbed) assert.ok(h.margin >= 1.5, `landing margin ${h.margin}`);
    }
    assert.ok(e.residual < 0.05, `snap ${e.residual}`);
  }
  // Every edge starts and ends exactly on its junctions (canonical rest state).
  for (const e of pack.edges) {
    const s = e.samples, last = (e.count - 1) * 5;
    assert.deepEqual([s[0], s[1], s[2]], [0, 0, 0]);
    const a = pack.junctions[e.from], b = pack.junctions[e.to];
    assert.deepEqual([s[last], s[last + 1], s[last + 2]], [Math.round((b.x - a.x) * 100), Math.round((b.y - a.y) * 100), Math.round((b.z - a.z) * 100)]);
  }
});

test("a fresh bake reproduces the committed pack byte for byte, in < 60 s", { skip: pack.header.version < PACK_VERSION ? "committed pack predates round 9 (re-baked at integration)" : false }, () => {
  const t0 = Date.now();
  const r = bake(model, tuning.player);
  assert.ok(Date.now() - t0 < 60000);
  assert.equal(r.report.pack, pack.hash, "fresh bake differs: run npm run level and commit");
});

test("runner dwell: taunt only when d > 35; head turn starts exactly 36 steps before the edge", () => {
  const params = { ...tuning.difficulty.normal };
  for (const far of [true, false]) {
    const r = new Runner(pack, params, new Rand(1), 0, pack.out[0][0]);
    const player = { x: 0, y: 0, z: 0 };
    let turnStart = -1, departs = 0, taunts = 0;
    for (let i = 0; i < 6000 && departs < 3; i++) {
      // Player either far away (> 35 m) or 25 m behind him.
      const d = far ? 60 : 25;
      player.x = r.p.x - d; player.y = r.p.y; player.z = r.p.z;
      const before = r.mode;
      r.step(player, d);
      if (r.events & RE_TAUNT) taunts++;
      if (r.mode === RM_TURN && before !== RM_TURN) turnStart = i;
      if (r.events & RE_DEPART) {
        departs++;
        assert.equal(r.mode, RM_EDGE);
        if (turnStart >= 0) assert.equal(i - turnStart, 36, "head turn must lead the first edge step by 36 steps");
      }
    }
    assert.ok(departs >= 3);
    if (far) assert.ok(taunts >= 2); else assert.equal(taunts, 0);
  }
});

// ---- round 9 hops on synthetic cities ----------------------------------------------------------------

const RUN = runnerFrom(tuning.player);
const roofBox = (x0: number, z0: number, x1: number, z1: number, top: number) => ({ kind: "roof" as const, landable: true, x0, z0, x1, z1, top });

test("links: street swings carry a baked building anchor (none = no link); +1.2..9 m alley steps are climbs; wall gaps link both ways", () => {
  // The world's deriveModel lists tallModel()'s notch as a wall gap (a wall-run hop), so its avenue gives few
  // swings; tallBlocks() adds a block city with a tower in every block.
  const m = tallModel();
  let swings = 0;
  for (const city of [m, tallBlocks()]) {
    const idx = new CityIndex(city);
    for (const list of buildLinks(city, RUN).values()) for (const l of list) {
      if (l.kind !== "street") continue;
      swings++;
      const a = l.anchor!;
      assert.ok(a && a.solid >= 0, "a baked anchor");
      const s = city.solids[a.solid];
      assert.ok(a.ay <= s.top && (a.ax === s.x0 || a.ax === s.x1 || a.az === s.z0 || a.az === s.z1), "on a building");
      assert.ok(idx.solids[a.solid].top - city.solids[l.from].top >= RUN.anchorMinAbove - RUN.halfHeight, "taller than the takeoff roof");
    }
  }
  assert.ok(swings >= 2, `${swings} swing links across the avenues`);
  // Steps: +1 m alley hop, +2.5 m and +6 m climbs (round 10: the run-up + ledge grab), +10..+32 m zip up, higher
  // nothing, -8 m drop. A climb above climbJumpMax keeps the zip onto the rim as its fallback.
  const pair = (tb: number) => deriveModel(DEFAULT_CONFIG, [roofBox(0, 0, 12, 12, 20), roofBox(16, 0, 28, 12, tb)] as Solid[]);
  const kind = (tb: number) => buildLinks(pair(tb), RUN).get(0)!.find(l => l.to === 1)?.kind;
  assert.equal(kind(21), "alley");
  assert.equal(kind(22.5), "climb");
  assert.equal(kind(26), "climb", "a 6 m step is a run-up climb");
  assert.ok(buildLinks(pair(26), RUN).get(0)!.find(l => l.to === 1)?.rim, "with a zip fallback");
  assert.equal(buildLinks(pair(22.5), RUN).get(0)!.find(l => l.to === 1)?.rim, null, "a low climb has none");
  assert.equal(kind(30), "zip", "a 10 m step is a zip up");
  assert.equal(kind(20 + GRAPH.zipUpMax + 1), undefined, "past zipUpMax: no link");
  assert.equal(kind(12), "drop");
  assert.equal(GRAPH.alleyClimbMax, 9);
  // Wall gap: a -> b and b -> a along the wall face (model.wallGaps, read structurally).
  const gm = { ...m, wallGaps: [{ a: TALL.gapA, b: TALL.gapB, wall: TALL.gapWall, axis: "x", dir: 1, edge: 155, far: 164, face: 12, side: 1 }] as WallGap[] } as CityModel;
  const gl = buildLinks(gm, RUN);
  const ab = gl.get(TALL.gapA)!.find(l => l.to === TALL.gapB), ba = gl.get(TALL.gapB)!.find(l => l.to === TALL.gapA);
  assert.equal(ab?.kind, "wallrun");
  assert.equal(ba?.kind, "wallrun");
  assert.equal(ba?.dir, -1);
  assert.equal(ba?.edge, 164);
});

test("runner hops: he climbs a +2.5 m alley step by ledge grab and wall-runs a wall gap", () => {
  // Climb: a pair of roofs across a 4 m alley, the far one 2.5 m higher.
  const pm = deriveModel(DEFAULT_CONFIG, [roofBox(0, 0, 12, 12, 20), roofBox(16, 0, 28, 12, 22.5)] as Solid[]);
  const link = buildLinks(pm, RUN).get(0)!.find(l => l.to === 1)!;
  assert.equal(link.kind, "climb");
  const world = { index: new CityIndex(pm), runner: null };
  let ok = 0, ledge = 0;
  for (let j = 0; j < 120; j++) {
    const params = newParams(1);
    const bot = new EdgeBot(pm, world, RUN, { from: { roof: 0, x: 6, y: 20.9, z: 6 }, to: { roof: 1, x: 22, y: 23.4, z: 6 }, links: [link] }, params);
    params[0].jump = j;
    bot.onStep = bb => { if (bb.body.ledgeMode > 0) ledge++; };
    bot.runToEnd();
    if (bot.phase === PH_DONE) ok++;
  }
  assert.ok(ok >= BAKE.alleyWindow, `climb window ${ok} steps`);
  assert.ok(ledge > 0, "some takeoffs climb by the ledge");
  // Wall run: along wall w's +z face across the 9 m notch from roof a to roof b.
  const m = { ...tallModel(), wallGaps: [{ a: TALL.gapA, b: TALL.gapB, wall: TALL.gapWall, axis: "x", dir: 1, edge: 155, far: 164, face: 12, side: 1 }] as WallGap[] } as CityModel;
  const wl = buildLinks(m, RUN).get(TALL.gapA)!.find(l => l.to === TALL.gapB)!;
  const a = m.solids[TALL.gapA], b = m.solids[TALL.gapB];
  const w2 = { index: new CityIndex(m), runner: null };
  let wok = 0, walls = 0;
  for (let j = 0; j < 160; j++) {
    const params = newParams(1);
    const bot = new EdgeBot(m, w2, RUN, { from: { roof: a.id, x: 145, y: a.top + 0.9, z: 18 }, to: { roof: b.id, x: 172, y: b.top + 0.9, z: 18 }, links: [wl] }, params);
    params[0].jump = j;
    let wall = false;
    bot.onStep = bb => { if (bb.body.wallMode > 0) wall = true; };
    bot.runToEnd();
    if (bot.phase === PH_DONE) { wok++; if (wall) walls++; }
  }
  assert.ok(wok >= BAKE.alleyWindow, `wall-run hop window ${wok} steps`);
  assert.ok(walls > 0, "he wall-runs the notch");
});

test("zip hops: he zips from the edge up to a roof 20 m higher across a street, launched onto it clear of the rim", () => {
  // (round 10: up to streetClimbMax = 16 m higher a street hop tries a swing first)
  const pm = deriveModel(DEFAULT_CONFIG, [roofBox(0, 0, 14, 14, 20), roofBox(34, 0, 48, 14, 40)] as Solid[]);
  const link = buildLinks(pm, RUN).get(0)!.find(l => l.to === 1)!;
  assert.equal(link.kind, "zip");
  assert.ok(GRAPH.streetClimbMax < 20);
  assert.ok(link.rim && link.rim.solid === 1 && link.rim.ax === 34 && link.rim.ay === 40 && link.rim.nx === -1, "the near rim of the higher roof");
  const world = { index: new CityIndex(pm), runner: null };
  let ok = 0, zipped = 0;
  for (let j = 0; j < 120; j++) {
    const params = newParams(1);
    const bot = new EdgeBot(pm, world, RUN, { from: { roof: 0, x: 4, y: 20.9, z: 7 }, to: { roof: 1, x: 42, y: 40.9, z: 7 }, links: [link] }, params);
    params[0].jump = j;
    bot.onStep = bb => { if (bb.body.zipOn) zipped++; };
    bot.runToEnd();
    if (bot.phase === PH_DONE) { ok++; assert.ok(bot.results[0].margin >= 1.5); }
  }
  assert.ok(ok >= BAKE.alleyWindow, `zip window ${ok} steps`);
  assert.ok(zipped > 0);
  // A street swing that cannot bake falls back to the same zip across (reported as a zip hop).
  const flat = deriveModel(DEFAULT_CONFIG, [roofBox(0, 0, 14, 14, 20), roofBox(34, 0, 48, 14, 21)] as Solid[]);
  const sl = buildLinks(flat, RUN).get(0)!.find(l => l.to === 1)!;
  assert.equal(sl.kind, "street");
  assert.equal(sl.swings.length, 0, "nothing tall to web");
  const fw = { index: new CityIndex(flat), runner: null };
  const js = [{ roof: 0, x: 4, y: 20.9, z: 7 }, { roof: 1, x: 42, y: 21.9, z: 7 }];
  const r = bakeEdge(flat, fw, RUN, js, { from: 0, to: 1, roofs: [0, 1], links: [sl] }).report;
  assert.ok(r.ok, r.reason);
  assert.equal(r.hops[0].kind, "zip");
});

test("bake: swing edges on a tall synthetic city record rope samples that index the pack v2 anchor table; deterministic", () => {
  const m = tallBlocks(11);
  const graph = buildGraph(m, 7, RUN);
  const world = { index: new CityIndex(m), runner: null };
  const baked = graph.candidates.map(c => bakeEdge(m, world, RUN, graph.junctions, c)).filter(b => b.report.ok);
  assert.ok(baked.length >= 4, `${baked.length} candidate edges bake`);
  const kinds = new Set(baked.flatMap(b => b.report.hops.map(h => h.kind)));
  assert.ok(kinds.has("street"), `hop kinds ${[...kinds]}`);
  // Record them into a v2 pack the way bake() does.
  const anchors: number[] = [], ids = new Map<string, number>();
  const anchorIndex = (a: AnchorHit) => {
    const key = `${Math.round(a.ax * 100)},${Math.round(a.ay * 100)},${Math.round(a.az * 100)}`;
    if (!ids.has(key)) { ids.set(key, ids.size); anchors.push(Math.round(a.ax * 100), Math.round(a.ay * 100), Math.round(a.az * 100)); }
    return ids.get(key)!;
  };
  const edges: PackEdgeHeader[] = [], all: number[] = [];
  for (const b of baked) {
    const rec = recordEdge(m, world, RUN, graph.junctions, b, anchorIndex);
    edges.push({ from: b.cand.from, to: b.cand.to, steps: rec.steps, offset: all.length, count: rec.samples.length / 5, events: rec.events, exit: [0, 0, 0], speed: 1000, score: 1000, hops: b.cand.links.length, roofs: b.cand.roofs });
    all.push(...rec.samples);
  }
  const js = graph.junctions.map(j => ({ roof: j.roof, x: Math.round(j.x * 100), y: Math.round(j.y * 100), z: Math.round(j.z * 100) }));
  const p = decodePack(encodePack({ version: PACK_VERSION, city: m.hash, tuning: tuningHash(RUN), anchors, junctions: js, edges }, Int16Array.from(all)));
  assert.equal(p.header.version, PACK_VERSION);
  assert.equal(p.anchors.length, anchors.length);
  const pose = { x: 0, y: 0, z: 0, phase: 0, ref: -1 };
  const out = { x: 0, y: 0, z: 0 };
  let rope = 0;
  for (const e of p.edges) for (let t = 0; t <= e.duration; t += 1 / 60) {
    sampleEdge(e, t, pose);
    if (pose.phase === PHASE_ROPE) {
      rope++;
      assert.ok(packAnchor(p, pose.ref, out), `rope ref ${pose.ref} in the table`);
      const d = Math.hypot(out.x - pose.x, out.y - pose.y, out.z - pose.z);
      assert.ok(d <= RUN.ropeMax + 8, `web ${d.toFixed(1)} m long`);
    }
    if (pose.phase === PHASE_WALL || pose.phase === PHASE_LEDGE) assert.ok(m.solids[pose.ref], "wall / ledge ref = a solid");
  }
  assert.ok(rope > 0, "he swings");
  // Same city + tuning = same tracks.
  const again = bakeEdge(m, world, RUN, graph.junctions, baked[0].cand);
  assert.deepEqual(again.params, baked[0].params);
});
