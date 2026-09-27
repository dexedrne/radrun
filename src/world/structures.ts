// Round 12 structures between the buildings (docs/specs/2026-09-26-round12-spider-tag.md §2): cables across
// every street, sign gantries and skybridges over the canyons, rooftop water tanks and billboard frames, and
// scaffolding / fire escapes on the street facades. Derived BY RULE at level time from the city.json solids (like
// adjacency and wall gaps), so moving a building in the editor and re-running `npm run level` moves them too.
// Every random draw is hash01 of the station's own position (never the iteration order): an edit in one corner
// of the city leaves the rest alone. Pure TS; no allocation concerns (build time), deterministic.
import { hash01 } from "../sim/math.ts";
import type { StructureKnobs, Tuning } from "../sim/tuning.ts";
import { CityIndex, RIG0, bottom, type Adjacency, type CityModel, type FixtureKind, type Rig, type Solid } from "./cityModel.ts";
import { emptyAnchor, findAnchor } from "./cityQuery.ts";

/** A keep-out rectangle on the roofs (decor: the Milady's stand, billboards, antennas, water towers). */
export type KeepOut = { x0: number; z0: number; x1: number; z1: number };

/** Geometry rules for the structures (lint G9-G12). Build-time constants, not tuning. */
export const SRULES = {
  /** Cables / floating fixtures stay this far under the lower roof's top (m). */
  underTop: 3,
  /** No cable this close (m, along the street) to a skybridge or gantry. */
  fixtureClear: 10,
  /** Any two cables on a street at least this far apart (m; G9), and cablePairs 2 needs this much between a pair's two. */
  pairMin: 6,
  /** Floating fixtures: bottom at least this high (m). */
  floatMin: 12,
  /** Street runs: two pairs are on the same street when their centre lines are this close (m) and their gaps overlap. */
  sameStreet: 1.5,
  /** Rooftop fixtures: inset from the roof edge, clearance from the roof centre and from props (m). The spec's 2.5 m inset / 4 m from the
   *  centre lines leave no room on the 12-15 m roofs of the low districts (where the tanks matter most), so tanks sit 1 m in. */
  roofInset: 1,
  roofCentre: 1.5,
  roofApart: 3,
  /** Sizes (m). */
  tank: 3.6,
  boardThick: 0.8,
  boardLen: [8, 12] as const,
  gantryWide: 1.0,
  gantryTall: 1.2,
  bridgeWide: 4,
  bridgeTall: 3.5,
  stackDeep: 1.5,
  stackWide: [6, 10] as const,
  stackShift: 4,
  /** A stack never within this far (m) of a cable end. */
  stackCable: 3,
  /** G12 budget per district. */
  maxRigs: 400,
  maxFixtures: 250,
  /** G11 swing coverage: sample spacing (m), height (x L), speed (m/s), pivot lateral / ahead window (m). */
  covStep: 4,
  covHeight: 0.7,
  covSpeed: 20,
  covLateral: 8,
  covAhead: [12, 32] as const,
} as const;

/** G11 targets per district (%). */
export const COVERAGE_TARGET: Record<string, number> = { downtown: 90, towers: 90, vertigo: 75, docks: 70, market: 60 };

/** One street pair's station: the centre of its overlap span, L = the lower facade top. */
export type Station = {
  pair: number; a: number; b: number; axis: "x" | "z";
  /** a's face (edge) and b's face (far) on the axis; the street centre line; the span; the station's along coordinate. */
  edge: number; far: number; c: number; lo: number; hi: number; s: number; L: number;
};
/** A street run: the stations along one street line (through its crossings), sorted by their along coordinate. */
export type Run = { axis: "x" | "z"; c: number; stations: Station[] };

const EPS = 1e-6;

