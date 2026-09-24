// Everything the sim needs that is derived BY RULE from the solids: hooks (§6 balloon rule), roof
// adjacency, junction candidates, spawn, bounds, lowest roof and the model hash. Used both by the
// generator and by `npm run level` (which reads the hand-editable city.json), so moving a building in
// the editor and re-running `npm run level` re-derives the gameplay layer.
import { Fnv1a, hash01 } from "../sim/math.ts";
export { hash01 };
import { pointBoxDist, type Adjacency, type CityConfig, type CityModel, type Hook, type Solid } from "./cityModel.ts";

/** Gap classes for facing roofs. */
export const ALLEY_MAX_GAP = 6;
export const STREET_MIN_GAP = 8;
export const STREET_MAX_GAP = 22;
export const MIN_OVERLAP = 4;
/** Lattice slack beyond a facing span, so hooks continue across alley mouths. */
const SPAN_SLACK = 2.5;

export type ManualHook = { x: number; y: number; z: number };

/** Facing pairs: two solids separated along one axis with an overlapping span and nothing between. */
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

const q = (v: number) => Math.round(v * 1000) / 1000;

export function deriveHooks(config: CityConfig, solids: Solid[], adjacency: Adjacency[], manual: ManualHook[]): Hook[] {
  const byId = new Map(solids.map(s => [s.id, s]));
  const cand = new Map<string, { x: number; y: number; z: number; src: Hook["src"]; axis: "x" | "z" | "" }>();
  const put = (x: number, y: number, z: number, src: Hook["src"], axis: "x" | "z" | "" = "") => {
    const key = `${q(x)},${q(z)}`;
    const cur = cand.get(key);
    if (!cur || y > cur.y) cand.set(key, { x: q(x), y: q(y), z: q(z), src: cur?.src === "intersection" ? "intersection" : src, axis: cur?.axis || axis });
  };
  const sp = config.hookSpacing;
  if (config.autoHooks) {
    const midX = new Map<number, number[]>(); // street midline x -> landable tops (streets running along z)
    const midZ = new Map<number, number[]>();
    for (const e of adjacency) {
      if (e.kind !== "street") continue;
      const a = byId.get(e.a)!, b = byId.get(e.b)!;
      const tops = [a, b].filter(s => s.landable).map(s => s.top);
      if (!tops.length) continue;
      const y = Math.max(...tops) + config.hookAbove;
      const mid = (e.axis === "x" ? a.x1 : a.z1) + e.gap / 2;
      const k0 = Math.ceil((e.lo - SPAN_SLACK) / sp), k1 = Math.floor((e.hi + SPAN_SLACK) / sp);
      for (let k = k0; k <= k1; k++) {
        const t = k * sp;
        if (e.axis === "x") put(mid, y, t, "street", "x"); else put(t, y, mid, "street", "z");
      }
      const m = e.axis === "x" ? midX : midZ;
      const key = q(mid);
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(...tops);
    }
    // Intersections: crossings of a street midline in x with one in z, clear of every footprint,
    // with landable corner roofs in at least three quadrants nearby.
    for (const X of [...midX.keys()].sort((a, b) => a - b)) {
      for (const Z of [...midZ.keys()].sort((a, b) => a - b)) {
        let inside = false;
        for (const s of solids) if (X > s.x0 - 2 && X < s.x1 + 2 && Z > s.z0 - 2 && Z < s.z1 + 2) { inside = true; break; }
        if (inside) continue;
        const quads = [-Infinity, -Infinity, -Infinity, -Infinity];
        for (const s of solids) {
          if (!s.landable) continue;
          const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
          const dx = X < s.x0 ? s.x0 - X : X > s.x1 ? X - s.x1 : 0;
          const dz = Z < s.z0 ? s.z0 - Z : Z > s.z1 ? Z - s.z1 : 0;
          if (dx > STREET_MAX_GAP / 2 + 1 || dz > STREET_MAX_GAP / 2 + 1) continue;
          const qi = (cx < X ? 0 : 1) + (cz < Z ? 0 : 2);
          quads[qi] = Math.max(quads[qi], s.top);
        }
        const found = quads.filter(v => v > -Infinity);
        if (found.length < 3) continue;
        put(X, Math.max(...found) + config.hookAbove, Z, "intersection");
      }
    }
  }
  // Balloon-free gaps (round 4): drop every street balloon of a chosen street segment (one pitch of one
  // street midline); intersection balloons stay. Integer hash of (seed, midline, segment) - no rng state.
  const gapChance = config.hookGapChance ?? 0;
  if (gapChance > 0) {
    const pitch = config.block + config.street;
    for (const [key, c] of cand) {
      if (c.src !== "street" || !c.axis) continue;
      const mid = c.axis === "x" ? c.x : c.z, along = c.axis === "x" ? c.z : c.x;
      const seg = Math.floor(along / pitch);
      if (hash01(config.seed, c.axis === "x" ? 1 : 2, Math.round(mid * 2), seg) < gapChance) cand.delete(key);
    }
  }
  // Manual hooks (Data kind "hook" in city.json) replace any auto hook within 3 m horizontally.
  for (const m of manual) {
    for (const [key, c] of cand) {
      const dx = c.x - m.x, dz = c.z - m.z;
      if (dx * dx + dz * dz < 9) cand.delete(key);
    }
  }
  const list = [...cand.values()].filter(h => {
    for (const s of solids) if (pointBoxDist(h.x, h.y, h.z, s) < config.hookClearance) return false;
    return true;
  });
  for (const m of manual) list.push({ x: q(m.x), y: q(m.y), z: q(m.z), src: "manual", axis: "" });
  list.sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y);
  return list.map((h, id) => ({ id, x: h.x, y: h.y, z: h.z, src: h.src }));
}

