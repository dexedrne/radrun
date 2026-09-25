// CityModel (the sim's source of truth, written to public/levels/city.model.json) and CityIndex, a
// 16 m uniform grid over the solids for allocation-free queries. Pure TS; covered by the determinism
// rule (fixed iteration order, sqrt-only maths).

/**
 * roof: a landable building. tower: a solid you can never land on (spines, needles, crane masts).
 * prop (round 9): a rooftop obstacle (AC unit, crate, bulkhead, container stack) - a ground-rooted box
 * inside one roof's footprint, landable, 0.8-1.4 m (vault) or 2.2-3.2 m (climb) above that roof; never in
 * adjacency, junctions, spawn, lowestRoof or anchor coverage (world/derive.ts, lint G3).
 */
export type SolidKind = "roof" | "tower" | "prop";

/** A ground-rooted, unrotated box. y0 is always 0; top = y1. */
export type Solid = {
  id: number;
  kind: SolidKind;
  landable: boolean;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  top: number;
  /** Source node id in city.json (for tooling / editor round trips). */
  node?: string;
};

/** @deprecated Round 9: balloons are gone; `model.hooks` is always []. Deleted at integration. */
export type Hook = {
  id: number; x: number; y: number; z: number;
  /** "sky" (round 7): a high balloon cluster over an intersection / plaza, grabbable from further away. */
  src: "street" | "intersection" | "manual" | "sky";
  /** Grab range override (m; sky hooks). Missing = the tuning's aimRadius. */
  reach?: number;
};

export type Adjacency = {
  a: number;
  b: number;
  kind: "alley" | "street";
  /** Axis the gap is measured along. */
  axis: "x" | "z";
  gap: number;
  /** Overlapping span along the other axis [lo, hi]. */
  lo: number;
  hi: number;
};

/**
 * Round 9 (lint G4): a notch between two roofs lined by a taller wall - the thief's wall-run hop. Derived by
 * rule from the solids (world/derive.ts deriveWallGaps). Listed once; both directions are usable.
 */
export type WallGap = {
  /** Landable roofs; a -> b along +dir on `axis`. */
  a: number;
  b: number;
  /** The taller solid whose face lines the notch. */
  wall: number;
  /** Travel axis. */
  axis: "x" | "z";
  dir: 1 | -1;
  /** a's takeoff edge on the axis. */
  edge: number;
  /** b's near edge on the axis. */
  far: number;
  /** The wall face coordinate on the other axis. */
  face: number;
  /** That face's outward normal sign on the other axis (points into the notch). */
  side: 1 | -1;
};

