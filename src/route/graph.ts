// Runner junction graph (spec §7, build time): roof hop links from the city adjacency, ~12 junction
// roofs by seeded farthest-point sampling, and candidate edges (seeded BFS roof paths between
// junctions). Pure TS; the bake (route/bake.ts) turns candidates into validated tracks.
import { mulberry32 } from "../sim/math.ts";
import type { Adjacency, CityModel, Solid } from "../world/cityModel.ts";

export const GRAPH = {
  junctions: 12,
  nearest: 5,
  variants: 3,
  minHops: 3,
  maxHops: 7,
  /** Alley hops need this much overlapping span. */
  alleyMinOverlap: 6,
  /** Street hooks used for swings must sit this far inside the facing span. */
  streetHookInset: 1.5,
  /** Round 7: an alley hop down by at least this much is a drop (walk off, fall, land on the lower roof). */
  dropMin: 6,
  /** Hops that climb more than this can never bake (jump apex / swing energy): not linked at all. */
  alleyClimbMax: 1.2,
  streetClimbMax: 4.5,
  /** Swing balloons must hang at least this far above both roofs (lower street tiers are not the runner's). */
  swingHookAbove: 2,
} as const;

/** alley = jump across; street = swing on a street balloon; drop (round 7) = walk off onto a much lower roof. */
export type HopKind = "alley" | "street" | "drop";

/** One roof-to-roof hop (axis-aligned). */
export type Link = {
  kind: HopKind;
  from: number;
  to: number;
  axis: "x" | "z";
  /** +1 when `to` lies toward +axis from `from`. */
  dir: 1 | -1;
  /** Takeoff edge coordinate (along the axis) on `from`. */
  edge: number;
  /** Near edge coordinate of `to`. */
  far: number;
  /** Overlapping lateral span. */
  lo: number;
  hi: number;
  /** Street: hook ids on the midline inside the span (swing balloons). */
  hooks: number[];
};

export type Junction = { roof: number; x: number; y: number; z: number };

export type Candidate = { from: number; to: number; roofs: number[]; links: Link[] };

export type Graph = {
  links: Map<number, Link[]>;
  junctions: Junction[];
  candidates: Candidate[];
};

const centre = (s: Solid) => ({ x: (s.x0 + s.x1) / 2, z: (s.z0 + s.z1) / 2 });

function linkFrom(m: CityModel, e: Adjacency, fromId: number): Link {
  const from = m.solids[fromId];
  const toId = e.a === fromId ? e.b : e.a;
  const to = m.solids[toId];
  const dir: 1 | -1 = e.a === fromId ? 1 : -1;
  const edge = e.axis === "x" ? (dir > 0 ? from.x1 : from.x0) : (dir > 0 ? from.z1 : from.z0);
  const far = e.axis === "x" ? (dir > 0 ? to.x0 : to.x1) : (dir > 0 ? to.z0 : to.z1);
  const hooks: number[] = [];
  if (e.kind === "street") {
    const low = m.solids[e.a];
    const mid = (e.axis === "x" ? low.x1 : low.z1) + e.gap / 2;
    const above = Math.max(from.top, to.top) + GRAPH.swingHookAbove;
    for (const h of m.hooks) {
      const along = e.axis === "x" ? h.x : h.z;
      const lat = e.axis === "x" ? h.z : h.x;
      if (Math.abs(along - mid) > 0.01 || h.y < above || h.src === "sky") continue;
      if (lat < e.lo + GRAPH.streetHookInset || lat > e.hi - GRAPH.streetHookInset) continue;
      hooks.push(h.id);
    }
  }
  const kind: HopKind = e.kind === "alley" && from.top - to.top >= GRAPH.dropMin ? "drop" : e.kind;
  return { kind, from: fromId, to: toId, axis: e.axis, dir, edge, far, lo: e.lo, hi: e.hi, hooks };
}

