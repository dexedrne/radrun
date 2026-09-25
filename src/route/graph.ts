// Runner junction graph (spec §7, build time): roof hop links from the city adjacency (+ round 9 wall
// gaps), ~12 junction roofs by seeded farthest-point sampling, and candidate edges (seeded BFS roof paths
// between junctions). Pure TS; the bake (route/bake.ts) turns candidates into validated tracks.
// Round 9 (docs/specs/2026-09-25-round9-movement.md §6.1): street swings carry a baked building anchor
// (findAnchor from the takeoff point), alley steps up to +3.5 m are climbs (ledge grab), wall gaps are
// wall-run hops.
import { mulberry32 } from "../sim/math.ts";
import { RUNNER, type Tuning } from "../sim/tuning.ts";
import { CityIndex, type Adjacency, type CityModel, type Solid } from "../world/cityModel.ts";
import { emptyAnchor, findAnchor, type AnchorHit } from "../world/cityQuery.ts";

export const GRAPH = {
  junctions: 12,
  nearest: 6,
  variants: 4,
  minHops: 3,
  maxHops: 8,
  /** Alley hops need this much overlapping span. */
  alleyMinOverlap: 6,
  /** Round 7: an alley hop down by at least this much is a drop (walk off, fall, land on the lower roof). */
  dropMin: 6,
  /** Round 9: alley steps up to alleyHopMax are hops, up to alleyClimbMax climbs (ledge grab); higher = no link. */
  alleyHopMax: 1.2,
  alleyClimbMax: 3.5,
  /** Street swings climb at most this much, and drop at most streetDropMax. */
  streetClimbMax: 4,
  streetDropMax: 40,
  /** Swing takeoff: the body centre this far behind the edge (the bot jumps there). */
  swingTakeoff: 0.5,
  /** Wall-run hops: the body side this far off the wall face. */
  wallOff: 0.2,
  /** Street swings: at most this many baked anchor options per link (the bake tries them in order). */
  swingOptions: 10,
  /**
   * Zip-up hops (integration): a street / alley neighbour higher than a swing / climb can reach, by up to
   * zipUpMax m across at most zipGapMax m, is reached by a web zip to its near rim (the sim's ledge zip).
   * Without them the tall canyon cities are one-way downhill for him (podium blocks differ by 6-30 m).
   */
  zipUpMax: 32,
  zipGapMax: 26,
  /** A street hop's zip fallback reaches a roof at most this much lower (the zip lasts <= zipMaxTime). */
  zipDownMax: 30,
  /** A swing takeoff in line with its pivot stays this far inside the overlapping span. */
  swingLatInset: 1.5,
  /** Street swings: the first anchor search looks this far past the far edge, this high, with this rope. */
  swingBeyond: 8,
  swingBeyondUp: 26,
  swingBeyondRope: 50,
} as const;

/**
 * alley = jump across; climb (round 9) = jump at a higher roof, the sim's ledge grab + climb finish it;
 * street = web swing across a street on the link's baked building anchor (the spec's "swing"); drop (round 7)
 * = walk off onto a much lower roof; wallrun (round 9) = run along a wall-gap face into the notch; zip
 * (integration) = web zip from the edge up to the higher roof's near rim, then the ledge launch onto it.
 */
export type HopKind = "alley" | "climb" | "street" | "drop" | "wallrun" | "zip";

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
  /** Street swing: the baked anchor (from the takeoff point at the span's centre); zip: the rim point; else null. */
  anchor: AnchorHit | null;
  /**
   * Street / zip: the near rim of `to` at the span's centre (a zip's target). A street hop whose swing options
   * all fail to bake falls back to a zip across onto it (the bake reports that hop as "zip").
   */
  rim: AnchorHit | null;
  /**
   * Street swing: the anchors the bake may try, the first = `anchor` (takeoff lateral x forward +-20 deg;
   * distinct points). The bake keeps the first that gives a release window.
   */
  swings: SwingOption[];
  /** Wall run: the wall solid, its face coordinate on the lateral axis and that face's outward normal sign. */
  wall: number;
  face: number;
  side: 1 | -1;
};

/** A swing takeoff lateral (on the hop's cross axis) and the anchor findAnchor gives from there. */
export type SwingOption = { lat: number; anchor: AnchorHit };

export type Junction = { roof: number; x: number; y: number; z: number };

/** cos / sin 20 deg: the swing anchor search's forward variations (literals: the graph is deterministic). */
const C20 = 0.9396926207859084, S20 = 0.3420201433256687;

