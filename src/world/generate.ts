// Seeded city generator. Only used by `npm run gen-city` to write a district's first city.json; after that
// city.json is the hand-editable source of truth.
//
// Round 9 (docs/specs/2026-09-25-round9-movement.md §4): the same 2 x 2 block lattice, bigger and taller.
//  - Podiums: each block gets a base height from a smooth field in [roofMin, roofMax]; its buildings are
//    base + a seeded step (cfg.steps), redrawn until every alley step is a hop, a climb or a drop (G2).
//  - Towers: non-landable spines inset from their lot; then the anchor-coverage fix-up (G1) turns the
//    buildings that cover the most bare street edges into towers until every street edge has a solid
//    >= 12 m taller within 34 m (Downtown, Docks, Towers; Market and Vertigo keep their bare stretches).
//  - Wall gaps (G4): a block whose back row is one taller slab with two front roofs flush against its face
//    and an 8-11 m notch between them.
//  - Props (G3): solid rooftop obstacles (vault or climb height), kind "prop".
//  - Docks: crane masts in the quay-side street intersections.
import { hash01, mulberry32 } from "../sim/math.ts";
import type { CityConfig, CityModel, Solid } from "./cityModel.ts";
import { deriveModel, deriveWallGaps, facingPairs, footDist, footGap, RULES, streetEdgePoints, uncoveredPoints } from "./derive.ts";

/** Downtown (Midtown): the classic, now a canyon city. */
export const DEFAULT_CONFIG: CityConfig = {
  seed: 7,
  blocksX: 6,
  blocksZ: 5,
  block: 42,
  street: 22,
  alley: 5,
  building: 18.5,
  mergeChance: 0.1,
  roofMin: 40,
  roofMax: 80,
  roofQuant: 0.5,
  towers: 8,
  towerMin: 140,
  towerMax: 220,
  towerSpread: 80,
  towerInset: 2,
  steps: [0, 0, 0, 1, -1, 2.5, 3.5, -7, -12],
  coverRise: 12,
  coverDist: 34,
  coverFix: true,
  coverTower: [25, 60],
  wallGapChance: 0.2,
  notch: [8, 11],
  wallRise: [4, 12],
  props: 1.5,
  propClimb: 0.35,
  propSet: "city",
  minRoof: 12,
  skylineCount: 56,
  skylineMin: 420,
  skylineMax: 650,
  skylineLow: 80,
  skylineHigh: 300,
};

/** A decorative box (skyline). Centre x/z, ground-rooted, height h. */
export type DecoBox = { x: number; z: number; w: number; d: number; h: number };

export type Layout = { config: CityConfig; solids: Solid[]; skyline: DecoBox[] };

/** Node id of the Milady's stand counter (a solid vault prop; decor.json puts the stand on it). */
export const STAND_NODE = "p-stand";
/** The stand counter: 2.4 m wide, 1.2 m deep, 1.1 m tall; she stands 1.25 m behind its centre. */
export const STAND = { w: 2.4, d: 1.2, h: 1.1, back: 1.25 } as const;

const quant = (v: number, qv: number) => Math.floor(v / qv + 0.5) * qv;
const r2 = (v: number) => Math.round(v * 100) / 100;
const EPS = 1e-6;

/** A G2-legal alley step (hop, climb or drop). */
const stepOk = (d: number) => d <= RULES.climbMax + EPS || d >= RULES.dropMin - EPS;

type Role = "plain" | "merged" | "gapA" | "gapB" | "gapW" | "mast";