export function modelHash(m: Pick<CityModel, "solids" | "hooks">): string {
  const h = new Fnv1a();
  for (const s of m.solids) h.i32(s.id).str(s.kind).i32(s.landable ? 1 : 0).f64(s.x0).f64(s.z0).f64(s.x1).f64(s.z1).f64(s.top);
  for (const k of m.hooks) h.i32(k.id).f64(k.x).f64(k.y).f64(k.z);
  return h.hex();
}

/** Solids (ids reassigned in order) + manual hooks -> the full CityModel. */
export function deriveModel(config: CityConfig, input: Solid[], manual: ManualHook[] = []): CityModel {
  const solids = input.map((s, id) => ({ ...s, id }));
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of solids) { x0 = Math.min(x0, s.x0); z0 = Math.min(z0, s.z0); x1 = Math.max(x1, s.x1); z1 = Math.max(z1, s.z1); }
  const landable = solids.filter(s => s.landable);
  const lowestRoof = Math.min(...landable.map(s => s.top));
  const adjacency = facingPairs(solids);
  const hooks = deriveHooks(config, solids, adjacency, manual);

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
    hooks,
    adjacency,
    junctionCandidates,
    spawn,
    hash: "",
  };
  model.hash = modelHash(model);
  return model;
}

// ---- lint (test 4; printed by `npm run level`) --------------------------------------------------

export type LintResult = { errors: string[]; warnings: string[]; stats: Record<string, number> };

export function lintModel(m: CityModel, aimRadius = 17): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cfg = m.config;
  let worstAlley = 0, worstStreet = 0, worstReach = 0;
  for (const e of m.adjacency) {
    const a = m.solids[e.a], b = m.solids[e.b];
    if (!a.landable || !b.landable) continue;
    const dh = Math.abs(a.top - b.top);
    if (e.kind === "alley") {
      worstAlley = Math.max(worstAlley, dh);
      if (dh > cfg.alleyMaxDh + 1e-9) errors.push(`alley roofs ${a.id}/${b.id} differ by ${dh} m (> ${cfg.alleyMaxDh})`);
    } else {
      worstStreet = Math.max(worstStreet, dh);
      if (dh > cfg.streetMaxDh + 1e-9) errors.push(`street roofs ${a.id}/${b.id} differ by ${dh} m (> ${cfg.streetMaxDh})`);
    }
  }
  for (const h of m.hooks) {
    for (const s of m.solids) {
      const d = pointBoxDist(h.x, h.y, h.z, s);
      if (d < cfg.hookClearance - 1e-9) errors.push(`hook ${h.id} is ${d.toFixed(2)} m from solid ${s.id}`);
    }
  }
  for (const s of m.solids) {
    if (!(s.x1 > s.x0 && s.z1 > s.z0 && s.top > 0)) errors.push(`solid ${s.id} is degenerate`);
  }
  // Reach: every street-facing roof edge has a hook within aimRadius - 0.5 of a standing takeoff point.
  const reach = aimRadius - 0.5;
  for (const e of m.adjacency) {
    if (e.kind !== "street") continue;
    for (const id of [e.a, e.b]) {
      const s = m.solids[id];
      if (!s.landable) continue;
      const edge = id === e.a ? (e.axis === "x" ? s.x1 : s.z1) : (e.axis === "x" ? s.x0 : s.z0);
      for (let t = e.lo + 0.5; t <= e.hi - 0.5 + 1e-9; t += 1) {
        const px = e.axis === "x" ? edge : t, pz = e.axis === "x" ? t : edge, py = s.top + 0.9;
        let best = Infinity;
        for (const h of m.hooks) {
          if (h.y < py + 1) continue;
          const dx = h.x - px, dy = h.y - py, dz = h.z - pz;
          best = Math.min(best, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        worstReach = Math.max(worstReach, best);
        if (best > reach) {
          // Districts with balloon-free gaps (round 4) break reach on purpose: warn, don't fail.
          ((cfg.hookGapChance ?? 0) > 0 ? warnings : errors).push(`reach: roof ${s.id} edge point (${px.toFixed(1)}, ${pz.toFixed(1)}) nearest hook ${best.toFixed(2)} m > ${reach}`);
          break;
        }
      }
    }
  }
  if (m.hooks.length < 50) warnings.push(`only ${m.hooks.length} hooks`);
  return {
    errors,
    warnings,
    stats: {
      solids: m.solids.length,
      roofs: m.solids.filter(s => s.landable).length,
      towers: m.solids.filter(s => s.kind === "tower").length,
      hooks: m.hooks.length,
      adjacency: m.adjacency.length,
      junctionCandidates: m.junctionCandidates.length,
      worstAlleyDh: worstAlley,
      worstStreetDh: worstStreet,
      worstReach: Math.round(worstReach * 100) / 100,
      lowestRoof: m.lowestRoof,
    },
  };
}