/** Street runs (§2.2 step 1) from the street pairs. */
export function streetRuns(solids: Solid[], adjacency: Adjacency[]): Run[] {
  const st: Station[] = [];
  adjacency.forEach((e, i) => {
    if (e.kind !== "street") return;
    const a = solids[e.a], b = solids[e.b];
    const edge = e.axis === "x" ? a.x1 : a.z1, far = e.axis === "x" ? b.x0 : b.z0;
    st.push({ pair: i, a: e.a, b: e.b, axis: e.axis, edge, far, c: (edge + far) / 2, lo: e.lo, hi: e.hi, s: (e.lo + e.hi) / 2, L: Math.min(a.top, b.top) });
  });
  // Streets: same axis, centre lines within sameStreet m, overlapping gaps.
  const groups: { axis: "x" | "z"; c: number; edge: number; far: number; list: Station[] }[] = [];
  const sorted = st.slice().sort((p, q) => (p.axis < q.axis ? -1 : p.axis > q.axis ? 1 : 0) || p.c - q.c || p.s - q.s || p.pair - q.pair);
  for (const x of sorted) {
    let g = groups.find(o => o.axis === x.axis && Math.abs(o.c - x.c) <= SRULES.sameStreet && Math.min(o.far, x.far) - Math.max(o.edge, x.edge) > 0.5 * Math.min(o.far - o.edge, x.far - x.edge));
    if (!g) { g = { axis: x.axis, c: x.c, edge: x.edge, far: x.far, list: [] }; groups.push(g); }
    g.list.push(x);
  }
  // A run is the whole street line, crossings included: the city blocks are ~40-60 m long, so a run cut at every
  // crossing would hold 1-2 stations (every station its run's "first or last": all gantries, one cable tier).
  return groups.map(g => mkRun(g.list.sort((p, q) => p.s - q.s || p.pair - q.pair)));
}

const mkRun = (stations: Station[]): Run => ({ axis: stations[0].axis, c: stations.reduce((t, x) => t + x.c, 0) / stations.length, stations });

/** Keep-outs from a decor.json prefab (the stand, billboards, antennas, water towers). Pure JSON walk. */
export function decorKeepOuts(decor: unknown): KeepOut[] {
  const out: KeepOut[] = [];
  type N = { id?: string; components?: Record<string, { properties?: Record<string, unknown> }>; children?: N[] };
  const kindOf = (n: N): string => {
    const d = n.components?.data?.properties?.data as { kind?: string } | undefined;
    return d?.kind ?? (n.id === "balloon-stand" ? "stand" : "");
  };
  const visit = (n: N) => {
    const kind = kindOf(n);
    const t = n.components?.transform?.properties as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
    const p = t?.position;
    if (p && (kind === "billboard" || kind === "stand" || kind === "antenna" || kind === "waterTower" || kind === "ac")) {
      const sc = t?.scale ?? [1, 1, 1];
      let hx = 1.5, hz = 1.5;
      if (kind === "billboard") {
        const w = 7.3 * sc[0] * 0.5 + 1, rot = t?.rotation?.[1] ?? 0;
        const side = Math.abs(Math.sin(rot)) > 0.7;
        hx = side ? 1.5 : w; hz = side ? w : 1.5;
      } else if (kind === "stand") { hx = hz = 2.5; }
      else if (kind === "waterTower") { hx = hz = 1.3 * sc[0] + 0.5; }
      out.push({ x0: p[0] - hx, z0: p[2] - hz, x1: p[0] + hx, z1: p[2] + hz });
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit((decor as { root?: N })?.root ?? {});
  return out;
}

const overlapXZ = (a: { x0: number; z0: number; x1: number; z1: number }, b: { x0: number; z0: number; x1: number; z1: number }, pad = 0) =>
  a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.z0 < b.z1 + pad && a.z1 > b.z0 - pad;

/** Horizontal gap between two rectangles (0 when they touch or overlap). */
function rectGap(a: { x0: number; z0: number; x1: number; z1: number }, b: { x0: number; z0: number; x1: number; z1: number }): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1), dz = Math.max(0, a.z0 - b.z1, b.z0 - a.z1);
  return Math.sqrt(dx * dx + dz * dz);
}

