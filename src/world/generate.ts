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

export function generate(cfg: CityConfig = DEFAULT_CONFIG): { model: CityModel; skyline: DecoBox[] } {
  const layout = generateLayout(cfg);
  return { model: deriveModel(cfg, layout.solids), skyline: layout.skyline };
}