export function generateLayout(cfg: CityConfig = DEFAULT_CONFIG): Layout {
  if (cfg.vertigo) return generateVertigo(cfg);
  const rand = mulberry32(cfg.seed);
  const draw = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  const pitch = cfg.block + cfg.street;
  const bw = cfg.building;
  const step = cfg.building + cfg.alley;
  const W = cfg.blocksX * pitch - cfg.street, D = cfg.blocksZ * pitch - cfg.street;
  const minRoof = cfg.minRoof ?? RULES.minRoof;
  const notch = cfg.notch ?? [8, 11];
  const notchHi = Math.min(notch[1], cfg.block - 2 * minRoof);
  const gapChance = notchHi >= notch[0] ? cfg.wallGapChance ?? 0 : 0;

  // 1. Footprints, block by block. `alleys` = pairs of lots facing across an alley (the G2 step rule).
  type Lot = { x0: number; z0: number; x1: number; z1: number; block: number; role: Role };
  const lots: Lot[] = [];
  const blocks: { cx: number; cz: number; lots: number[]; alleys: [number, number][]; gap: boolean }[] = [];
  for (let bz = 0; bz < cfg.blocksZ; bz++) {
    for (let bx = 0; bx < cfg.blocksX; bx++) {
      const ox = bx * pitch, oz = bz * pitch, bi = blocks.length;
      const add = (x0: number, z0: number, x1: number, z1: number, role: Role) => { lots.push({ x0, z0, x1, z1, block: bi, role }); return lots.length - 1; };
      const blk = { cx: ox + cfg.block / 2, cz: oz + cfg.block / 2, lots: [] as number[], alleys: [] as [number, number][], gap: false };
      const r = rand();
      if (r < gapChance) {
        // Wall gap: back row = one taller slab W; the two front roofs absorb the row alley (flush with W's
        // face) and leave an 8-11 m notch between them.
        const alongX = rand() < 0.5, backHigh = rand() < 0.5;
        const n = quant(notch[0] + rand() * (notchHi - notch[0]), 0.5);
        const half = (cfg.block - n) / 2;
        if (alongX) {
          const [f0, f1] = backHigh ? [oz, oz + step] : [oz + bw, oz + cfg.block];
          blk.lots.push(add(ox, backHigh ? oz + step : oz, ox + cfg.block, backHigh ? oz + cfg.block : oz + bw, "gapW"));
          blk.lots.push(add(ox, f0, ox + half, f1, "gapA"), add(ox + cfg.block - half, f0, ox + cfg.block, f1, "gapB"));
        } else {
          const [f0, f1] = backHigh ? [ox, ox + step] : [ox + bw, ox + cfg.block];
          blk.lots.push(add(backHigh ? ox + step : ox, oz, backHigh ? ox + cfg.block : ox + bw, oz + cfg.block, "gapW"));
          blk.lots.push(add(f0, oz, f1, oz + half, "gapA"), add(f0, oz + cfg.block - half, f1, oz + cfg.block, "gapB"));
        }
        blk.gap = true;
      } else if (r < gapChance + cfg.mergeChance) {
        // Merge one pair into a block-long slab: along x (a row) or along z (a column).
        const alongX = rand() < 0.5;
        const which = rand() < 0.5 ? 0 : 1;
        let m: number, s0: number, s1: number;
        if (alongX) {
          m = add(ox, oz + which * step, ox + cfg.block, oz + which * step + bw, "merged");
          s0 = add(ox, oz + (1 - which) * step, ox + bw, oz + (1 - which) * step + bw, "plain");
          s1 = add(ox + step, oz + (1 - which) * step, ox + step + bw, oz + (1 - which) * step + bw, "plain");
        } else {
          m = add(ox + which * step, oz, ox + which * step + bw, oz + cfg.block, "merged");
          s0 = add(ox + (1 - which) * step, oz, ox + (1 - which) * step + bw, oz + bw, "plain");
          s1 = add(ox + (1 - which) * step, oz + step, ox + (1 - which) * step + bw, oz + step + bw, "plain");
        }
        blk.lots.push(m, s0, s1);
        blk.alleys.push([m, s0], [m, s1], [s0, s1]);
      } else {
        const ids: number[] = [];
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) ids.push(add(ox + i * step, oz + j * step, ox + i * step + bw, oz + j * step + bw, "plain"));
        blk.lots.push(...ids);
        blk.alleys.push([ids[0], ids[1]], [ids[0], ids[2]], [ids[1], ids[3]], [ids[2], ids[3]]);
      }
      blocks.push(blk);
    }
  }

  // 2. Podium heights: a smooth seeded field (polynomial bumps, no trig/exp) sampled per block.
  const size = Math.max(W, D);
  const bumps = Array.from({ length: 7 }, () => ({
    x: rand() * W, z: rand() * D, r: (0.2 + rand() * 0.36) * size, w: (rand() < 0.3 ? -0.6 : 1) * (0.5 + rand()),
  }));
  const field = (x: number, z: number) => {
    let f = 0;
    for (const b of bumps) {
      const dx = x - b.x, dz = z - b.z;
      const qv = (dx * dx + dz * dz) / (b.r * b.r);
      if (qv < 1) f += b.w * (1 - qv) * (1 - qv);
    }
    return f;
  };
  // Neighbouring blocks contrast freely (the canyon walls): the field sets the district's shape, a seeded
  // per-block share (podiumJitter) sets the contrast across each street.
  const raw = blocks.map(b => field(b.cx, b.cz));
  const lo = Math.min(...raw), hi = Math.max(...raw);
  const jit = cfg.podiumJitter ?? 0.45;
  const base = raw.map(v => quant(cfg.roofMin + ((1 - jit) * ((v - lo) / (hi - lo || 1)) + jit * rand()) * (cfg.roofMax - cfg.roofMin), cfg.roofQuant));
  const clampRoof = (v: number) => Math.min(RULES.landMax, Math.max(RULES.landMin, v));
  const top = new Array<number>(lots.length).fill(NaN);
  const steps = cfg.steps ?? [0];
  blocks.forEach((blk, bi) => {
    const b0 = base[bi];
    if (blk.gap) {
      const [w, a, b] = blk.lots;
      top[a] = clampRoof(b0 + draw([0, 0, 1, -1]));
      top[b] = clampRoof(top[a] + draw([0, 0, 1, -1]));
      const rise = cfg.wallRise ?? [4, 12];
      top[w] = clampRoof(Math.max(top[a], top[b]) + quant(rise[0] + rand() * (rise[1] - rise[0]), cfg.roofQuant));
      return;
    }
    for (const id of blk.lots) {
      const partners = blk.alleys.filter(p => p[0] === id || p[1] === id).map(p => (p[0] === id ? p[1] : p[0])).filter(o => !Number.isNaN(top[o]));
      let t = NaN;
      for (let k = 0; k < 40 && Number.isNaN(t); k++) {
        const c = b0 + draw(steps);
        if (c < RULES.landMin || c > RULES.landMax) continue;
        if (partners.every(o => stepOk(Math.abs(top[o] - c)))) t = c;
      }
      top[id] = Number.isNaN(t) ? (partners.length ? top[partners[0]] : clampRoof(b0)) : t;
    }
  });
  const solids: Solid[] = lots.map((l, id) => ({ id, kind: "roof", landable: true, x0: l.x0, z0: l.z0, x1: l.x1, z1: l.z1, top: top[id] }));
  const role = (s: Solid): Role => (s.id < lots.length ? lots[s.id].role : "mast");
  const inset = cfg.towerInset ?? 2;
  /** Lot -> tower. A wall-gap block's wall slab keeps its footprint (its face must stay flush: G4). */
  const makeTower = (s: Solid, t: number) => {
    const d = role(s) === "gapW" ? 0 : inset;
    s.kind = "tower";
    s.landable = false;
    s.x0 += d; s.z0 += d; s.x1 -= d; s.z1 -= d;
    s.top = Math.min(RULES.towerTop, quant(t, cfg.roofQuant));
  };

  // 3. Landmark towers in plain lots, spread apart, away from the centre (the sandbox spawn).
  const cx = W / 2, cz = D / 2;
  const spread = cfg.towerSpread ?? 70;
  const towers: Solid[] = [];
  for (let tries = 0; towers.length < cfg.towers && tries < 5000; tries++) {
    const s = solids[Math.floor(rand() * lots.length)];
    if (s.kind !== "roof" || role(s) !== "plain") continue;
    const sx = (s.x0 + s.x1) / 2, sz = (s.z0 + s.z1) / 2;
    if ((sx - cx) * (sx - cx) + (sz - cz) * (sz - cz) < 45 * 45) continue;
    if (towers.some(t => { const dx = (t.x0 + t.x1) / 2 - sx, dz = (t.z0 + t.z1) / 2 - sz; return dx * dx + dz * dz < spread * spread; })) continue;
    makeTower(s, cfg.towerMin + rand() * (cfg.towerMax - cfg.towerMin));
    towers.push(s);
  }

  // 4. Docks: crane masts standing in the street intersections, quay side (+z) first.
  if (cfg.masts) {
    const M = cfg.masts;
    // Checkerboard over the intersections (quay side first), so they spread along both streets.
    const spots: [number, number][] = [];
    for (const parity of [0, 1]) {
      for (let bz = cfg.blocksZ - 1; bz >= 1; bz--) for (let bx = 1; bx < cfg.blocksX; bx++) {
        if ((bx + bz + cfg.blocksZ) % 2 === parity) spots.push([bx * pitch - cfg.street / 2, bz * pitch - cfg.street / 2]);
      }
    }
    for (const [x, z] of spots.slice(0, M.count)) {
      solids.push({ id: solids.length, kind: "tower", landable: false, x0: x - M.size / 2, z0: z - M.size / 2, x1: x + M.size / 2, z1: z + M.size / 2, top: quant(M.min + rand() * (M.max - M.min), cfg.roofQuant) });
    }
  }

  // 5. Anchor coverage (G1): turn the building that covers the most bare street-edge points into a tower of
  // (the highest roof it covers) + coverTower m, until every street edge has an anchor or nothing helps.
  if (cfg.coverFix) {
    const rise = cfg.coverRise ?? RULES.coverRise, dist = cfg.coverDist ?? RULES.coverDist;
    const [c0, c1] = cfg.coverTower ?? [25, 60];
    for (let iter = 0; iter < 400; iter++) {
      const adj = facingPairs(solids);
      const bad = uncoveredPoints(solids, streetEdgePoints(solids, adj, deriveWallGaps(solids, adj)), rise, dist);
      if (!bad.length) break;
      const degree = new Map<number, number>();
      for (const e of adj) if (solids[e.a].landable && solids[e.b].landable) { degree.set(e.a, (degree.get(e.a) ?? 0) + 1); degree.set(e.b, (degree.get(e.b) ?? 0) + 1); }
      // Raising a tower costs no roof, so a tower that can cover a bare point is always taken first.
      let best: Solid | null = null, bestScore = 0, bestDeg = 0, bestTop = 0, bestRaise = false;
      for (const c of solids) {
        const raise = c.kind === "tower" && role(c) !== "mast";
        if (!raise && (c.kind !== "roof" || role(c) === "gapA" || role(c) === "gapB")) continue;
        if (bestRaise && !raise) continue;
        const box = raise || role(c) === "gapW" ? c : { ...c, x0: c.x0 + inset, z0: c.z0 + inset, x1: c.x1 - inset, z1: c.z1 - inset };
        let near = 0, own = 0, maxTop = -Infinity;
        for (const p of bad) {
          if (p.roof === c.id) { own++; continue; }
          if (footDist(p.x, p.z, box) <= dist + EPS) { near++; maxTop = Math.max(maxTop, p.top); }
        }
        if (!near) continue;
        if (raise && maxTop + rise > RULES.towerTop) continue;
        const score = near + own, deg = degree.get(c.id) ?? 0;
        if ((raise && !bestRaise) || score > bestScore || (score === bestScore && deg < bestDeg)) { best = c; bestScore = score; bestDeg = deg; bestTop = maxTop; bestRaise = raise; }
      }
      if (!best) break;
      const lift = c0 + hash01(cfg.seed, 21, best.id, 0) * (c1 - c0);
      if (bestRaise) best.top = Math.min(RULES.towerTop, quant(Math.max(best.top, bestTop + Math.max(lift, rise)), cfg.roofQuant));
      else makeTower(best, Math.max(bestTop + Math.max(lift, rise), best.top + c0));
    }
  }

  repairAlleySteps(solids);
  const props = placeProps(cfg, solids, rand);
  const skyline = skylineRing(cfg, cx, cz, rand);
  return { config: cfg, solids: ordered(solids, props), skyline };
}

