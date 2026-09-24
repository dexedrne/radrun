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
} as const;

export type HopKind = "alley" | "street";

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
    for (const h of m.hooks) {
      const along = e.axis === "x" ? h.x : h.z;
      const lat = e.axis === "x" ? h.z : h.x;
      if (Math.abs(along - mid) > 0.01) continue;
      if (lat < e.lo + GRAPH.streetHookInset || lat > e.hi - GRAPH.streetHookInset) continue;
      hooks.push(h.id);
    }
  }
  return { kind: e.kind, from: fromId, to: toId, axis: e.axis, dir, edge, far, lo: e.lo, hi: e.hi, hooks };
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
      links.get(id)!.push(l);
    }
  }
  for (const list of links.values()) list.sort((p, q) => p.to - q.to);
  return links;
}

/** ~12 junction roofs by seeded farthest-point sampling over the junction candidates. */
export function sampleJunctions(m: CityModel, links: Map<number, Link[]>, seed: number, count: number = GRAPH.junctions): Junction[] {
  const cands = m.junctionCandidates.filter(id => (links.get(id)?.length ?? 0) >= 3).sort((a, b) => a - b);
  if (!cands.length) return [];
  const rand = mulberry32(seed ^ 0x51ed270b);
  const chosen: number[] = [cands[Math.floor(rand() * cands.length)]];
  const dmin = new Map<number, number>();
  for (const id of cands) dmin.set(id, Infinity);
  while (chosen.length < Math.min(count, cands.length)) {
    const last = centre(m.solids[chosen[chosen.length - 1]]);
    let best = -1, bestD = -1;
    for (const id of cands) {
      const c = centre(m.solids[id]);
      const dx = c.x - last.x, dz = c.z - last.z;
      const d = Math.min(dmin.get(id)!, dx * dx + dz * dz);
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

/** Seeded BFS roof path (neighbour order shuffled per visit). */
function bfs(links: Map<number, Link[]>, from: number, to: number, rand: () => number, maxHops: number): number[] | null {
  const prev = new Map<number, number>([[from, -1]]);
  let frontier = [from];
  for (let depth = 0; depth < maxHops && frontier.length; depth++) {
    const next: number[] = [];
    for (const r of frontier) {
      const ls = links.get(r)!.slice();
      for (let i = ls.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = ls[i]; ls[i] = ls[j]; ls[j] = t; }
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
  const junctions = sampleJunctions(m, links, seed);
  const rand = mulberry32(seed ^ 0x2c1b3c6d);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  junctions.forEach((ja, ia) => {
    const near = junctions
      .map((jb, ib) => ({ ib, d: (jb.x - ja.x) * (jb.x - ja.x) + (jb.z - ja.z) * (jb.z - ja.z) }))
      .filter(o => o.ib !== ia)
      .sort((p, q) => p.d - q.d || p.ib - q.ib)
      .slice(0, GRAPH.nearest);
    for (const { ib } of near) {
      for (let v = 0; v < GRAPH.variants; v++) {
        const roofs = bfs(links, ja.roof, junctions[ib].roof, rand, GRAPH.maxHops);
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