/** Hop links between landable roofs: alleys with enough overlap, streets with a swing balloon. */
export function buildLinks(m: CityModel): Map<number, Link[]> {
  const links = new Map<number, Link[]>();
  for (const s of m.solids) if (s.landable) links.set(s.id, []);
  for (const e of m.adjacency) {
    const a = m.solids[e.a], b = m.solids[e.b];
    if (!a.landable || !b.landable) continue;
    if (e.kind === "alley" && e.hi - e.lo < GRAPH.alleyMinOverlap) continue;
    for (const id of [e.a, e.b]) {
      const l = linkFrom(m, e, id);
      if (l.kind === "street" && !l.hooks.length) continue;
      const climb = m.solids[l.to].top - m.solids[l.from].top;
      if (climb > (l.kind === "street" ? GRAPH.streetClimbMax : GRAPH.alleyClimbMax)) continue;
      links.get(id)!.push(l);
    }
  }
  for (const list of links.values()) list.sort((p, q) => p.to - q.to);
  return links;
}

/**
 * Round 7 Vertigo graphs (model.config.vertigo): more junctions, sampled far apart in height too (so he has
 * junctions high up and down low), more BFS variants per pair, and the bake keeps edges with drops first.
 */
export const VERTIGO_GRAPH = { junctions: 14, variants: 6, heightW: 2.5, near3d: 3, dropTo: 3, dropBelow: 10 } as const;

/** ~12 junction roofs by seeded farthest-point sampling over the junction candidates. */
export function sampleJunctions(m: CityModel, links: Map<number, Link[]>, seed: number, count: number = GRAPH.junctions, heightW = 0): Junction[] {
  const cands = m.junctionCandidates.filter(id => (links.get(id)?.length ?? 0) >= 3).sort((a, b) => a - b);
  if (!cands.length) return [];
  const rand = mulberry32(seed ^ 0x51ed270b);
  const chosen: number[] = [cands[Math.floor(rand() * cands.length)]];
  const dmin = new Map<number, number>();
  for (const id of cands) dmin.set(id, Infinity);
  while (chosen.length < Math.min(count, cands.length)) {
    const lastS = m.solids[chosen[chosen.length - 1]];
    const last = centre(lastS);
    let best = -1, bestD = -1;
    for (const id of cands) {
      const c = centre(m.solids[id]);
      const dx = c.x - last.x, dz = c.z - last.z, dy = (m.solids[id].top - lastS.top) * heightW;
      const d = Math.min(dmin.get(id)!, dx * dx + dz * dz + dy * dy);
      dmin.set(id, d);
      if (d > bestD) { bestD = d; best = id; }
    }
    if (bestD <= 0) break;
    chosen.push(best);
  }
  return chosen.map(roof => {
    const s = m.solids[roof];
    const c = centre(s);
    return { roof, x: c.x, y: s.top + 0.9, z: c.z };
  });
}

/** Seeded BFS roof path (neighbour order shuffled per visit; dropsFirst: drop links tried first). */
function bfs(links: Map<number, Link[]>, from: number, to: number, rand: () => number, maxHops: number, dropsFirst = false): number[] | null {
  const prev = new Map<number, number>([[from, -1]]);
  let frontier = [from];
  for (let depth = 0; depth < maxHops && frontier.length; depth++) {
    const next: number[] = [];
    for (const r of frontier) {
      const ls = links.get(r)!.slice();
      for (let i = ls.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = ls[i]; ls[i] = ls[j]; ls[j] = t; }
      if (dropsFirst) ls.sort((p, q) => (p.kind === "drop" ? 0 : 1) - (q.kind === "drop" ? 0 : 1));
      for (const l of ls) {
        if (prev.has(l.to)) continue;
        prev.set(l.to, r);
        if (l.to === to) {
          const path = [to];
          let c = r;
          while (c !== -1) { path.push(c); c = prev.get(c)!; }
          return path.reverse();
        }
        next.push(l.to);
      }
    }
    frontier = next;
  }
  return null;
}

