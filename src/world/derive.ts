// Everything the sim needs that is derived BY RULE from the solids: roof adjacency, wall-run notches
// (round 9), junction candidates, spawn, bounds, lowest roof and the model hash. Used both by the
// generator and by `npm run level` (which reads the hand-editable city.json), so moving a building in
// the editor and re-running `npm run level` re-derives the gameplay layer.
//
// Round 9: no balloons. Web anchors are found at run time on the buildings themselves, so the model only
// has to promise geometry (lintModel, rules G1-G8 of docs/specs/2026-09-25-round9-movement.md §4.3):
// tall solids near every street edge, runnable roofs, solid rooftop props, wall gaps and no hook data.
import { Fnv1a, hash01 } from "../sim/math.ts";
export { hash01 };
import type { Adjacency, CityConfig, CityModel, Solid, WallGap } from "./cityModel.ts";

/** Gap classes for facing roofs. */
export const ALLEY_MAX_GAP = 6;
export const STREET_MIN_GAP = 8;
/** Round 9: the Financial District's avenues are 24 m (+2 m tower setbacks). */
export const STREET_MAX_GAP = 26;
export const MIN_OVERLAP = 4;

/** Round 9 geometry rules (lint G1-G8). Per-district overrides live in CityConfig. */
export const RULES = {
  /** G1: a solid this much taller than a street-facing roof edge ... */
  coverRise: 12,
  /** ... within this horizontal box distance of every point of it (m). */
  coverDist: 34,
  /** G1 sample spacing along an edge (m). */
  coverStep: 2,
  /** G2: alley height steps are hops (<= hopMax), climbs (<= climbMax) or drops (>= dropMin). */
  hopMax: 1.2,
  climbMax: 3.5,
  dropMin: 6,
  minRoof: 12,
  /** G3 props. */
  vault: [0.8, 1.4] as const,
  climb: [2.2, 3.2] as const,
  propInset: 2.5,
  propCentre: 3,
  propApart: 3,
  propPerRoof: 3,
  /** G4 wall gaps. */
  notch: [8, 11] as const,
  wallAbove: 3,
  gapFlat: 1,
  gapSpanSlack: 1,
  /** G6 heights. */
  landMin: 10,
  landMax: 140,
  towerTop: 230,
  /** G7. */
  junctions: 14,
} as const;

const EPS = 1e-6;

/** Horizontal distance from a point to a solid's footprint (0 inside). */
export function footDist(x: number, z: number, s: Solid): number {
  const dx = x < s.x0 ? s.x0 - x : x > s.x1 ? x - s.x1 : 0;
  const dz = z < s.z0 ? s.z0 - z : z > s.z1 ? z - s.z1 : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Horizontal gap between two footprints (0 when they touch or overlap). */
export function footGap(a: Solid, b: Solid): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dz = Math.max(0, a.z0 - b.z1, b.z0 - a.z1);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Facing pairs: two solids separated along one axis with an overlapping span and nothing between. Pass
 *  the non-prop solids (props never take part: G3). */
export function facingPairs(solids: Solid[], maxGap = STREET_MAX_GAP): Adjacency[] {
  const out: Adjacency[] = [];
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i], b = solids[j];
      for (const axis of ["x", "z"] as const) {
        const [a0, a1, b0, b1] = axis === "x" ? [a.x0, a.x1, b.x0, b.x1] : [a.z0, a.z1, b.z0, b.z1];
        const [o0a, o1a, o0b, o1b] = axis === "x" ? [a.z0, a.z1, b.z0, b.z1] : [a.x0, a.x1, b.x0, b.x1];
        let gap: number, lowA: Solid, g0: number;
        if (a1 <= b0) { gap = b0 - a1; lowA = a; g0 = a1; } else if (b1 <= a0) { gap = a0 - b1; lowA = b; g0 = b1; } else continue;
        if (gap <= 0.01 || gap > maxGap) continue;
        const lo = Math.max(o0a, o0b), hi = Math.min(o1a, o1b);
        if (hi - lo < MIN_OVERLAP) continue;
        // Nothing may stand in the gap rectangle.
        let blocked = false;
        for (const s of solids) {
          if (s === a || s === b) continue;
          const [s0, s1, t0, t1] = axis === "x" ? [s.x0, s.x1, s.z0, s.z1] : [s.z0, s.z1, s.x0, s.x1];
          if (s1 > g0 + 0.01 && s0 < g0 + gap - 0.01 && t1 > lo + 0.01 && t0 < hi - 0.01) { blocked = true; break; }
        }
        if (blocked) continue;
        const other = lowA === a ? b : a;
        const kind = gap <= ALLEY_MAX_GAP ? "alley" : gap >= STREET_MIN_GAP ? "street" : null;
        if (!kind) continue;
        out.push({ a: lowA.id, b: other.id, kind, axis, gap, lo, hi });
      }
    }
  }
  return out;
}