/** Solids in city.json order (roofs, towers, props), ids reassigned: generate() ids = round-trip ids. */
function ordered(solids: Solid[], props: Solid[]): Solid[] {
  const out = [...solids.filter(s => s.kind === "roof"), ...solids.filter(s => s.kind === "tower"), ...props];
  return out.map((s, id) => ({ ...s, id }));
}

/**
 * G2 safety net: any alley pair whose step is an awkward 3.5-6 m becomes a climb or a drop by moving one roof
 * (the lower one down to a drop first, then up to a climb, then the higher one), keeping that roof's other
 * alley steps legal. Deterministic (ascending pairs).
 */
export function repairAlleySteps(solids: Solid[]): number {
  let fixed = 0;
  for (let pass = 0; pass < 20; pass++) {
    const adj = facingPairs(solids.filter(s => s.kind !== "prop")).filter(e => e.kind === "alley" && solids[e.a].kind === "roof" && solids[e.b].kind === "roof");
    const partners = new Map<number, number[]>();
    for (const e of adj) { (partners.get(e.a) ?? partners.set(e.a, []).get(e.a)!).push(e.b); (partners.get(e.b) ?? partners.set(e.b, []).get(e.b)!).push(e.a); }
    let changed = false;
    for (const e of adj) {
      const a = solids[e.a], b = solids[e.b];
      if (stepOk(Math.abs(a.top - b.top))) continue;
      const [loS, hiS] = a.top < b.top ? [a, b] : [b, a];
      const options: [Solid, number][] = [[loS, hiS.top - RULES.dropMin], [loS, hiS.top - RULES.climbMax], [hiS, loS.top + RULES.dropMin], [hiS, loS.top + RULES.climbMax]];
      for (const [s, t] of options) {
        if (t < RULES.landMin || t > RULES.landMax) continue;
        if (!(partners.get(s.id) ?? []).every(o => stepOk(Math.abs(solids[o].top - t)))) continue;
        s.top = t;
        changed = true;
        fixed++;
        break;
      }
    }
    if (!changed) break;
  }
  return fixed;
}