export type Candidate = { from: number; to: number; roofs: number[]; links: Link[] };

export type Graph = {
  links: Map<number, Link[]>;
  junctions: Junction[];
  candidates: Candidate[];
};

const centre = (s: Solid) => ({ x: (s.x0 + s.x1) / 2, z: (s.z0 + s.z1) / 2 });

function linkFrom(m: CityModel, e: Adjacency, fromId: number, idx: CityIndex, k: Tuning): Link | null {
  const from = m.solids[fromId];
  const toId = e.a === fromId ? e.b : e.a;
  const to = m.solids[toId];
  const dir: 1 | -1 = e.a === fromId ? 1 : -1;
  const edge = e.axis === "x" ? (dir > 0 ? from.x1 : from.x0) : (dir > 0 ? from.z1 : from.z0);
  const far = e.axis === "x" ? (dir > 0 ? to.x0 : to.x1) : (dir > 0 ? to.z0 : to.z1);
  const dh = to.top - from.top;
  const base = { from: fromId, to: toId, axis: e.axis, dir, edge, far, lo: e.lo, hi: e.hi, anchor: null, rim: null, swings: [], wall: -1, face: 0, side: 1 as const };
  const gap = Math.abs(far - edge);
  // The near rim of `to`, straight across from the span's centre (zip target).
  const rim = emptyAnchor(), mid = (e.lo + e.hi) / 2;
  rim.solid = toId; rim.rim = true; rim.ay = rim.py = to.top;
  if (e.axis === "x") { rim.ax = rim.px = far; rim.az = rim.pz = mid; rim.nx = -dir; } else { rim.az = rim.pz = far; rim.ax = rim.px = mid; rim.nz = -dir; }
  const zipOk = gap <= GRAPH.zipGapMax && dh <= GRAPH.zipUpMax && dh >= -GRAPH.zipDownMax;
  if (dh > (e.kind === "street" ? GRAPH.streetClimbMax : GRAPH.alleyClimbMax)) {
    // Too high to swing or climb: a zip up to the near rim of `to`.
    return zipOk ? { ...base, kind: "zip", anchor: rim, rim } : null;
  }
  if (e.kind === "street") {
    if (dh < -GRAPH.streetDropMax) return null;
    // Baked anchors: findAnchor from takeoff points on the edge (span centre first, then 3 m inside either
    // end), forward = the hop (then +-20 deg), the ideal point at the tuning's distance ahead and then closer
    // (mid-street / the takeoff side: a pivot just off the far facade cannot lift him onto its rim). The bake
    // tries them in order. No anchor at all -> no link.
    const along = edge - dir * GRAPH.swingTakeoff, mid = (e.lo + e.hi) / 2;
    const lats = e.hi - e.lo > 6 ? [mid, e.lo + 3, e.hi - 3] : [mid];
    // Integration: first past the far edge and higher (a crossing pendulum wants its pivot over or beyond the
    // far roof: a tower behind it), then the tuning's point, then mid-street / the takeoff side.
    const aheads = [gap + GRAPH.swingBeyond, -1, gap * 0.5, gap * 0.25];
    const swings: SwingOption[] = [];
    for (const ahead of aheads) {
      const kk = ahead < 0 ? k : ahead > gap ? { ...k, anchorAhead: ahead, anchorAheadPerSpeed: 0, anchorUp: GRAPH.swingBeyondUp, ropeMax: GRAPH.swingBeyondRope } : { ...k, anchorAhead: ahead, anchorAheadPerSpeed: 0 };
      for (const lat of lats) {
        for (const [c, sn] of [[1, 0], [C20, S20], [C20, -S20]]) {
          if (swings.length >= GRAPH.swingOptions) break;
          const x = e.axis === "x" ? along : lat, z = e.axis === "x" ? lat : along;
          // forward = the hop direction rotated by +-20 deg about y
          const hx = e.axis === "x" ? dir : 0, hz = e.axis === "x" ? 0 : dir;
          const fx = hx * c - hz * sn, fz = hx * sn + hz * c;
          const a = emptyAnchor();
          if (!findAnchor(idx, x, from.top + k.halfHeight, z, fx, fz, k.runSpeed, kk, -1, -1, fromId, a)) continue;
          // Integration: take off in line with the pivot (the swing plane along the hop, not diagonally
          // into the facades), when the pivot's lateral lies over the span; then from the searched lateral.
          const plat = e.axis === "x" ? a.pz : a.px;
          const lats2 = plat >= e.lo + GRAPH.swingLatInset && plat <= e.hi - GRAPH.swingLatInset ? [plat, lat] : [lat];
          for (const l2 of lats2) {
            if (swings.length >= GRAPH.swingOptions) break;
            if (swings.some(o => o.anchor.solid === a.solid && o.anchor.ax === a.ax && o.anchor.ay === a.ay && o.anchor.az === a.az && o.lat === l2)) continue;
            swings.push({ lat: l2, anchor: a });
          }
        }
      }
    }
    if (!swings.length && !zipOk) return null;
    return { ...base, kind: "street", anchor: swings[0]?.anchor ?? null, rim: zipOk ? rim : null, swings };
  }
  if (dh <= -GRAPH.dropMin) return { ...base, kind: "drop" };
  return { ...base, kind: dh > GRAPH.alleyHopMax ? "climb" : "alley" };
}