export type CityConfig = {
  seed: number;
  blocksX: number;
  blocksZ: number;
  block: number;
  street: number;
  alley: number;
  building: number;
  mergeChance: number;
  /** Block podium heights come from a smooth field in [roofMin, roofMax] (round 9). */
  roofMin: number;
  roofMax: number;
  roofQuant: number;
  /** Landmark towers: `towers` spines of towerMin-towerMax m, at least towerSpread m apart. */
  towers: number;
  towerMin: number;
  towerMax: number;
  skylineCount: number;
  skylineMin: number;
  skylineMax: number;
  /** Skyline box heights (decor ring, m; round 9: 80-300). */
  skylineLow?: number;
  skylineHigh?: number;
  /**
   * Round 9 podium steps: each building of a block is the block's base height + one of these (seeded),
   * redrawn until every alley step is a hop (<= 1.2 m), a climb (1.2-3.5 m) or a drop (>= 6 m).
   */
  steps?: number[];
  /** Round 9: share of each block's base height that is seeded per block (the rest is the smooth field). */
  podiumJitter?: number;
  /** Round 9: tower footprints are inset this much from their lot (m). */
  towerInset?: number;
  /** Round 9: min distance between landmark towers (m; default 70). */
  towerSpread?: number;
  /**
   * Round 9 anchor coverage (lint G1): every street-facing roof edge has a solid >= coverRise m taller
   * within coverDist m. `coverFix` turns buildings into towers of roof + coverTower[0..1] m until it holds;
   * `coverWarn` makes a gap a lint warning instead of an error (Market, Vertigo).
   */
  coverRise?: number;
  coverDist?: number;
  coverFix?: boolean;
  coverWarn?: boolean;
  coverTower?: [number, number];
  /** Round 9 wall gaps (G4): chance per block, notch width [min, max] and wall rise [min, max] (m). */
  wallGapChance?: number;
  notch?: [number, number];
  wallRise?: [number, number];
  /** Round 9 solid rooftop props (G3): mean per roof (<= 3), share of climb-height ones, flavour set. */
  props?: number;
  propClimb?: number;
  propSet?: "city" | "docks";
  /** Round 9 runnable roof minimum side (G2; default 12, Market 10). */
  minRoof?: number;
  /** Round 9 Docks: crane masts (4 x 4 m towers) standing in the quay-side street intersections. */
  masts?: { count: number; size: number; min: number; max: number };
  /** Round 7 "Vertigo" layout (generate.ts generateVertigo): roofs on stacked spiral ramps. */
  vertigo?: VertigoLayout;
  /** @deprecated Round 1-8 balloon / clamp settings, ignored since round 9 (kept so old city.json files parse). */
  alleyMaxDh?: number;
  streetMaxDh?: number;
  hookSpacing?: number;
  hookAbove?: number;
  hookClearance?: number;
  autoHooks?: boolean;
  hookGapChance?: number;
  sky?: SkyHooks;
  lowTierDh?: number;
};

/** @deprecated Round 7 sky balloon clusters (removed in round 9). */
export type SkyHooks = { chance: number; min: number; max: number; radius: number; reach: number };

/**
 * Helix rings: building ring r (0 = outer) climbs from rings[r][0] to rings[r][1] m going round the city
 * (+streetStep per street crossing, +alleyStep per alley, scaled down to fit; odd rings the other way
 * round), then drops back in one cliff. Rings past the list are the core: `needles` slim towers, `plazas`
 * empty lots, the rest mesas at `mesa` m.
 */
export type VertigoLayout = {
  rings: [number, number][];
  streetStep: number;
  alleyStep: number;
  needles: number;
  needleMin: number;
  needleMax: number;
  needleSize: number;
  plazas: number;
  mesa: [number, number];
};

export type CityModel = {
  version: 1;
  config: CityConfig;
  bounds: { x0: number; z0: number; x1: number; z1: number };
  lowestRoof: number;
  solids: Solid[];
  /** @deprecated Always [] since round 9 (no balloons); deleted at integration. */
  hooks: Hook[];
  adjacency: Adjacency[];
  /** Round 9 wall-run notches (lint G4). Optional this round; required after integration. */
  wallGaps?: WallGap[];
  /** Non-boundary landable roofs (runner junction candidates, M2; never props). */
  junctionCandidates: number[];
  spawn: { roofId: number; x: number; y: number; z: number; yaw: number };
  hash: string;
};

export const GRID = 16;

/**
 * Uniform-grid index. All queries return solid ids in ascending order so iteration order is fixed.
 * Scratch arrays are owned by the index: a query result is valid until the next query.
 */
export class CityIndex {
  readonly model: CityModel;
  readonly solids: Solid[];
  readonly hooks: Hook[];
  readonly gx0: number;
  readonly gz0: number;
  readonly nx: number;
  readonly nz: number;
  private cellStart: Int32Array;
  private cellItems: Int32Array;
  private stamp: Uint32Array;
  private stampN = 1;
  /** Scratch result buffer for nearbySolids. */
  readonly out: Int32Array;

