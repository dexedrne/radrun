// Seeded city generator (spec §6): 6 x 5 blocks of 2 x 2 roofs, smooth roof-height field with alley /
// street clamps, landmark towers and a skyline ring. Only used by `npm run gen-city` to write the
// first city.json; after that city.json is the hand-editable source of truth.
import { mulberry32 } from "../sim/math.ts";
import type { CityConfig, CityModel, Solid } from "./cityModel.ts";
import { deriveModel, facingPairs } from "./derive.ts";

export const DEFAULT_CONFIG: CityConfig = {
  seed: 7,
  blocksX: 6,
  blocksZ: 5,
  block: 28,
  street: 14,
  alley: 4,
  building: 12,
  mergeChance: 0.1,
  roofMin: 24,
  roofMax: 34,
  roofQuant: 0.5,
  alleyMaxDh: 1.0,
  streetMaxDh: 4,
  towers: 6,
  towerMin: 50,
  towerMax: 70,
  hookSpacing: 7,
  hookAbove: 10,
  hookClearance: 2,
  autoHooks: true,
  skylineCount: 40,
  skylineMin: 250,
  skylineMax: 400,
};

/** A decorative box (skyline). Centre x/z, ground-rooted, height h. */
export type DecoBox = { x: number; z: number; w: number; d: number; h: number };

export type Layout = { config: CityConfig; solids: Solid[]; skyline: DecoBox[] };

const quant = (v: number, qv: number) => Math.floor(v / qv + 0.5) * qv;

