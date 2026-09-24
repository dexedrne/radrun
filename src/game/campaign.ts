// Round 4 campaign (docs/specs/2026-09-24-round4-depth.md §3): 12 levels across the four districts,
// 3 objectives each, stars kept best-of, and the unlocks that hang off them. Pure (the storage calls
// are guarded and go through a tiny adapter so tests can run in Node).
import type { Difficulty } from "../sim/tuning.ts";
import type { DistrictId } from "../world/districts.ts";
import type { RoundStats, RoundPhase } from "./round.ts";
import { M_LOWGRAV, M_NIGHT, M_NOYOINK, M_ONELIFE, M_POPS, M_SIXTY, M_WIND, MUTATORS } from "./mutators.ts";

export type Objective =
  | { kind: "catch" }
  | { kind: "under"; s: number }
  | { kind: "noFalls" }
  | { kind: "yoink" }
  | { kind: "chain"; n: number }
  | { kind: "closeCall"; s: number };

export type Level = {
  /** 1-based, stable (stored progress keys on it). */
  n: number;
  name: string;
  map: DistrictId;
  difficulty: Difficulty;
  mutators: number;
  goals: [Objective, Objective, Objective];
  blurb: string;
};

const catchIt: Objective = { kind: "catch" };

export const LEVELS: readonly Level[] = [
  { n: 1, name: "First Pour", map: "downtown", difficulty: "chill", mutators: 0, goals: [catchIt, { kind: "under", s: 60 }, { kind: "noFalls" }], blurb: "He swiped your bag. Learn the ropes." },
  { n: 2, name: "Rush Hour", map: "downtown", difficulty: "normal", mutators: 0, goals: [catchIt, { kind: "under", s: 50 }, { kind: "chain", n: 4 }], blurb: "Normal speed. Chain your swings down the streets." },
  { n: 3, name: "Pop Quiz", map: "downtown", difficulty: "normal", mutators: M_POPS, goals: [catchIt, { kind: "yoink" }, { kind: "under", s: 55 }], blurb: "Pale balloons pop when you let go. Pick your ropes." },
  { n: 4, name: "Neon Alleys", map: "market", difficulty: "chill", mutators: 0, goals: [catchIt, { kind: "under", s: 55 }, { kind: "noFalls" }], blurb: "Tight streets, lots of corners, some stretches with no balloons." },
  { n: 5, name: "Hands Only", map: "market", difficulty: "normal", mutators: M_NOYOINK, goals: [catchIt, { kind: "chain", n: 5 }, { kind: "under", s: 55 }], blurb: "No lasso tonight. You have to touch him." },
  { n: 6, name: "Lights Out", map: "market", difficulty: "normal", mutators: M_NIGHT, goals: [catchIt, { kind: "yoink" }, { kind: "under", s: 45 }], blurb: "The market after dark." },
  { n: 7, name: "Sea Breeze", map: "docks", difficulty: "normal", mutators: M_WIND, goals: [catchIt, { kind: "under", s: 55 }, { kind: "noFalls" }], blurb: "Gusts off the water. Watch the arrow." },
  { n: 8, name: "Moon Jump", map: "docks", difficulty: "normal", mutators: M_WIND | M_LOWGRAV, goals: [catchIt, { kind: "chain", n: 5 }, { kind: "yoink" }], blurb: "Low gravity, long flights, same wind." },
  { n: 9, name: "Last Call", map: "docks", difficulty: "normal", mutators: M_WIND | M_SIXTY, goals: [catchIt, { kind: "under", s: 40 }, { kind: "closeCall", s: 10 }], blurb: "Sixty seconds on the clock." },
  { n: 10, name: "Vertigo", map: "towers", difficulty: "normal", mutators: M_POPS, goals: [catchIt, { kind: "under", s: 55 }, { kind: "chain", n: 4 }], blurb: "Tall roofs, deep drops, popping balloons." },
  { n: 11, name: "High Winds", map: "towers", difficulty: "normal", mutators: M_POPS | M_WIND, goals: [catchIt, { kind: "noFalls" }, { kind: "yoink" }], blurb: "Pops and wind at altitude." },
  { n: 12, name: "Rugpull", map: "towers", difficulty: "degen", mutators: M_POPS | M_WIND | M_ONELIFE, goals: [catchIt, { kind: "under", s: 60 }, { kind: "yoink" }], blurb: "Degen runner. One life. Don't fall." },
];
export const TOTAL_STARS = LEVELS.length * 3;

