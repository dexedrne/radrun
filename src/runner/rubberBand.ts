// Rubber band (spec §7): playback-rate multiplier m from the chase distance d, smoothed by M_SMOOTH,
// clamped to [airMin, airMax] in the air (spec 0.9-1.1; per difficulty), capped at 0.9 by the flinch rule, with a panic budget that drains while
// m > 1 (in proportion to the excess) and leaves him GASSED (m_max = 1.0) until it refills to 30 %.
// PANIC (UI, sprint clip) = m > 1.05. Pure; determinism rule applies.
import { M_SMOOTH } from "../sim/tuning.ts";

export type BandParams = { gStar: number; mMin: number; mMax: number; panicBudget: number; airMin: number; airMax: number };

export type Band = {
  m: number;
  mTarget: number;
  /** Panic budget left, seconds. */
  budget: number;
  gassed: boolean;
  panic: boolean;
};

export const BAND = {
  slope: 0.025,
  panicAbove: 1.05,
  regenRate: 0.3,
  regenMinD: 20,
  refill: 0.3,
  flinchCap: 0.9,
} as const;

export const createBand = (p: BandParams): Band => ({ m: 1, mTarget: 1, budget: p.panicBudget, gassed: false, panic: false });

/** One fixed step. Returns the playback rate for this step. */
export function stepBand(b: Band, p: BandParams, d: number, flinch: boolean, airborne: boolean, dt: number): number {
  const mMax = b.gassed ? 1.0 : p.mMax;
  let t = 1 + BAND.slope * (p.gStar - d);
  if (t < p.mMin) t = p.mMin;
  if (t > mMax) t = mMax;
  if (flinch && t > BAND.flinchCap) t = BAND.flinchCap;
  b.mTarget = t;
  b.m += (t - b.m) * M_SMOOTH;
  if (b.m > 1) {
    // Deviation (NOTES): drain scales with the excess, 1 s/s at m_max (spec: 1 s/s whenever m > 1.05).
    // With the fixed 0.45 s junction dwell a k = 1.0 follower forces an average m of ~1.06, which a
    // binary drain would always turn into GASSED before 90 s.
    b.budget -= (dt * (b.m - 1)) / (p.mMax - 1);
    if (b.budget <= 0) { b.budget = 0; b.gassed = true; }
  } else if (b.m <= 1 && d > BAND.regenMinD) {
    b.budget += BAND.regenRate * dt;
    if (b.budget > p.panicBudget) b.budget = p.panicBudget;
  }
  if (b.gassed && b.budget >= BAND.refill * p.panicBudget) b.gassed = false;
  b.panic = b.m > BAND.panicAbove;
  if (!airborne) return b.m;
  return b.m < p.airMin ? p.airMin : b.m > p.airMax ? p.airMax : b.m;
}