export type Derived = { fixtures: Omit<Solid, "id">[]; rigs: Omit<Rig, "id">[] };

/**
 * §2.2: the structures of a city from its solids and street adjacency. `keepOut` = decor footprints on the roofs,
 * `spawnRoof` = the sandbox spawn roof (never gets a rooftop fixture).
 */
export function deriveStructures(solids: Solid[], adjacency: Adjacency[], knobs: StructureKnobs, keepOut: KeepOut[], seed: number, spawnRoof = -1): Derived {
  const fixtures: Omit<Solid, "id">[] = [];
  const rigs: Omit<Rig, "id">[] = [];
  const H = (x: number, z: number, salt: number) => hash01(seed | 0, Math.round(x * 10), Math.round(z * 10), salt);
  const fixture = (sub: FixtureKind, x0: number, z0: number, x1: number, z1: number, top: number, y0?: number): Omit<Solid, "id"> =>
    ({ kind: "fixture", landable: true, x0: r3(x0), z0: r3(z0), x1: r3(x1), z1: r3(z1), top: r3(top), ...(y0 !== undefined ? { y0: r3(y0) } : {}), sub });
  const cableEnds: { x: number; z: number }[] = [];
  const floating: { axis: "x" | "z"; c: number; lo: number; hi: number }[] = [];

  // Steps 1-3: street runs, their skybridge / gantry, then the cables (clearances need the floating fixtures first).
  for (const run of streetRuns(solids, adjacency)) {
    const n = run.stations.length;
    let bridge = false, gantry = false;
    const fl: { s: number; half: number }[] = [];
    const kind: ("bridge" | "gantry" | "")[] = [];
    run.stations.forEach((x, i) => {
      const sx = run.axis === "x" ? x.c : x.s, sz = run.axis === "x" ? x.s : x.c;
      const span = x.hi - x.lo;
      if (!bridge && x.L >= 30 && span >= 10 && knobs.skybridge > 0 && H(sx, sz, 1) < knobs.skybridge) {
        const y0 = Math.max(SRULES.floatMin, x.L * (knobs.skybridgeLo + (knobs.skybridgeHi - knobs.skybridgeLo) * H(sx, sz, 2)));
        if (y0 + SRULES.bridgeTall <= x.L - SRULES.underTop + EPS) {
          const h = SRULES.bridgeWide / 2;
          fixtures.push(run.axis === "x" ? fixture("skybridge", x.edge, x.s - h, x.far, x.s + h, y0 + SRULES.bridgeTall, y0) : fixture("skybridge", x.s - h, x.edge, x.s + h, x.far, y0 + SRULES.bridgeTall, y0));
          bridge = true; kind[i] = "bridge"; fl.push({ s: x.s, half: h });
          floating.push({ axis: run.axis, c: x.c, lo: x.s - h, hi: x.s + h });
          return;
        }
      }
      if (knobs.gantry && !gantry && x.L >= knobs.gantryMinL && (i === 0 || i === n - 1)) {
        const y0 = knobs.gantryMin + (knobs.gantryMax - knobs.gantryMin) * H(sx, sz, 3);
        if (y0 >= SRULES.floatMin - EPS && y0 + SRULES.gantryTall <= x.L - SRULES.underTop + EPS) {
          const h = SRULES.gantryWide / 2;
          fixtures.push(run.axis === "x" ? fixture("gantry", x.edge, x.s - h, x.far, x.s + h, y0 + SRULES.gantryTall, y0) : fixture("gantry", x.s - h, x.edge, x.s + h, x.far, y0 + SRULES.gantryTall, y0));
          gantry = true; kind[i] = "gantry"; fl.push({ s: x.s, half: h });
          floating.push({ axis: run.axis, c: x.c, lo: x.s - h, hi: x.s + h });
          return;
        }
      }
      kind[i] = "";
    });
    const placed: { s: number; tier: number }[] = [];
    run.stations.forEach((x, i) => {
      if (kind[i]) return;
      // Where this pair's cables go along the street: its span's centre (the spec's one station per pair), or with
      // cablePairs 2 (round 12 fix) both ends of the span, cableInset m in from the corners - a cable on each side of
      // every crossing and alley, so the canyons get one every ~9-26 m instead of every 23-40 m.
      const span = x.hi - x.lo;
      const at = knobs.cablePairs >= 2 && span >= 2 * knobs.cableInset + SRULES.pairMin ? [x.lo + knobs.cableInset, x.hi - knobs.cableInset] : [x.s];
      for (const s of at) {
        const sx = run.axis === "x" ? x.c : s, sz = run.axis === "x" ? s : x.c;
        if (!(knobs.cables > 0 && H(sx, sz, 4) < knobs.cables)) continue;
        const tier = knobs.cableTier2 > 0 ? i % 2 : 0;
        const f = tier === 0 ? knobs.cableTier1 : knobs.cableTier2;
        if (placed.some(p => (p.tier === tier && Math.abs(p.s - s) < knobs.rigApart - EPS) || Math.abs(p.s - s) < SRULES.pairMin - EPS)) continue;
        if (fl.some(q => Math.abs(q.s - s) - q.half < SRULES.fixtureClear)) continue;
        const h = Math.min(Math.max(x.L * f + (2 * H(sx, sz, 5) - 1) * 0.04 * x.L, knobs.cableMin), x.L - SRULES.underTop);
        if (h <= 0) continue;
        const y = r3(h);
        rigs.push(run.axis === "x"
          ? { kind: "cable", ax: r3(x.edge), ay: y, az: r3(s), bx: r3(x.far), by: y, bz: r3(s), sag: knobs.cableSag }
          : { kind: "cable", ax: r3(s), ay: y, az: r3(x.edge), bx: r3(s), by: y, bz: r3(x.far), sag: knobs.cableSag });
        cableEnds.push(run.axis === "x" ? { x: x.edge, z: s } : { x: s, z: x.edge }, run.axis === "x" ? { x: x.far, z: s } : { x: s, z: x.far });
        placed.push({ s, tier });
      }
    });
  }

  // Step 4: rooftop tanks and boards.
  const props = solids.filter(s => s.kind === "prop");
  const streetSides = new Map<number, Map<string, number>>();
  const side = (id: number, key: string, len: number) => {
    if (!streetSides.has(id)) streetSides.set(id, new Map());
    const m = streetSides.get(id)!;
    m.set(key, (m.get(key) ?? 0) + len);
  };
  for (const e of adjacency) {
    if (e.kind !== "street") continue;
    side(e.a, e.axis === "x" ? "x1" : "z1", e.hi - e.lo);
    side(e.b, e.axis === "x" ? "x0" : "z0", e.hi - e.lo);
  }
  for (const r of solids) {
    if (r.kind !== "roof" || r.id === spawnRoof) continue;
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const sides = [...(streetSides.get(r.id) ?? new Map<string, number>()).entries()].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1));
    const longest = sides[0]?.[0] ?? "";
    const onRoof = props.filter(p => p.x0 >= r.x0 - EPS && p.x1 <= r.x1 + EPS && p.z0 >= r.z0 - EPS && p.z1 <= r.z1 + EPS);
    const mine: { x0: number; z0: number; x1: number; z1: number }[] = [];
    const clear = (b: { x0: number; z0: number; x1: number; z1: number }) =>
      b.x0 >= r.x0 + SRULES.roofInset - EPS && b.x1 <= r.x1 - SRULES.roofInset + EPS && b.z0 >= r.z0 + SRULES.roofInset - EPS && b.z1 <= r.z1 - SRULES.roofInset + EPS &&
      rectGap(b, { x0: cx, z0: cz, x1: cx, z1: cz }) >= SRULES.roofCentre - EPS &&
      onRoof.every(p => rectGap(b, p) >= SRULES.roofApart - EPS) && mine.every(p => rectGap(b, p) >= SRULES.roofApart - EPS) &&
      keepOut.every(k => !overlapXZ(b, k));
    if (knobs.tanks > 0 && H(cx, cz, 6) < knobs.tanks) {
      // The corner quadrant farthest from the longest street edge first (then the others, in a seeded order).
      const fx = longest === "x1" ? -1 : longest === "x0" ? 1 : H(cx, cz, 7) < 0.5 ? -1 : 1;
      const other = sides.find(sd => sd[0][0] !== longest[0])?.[0] ?? "";
      const fz = other === "z1" || longest === "z1" ? -1 : other === "z0" || longest === "z0" ? 1 : H(cx, cz, 8) < 0.5 ? -1 : 1;
      const T = SRULES.tank, I = SRULES.roofInset;
      for (const [qx, qz] of [[fx, fz], [fx, -fz], [-fx, fz], [-fx, -fz]]) {
        const x0 = qx < 0 ? r.x0 + I : r.x1 - I - T, z0 = qz < 0 ? r.z0 + I : r.z1 - I - T;
        const b = { x0, z0, x1: x0 + T, z1: z0 + T };
        if (!clear(b)) continue;
        fixtures.push(fixture("tank", b.x0, b.z0, b.x1, b.z1, r.top + knobs.tankLo + (knobs.tankHi - knobs.tankLo) * H(cx, cz, 9)));
        mine.push(b);
        break;
      }
    }
    if (knobs.boards > 0 && longest && H(cx, cz, 10) < knobs.boards) {
      const along = longest[0] === "x" ? "z" : "x";
      const len0 = along === "z" ? r.z1 - r.z0 : r.x1 - r.x0;
      const len = Math.min(SRULES.boardLen[0] + (SRULES.boardLen[1] - SRULES.boardLen[0]) * H(cx, cz, 11), len0 - 2 * SRULES.roofInset - 1);
      if (len >= SRULES.boardLen[0] - EPS) {
        const mid = (along === "z" ? cz : cx) + (2 * H(cx, cz, 12) - 1) * 2;
        const a0 = Math.min(Math.max(mid - len / 2, (along === "z" ? r.z0 : r.x0) + SRULES.roofInset), (along === "z" ? r.z1 : r.x1) - SRULES.roofInset - len);
        const inset = 2.5, t = SRULES.boardThick;
        const e0 = longest === "x1" ? r.x1 - inset - t : longest === "x0" ? r.x0 + inset : longest === "z1" ? r.z1 - inset - t : r.z0 + inset;
        const b = along === "z" ? { x0: e0, z0: a0, x1: e0 + t, z1: a0 + len } : { x0: a0, z0: e0, x1: a0 + len, z1: e0 + t };
        if (clear(b)) {
          fixtures.push(fixture("board", b.x0, b.z0, b.x1, b.z1, r.top + knobs.boardLo + (knobs.boardHi - knobs.boardLo) * H(cx, cz, 13)));
          mine.push(b);
        }
      }
    }
  }

  // Step 5: stacks on the street facades (L >= 25).
  if (knobs.stacks > 0) {
    for (const run of streetRuns(solids, adjacency)) {
      for (const x of run.stations) {
        if (x.L < 25) continue;
        for (const onA of [true, false]) {
          const face = onA ? x.edge : x.far, dir = onA ? 1 : -1;
          const sx = run.axis === "x" ? face : x.s, sz = run.axis === "x" ? x.s : face;
          if (H(sx, sz, 14) >= knobs.stacks) continue;
          const w = SRULES.stackWide[0] + (SRULES.stackWide[1] - SRULES.stackWide[0]) * H(sx, sz, 15);
          const mid = x.s + (2 * H(sx, sz, 16) - 1) * SRULES.stackShift;
          const lo = Math.max(mid - w / 2, x.lo), hi = Math.min(mid + w / 2, x.hi);
          if (hi - lo < SRULES.stackWide[0] - EPS) continue;
          if (cableEnds.some(p => (run.axis === "x" ? Math.abs(p.x - face) < 0.01 && p.z > lo - SRULES.stackCable && p.z < hi + SRULES.stackCable : Math.abs(p.z - face) < 0.01 && p.x > lo - SRULES.stackCable && p.x < hi + SRULES.stackCable))) continue;
          if (floating.some(f => f.axis === run.axis && Math.abs(f.c - x.c) <= SRULES.sameStreet && f.lo < hi && f.hi > lo)) continue;
          const top = x.L - (knobs.stackBelowLo + (knobs.stackBelowHi - knobs.stackBelowLo) * H(sx, sz, 17));
          const d0 = onA ? face : face - SRULES.stackDeep, d1 = onA ? face + SRULES.stackDeep : face;
          void dir;
          fixtures.push(run.axis === "x" ? fixture("stack", d0, lo, d1, hi, top) : fixture("stack", lo, d0, hi, d1, top));
        }
      }
    }
  }
  return { fixtures, rigs };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The point on a rig at chord parameter t (sag included). */
