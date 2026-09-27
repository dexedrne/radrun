// The online join self-test (multiplayer design §3.6): a bundled 600-step, two-Radbro Spider-tag fixture on a small synthetic
// city with the built-in movement defaults. It must hash to SELFTEST_HASH in every browser that plays online; a
// browser whose maths rounds differently fails here (about a millisecond) instead of desyncing a match. The ?bench
// page prints it too (Chromium, Firefox, Safari on a real iPhone: design gate 3).
import type { CityModel, Solid } from "../world/cityModel.ts";
import { mulberry32 } from "../sim/math.ts";
import { PLAYER } from "../sim/tuning.ts";
import { TagMatch } from "../game/tagMatch.ts";
import { emptyRec, recFromInput } from "../game/ghost.ts";
import { packWord } from "./wire.ts";

/** Update when the sim changes on purpose (npm test prints the new value). */
export const SELFTEST_HASH = 0x113801d5;

let cached: CityModel | null = null;

/**
 * 3 x 3 blocks of four 12 m buildings (one a 85-110 m tower), 4 m alleys, 18 m streets. Built directly (the sim reads
 * only the solids; no world builder in the online chunk).
 */
export function selfTestCity(): CityModel {
  if (cached) return cached;
  const rand = mulberry32(7);
  const solids: Solid[] = [];
  const B = 12, A = 4, S = 18, pitch = 2 * B + A + S;
  for (let bz = 0; bz < 3; bz++) for (let bx = 0; bx < 3; bx++) {
    const t = Math.floor(rand() * 4), base = 44 + Math.floor(rand() * 3);
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const x0 = bx * pitch + i * (B + A), z0 = bz * pitch + j * (B + A), id = solids.length;
      if (i + 2 * j === t) solids.push({ id, kind: "tower", landable: false, x0, z0, x1: x0 + B, z1: z0 + B, top: 85 + Math.floor(rand() * 26) });
      else solids.push({ id, kind: "roof", landable: true, x0, z0, x1: x0 + B, z1: z0 + B, top: base + [0, 0, 1, 2.5][Math.floor(rand() * 4)] });
    }
  }
  const roofs = solids.filter(r => r.landable);
  const sp = roofs[0];
  cached = {
    version: 1, config: null as unknown as CityModel["config"], bounds: { x0: 0, z0: 0, x1: 3 * pitch - S, z1: 3 * pitch - S },
    lowestRoof: Math.min(...roofs.map(r => r.top)), solids, adjacency: [], wallGaps: [], junctionCandidates: roofs.map(r => r.id),
    spawn: { roofId: sp.id, x: (sp.x0 + sp.x1) / 2, y: sp.top + 0.9, z: (sp.z0 + sp.z1) / 2, yaw: 0 }, rigs: [], hash: "selftest",
  };
  return cached;
}

/** Run the fixture and return its match hash (u32). */
export function selfTestHash(steps = 600): number {
  const m = new TagMatch({ model: selfTestCity(), tuning: PLAYER, slots: [{ radbro: "652" }, { radbro: "4764", touch: true }], seed: 42, seconds: 30, countdown: false });
  const r = mulberry32(1234);
  const rec = emptyRec();
  const yaw = [0.3, 2.2], hold = [0, 0], held = [false, false];
  const w = [0, 0];
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < 2; i++) {
      if (--hold[i] <= 0) { hold[i] = 20 + Math.floor(r() * 60); yaw[i] = r() * 6.283; held[i] = r() < 0.5; }
      const press = r() < 0.03, jump = r() < 0.02, zip = r() < 0.006;
      w[i] = packWord(recFromInput(rec, yaw[i], 1, r() < 0.2 ? 0.5 : 0, jump, press, held[i] || press, zip, false, r() < 0.05, (r() - 0.5) * 0.8));
    }
    m.stepWords(w);
  }
  return m.hash();
}
