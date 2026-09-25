// Runner bake (spec §7, build time): drive the bot + stepBody (RUNNER preset) hop by hop along every
// candidate edge, sweep each hop's integer step parameter, validate, keep each junction's best edges,
// run the graph checks and record 60 Hz tracks into runner.pack.bin. Failing candidates are dropped
// (never fail the build); the graph checks are reported for test 5.
import { Fnv1a } from "../sim/math.ts";
import { MOVE_KEYS, runnerFrom, type Tuning } from "../sim/tuning.ts";
import { EV_ATTACH, EV_JUMP, EV_LAND, EV_RELEASE, type SimWorld } from "../sim/player.ts";
import { CityIndex, type CityModel } from "../world/cityModel.ts";
import { buildGraph, forcedUTurns, stronglyConnected, type Candidate, type Junction } from "./graph.ts";
import { EdgeBot, newParams, PH_DONE, PH_FAIL, PH_LINE, type HopParams } from "./bot.ts";
import {
  encodePack, packHash, EVT_ATTACH, EVT_LAND, EVT_RELEASE, EVT_TAKEOFF, PHASE_AIR, PHASE_GROUND, PHASE_ROPE,
  SAMPLE_STRIDE, type PackEdgeHeader, type PackHeader,
} from "./trackPack.ts";

export const BAKE = {
  /**
   * Minimum press windows (steps). Spec: 250 ms alley / 400 ms swing; measured with the §5.5 constants a
   * flat 4 m alley gives ~250 ms and every uphill hop less (a +1 m alley ~100 ms, a +2 m swing ~390 ms).
   * The runner plays recorded tracks, so windows are only a robustness score: 100 / 300 ms here (NOTES).
   */
  alleyWindow: 12,
  swingWindow: 36,
  alleySweep: 120,
  swingSweep: 360,
  keepPerJunction: 3,
  snapMax: 0.05,
} as const;

export type HopReport = { kind: string; from: number; to: number; window: number; windowMs: number; param: number; margin: number };
export type EdgeReport = {
  from: number; to: number; roofs: number[]; ok: boolean; reason: string; hops: HopReport[];
  seconds: number; speed: number; score: number; residual: number; kept: boolean;
  /** Unit horizontal exit direction (+2 s). */
  exitX: number; exitZ: number;
};

export type BakeReport = {
  city: string;
  tuning: string;
  pack: string;
  packBytes: number;
  ms: number;
  junctions: number;
  candidates: number;
  baked: number;
  kept: number;
  checks: { stronglyConnected: boolean; forcedUTurns: number; walkStalls: number; minSwingWindowMs: number; minAlleyWindowMs: number; minLandMargin: number; maxSnap: number };
  edges: EdgeReport[];
};

type Baked = { cand: Candidate; params: HopParams[]; report: EdgeReport };

export function tuningHash(t: Tuning): string {
  const h = new Fnv1a();
  // The player-only moves are off for the runner: leave their keys out so older bakes hash the same.
  const movesOff = t.airJumps === 0 && !t.webZip;
  for (const k of Object.keys(t).sort()) {
    if (movesOff && (MOVE_KEYS as readonly string[]).includes(k)) continue;
    const v = (t as Record<string, unknown>)[k];
    h.str(k);
    if (typeof v === "number") h.f64(v); else h.str(String(v));
  }
  return h.hex();
}

/** Longest contiguous run of ok entries -> [first, last] indices, or null. */
function longestRun(ok: boolean[]): [number, number] | null {
  let best: [number, number] | null = null, start = -1;
  for (let i = 0; i <= ok.length; i++) {
    if (i < ok.length && ok[i]) { if (start < 0) start = i; continue; }
    if (start >= 0) {
      if (!best || i - 1 - start > best[1] - best[0]) best = [start, i - 1];
      start = -1;
    }
  }
  return best;
}