type PropDef = { w: number; d: number; h: [number, number] };
/** Rooftop obstacles (what you see is solid): vault 0.8-1.4 m, climb 2.2-3.2 m. The last of each list is
 *  the small fallback that fits a 10-12 m roof's corner. */
const PROP_SETS: Record<"city" | "docks", { vault: PropDef[]; climb: PropDef[] }> = {
  city: {
    // AC unit, duct run, vent box | stair bulkhead, cooling tower, vent stack
    vault: [{ w: 1.6, d: 1.1, h: [1.0, 1.3] }, { w: 2.4, d: 0.9, h: [0.8, 1.0] }, { w: 1.1, d: 1.1, h: [0.8, 1.2] }],
    climb: [{ w: 3.0, d: 2.4, h: [2.6, 3.0] }, { w: 2.4, d: 2.4, h: [2.2, 2.8] }, { w: 1.2, d: 1.2, h: [2.2, 2.6] }],
  },
  docks: {
    // crate, crate pair | container, half container, crate stack
    vault: [{ w: 1.2, d: 1.2, h: [0.9, 1.3] }, { w: 2.4, d: 1.2, h: [0.9, 1.2] }, { w: 1.2, d: 1.2, h: [0.9, 1.3] }],
    climb: [{ w: 6.1, d: 2.4, h: [2.6, 2.6] }, { w: 3.0, d: 2.4, h: [2.6, 2.6] }, { w: 1.2, d: 1.2, h: [2.2, 2.4] }],
  },
};