/**
 * Round 9 wall gaps (G4), by rule: a street-class adjacency 8-11 m wide between two roofs within 1 m of each
 * other, whose back sides (on the other axis) are flush with the face of one taller solid (>= 3 m above both)
 * that spans the whole notch + 1 m each side. The thief runs along that face from a to b (or back).
 */
export function deriveWallGaps(solids: Solid[], adjacency: Adjacency[]): WallGap[] {
  const out: WallGap[] = [];
  for (const e of adjacency) {
    if (e.kind !== "street" || e.gap < RULES.notch[0] - EPS || e.gap > RULES.notch[1] + EPS) continue;
    const a = solids[e.a], b = solids[e.b];
    if (a.kind !== "roof" || b.kind !== "roof" || Math.abs(a.top - b.top) > RULES.gapFlat + EPS) continue;
    const X = e.axis === "x";
    const edge = X ? a.x1 : a.z1, far = X ? b.x0 : b.z0;
    for (const side of [-1, 1] as const) {
      // side -1: the wall stands on the + side of the other axis and its face looks back (-) into the notch.
      const face = side < 0 ? (X ? a.z1 : a.x1) : (X ? a.z0 : a.x0);
      const fb = side < 0 ? (X ? b.z1 : b.x1) : (X ? b.z0 : b.x0);
      if (Math.abs(face - fb) > 0.01) continue;
      for (const w of solids) {
        if (w.kind === "prop" || w.id === a.id || w.id === b.id) continue;
        const wface = side < 0 ? (X ? w.z0 : w.x0) : (X ? w.z1 : w.x1);
        const t0 = X ? w.x0 : w.z0, t1 = X ? w.x1 : w.z1;
        if (Math.abs(wface - face) > 0.01) continue;
        if (t0 > edge - RULES.gapSpanSlack + EPS || t1 < far + RULES.gapSpanSlack - EPS) continue;
        if (w.top < Math.max(a.top, b.top) + RULES.wallAbove - EPS) continue;
        out.push({ a: a.id, b: b.id, wall: w.id, axis: e.axis, dir: 1, edge, far, face, side });
        break;
      }
    }
  }
  return out;
}

export function modelHash(m: Pick<CityModel, "solids" | "hooks">): string {
  const h = new Fnv1a();
  for (const s of m.solids) h.i32(s.id).str(s.kind).i32(s.landable ? 1 : 0).f64(s.x0).f64(s.z0).f64(s.x1).f64(s.z1).f64(s.top);
  for (const k of m.hooks) {
    h.i32(k.id).f64(k.x).f64(k.y).f64(k.z);
    if (k.reach !== undefined) h.f64(k.reach);
  }
  return h.hex();
}

const q = (v: number) => Math.round(v * 1000) / 1000;