export function objectiveText(o: Objective): string {
  switch (o.kind) {
    case "catch": return "catch him";
    case "under": return `catch him in under ${o.s} s`;
    case "noFalls": return "catch him without falling";
    case "yoink": return "finish with a YOINK";
    case "chain": return `chain ${o.n} swings in a row`;
    case "closeCall": return `catch him with under ${o.s} s left`;
  }
}

/** Which objectives a finished round met (every objective needs the catch). */
export function evaluate(level: Level, phase: RoundPhase, stats: RoundStats, clockLeft: number): [boolean, boolean, boolean] {
  const caught = phase === "caught";
  const one = (o: Objective): boolean => {
    if (!caught) return false;
    switch (o.kind) {
      case "catch": return true;
      case "under": return stats.catchTime < o.s;
      case "noFalls": return stats.falls === 0;
      case "yoink": return stats.catchKind === "yoink";
      case "chain": return stats.maxChain >= o.n;
      case "closeCall": return clockLeft < o.s;
    }
  };
  return [one(level.goals[0]), one(level.goals[1]), one(level.goals[2])];
}

// ---- progress --------------------------------------------------------------------------------------

export type Hat = "none" | "party" | "crown" | "foil";
export const HATS: readonly { id: Hat; name: string; stars: number }[] = [
  { id: "none", name: "no hat", stars: 0 },
  { id: "party", name: "party hat", stars: 9 },
  { id: "crown", name: "crown", stars: 21 },
  { id: "foil", name: "tin-foil hat", stars: 33 },
];

export type Progress = {
  /** Stars per level n (best-of per objective). */
  stars: Record<number, [boolean, boolean, boolean]>;
  /** Best catch time per level n. */
  best: Record<number, number>;
  hat: Hat;
};

const KEY = "rugrun.campaign.v1";
export const emptyProgress = (): Progress => ({ stars: {}, best: {}, hat: "none" });

type Store = { get(k: string): string | null; set(k: string, v: string): void };
const browserStore: Store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode / blocked storage */ } },
};

export function loadProgress(store: Store = browserStore): Progress {
  try {
    const p = JSON.parse(store.get(KEY) ?? "null") as Partial<Progress> | null;
    if (!p || typeof p !== "object") return emptyProgress();
    return { stars: p.stars ?? {}, best: p.best ?? {}, hat: HATS.some(h => h.id === p.hat) ? (p.hat as Hat) : "none" };
  } catch {
    return emptyProgress();
  }
}
export function saveProgress(p: Progress, store: Store = browserStore): void {
  store.set(KEY, JSON.stringify(p));
}

/** Merge a finished round into the progress (stars best-of, best time); returns the new stars earned. */
export function recordLevel(p: Progress, n: number, got: [boolean, boolean, boolean], catchTime: number | null): boolean[] {
  const prev = p.stars[n] ?? [false, false, false];
  const next: [boolean, boolean, boolean] = [prev[0] || got[0], prev[1] || got[1], prev[2] || got[2]];
  p.stars[n] = next;
  if (catchTime !== null && (p.best[n] === undefined || catchTime < p.best[n])) p.best[n] = catchTime;
  return next.map((v, i) => v && !prev[i]);
}

export const starCount = (p: Progress): number => Object.values(p.stars).reduce((a, s) => a + s.filter(Boolean).length, 0);
export const levelCaught = (p: Progress, n: number): boolean => !!p.stars[n]?.[0];

/** Level n is playable when it is the first or the one before it was caught. */
export const levelUnlocked = (p: Progress, n: number): boolean => n <= 1 || levelCaught(p, n - 1);

/** A district opens in free play once its first campaign level has been caught (Downtown always). */
export function districtUnlocked(p: Progress, id: DistrictId): boolean {
  if (id === "downtown") return true;
  const first = LEVELS.find(l => l.map === id);
  return !!first && levelCaught(p, first.n);
}

/** A mutator opens in free play once a campaign level using it has been caught. */
export function mutatorUnlocked(p: Progress, bit: number): boolean {
  return LEVELS.some(l => (l.mutators & bit) !== 0 && levelCaught(p, l.n));
}
export const unlockedMutators = (p: Progress): number => MUTATORS.reduce((m, x) => (mutatorUnlocked(p, x.bit) ? m | x.bit : m), 0);

export const DEGEN_STARS = 12;
export const degenUnlocked = (p: Progress): boolean => starCount(p) >= DEGEN_STARS;
export const hatUnlocked = (p: Progress, h: Hat): boolean => starCount(p) >= (HATS.find(x => x.id === h)?.stars ?? 0);