/**
 * G3 props: the Milady's stand counter on the roof nearest the district centre that fits it, then
 * floor(cfg.props + rand) (<= 3) obstacles per roof, >= 2.5 m inside the edges, >= 3 m from the roof
 * centre (the runner's junction point) and from each other. Climb-height ones also keep off the roof's
 * centre cross (the runner's legs to the edge midpoints).
 */
function placeProps(cfg: CityConfig, solids: Solid[], rand: () => number): Solid[] {
  const out: Solid[] = [];
  const roofs = solids.filter(s => s.kind === "roof");
  if (!roofs.length) return out;
  const set = PROP_SETS[cfg.propSet ?? "city"];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of solids) { x0 = Math.min(x0, s.x0); z0 = Math.min(z0, s.z0); x1 = Math.max(x1, s.x1); z1 = Math.max(z1, s.z1); }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const mid = (s: Solid) => [(s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2];
  const onRoof = new Map<number, Solid[]>();
  let milady: [number, number, number] | null = null;
  const box = (host: Solid, x: number, z: number, w: number, d: number, h: number): Solid =>
    ({ id: -1, kind: "prop", landable: true, x0: r2(x), z0: r2(z), x1: r2(x + w), z1: r2(z + d), top: r2(host.top + h) });
  const fits = (host: Solid, p: Solid, climb: boolean): boolean => {
    if (p.x0 < host.x0 + RULES.propInset - EPS || p.x1 > host.x1 - RULES.propInset + EPS) return false;
    if (p.z0 < host.z0 + RULES.propInset - EPS || p.z1 > host.z1 - RULES.propInset + EPS) return false;
    const [mx, mz] = mid(host);
    if (footDist(mx, mz, p) < RULES.propCentre + 0.05) return false;
    if (climb && ((p.x1 > mx - 1.2 && p.x0 < mx + 1.2) || (p.z1 > mz - 1.2 && p.z0 < mz + 1.2))) return false;
    for (const o of onRoof.get(host.id) ?? []) if (footGap(o, p) < RULES.propApart + 0.05) return false;
    if (milady && milady[0] === host.id && footDist(milady[1], milady[2], p) < 1.5) return false;
    return true;
  };
  const keep = (host: Solid, p: Solid) => {
    out.push(p);
    if (!onRoof.has(host.id)) onRoof.set(host.id, []);
    onRoof.get(host.id)!.push(p);
  };

  // The stand: counter faces the roof centre, offset toward the district centre where it fits.
  const byCentre = roofs.slice().sort((a, b) => {
    const [ax, az] = mid(a), [bx, bz] = mid(b);
    return (ax - cx) ** 2 + (az - cz) ** 2 - ((bx - cx) ** 2 + (bz - cz) ** 2) || a.id - b.id;
  });
  standSearch: for (const host of byCentre) {
    const [mx, mz] = mid(host);
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    dirs.sort((p, q) => (q[0] * (cx - mx) + q[1] * (cz - mz)) - (p[0] * (cx - mx) + p[1] * (cz - mz)));
    for (const [ux, uz] of dirs) {
      const half = ux ? (host.x1 - host.x0) / 2 : (host.z1 - host.z0) / 2;
      const off = Math.min(half - RULES.propInset - STAND.d / 2 - 0.1, 4.5);
      if (off < RULES.propCentre + STAND.d / 2 + 0.1) continue;
      const w = ux ? STAND.d : STAND.w, d = ux ? STAND.w : STAND.d;
      const sx = mx + ux * off, sz = mz + uz * off;
      const p = box(host, sx - w / 2, sz - d / 2, w, d, STAND.h);
      if (!fits(host, p, false)) continue;
      p.node = STAND_NODE;
      keep(host, p);
      milady = [host.id, sx + ux * STAND.back, sz + uz * STAND.back];
      break standSearch;
    }
  }

  const mean = cfg.props ?? 0;
  for (const host of roofs) {
    const n = Math.min(RULES.propPerRoof - (onRoof.get(host.id)?.length ?? 0), Math.floor(mean + rand()));
    for (let k = 0; k < n; k++) {
      const climb = rand() < (cfg.propClimb ?? 0.3);
      const list = climb ? set.climb : set.vault;
      const tryDefs = [pick(list, rand), list[list.length - 1]];
      const hRoll = rand();
      placed: for (const def of tryDefs) {
        const turn = rand() < 0.5;
        const w = turn ? def.d : def.w, d = turn ? def.w : def.d;
        const h = Math.round((def.h[0] + hRoll * (def.h[1] - def.h[0])) * 10) / 10;
        const spanX = host.x1 - host.x0 - 2 * RULES.propInset - w, spanZ = host.z1 - host.z0 - 2 * RULES.propInset - d;
        if (spanX < 0 || spanZ < 0) continue;
        // The four inset corners (shuffled) first - the only spots on a 10-12 m roof - then random spots.
        const spots: [number, number][] = [[0, 0], [spanX, 0], [spanX, spanZ], [0, spanZ]];
        for (let i = 3; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
        for (let t = 0; t < 8; t++) spots.push([Math.floor(rand() * spanX * 10) / 10, Math.floor(rand() * spanZ * 10) / 10]);
        for (const [sx, sz] of spots) {
          const x = host.x0 + RULES.propInset + sx, z = host.z0 + RULES.propInset + sz;
          const p = box(host, x, z, w, d, h);
          if (!fits(host, p, climb)) continue;
          keep(host, p);
          break placed;
        }
      }
    }
  }
  return out;
}

function pick<T>(list: readonly T[], rand: () => number): T {
  return list[Math.floor(rand() * list.length)];
}

/** Skyline ring (decor only, never solid): boxes of skylineLow-High m at skylineMin-Max m from the centre. */
function skylineRing(cfg: CityConfig, cx: number, cz: number, rand: () => number): DecoBox[] {
  const skyline: DecoBox[] = [];
  const lo = cfg.skylineLow ?? 80, hi = cfg.skylineHigh ?? 300;
  while (skyline.length < cfg.skylineCount) {
    const ux = rand() * 2 - 1, uz = rand() * 2 - 1;
    const l = Math.sqrt(ux * ux + uz * uz);
    if (l < 0.2 || l > 1) continue;
    const r = cfg.skylineMin + rand() * (cfg.skylineMax - cfg.skylineMin);
    const w = 20 + rand() * 40, d = 20 + rand() * 40, h = lo + rand() * rand() * (hi - lo);
    skyline.push({ x: quant(cx + (ux / l) * r, 0.5), z: quant(cz + (uz / l) * r, 0.5), w: quant(w, 0.5), d: quant(d, 0.5), h: quant(h, 0.5) });
  }
  return skyline;
}

/** Clockwise ring of building cells (i, j) at depth r in an nx x nz lattice (empty when r is past the middle). */
export function ringCells(nx: number, nz: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  const i0 = r, i1 = nx - 1 - r, j0 = r, j1 = nz - 1 - r;
  if (i0 > i1 || j0 > j1) return out;
  for (let i = i0; i <= i1; i++) out.push([i, j0]);
  for (let j = j0 + 1; j <= j1; j++) out.push([i1, j]);
  if (j1 > j0) for (let i = i1 - 1; i >= i0; i--) out.push([i, j1]);
  if (i1 > i0) for (let j = j1 - 1; j > j0; j--) out.push([i0, j]);
  return out;
}

/**
 * Round 7 "Vertigo" (cfg.vertigo): the block lattice of the grid layout (2 x 2 buildings per block), but
 * every ring of buildings is a helix: walking round ring r (0 = outer) it climbs from rings[r][0] to
 * rings[r][1] in steps the runner can take upward (+alleyStep across an alley, +streetStep across a street,
 * scaled to fit), then drops back to the bottom in one cliff. Neighbouring rings climb in opposite
 * directions from seeded starts, so they cross (two-way hops) in places and stand as tall cliffs (one-way
 * drops, 10-50 m) elsewhere. The core (rings past the list): slim needle towers (round 9: 5 x 150-220 m, the
 * anchors of the descent), empty plazas and summit mesas. Round 9 adds the G2 alley-step repair and solid
 * rooftop props. Seeded from cfg.seed.
 */
export function generateVertigo(cfg: CityConfig): Layout {
  const V = cfg.vertigo!;
  const rand = mulberry32(cfg.seed);
  const pitch = cfg.block + cfg.street, step = cfg.building + cfg.alley, bw = cfg.building;
  const nx = cfg.blocksX * 2, nz = cfg.blocksZ * 2;
  const W = cfg.blocksX * pitch - cfg.street, D = cfg.blocksZ * pitch - cfg.street;
  const x0 = (i: number) => (i >> 1) * pitch + (i & 1) * step;
  const top = new Float64Array(nx * nz).fill(-1);
  const kind: ("roof" | "tower" | "none")[] = new Array(nx * nz).fill("roof");
  // Crossing between lattice neighbours a -> b: alley inside a block, street between blocks.
  const isAlley = (a: [number, number], b: [number, number]) => (a[0] !== b[0] ? Math.min(a[0], b[0]) : Math.min(a[1], b[1])) % 2 === 0;
  const core: number[] = [];
  for (let r = 0; ; r++) {
    const cells = ringCells(nx, nz, r);
    if (!cells.length) break;
    const spec = V.rings[r];
    if (!spec) { for (const [i, j] of cells) core.push(j * nx + i); continue; }
    // Rotate so the cliff sits at a seeded spot; odd rings climb the other way round.
    const s0 = Math.floor(rand() * cells.length);
    let path = cells.slice(s0).concat(cells.slice(0, s0));
    if (r % 2 === 1) path = path.reverse();
    const inc = [0];
    for (let k = 1; k < path.length; k++) inc.push(isAlley(path[k - 1], path[k]) ? V.alleyStep : V.streetStep);
    const total = inc.reduce((a, b) => a + b, 0);
    const scale = Math.min(1, (spec[1] - spec[0]) / (total || 1));
    let h = spec[0];
    path.forEach(([i, j], k) => {
      h += inc[k] * scale;
      top[j * nx + i] = quant(h, cfg.roofQuant);
    });
  }
  // Core: needles (spread apart), plazas, then mesas.
  const pickSpread = (from: number[], n: number): number[] => {
    const out: number[] = [];
    const pool = from.slice();
    while (out.length < n && pool.length) {
      let best = 0, bestD = -1;
      for (let k = 0; k < pool.length; k++) {
        const c = pool[k], ci = c % nx, cj = Math.floor(c / nx);
        const d = out.length ? Math.min(...out.map(o => (o % nx - ci) ** 2 + (Math.floor(o / nx) - cj) ** 2)) + rand() * 0.5 : rand();
        if (d > bestD) { bestD = d; best = k; }
      }
      out.push(pool[best]);
      pool.splice(best, 1);
    }
    return out;
  };
  const needles = pickSpread(core, V.needles);
  const rest = core.filter(c => !needles.includes(c));
  const plazas = pickSpread(rest, V.plazas);
  for (const c of core) {
    if (needles.includes(c)) { kind[c] = "tower"; top[c] = quant(V.needleMin + rand() * (V.needleMax - V.needleMin), cfg.roofQuant); }
    else if (plazas.includes(c)) kind[c] = "none";
    else top[c] = quant(V.mesa[0] + rand() * (V.mesa[1] - V.mesa[0]), cfg.roofQuant);
  }
  const solids: Solid[] = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    if (kind[c] === "none") continue;
    const ax = x0(i), az = x0(j);
    const inset = kind[c] === "tower" ? (bw - V.needleSize) / 2 : 0;
    solids.push({
      id: solids.length, kind: kind[c] as "roof" | "tower", landable: kind[c] === "roof",
      x0: ax + inset, z0: az + inset, x1: ax + bw - inset, z1: az + bw - inset, top: top[c],
    });
  }
  repairAlleySteps(solids);
  const props = placeProps(cfg, solids, rand);
  const skyline = skylineRing(cfg, W / 2, D / 2, rand);
  return { config: cfg, solids: ordered(solids, props), skyline };
}

export function generate(cfg: CityConfig = DEFAULT_CONFIG): { model: CityModel; skyline: DecoBox[] } {
  const layout = generateLayout(cfg);
  return { model: deriveModel(cfg, layout.solids), skyline: layout.skyline };
}