/** Solids (ids reassigned in order) -> the full CityModel. Round 9: `hooks` is always []. */
export function deriveModel(config: CityConfig, input: Solid[]): CityModel {
  const solids = input.map((s, id) => ({ ...s, id }));
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of solids) { x0 = Math.min(x0, s.x0); z0 = Math.min(z0, s.z0); x1 = Math.max(x1, s.x1); z1 = Math.max(z1, s.z1); }
  // Props (G3) never take part in adjacency, junctions, spawn or lowestRoof.
  const main = solids.filter(s => s.kind !== "prop");
  const landable = main.filter(s => s.landable);
  const lowestRoof = Math.min(...landable.map(s => s.top));
  const adjacency = facingPairs(main);
  const wallGaps = deriveWallGaps(solids, adjacency);

  // Junction candidates (M2): landable, not on the district boundary, >= 3 facing neighbours.
  const degree = new Map<number, number>();
  for (const e of adjacency) {
    const a = solids[e.a], b = solids[e.b];
    if (!a.landable || !b.landable) continue;
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  const junctionCandidates = landable
    .filter(s => s.x0 > x0 + 1 && s.z0 > z0 + 1 && s.x1 < x1 - 1 && s.z1 < z1 - 1 && (degree.get(s.id) ?? 0) >= 3)
    .map(s => s.id);

  // Sandbox spawn: the landable roof nearest the district centre, facing its nearest street edge.
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  let spawnRoof = landable[0];
  let bestD = Infinity;
  for (const s of landable) {
    const dx = (s.x0 + s.x1) / 2 - cx, dz = (s.z0 + s.z1) / 2 - cz;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; spawnRoof = s; }
  }
  // yaw convention (camera/rig.ts): forward = (-sin yaw, 0, -cos yaw); literals only.
  let yaw = -1.5707963267948966; // +x
  let bestGap = -1;
  for (const e of adjacency) {
    if (e.kind !== "street" || (e.a !== spawnRoof.id && e.b !== spawnRoof.id)) continue;
    const low = e.a === spawnRoof.id; // spawn roof is on the low side -> street is toward +axis
    if (e.gap > bestGap) {
      bestGap = e.gap;
      yaw = e.axis === "x" ? (low ? -1.5707963267948966 : 1.5707963267948966) : (low ? 3.141592653589793 : 0);
    }
  }
  const spawn = {
    roofId: spawnRoof.id,
    x: q((spawnRoof.x0 + spawnRoof.x1) / 2),
    y: spawnRoof.top + 0.9,
    z: q((spawnRoof.z0 + spawnRoof.z1) / 2),
    yaw,
  };
  const model: CityModel = {
    version: 1,
    config,
    bounds: { x0, z0, x1, z1 },
    lowestRoof,
    solids,
    hooks: [],
    adjacency,
    wallGaps,
    junctionCandidates,
    spawn,
    hash: "",
  };
  model.hash = modelHash(model);
  return model;
}

// ---- anchor coverage (G1; also used by the generator's fix-up) ----------------------------------

export type EdgePoint = { roof: number; x: number; z: number; top: number };

/**
 * Sample points (every coverStep m, both ends) on every street-facing edge of every landable roof. A wall
 * gap's notch (8-11 m, G4) is not a street: its edges are wall-run edges and need no anchor.
 */
export function streetEdgePoints(solids: Solid[], adjacency: Adjacency[], wallGaps: WallGap[] = [], step: number = RULES.coverStep): EdgePoint[] {
  const out: EdgePoint[] = [];
  for (const e of adjacency) {
    if (e.kind !== "street") continue;
    if (wallGaps.some(g => g.a === e.a && g.b === e.b && g.axis === e.axis)) continue;
    for (const id of [e.a, e.b]) {
      const s = solids[id];
      if (s.kind !== "roof") continue;
      const edge = id === e.a ? (e.axis === "x" ? s.x1 : s.z1) : (e.axis === "x" ? s.x0 : s.z0);
      const n = Math.max(1, Math.ceil((e.hi - e.lo) / step - EPS));
      for (let k = 0; k <= n; k++) {
        const t = e.lo + ((e.hi - e.lo) * k) / n;
        out.push(e.axis === "x" ? { roof: id, x: edge, z: t, top: s.top } : { roof: id, x: t, z: edge, top: s.top });
      }
    }
  }
  return out;
}

/** Does solid s give an anchor for edge point p (G1)? Props never count. */
export function covers(s: Solid, p: EdgePoint, rise: number, dist: number): boolean {
  return s.kind !== "prop" && s.id !== p.roof && s.top >= p.top + rise - EPS && footDist(p.x, p.z, s) <= dist + EPS;
}

/** Edge points with no anchor solid (G1). */
export function uncoveredPoints(solids: Solid[], points: EdgePoint[], rise: number, dist: number): EdgePoint[] {
  const tall = solids.filter(s => s.kind !== "prop");
  return points.filter(p => !tall.some(s => covers(s, p, rise, dist)));
}

/** The landable roof a prop stands on (footprint inside, top below), or undefined. */
export function propHost(solids: Solid[], p: Solid): Solid | undefined {
  for (const r of solids) {
    if (r.kind !== "roof" || r.top >= p.top) continue;
    if (p.x0 >= r.x0 - EPS && p.x1 <= r.x1 + EPS && p.z0 >= r.z0 - EPS && p.z1 <= r.z1 + EPS) return r;
  }
  return undefined;
}

// ---- lint (test 4; printed by `npm run level`) --------------------------------------------------

export type LintResult = { errors: string[]; warnings: string[]; stats: Record<string, number> };

const inBand = (v: number, band: readonly [number, number]) => v >= band[0] - EPS && v <= band[1] + EPS;