export function generateLayout(cfg: CityConfig = DEFAULT_CONFIG): Layout {
  if (cfg.vertigo) return generateVertigo(cfg);
  const rand = mulberry32(cfg.seed);
  const pitch = cfg.block + cfg.street;
  const bw = cfg.building;
  const step = cfg.building + cfg.alley;
  const W = cfg.blocksX * pitch - cfg.street, D = cfg.blocksZ * pitch - cfg.street;

  // Footprints.
  type Slot = { x0: number; z0: number; x1: number; z1: number; merged: boolean };
  const slots: Slot[] = [];
  for (let bz = 0; bz < cfg.blocksZ; bz++) {
    for (let bx = 0; bx < cfg.blocksX; bx++) {
      const ox = bx * pitch, oz = bz * pitch;
      const r = rand();
      if (r < cfg.mergeChance) {
        // Merge one pair into a 28 x 12 slab: along x (a row) or along z (a column).
        const alongX = rand() < 0.5;
        const which = rand() < 0.5 ? 0 : 1;
        if (alongX) {
          slots.push({ x0: ox, z0: oz + which * step, x1: ox + cfg.block, z1: oz + which * step + bw, merged: true });
          for (let i = 0; i < 2; i++) slots.push({ x0: ox + i * step, z0: oz + (1 - which) * step, x1: ox + i * step + bw, z1: oz + (1 - which) * step + bw, merged: false });
        } else {
          slots.push({ x0: ox + which * step, z0: oz, x1: ox + which * step + bw, z1: oz + cfg.block, merged: true });
          for (let j = 0; j < 2; j++) slots.push({ x0: ox + (1 - which) * step, z0: oz + j * step, x1: ox + (1 - which) * step + bw, z1: oz + j * step + bw, merged: false });
        }
      } else {
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
          slots.push({ x0: ox + i * step, z0: oz + j * step, x1: ox + i * step + bw, z1: oz + j * step + bw, merged: false });
        }
      }
    }
  }

  // Smooth seeded height field: sum of polynomial bumps (no trig/exp), normalised to [0, 1].
  const bumps = Array.from({ length: 7 }, () => ({
    x: rand() * W, z: rand() * D, r: 50 + rand() * 90, w: (rand() < 0.3 ? -0.6 : 1) * (0.5 + rand()),
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
  const raw = slots.map(s => field((s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2) + rand() * 0.08);
  const lo = Math.min(...raw), hi = Math.max(...raw);
  const solids: Solid[] = slots.map((s, id) => ({
    id,
    kind: "roof",
    landable: true,
    x0: s.x0, z0: s.z0, x1: s.x1, z1: s.z1,
    top: quant(cfg.roofMin + ((raw[id] - lo) / (hi - lo || 1)) * (cfg.roofMax - cfg.roofMin), cfg.roofQuant),
  }));

  // Clamp: lower the higher roof of any violating pair until every pair is within its limit.
  const pairs = facingPairs(solids);
  for (let iter = 0; iter < 1000; iter++) {
    let changed = false;
    for (const e of pairs) {
      const a = solids[e.a], b = solids[e.b];
      const lim = e.kind === "alley" ? cfg.alleyMaxDh : cfg.streetMaxDh;
      if (Math.abs(a.top - b.top) <= lim + 1e-9) continue;
      const [hiS, loS] = a.top > b.top ? [a, b] : [b, a];
      hiS.top = loS.top + lim;
      changed = true;
    }
    if (!changed) break;
  }

  // Landmark towers in plain building slots, spread apart, away from the centre (the sandbox spawn).
  const cx = W / 2, cz = D / 2;
  const towers: Solid[] = [];
  for (let tries = 0; towers.length < cfg.towers && tries < 5000; tries++) {
    const i = Math.floor(rand() * solids.length);
    const s = solids[i];
    if (s.kind === "tower" || slots[i].merged) continue;
    const sx = (s.x0 + s.x1) / 2, sz = (s.z0 + s.z1) / 2;
    if ((sx - cx) * (sx - cx) + (sz - cz) * (sz - cz) < 45 * 45) continue;
    if (towers.some(t => { const dx = (t.x0 + t.x1) / 2 - sx, dz = (t.z0 + t.z1) / 2 - sz; return dx * dx + dz * dz < 70 * 70; })) continue;
    s.kind = "tower";
    s.landable = false;
    s.top = quant(cfg.towerMin + rand() * (cfg.towerMax - cfg.towerMin), cfg.roofQuant);
    towers.push(s);
  }

  // Skyline ring (decor only, never solid).
  const skyline: DecoBox[] = [];
  while (skyline.length < cfg.skylineCount) {
    const ux = rand() * 2 - 1, uz = rand() * 2 - 1;
    const l = Math.sqrt(ux * ux + uz * uz);
    if (l < 0.2 || l > 1) continue;
    const r = cfg.skylineMin + rand() * (cfg.skylineMax - cfg.skylineMin);
    const w = 18 + rand() * 34, d = 18 + rand() * 34, h = 30 + rand() * 90;
    skyline.push({ x: quant(cx + (ux / l) * r, 0.5), z: quant(cz + (uz / l) * r, 0.5), w: quant(w, 0.5), d: quant(d, 0.5), h: quant(h, 0.5) });
  }
  return { config: cfg, solids, skyline };
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
 * drops, 10-50 m) elsewhere. The core (rings past the list): a few slim needle towers, empty plazas and
 * summit mesas. Seeded from cfg.seed.
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
  // Skyline ring (decor only), as the grid layout.
  const cx = W / 2, cz = D / 2;
  const skyline: DecoBox[] = [];
  while (skyline.length < cfg.skylineCount) {
    const ux = rand() * 2 - 1, uz = rand() * 2 - 1;
    const l = Math.sqrt(ux * ux + uz * uz);
    if (l < 0.2 || l > 1) continue;
    const rr = cfg.skylineMin + rand() * (cfg.skylineMax - cfg.skylineMin);
    const w = 14 + rand() * 24, d = 14 + rand() * 24, hh = 60 + rand() * 160;
    skyline.push({ x: quant(cx + (ux / l) * rr, 0.5), z: quant(cz + (uz / l) * rr, 0.5), w: quant(w, 0.5), d: quant(d, 0.5), h: quant(hh, 0.5) });
  }
  return { config: cfg, solids, skyline };
}

export function generate(cfg: CityConfig = DEFAULT_CONFIG): { model: CityModel; skyline: DecoBox[] } {
  const layout = generateLayout(cfg);
  return { model: deriveModel(cfg, layout.solids), skyline: layout.skyline };
}