export function rigPoint(g: Rig, t: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  out.x = g.ax + (g.bx - g.ax) * t;
  out.y = g.ay + (g.by - g.ay) * t - 4 * g.sag * t * (1 - t);
  out.z = g.az + (g.bz - g.az) * t;
  return out;
}

// ---- lint G9-G12 + the G11 swing coverage stat ------------------------------------------------------

export type StructureLint = { errors: string[]; warnings: string[]; stats: Record<string, number> };

/** G9 (structures), G10 (clear lines), G12 (budget). Geometry only. */
export function lintStructures(m: CityModel): StructureLint {
  const errors: string[] = [], warnings: string[] = [];
  const S = m.solids, rigs = m.rigs ?? [];
  const fixtures = S.filter(s => s.kind === "fixture");
  const main = S.filter(s => s.kind !== "fixture" && s.kind !== "prop");
  const idx = new CityIndex(m);
  const runs = streetRuns(S, m.adjacency);
  const pairOf = (g: Rig) => m.adjacency.find(e => {
    if (e.kind !== "street") return false;
    const a = S[e.a], b = S[e.b];
    if (e.axis === "x") return Math.abs(g.az - g.bz) < 0.01 && Math.abs(g.ax - a.x1) < 0.01 && Math.abs(g.bx - b.x0) < 0.01 && g.az >= e.lo - EPS && g.az <= e.hi + EPS;
    return Math.abs(g.ax - g.bx) < 0.01 && Math.abs(g.az - a.z1) < 0.01 && Math.abs(g.bz - b.z0) < 0.01 && g.ax >= e.lo - EPS && g.ax <= e.hi + EPS;
  });
  // G9 cables: on the two faces of a street pair, >= underTop under the lower top, apart along their street.
  rigs.forEach((g, i) => {
    const e = pairOf(g);
    if (!e) { errors.push(`G9: cable ${i} does not end on the two faces of a street pair`); return; }
    const L = Math.min(S[e.a].top, S[e.b].top);
    if (Math.max(g.ay, g.by) > L - SRULES.underTop + EPS) errors.push(`G9: cable ${i} is ${(L - Math.max(g.ay, g.by)).toFixed(2)} m under the lower roof (< ${SRULES.underTop})`);
    // G10: nothing but the two end solids on its segment (checked at the sag too).
    const mid = rigPoint(g, 0.5, { x: 0, y: 0, z: 0 });
    if (idx.segmentBlocked(g.ax, g.ay, g.az, mid.x, mid.y, mid.z, e.a, e.b) || idx.segmentBlocked(mid.x, mid.y, mid.z, g.bx, g.by, g.bz, e.a, e.b)) errors.push(`G10: cable ${i} is blocked by a solid`);
  });
  for (const run of runs) {
    const on = rigs.filter(g => { const e = pairOf(g); return e !== undefined && run.stations.some(x => x.pair === m.adjacency.indexOf(e)); })
      .map(g => (run.axis === "x" ? g.az : g.ax)).sort((a, b) => a - b);
    for (let i = 1; i < on.length; i++) if (on[i] - on[i - 1] < 6 - EPS) errors.push(`G9: cables ${(on[i] - on[i - 1]).toFixed(1)} m apart on one street`);
  }
  // G9 fixtures.
  const perRoof = new Map<string, number>();
  let floatN = 0;
  for (const f of fixtures) {
    const y0 = bottom(f);
    const tag = `G9: ${f.sub ?? "fixture"} ${f.id}`;
    if (!(f.x1 > f.x0 && f.z1 > f.z0 && f.top > y0)) { errors.push(`${tag} is degenerate`); continue; }
    if (f.sub === "gantry" || f.sub === "skybridge") {
      floatN++;
      if (y0 < SRULES.floatMin - EPS) errors.push(`${tag} floats at ${y0} m (< ${SRULES.floatMin})`);
      // Flush with both faces of a street pair it crosses.
      const e = m.adjacency.find(p => {
        if (p.kind !== "street") return false;
        const a = S[p.a], b = S[p.b];
        return p.axis === "x" ? Math.abs(f.x0 - a.x1) <= 0.01 && Math.abs(f.x1 - b.x0) <= 0.01 && f.z0 >= p.lo - 0.01 && f.z1 <= p.hi + 0.01
          : Math.abs(f.z0 - a.z1) <= 0.01 && Math.abs(f.z1 - b.z0) <= 0.01 && f.x0 >= p.lo - 0.01 && f.x1 <= p.hi + 0.01;
      });
      if (!e) errors.push(`${tag} is not flush with both faces of a street pair`);
      else if (f.top > Math.min(S[e.a].top, S[e.b].top) - SRULES.underTop + EPS) errors.push(`${tag} reaches within ${SRULES.underTop} m of the lower roof`);
      for (const s of main) if (overlap3(f, s)) errors.push(`G10: ${f.sub} ${f.id} overlaps solid ${s.id}`);
    } else if (f.sub === "tank" || f.sub === "board") {
      const host = S.find(r => r.kind === "roof" && f.x0 >= r.x0 - EPS && f.x1 <= r.x1 + EPS && f.z0 >= r.z0 - EPS && f.z1 <= r.z1 + EPS && r.top < f.top);
      if (!host) { errors.push(`${tag} is not on a roof`); continue; }
      const h = f.top - host.top;
      const band = f.sub === "tank" ? [5, 14] : [4, 12];
      if (h < band[0] - EPS || h > band[1] + EPS) errors.push(`${tag} is ${h.toFixed(2)} m tall (${band.join("-")})`);
      const key = `${host.id}:${f.sub}`;
      perRoof.set(key, (perRoof.get(key) ?? 0) + 1);
      if (perRoof.get(key)! > 1) errors.push(`G9: roof ${host.id} has more than one ${f.sub}`);
      const inset = Math.min(f.x0 - host.x0, host.x1 - f.x1, f.z0 - host.z0, host.z1 - f.z1);
      if (inset < SRULES.roofInset - EPS) errors.push(`${tag} is ${inset.toFixed(2)} m inside roof ${host.id}'s edge (< ${SRULES.roofInset})`);
      for (const s of main) if (s.id !== host.id && overlap3(f, s)) errors.push(`G9: ${f.sub} ${f.id} overlaps solid ${s.id}`);
    } else if (f.sub === "stack") {
      for (const s of main) if (overlap3(f, s)) errors.push(`G9: stack ${f.id} overlaps solid ${s.id}`);
    }
  }
  for (let i = 0; i < fixtures.length; i++) for (let j = i + 1; j < fixtures.length; j++) if (overlap3(fixtures[i], fixtures[j])) errors.push(`G9: fixtures ${fixtures[i].id}/${fixtures[j].id} overlap`);
  for (const run of runs) {
    const inRun = (f: Solid) => run.stations.some(x => (run.axis === "x" ? Math.abs(f.x0 - x.edge) < 0.01 && f.z0 >= x.lo - 0.01 && f.z1 <= x.hi + 0.01 : Math.abs(f.z0 - x.edge) < 0.01 && f.x0 >= x.lo - 0.01 && f.x1 <= x.hi + 0.01));
    const b = fixtures.filter(f => f.sub === "skybridge" && inRun(f)).length, g = fixtures.filter(f => f.sub === "gantry" && inRun(f)).length;
    if (b > 1 || g > 1) errors.push(`G9: a street run has ${b} skybridges and ${g} gantries (at most one each)`);
  }
  // G12 budget.
  if (rigs.length > SRULES.maxRigs) errors.push(`G12: ${rigs.length} rigs (> ${SRULES.maxRigs})`);
  if (fixtures.length > SRULES.maxFixtures) errors.push(`G12: ${fixtures.length} fixtures (> ${SRULES.maxFixtures})`);
  const count = (k: string) => fixtures.filter(f => f.sub === k).length;
  return {
    errors, warnings,
    stats: { cables: rigs.length, gantries: count("gantry"), skybridges: count("skybridge"), tanks: count("tank"), boards: count("board"), stacks: count("stack"), floating: floatN, streetRuns: runs.length },
  };
}