/** Round 9 geometry rules G1-G8 (docs/specs/2026-09-25-round9-movement.md §4.3). Geometry only. */
export function lintModel(m: CityModel): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cfg = m.config;
  const S = m.solids;
  const roofs = S.filter(s => s.kind === "roof");
  const props = S.filter(s => s.kind === "prop");
  const towers = S.filter(s => s.kind === "tower");

  // G8: unrotated ground-rooted boxes (structural), non-degenerate, non-prop footprints never overlap.
  for (const s of S) if (!(s.x1 > s.x0 && s.z1 > s.z0 && s.top > 0)) errors.push(`G8: solid ${s.id} is degenerate`);
  const main = S.filter(s => s.kind !== "prop");
  for (let i = 0; i < main.length; i++) for (let j = i + 1; j < main.length; j++) {
    const a = main[i], b = main[j];
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
    if (ox > 0.01 && oz > 0.01) errors.push(`G8: solids ${a.id}/${b.id} overlap`);
  }

  // G6: heights.
  for (const s of roofs) if (s.top < RULES.landMin - EPS || s.top > RULES.landMax + EPS) errors.push(`G6: roof ${s.id} top ${s.top} m outside ${RULES.landMin}-${RULES.landMax}`);
  for (const s of towers) if (s.top > RULES.towerTop + EPS) errors.push(`G6: tower ${s.id} top ${s.top} m > ${RULES.towerTop}`);
  for (const s of S) if (s.landable !== (s.kind !== "tower")) errors.push(`G6: solid ${s.id} (${s.kind}) landable=${s.landable}`);

  // G2: runnable roofs and alley steps.
  const minRoof = cfg.minRoof ?? RULES.minRoof;
  for (const s of roofs) {
    if (s.x1 - s.x0 < minRoof - EPS || s.z1 - s.z0 < minRoof - EPS) errors.push(`G2: roof ${s.id} is ${(s.x1 - s.x0).toFixed(1)} x ${(s.z1 - s.z0).toFixed(1)} m (< ${minRoof} x ${minRoof})`);
  }
  let worstAlley = 0, worstStreet = 0, hops = 0, climbs = 0, drops = 0;
  for (const e of m.adjacency) {
    const a = S[e.a], b = S[e.b];
    if (a.kind === "prop" || b.kind === "prop") errors.push(`G3: prop in adjacency ${e.a}/${e.b}`);
    if (a.kind !== "roof" || b.kind !== "roof") continue;
    const dh = Math.abs(a.top - b.top);
    if (e.kind === "street") { worstStreet = Math.max(worstStreet, dh); continue; }
    worstAlley = Math.max(worstAlley, dh);
    if (dh <= RULES.hopMax + EPS) hops++;
    else if (dh <= RULES.climbMax + EPS) climbs++;
    else if (dh >= RULES.dropMin - EPS) drops++;
    else errors.push(`G2: alley roofs ${a.id}/${b.id} differ by ${dh} m (neither a climb <= ${RULES.climbMax} nor a drop >= ${RULES.dropMin})`);
  }

  // G3: props.
  const perHost = new Map<number, Solid[]>();
  for (const p of props) {
    if (!p.landable) errors.push(`G3: prop ${p.id} is not landable`);
    const host = propHost(S, p);
    if (!host) { errors.push(`G3: prop ${p.id} is not inside a roof footprint`); continue; }
    const h = p.top - host.top;
    if (!inBand(h, RULES.vault) && !inBand(h, RULES.climb)) errors.push(`G3: prop ${p.id} is ${h.toFixed(2)} m tall (vault ${RULES.vault.join("-")} or climb ${RULES.climb.join("-")})`);
    const inset = Math.min(p.x0 - host.x0, host.x1 - p.x1, p.z0 - host.z0, host.z1 - p.z1);
    if (inset < RULES.propInset - EPS) errors.push(`G3: prop ${p.id} is ${inset.toFixed(2)} m inside roof ${host.id}'s edge (< ${RULES.propInset})`);
    const dc = footDist((host.x0 + host.x1) / 2, (host.z0 + host.z1) / 2, p);
    if (dc < RULES.propCentre - EPS) errors.push(`G3: prop ${p.id} is ${dc.toFixed(2)} m from roof ${host.id}'s centre (< ${RULES.propCentre})`);
    if (!perHost.has(host.id)) perHost.set(host.id, []);
    perHost.get(host.id)!.push(p);
  }
  for (const [host, list] of perHost) {
    if (list.length > RULES.propPerRoof) errors.push(`G3: roof ${host} has ${list.length} props (> ${RULES.propPerRoof})`);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const g = footGap(list[i], list[j]);
      if (g < RULES.propApart - EPS) errors.push(`G3: props ${list[i].id}/${list[j].id} are ${g.toFixed(2)} m apart (< ${RULES.propApart})`);
    }
  }
  const isProp = (id: number) => S[id]?.kind === "prop";
  if (m.junctionCandidates.some(isProp)) errors.push("G3: a prop is a junction candidate");
  if (isProp(m.spawn.roofId)) errors.push("G3: the spawn roof is a prop");
  if (roofs.length && m.lowestRoof !== Math.min(...S.filter(s => s.landable && s.kind !== "prop").map(s => s.top))) errors.push("G3: lowestRoof counts a prop");

  // G4: wall gaps.
  const gaps = m.wallGaps ?? [];
  for (const g of gaps) {
    const a = S[g.a], b = S[g.b], w = S[g.wall];
    const tag = `G4: wall gap ${g.a}->${g.b} (wall ${g.wall})`;
    if (!a || !b || !w || a.kind !== "roof" || b.kind !== "roof" || w.kind === "prop") { errors.push(`${tag}: bad solids`); continue; }
    if (Math.abs(a.top - b.top) > RULES.gapFlat + EPS) errors.push(`${tag}: roofs differ by ${Math.abs(a.top - b.top)} m`);
    if (w.top < Math.max(a.top, b.top) + RULES.wallAbove - EPS) errors.push(`${tag}: wall only ${(w.top - Math.max(a.top, b.top)).toFixed(1)} m above`);
    const notch = g.far - g.edge;
    if (!inBand(notch, RULES.notch)) errors.push(`${tag}: notch ${notch} m`);
    const X = g.axis === "x";
    const back = (s: Solid) => (g.side < 0 ? (X ? s.z1 : s.x1) : (X ? s.z0 : s.x0));
    const wface = g.side < 0 ? (X ? w.z0 : w.x0) : (X ? w.z1 : w.x1);
    if (Math.abs(back(a) - g.face) > 0.01 || Math.abs(back(b) - g.face) > 0.01 || Math.abs(wface - g.face) > 0.01) errors.push(`${tag}: not flush with the wall face`);
    if ((X ? w.x0 : w.z0) > g.edge - RULES.gapSpanSlack + EPS || (X ? w.x1 : w.z1) < g.far + RULES.gapSpanSlack - EPS) errors.push(`${tag}: the face does not span the notch + 1 m`);
  }
  if ((cfg.wallGapChance ?? 0) > 0 && !gaps.length) warnings.push("G4: wallGapChance > 0 but no wall gaps");

  // G5: no balloons.
  if (m.hooks.length) errors.push(`G5: ${m.hooks.length} hooks (balloons were removed in round 9)`);

  // G7.
  if (m.junctionCandidates.length < RULES.junctions) errors.push(`G7: only ${m.junctionCandidates.length} junction candidates (< ${RULES.junctions})`);

  // G1: anchor coverage.
  const rise = cfg.coverRise ?? RULES.coverRise, dist = cfg.coverDist ?? RULES.coverDist;
  const points = streetEdgePoints(S, m.adjacency, gaps);
  const bad = uncoveredPoints(S, points, rise, dist);
  const badRoofs = [...new Set(bad.map(p => p.roof))].sort((a, b) => a - b);
  if (bad.length) {
    if (cfg.coverWarn || cfg.vertigo) {
      warnings.push(`G1: ${bad.length}/${points.length} street-edge points on ${badRoofs.length} roofs have no solid >= ${rise} m taller within ${dist} m (few-anchor district: run, vault, climb)`);
    } else {
      for (const id of badRoofs) {
        const p = bad.find(b => b.roof === id)!;
        errors.push(`G1: roof ${id} edge point (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) has no solid >= ${rise} m taller within ${dist} m`);
      }
    }
  }

  const tops = roofs.map(s => s.top);
  return {
    errors,
    warnings,
    stats: {
      solids: S.length,
      roofs: roofs.length,
      towers: towers.length,
      props: props.length,
      wallGaps: gaps.length,
      hooks: m.hooks.length,
      adjacency: m.adjacency.length,
      junctionCandidates: m.junctionCandidates.length,
      alleyHops: hops,
      alleyClimbs: climbs,
      alleyDrops: drops,
      worstAlleyDh: worstAlley,
      worstStreetDh: worstStreet,
      lowestRoof: m.lowestRoof,
      highestRoof: tops.length ? Math.max(...tops) : 0,
      tallest: Math.max(...S.map(s => s.top)),
      uncoveredEdgePoints: bad.length,
      edgePoints: points.length,
    },
  };
}