/** Bake one candidate edge. Returns the chosen params or a failure reason. */
export function bakeEdge(model: CityModel, world: SimWorld, runner: Tuning, junctions: Junction[], cand: Candidate): Baked {
  const plan = { from: junctions[cand.from], to: junctions[cand.to], links: cand.links };
  const params = newParams(cand.links.length);
  const report: EdgeReport = { from: cand.from, to: cand.to, roofs: cand.roofs, ok: false, reason: "", hops: [], seconds: 0, speed: 0, score: 0, residual: 0, kept: false, exitX: 0, exitZ: 0 };
  const bot = new EdgeBot(model, world, runner, plan, params);
  bot.onStep = bb => {
    if (bb.step === 240) { report.exitX = bb.body.p.x - plan.from.x; report.exitZ = bb.body.p.z - plan.from.z; }
  };
  for (let h = 0; h < cand.links.length; h++) {
    const link = cand.links[h];
    let window = 0, param = -1;
    if (link.kind === "alley") {
      while (bot.phase !== PH_LINE && bot.phase < PH_DONE) bot.tick();
      if (bot.phase >= PH_DONE) { report.reason = bot.fail || "approach failed"; return { cand, params, report }; }
      const s0 = bot.step;
      const ok: boolean[] = [];
      for (let j = 0; j < BAKE.alleySweep; j++) {
        const c = bot.clone();
        c.params[h].jump = s0 + j;
        c.runHop();
        ok.push(c.phase !== PH_FAIL && c.hop > h);
      }
      const run = longestRun(ok);
      window = run ? run[1] - run[0] + 1 : 0;
      if (!run || window < BAKE.alleyWindow) { report.reason = `alley hop ${h} window ${window} steps`; report.hops.push({ kind: "alley", from: link.from, to: link.to, window, windowMs: Math.round(window * 1000 / 120), param: -1, margin: 0 }); return { cand, params, report }; }
      param = s0 + ((run[0] + run[1]) >> 1);
      bot.params[h].jump = param;
    } else {
      while (!bot.swingJumpDue() && bot.phase < PH_DONE && bot.legSteps < 720) bot.tick();
      if (bot.phase >= PH_DONE || !bot.swingJumpDue()) { report.reason = bot.fail || `no swing takeoff (hop ${h})`; return { cand, params, report }; }
      const J = bot.step;
      bot.params[h].jump = J;
      const ok: boolean[] = [];
      for (let r = 0; r < BAKE.swingSweep; r++) {
        const c = bot.clone();
        c.params[h].release = J + 2 + r;
        c.runHop();
        ok.push(c.phase !== PH_FAIL && c.hop > h);
        if (c.autoReleased) break; // every later release is the same run
      }
      const run = longestRun(ok);
      window = run ? run[1] - run[0] + 1 : 0;
      if (!run || window < BAKE.swingWindow) { report.reason = `swing hop ${h} window ${window} steps`; report.hops.push({ kind: "street", from: link.from, to: link.to, window, windowMs: Math.round(window * 1000 / 120), param: -1, margin: 0 }); return { cand, params, report }; }
      const off = Math.min(run[1] - run[0], Math.max(24, Math.floor((run[1] - run[0] + 1) / 4)));
      param = J + 2 + run[0] + off;
      bot.params[h].release = param;
    }
    bot.runHop();
    if (bot.phase === PH_FAIL || bot.hop <= h) { report.reason = bot.fail || `hop ${h} failed on replay`; return { cand, params, report }; }
    const r = bot.results[h];
    report.hops.push({
      kind: link.kind, from: link.from, to: link.to, window, windowMs: Math.round(window * 1000 / 120), param, margin: Math.round(r.margin * 100) / 100,
    });
  }
  bot.runToEnd();
  if (bot.phase === PH_FAIL) { report.reason = bot.fail; return { cand, params, report }; }
  const j = plan.to;
  const dx = bot.body.p.x - j.x, dy = bot.body.p.y - j.y, dz = bot.body.p.z - j.z;
  report.residual = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (report.residual >= BAKE.snapMax) { report.reason = `snap residual ${report.residual.toFixed(3)} m`; return { cand, params, report }; }
  if (bot.step < 240) { report.exitX = bot.body.p.x - plan.from.x; report.exitZ = bot.body.p.z - plan.from.z; }
  const el = Math.sqrt(report.exitX * report.exitX + report.exitZ * report.exitZ) || 1;
  report.exitX /= el;
  report.exitZ /= el;
  for (let h = 0; h < params.length; h++) Object.assign(params[h], bot.params[h]);
  report.ok = true;
  report.seconds = bot.step / 120;
  report.score = Math.min(...report.hops.map(hp => hp.window / (hp.kind === "alley" ? BAKE.alleyWindow : BAKE.swingWindow)));
  return { cand, params, report };
}