/** Wall-run links from the model's wall gaps (both directions). */
function wallLinks(m: CityModel): Link[] {
  const out: Link[] = [];
  const gaps = m.wallGaps;
  for (const g of gaps) {
    const a = m.solids[g.a], b = m.solids[g.b];
    if (!a || !b || !a.landable || !b.landable) continue;
    const lo = g.axis === "x" ? Math.max(a.z0, b.z0) : Math.max(a.x0, b.x0);
    const hi = g.axis === "x" ? Math.min(a.z1, b.z1) : Math.min(a.x1, b.x1);
    const common = { kind: "wallrun" as const, axis: g.axis, lo, hi, anchor: null, rim: null, swings: [], wall: g.wall, face: g.face, side: g.side };
    out.push({ ...common, from: g.a, to: g.b, dir: g.dir, edge: g.edge, far: g.far });
    out.push({ ...common, from: g.b, to: g.a, dir: g.dir > 0 ? -1 : 1, edge: g.far, far: g.edge });
  }
  return out;
}

/**
 * Hop links between landable roofs: alleys with enough overlap (hops, climbs, drops), streets with a baked
 * swing anchor, and wall gaps. `k` = the runner tuning the anchors are searched with.
 */
export function buildLinks(m: CityModel, k: Tuning = RUNNER): Map<number, Link[]> {
  const links = new Map<number, Link[]>();
  const idx = new CityIndex(m);
  for (const s of m.solids) if (s.landable) links.set(s.id, []);
  for (const e of m.adjacency) {
    const a = m.solids[e.a], b = m.solids[e.b];
    if (!a.landable || !b.landable) continue;
    if (e.kind === "alley" && e.hi - e.lo < GRAPH.alleyMinOverlap) continue;
    for (const id of [e.a, e.b]) {
      const l = linkFrom(m, e, id, idx, k);
      if (l) links.get(id)!.push(l);
    }
  }
  // A wall gap's pair hops by wall run (it replaces any street / alley link between the two roofs).
  for (const l of wallLinks(m)) {
    const list = links.get(l.from);
    if (!list) continue;
    const i = list.findIndex(o => o.to === l.to);
    if (i >= 0) list[i] = l; else list.push(l);
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
      // Zips last: his routes swing / run / climb where they can and zip where they must.
      ls.sort((p, q) => (p.kind === "zip" ? 1 : 0) - (q.kind === "zip" ? 1 : 0));
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

export function buildGraph(m: CityModel, seed = m.config?.seed ?? 7, k: Tuning = RUNNER): Graph {
  const links = buildLinks(m, k);
  const vert = !!m.config?.vertigo;
  const maxHops = m.config?.runnerMaxHops ?? GRAPH.maxHops;
  const junctions = vert ? sampleJunctions(m, links, seed, VERTIGO_GRAPH.junctions, VERTIGO_GRAPH.heightW) : sampleJunctions(m, links, seed, m.config?.runnerJunctions ?? GRAPH.junctions);
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
        const roofs = bfs(links, ja.roof, junctions[ib].roof, rand, maxHops, vert && v >= variants / 2);
        if (!roofs) continue;
        const hops = roofs.length - 1;
        if (hops < GRAPH.minHops || hops > maxHops) continue;
        const key = roofs.join(",");
        if (seen.has(key)) continue;
        const ls: Link[] = [];
        for (let i = 0; i < hops; i++) ls.push(links.get(roofs[i])!.find(l => l.to === roofs[i + 1])!);
        if (!ls.some(l => l.kind === "street" || l.kind === "wallrun" || l.kind === "zip")) continue;
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