export function buildGraph(m: CityModel, seed = m.config?.seed ?? 7): Graph {
  const links = buildLinks(m);
  const vert = !!m.config?.vertigo;
  const junctions = vert ? sampleJunctions(m, links, seed, VERTIGO_GRAPH.junctions, VERTIGO_GRAPH.heightW) : sampleJunctions(m, links, seed);
  const variants = vert ? VERTIGO_GRAPH.variants : GRAPH.variants;
  const rand = mulberry32(seed ^ 0x2c1b3c6d);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  junctions.forEach((ja, ia) => {
    let near = junctions
      .map((jb, ib) => ({ ib, d: (jb.x - ja.x) * (jb.x - ja.x) + (jb.z - ja.z) * (jb.z - ja.z) }))
      .filter(o => o.ib !== ia)
      .sort((p, q) => p.d - q.d || p.ib - q.ib)
      .slice(0, GRAPH.nearest);
    if (vert) {
      // Vertigo: also the nearest junctions counting height (climbs along a ramp) and the nearest ones
      // well below (routes that drop).
      const V = VERTIGO_GRAPH;
      const all = junctions.map((jb, ib) => {
        const dx = jb.x - ja.x, dz = jb.z - ja.z, dy = (jb.y - ja.y) * V.heightW;
        return { ib, d: dx * dx + dz * dz, d3: dx * dx + dz * dz + dy * dy, below: ja.y - jb.y };
      }).filter(o => o.ib !== ia);
      const extra = [
        ...all.slice().sort((p, q) => p.d3 - q.d3 || p.ib - q.ib).slice(0, V.near3d),
        ...all.filter(o => o.below >= V.dropBelow).sort((p, q) => p.d - q.d || p.ib - q.ib).slice(0, V.dropTo),
      ];
      for (const o of extra) if (!near.some(n => n.ib === o.ib)) near = near.concat({ ib: o.ib, d: o.d });
    }
    for (const { ib } of near) {
      for (let v = 0; v < variants; v++) {
        const roofs = bfs(links, ja.roof, junctions[ib].roof, rand, GRAPH.maxHops, vert && v >= variants / 2);
        if (!roofs) continue;
        const hops = roofs.length - 1;
        if (hops < GRAPH.minHops || hops > GRAPH.maxHops) continue;
        const key = roofs.join(",");
        if (seen.has(key)) continue;
        const ls: Link[] = [];
        for (let i = 0; i < hops; i++) ls.push(links.get(roofs[i])!.find(l => l.to === roofs[i + 1])!);
        if (!ls.some(l => l.kind === "street")) continue;
        seen.add(key);
        candidates.push({ from: ia, to: ib, roofs, links: ls });
      }
    }
  });
  return { links, junctions, candidates };
}

// ---- graph checks (test 5) --------------------------------------------------------------------

export type EdgeRef = { from: number; to: number };

/** True when every junction reaches every other along directed edges. */
export function stronglyConnected(n: number, edges: EdgeRef[]): boolean {
  if (n === 0) return false;
  const reach = (fwd: boolean) => {
    const seen = new Set<number>([0]);
    const stack = [0];
    while (stack.length) {
      const j = stack.pop()!;
      for (const e of edges) {
        const [a, b] = fwd ? [e.from, e.to] : [e.to, e.from];
        if (a === j && !seen.has(b)) { seen.add(b); stack.push(b); }
      }
    }
    return seen.size === n;
  };
  return reach(true) && reach(false);
}

/** Every arrival (edge i -> j) has a way on that does not go straight back to i. */
export function forcedUTurns(edges: EdgeRef[]): EdgeRef[] {
  const bad: EdgeRef[] = [];
  for (const e of edges) {
    if (!edges.some(o => o.from === e.to && o.to !== e.from)) bad.push(e);
  }
  return bad;
}