type Recorded = { steps: number; samples: number[]; events: number[]; length: number };

/** Re-run an edge from scratch with its final params and record the 60 Hz track + events. */
export function recordEdge(model: CityModel, world: SimWorld, runner: Tuning, junctions: Junction[], b: Baked): Recorded {
  const plan = { from: junctions[b.cand.from], to: junctions[b.cand.to], links: b.cand.links };
  const bot = new EdgeBot(model, world, runner, plan, b.params.map(p => ({ ...p })));
  const o = plan.from;
  const states: number[][] = [[o.x, o.y, o.z, PHASE_GROUND, o.roof]];
  const events: number[] = [];
  bot.onStep = bb => {
    const body = bb.body;
    const phase = body.ropeHook >= 0 ? PHASE_ROPE : body.grounded ? PHASE_GROUND : PHASE_AIR;
    const ref = phase === PHASE_ROPE ? body.ropeHook : phase === PHASE_GROUND ? body.roofId : -1;
    states.push([body.p.x, body.p.y, body.p.z, phase, ref]);
    const i = states.length - 1;
    if (body.events & EV_JUMP) events.push(i, EVT_TAKEOFF, 0);
    if (body.events & EV_ATTACH) events.push(i, EVT_ATTACH, body.ropeHook);
    if (body.events & EV_RELEASE) events.push(i, EVT_RELEASE, 0);
    if (body.events & EV_LAND) events.push(i, EVT_LAND, body.roofId);
  };
  bot.runToEnd();
  if (bot.phase !== PH_DONE) throw new Error(`replay of edge ${b.cand.from}->${b.cand.to} failed: ${bot.fail}`);
  // Canonical rest state at the destination junction (snap), padded to an even step count.
  const end = plan.to;
  states[states.length - 1] = [end.x, end.y, end.z, PHASE_GROUND, end.roof];
  if ((states.length - 1) % 2 === 1) states.push([end.x, end.y, end.z, PHASE_GROUND, end.roof]);
  const steps = states.length - 1;
  const samples: number[] = [];
  let length = 0;
  for (let i = 0; i <= steps; i += 2) {
    const s = states[i];
    const cx = Math.round((s[0] - o.x) * 100), cy = Math.round((s[1] - o.y) * 100), cz = Math.round((s[2] - o.z) * 100);
    if (Math.abs(cx) > 32000 || Math.abs(cy) > 32000 || Math.abs(cz) > 32000) throw new Error("track leaves the int16 range");
    if (i > 0) {
      const n = samples.length;
      const dx = cx - samples[n - 5], dy = cy - samples[n - 4], dz = cz - samples[n - 3];
      length += Math.sqrt(dx * dx + dy * dy + dz * dz) / 100;
    }
    samples.push(cx, cy, cz, s[3], s[4]);
  }
  return { steps, samples, events, length };
}

export type BakeResult = { bytes: Uint8Array; report: BakeReport; header: PackHeader };