/** 3D box overlap by more than 1 cm on every axis (flush contact is fine). */
function overlap3(a: Solid, b: Solid): boolean {
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  const oy = Math.min(a.top, b.top) - Math.max(bottom(a), bottom(b));
  return ox > 0.01 && oz > 0.01 && oy > 0.01;
}

/**
 * G11 swing coverage (%): along every street run's centre line every covStep m at covHeight x L, both ways, moving
 * at covSpeed: the share of samples where the player's anchor search finds an anchor whose pivot is within
 * covLateral m of the centre line and covAhead m ahead. `withStructures` false = the round 11 baseline (no fixtures,
 * no rigs).
 */
export function swingCoverage(m: CityModel, k: Tuning, withStructures = true): { pct: number; samples: number; hits: number } {
  const model: CityModel = withStructures ? m : { ...m, solids: m.solids.filter(s => s.kind !== "fixture"), rigs: [] };
  const idx = new CityIndex(model);
  const out = emptyAnchor();
  const vel = { x: 0, y: 0, z: 0 };
  let samples = 0, hits = 0;
  for (const run of streetRuns(model.solids, model.adjacency)) {
    const lo = Math.min(...run.stations.map(x => x.lo)), hi = Math.max(...run.stations.map(x => x.hi));
    for (let s = lo; s <= hi + EPS; s += SRULES.covStep) {
      let st = run.stations[0], bd = Infinity;
      for (const x of run.stations) { const d = s < x.lo ? x.lo - s : s > x.hi ? s - x.hi : 0; if (d < bd) { bd = d; st = x; } }
      const y = SRULES.covHeight * st.L;
      for (const dir of [1, -1]) {
        const px = run.axis === "x" ? run.c : s, pz = run.axis === "x" ? s : run.c;
        const fx = run.axis === "x" ? 0 : dir, fz = run.axis === "x" ? dir : 0;
        vel.x = fx * SRULES.covSpeed; vel.z = fz * SRULES.covSpeed;
        samples++;
        if (!findAnchor(idx, px, y, pz, fx, fz, SRULES.covSpeed, k, -1, -1, -1, out, k.aimCos, vel)) continue;
        const lat = run.axis === "x" ? out.px - run.c : out.pz - run.c;
        const ahead = run.axis === "x" ? (out.pz - pz) * dir : (out.px - px) * dir;
        if (Math.abs(lat) <= SRULES.covLateral && ahead >= SRULES.covAhead[0] && ahead <= SRULES.covAhead[1]) hits++;
      }
    }
  }
  return { pct: samples ? (100 * hits) / samples : 0, samples, hits };
}

/** Rig id helpers. */
export const isRig = (id: number): boolean => id >= RIG0;