  constructor(model: CityModel) {
    this.model = model;
    this.solids = model.solids;
    this.hooks = model.hooks;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const s of model.solids) {
      x0 = Math.min(x0, s.x0); z0 = Math.min(z0, s.z0); x1 = Math.max(x1, s.x1); z1 = Math.max(z1, s.z1);
    }
    if (!model.solids.length) { x0 = z0 = 0; x1 = z1 = GRID; }
    this.gx0 = Math.floor(x0 / GRID) * GRID - GRID;
    this.gz0 = Math.floor(z0 / GRID) * GRID - GRID;
    this.nx = Math.floor((x1 - this.gx0) / GRID) + 2;
    this.nz = Math.floor((z1 - this.gz0) / GRID) + 2;
    const cells: number[][] = Array.from({ length: this.nx * this.nz }, () => []);
    for (const s of model.solids) {
      const [ca, cb] = this.cellRange(s.x0, s.x1, this.gx0, this.nx);
      const [ra, rb] = this.cellRange(s.z0, s.z1, this.gz0, this.nz);
      for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) cells[r * this.nx + c].push(s.id);
    }
    this.cellStart = new Int32Array(cells.length + 1);
    let n = 0;
    cells.forEach((list, i) => { this.cellStart[i] = n; n += list.length; });
    this.cellStart[cells.length] = n;
    this.cellItems = new Int32Array(n);
    let k = 0;
    for (const list of cells) for (const id of list.sort((a, b) => a - b)) this.cellItems[k++] = id;
    this.stamp = new Uint32Array(model.solids.length);
    this.out = new Int32Array(Math.max(16, model.solids.length));
  }

  private cellRange(a: number, b: number, g0: number, n: number): [number, number] {
    let lo = Math.floor((a - g0) / GRID), hi = Math.floor((b - g0) / GRID);
    if (lo < 0) lo = 0;
    if (hi > n - 1) hi = n - 1;
    return [lo, hi];
  }

  /** Ids of solids whose grid cells touch the xz rectangle, ascending, in this.out. Returns the count. */
  nearbySolids(x0: number, z0: number, x1: number, z1: number): number {
    let ca = Math.floor((x0 - this.gx0) / GRID), cb = Math.floor((x1 - this.gx0) / GRID);
    let ra = Math.floor((z0 - this.gz0) / GRID), rb = Math.floor((z1 - this.gz0) / GRID);
    if (ca < 0) ca = 0;
    if (ra < 0) ra = 0;
    if (cb > this.nx - 1) cb = this.nx - 1;
    if (rb > this.nz - 1) rb = this.nz - 1;
    this.stampN = (this.stampN + 1) >>> 0;
    if (this.stampN === 0) { this.stamp.fill(0); this.stampN = 1; }
    let count = 0;
    for (let r = ra; r <= rb; r++) {
      for (let c = ca; c <= cb; c++) {
        const cell = r * this.nx + c;
        for (let i = this.cellStart[cell]; i < this.cellStart[cell + 1]; i++) {
          const id = this.cellItems[i];
          if (this.stamp[id] === this.stampN) continue;
          this.stamp[id] = this.stampN;
          // insertion sort keeps the result ascending
          let j = count++;
          while (j > 0 && this.out[j - 1] > id) { this.out[j] = this.out[j - 1]; j--; }
          this.out[j] = id;
        }
      }
    }
    return count;
  }

  /**
   * Parametric t in [0, 1] of the first solid hit by segment a->b, or -1. Solids whose id equals
   * skipA / skipB are ignored (e.g. the roofs the endpoints stand on).
   */
  segmentHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, skipA = -1, skipB = -1): number {
    const n = this.nearbySolids(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz));
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    let best = -1;
    for (let i = 0; i < n; i++) {
      const s = this.solids[this.out[i]];
      if (s.id === skipA || s.id === skipB) continue;
      const t = slab(ax, ay, az, dx, dy, dz, s.x0, 0, s.z0, s.x1, s.top, s.z1);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  }

  segmentBlocked(ax: number, ay: number, az: number, bx: number, by: number, bz: number, skipA = -1, skipB = -1): boolean {
    return this.segmentHit(ax, ay, az, bx, by, bz, skipA, skipB) >= 0;
  }

  /** Entry distance of the last ledgeAlong hit (m along the ray). */
  ledgeT = 0;

  /**
   * Web zip (player): the first landable roof whose footprint the horizontal ray from (x, z) along the
   * unit (dx, dz) enters within `range`, with its top in [yMin, yMax]. A solid entered earlier that rises
   * above yMax (or a non-landable one above yMin) blocks it. `skip` (the roof you stand on) and solids
   * containing the start are ignored. Returns the roof id (entry distance in ledgeT) or -1.
   */
  ledgeAlong(x: number, z: number, dx: number, dz: number, range: number, yMin: number, yMax: number, skip = -1): number {
    const ex = x + dx * range, ez = z + dz * range;
    const n = this.nearbySolids(Math.min(x, ex), Math.min(z, ez), Math.max(x, ex), Math.max(z, ez));
    let best = -1, bestT = Infinity, block = Infinity;
    for (let i = 0; i < n; i++) {
      const s = this.solids[this.out[i]];
      if (s.id === skip) continue;
      if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) continue;
      const t = slab(x, 0, z, ex - x, 0, ez - z, s.x0, -1, s.z0, s.x1, 1, s.z1);
      if (t < 0) continue;
      const d = t * range;
      if (s.top > yMax || (!s.landable && s.top > yMin)) { if (d < block) block = d; continue; }
      if (!s.landable || s.top < yMin) continue;
      if (d < bestT || (d === bestT && s.top > this.solids[best].top)) { bestT = d; best = s.id; }
    }
    if (best >= 0 && bestT >= block) best = -1;
    this.ledgeT = best >= 0 ? bestT : 0;
    return best;
  }

  /** Highest solid top at (x, z) that is <= y + 0.05, or 0 (water / street level). */
  groundBelow(x: number, z: number, y: number): number {
    const n = this.nearbySolids(x, z, x, z);
    let best = 0;
    for (let i = 0; i < n; i++) {
      const s = this.solids[this.out[i]];
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      if (s.top <= y + 0.05 && s.top > best) best = s.top;
    }
    return best;
  }

  /** Solid id whose footprint contains (x, z) and whose top is within 0.05 of y, or -1. */
  roofAt(x: number, z: number, y: number): number {
    const n = this.nearbySolids(x, z, x, z);
    for (let i = 0; i < n; i++) {
      const s = this.solids[this.out[i]];
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      if (Math.abs(s.top - y) <= 0.05) return s.id;
    }
    return -1;
  }
}

/** Slab test: entry t in [0,1] of the ray a + t*d against the box, or -1 (a start inside counts as 0). */
export function slab(
  ax: number, ay: number, az: number, dx: number, dy: number, dz: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): number {
  let tmin = 0, tmax = 1;
  // x
  if (dx === 0) { if (ax < x0 || ax > x1) return -1; } else {
    let t0 = (x0 - ax) / dx, t1 = (x1 - ax) / dx;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return -1;
  }
  if (dy === 0) { if (ay < y0 || ay > y1) return -1; } else {
    let t0 = (y0 - ay) / dy, t1 = (y1 - ay) / dy;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return -1;
  }
  if (dz === 0) { if (az < z0 || az > z1) return -1; } else {
    let t0 = (z0 - az) / dz, t1 = (z1 - az) / dz;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** Distance from a point to a box (0 inside). */
export function pointBoxDist(x: number, y: number, z: number, s: Solid): number {
  const dx = x < s.x0 ? s.x0 - x : x > s.x1 ? x - s.x1 : 0;
  const dy = y < 0 ? -y : y > s.top ? y - s.top : 0;
  const dz = z < s.z0 ? s.z0 - z : z > s.z1 ? z - s.z1 : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