export function bake(model: CityModel, player: Tuning, log: (m: string) => void = () => {}): BakeResult {
  const t0 = Date.now();
  const runner = runnerFrom(player);
  const world: SimWorld = { index: new CityIndex(model), hooks: model.hooks, lowestRoof: model.lowestRoof, runner: null };
  const graph = buildGraph(model);
  const js = graph.junctions;
  const baked: Baked[] = graph.candidates.map(c => bakeEdge(model, world, runner, js, c));
  const good = baked.filter(b => b.report.ok);
  log(`bake: ${js.length} junctions, ${graph.candidates.length} candidate edges, ${good.length} baked OK`);

  // Keep the largest strongly connected set of junctions, then each junction's best edges.
  const alive = new Set(js.map((_, i) => i));
  let edges = good.slice();
  for (;;) {
    edges = edges.filter(e => alive.has(e.cand.from) && alive.has(e.cand.to));
    // Drop junctions with < 2 distinct outgoing destinations or no incoming edge.
    let changed = false;
    for (const j of [...alive]) {
      const outs = new Set(edges.filter(e => e.cand.from === j).map(e => e.cand.to));
      const ins = edges.some(e => e.cand.to === j);
      if (outs.size < 2 || !ins) { alive.delete(j); changed = true; }
    }
    if (!changed) break;
  }
  // Largest SCC (Kosaraju-lite via reachability from each node; n is tiny).
  const ids = [...alive].sort((a, b) => a - b);
  const reach = (from: number, fwd: boolean) => {
    const seen = new Set([from]);
    const st = [from];
    while (st.length) {
      const j = st.pop()!;
      for (const e of edges) {
        const [a, b] = fwd ? [e.cand.from, e.cand.to] : [e.cand.to, e.cand.from];
        if (a === j && !seen.has(b)) { seen.add(b); st.push(b); }
      }
    }
    return seen;
  };
  let scc: number[] = [];
  for (const j of ids) {
    const f = reach(j, true), r = reach(j, false);
    const comp = ids.filter(i => f.has(i) && r.has(i));
    if (comp.length > scc.length) scc = comp;
  }
  const inScc = new Set(scc);
  edges = edges.filter(e => inScc.has(e.cand.from) && inScc.has(e.cand.to));
  // Per junction: best edges by score (distinct destinations first), at most keepPerJunction.
  // Prefer edges of <= 10 s (spec 5-9 s), then the bake margin score, then the shorter one.
  const long = (b: Baked) => (b.report.seconds > 10 ? 1 : 0);
  const byScore = (a: Baked, b: Baked) => long(a) - long(b) || b.report.score - a.report.score || a.report.seconds - b.report.seconds;
  let kept: Baked[] = [];
  // Greedy spread: after the best edge, each pick maximises the smallest exit-direction difference to
  // the edges already picked (so a junction never offers only one way out), distinct destinations.
  for (const j of scc) {
    const outs = edges.filter(e => e.cand.from === j).sort(byScore);
    const pick: Baked[] = [];
    while (pick.length < BAKE.keepPerJunction) {
      let best: Baked | null = null, bestD = -Infinity;
      for (const e of outs) {
        if (pick.includes(e) || pick.some(p => p.cand.to === e.cand.to)) continue;
        let dmin = 2;
        for (const p of pick) dmin = Math.min(dmin, 1 - (e.report.exitX * p.report.exitX + e.report.exitZ * p.report.exitZ));
        const d = Math.floor(dmin * 4) - long(e) * 0.5; // quantised spread, then the byScore order
        if (d > bestD) { bestD = d; best = e; }
      }
      if (!best) break;
      pick.push(best);
    }
    kept.push(...pick);
  }
  const ref = (list: Baked[]) => list.map(e => ({ from: e.cand.from, to: e.cand.to }));
  const remap = new Map(scc.map((j, i) => [j, i]));
  const connected = (list: Baked[]) => stronglyConnected(scc.length, ref(list).map(e => ({ from: remap.get(e.from)!, to: remap.get(e.to)! })));
  if (!connected(kept) || forcedUTurns(ref(kept)).length) {
    for (const e of edges.slice().sort(byScore)) {
      if (connected(kept) && !forcedUTurns(ref(kept)).length) break;
      if (!kept.includes(e)) kept.push(e);
    }
  }
  kept = kept.sort((a, b) => remap.get(a.cand.from)! - remap.get(b.cand.from)! || remap.get(a.cand.to)! - remap.get(b.cand.to)! || a.cand.roofs.join().localeCompare(b.cand.roofs.join()));

  // Record tracks.
  const junctions = scc.map(j => js[j]);
  const headerEdges: PackEdgeHeader[] = [];
  const all: number[] = [];
  let maxSnap = 0;
  for (const b of kept) {
    const rec = recordEdge(model, world, runner, js, b);
    b.report.kept = true;
    b.report.seconds = rec.steps / 120;
    b.report.speed = Math.round((rec.length / b.report.seconds) * 100) / 100;
    maxSnap = Math.max(maxSnap, b.report.residual);
    const exitI = Math.min(240, rec.steps) / 2;
    const ex = rec.samples.slice(exitI * SAMPLE_STRIDE, exitI * SAMPLE_STRIDE + 3) as [number, number, number];
    headerEdges.push({
      from: remap.get(b.cand.from)!, to: remap.get(b.cand.to)!, steps: rec.steps, offset: all.length, count: rec.samples.length / SAMPLE_STRIDE,
      events: rec.events, exit: ex, speed: Math.round((rec.length / (rec.steps / 120)) * 1000), score: Math.round(b.report.score * 1000),
      hops: b.cand.links.length, roofs: b.cand.roofs,
    });
    all.push(...rec.samples);
  }
  const header: PackHeader = {
    version: 1,
    city: model.hash,
    tuning: tuningHash(runner),
    junctions: junctions.map(j => ({ roof: j.roof, x: Math.round(j.x * 100), y: Math.round(j.y * 100), z: Math.round(j.z * 100) })),
    edges: headerEdges,
  };
  const bytes = encodePack(header, Int16Array.from(all));
  const keptEdges = kept.map(k => k.report);
  const hops = keptEdges.flatMap(e => e.hops);
  const refs = headerEdges.map(e => ({ from: e.from, to: e.to }));
  const report: BakeReport = {
    city: model.hash,
    tuning: header.tuning,
    pack: packHash(bytes),
    packBytes: bytes.length,
    ms: Date.now() - t0,
    junctions: junctions.length,
    candidates: graph.candidates.length,
    baked: good.length,
    kept: kept.length,
    checks: {
      stronglyConnected: stronglyConnected(junctions.length, refs),
      forcedUTurns: forcedUTurns(refs).length,
      walkStalls: randomWalkStalls(junctions.length, headerEdges, 300),
      minSwingWindowMs: Math.min(...hops.filter(h => h.kind === "street").map(h => h.windowMs)),
      minAlleyWindowMs: Math.min(...hops.filter(h => h.kind === "alley").map(h => h.windowMs), Infinity),
      minLandMargin: Math.min(...hops.map(h => h.margin)),
      maxSnap: Math.round(maxSnap * 10000) / 10000,
    },
    edges: baked.map(b => b.report),
  };
  return { bytes, report, header };
}

/** Random walk over the kept graph for `seconds` of track time; counts dead ends (stalls). */
export function randomWalkStalls(n: number, edges: { from: number; to: number; steps: number }[], seconds: number, seed = 1): number {
  if (!n) return 1;
  let a = seed >>> 0;
  const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let j = 0, prev = -1, t = 0, stalls = 0;
  while (t < seconds) {
    const outs = edges.filter(e => e.from === j && e.to !== prev);
    const any = outs.length ? outs : edges.filter(e => e.from === j);
    if (!any.length) { stalls++; break; }
    const e = any[Math.floor(rand() * any.length)];
    t += e.steps / 120 + 0.45;
    prev = j;
    j = e.to;
  }
  return stalls;
}
