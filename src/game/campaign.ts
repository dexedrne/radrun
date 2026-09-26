// Round 4 campaign (docs/specs/2026-09-24-round4-depth.md §3): 12 levels across the four districts (round 7:
// + 3 Vertigo levels, 13-15), 3 objectives each, stars kept best-of, and the unlocks that hang off them. Pure (the storage calls
// are guarded and go through a tiny adapter so tests can run in Node).
import type { Difficulty } from "../sim/tuning.ts";
import type { DistrictId } from "../world/districts.ts";
import type { RoundStats, RoundPhase } from "./round.ts";
import { M_LOWGRAV, M_NIGHT, M_NOYOINK, M_ONELIFE, M_SNAP, M_SIXTY, M_WIND, MUTATORS } from "./mutators.ts";

export type Objective =
  | { kind: "catch" }
  | { kind: "under"; s: number }
  | { kind: "noFalls" }
  | { kind: "yoink" }
  | { kind: "chain"; n: number }
  | { kind: "closeCall"; s: number }
  /** Round 7 (Vertigo): catch him before he has stood on a roof below y m ("street level"). */
  | { kind: "above"; y: number }
  /** Round 9: at least n parkour moves (wall runs, wall jumps, ledge climbs, vaults, slides) in the round. */
  | { kind: "parkour"; n: number };

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

// Round 6: time objectives re-checked against the swinging balance bot per level (with its district tweak
// and mutators): each "under N s" star now takes a good run rather than any catch (the bot gets it in
// ~60-85 % of rounds, ~30 % on the Degen finale). Round 9: re-set against the zipping swing bot on the new
// cities (100 seeds per level; where it catches in fewer rounds than that, the star takes about 9 in 10 of
// its catches); L4 and L9 swap a time / close-call star for parkour moves.
export const LEVELS: readonly Level[] = [
  { n: 1, name: "First Pour", map: "downtown", difficulty: "chill", mutators: 0, goals: [catchIt, { kind: "under", s: 30 }, { kind: "noFalls" }], blurb: "He swiped your bag. Learn the ropes." },
  { n: 2, name: "Rush Hour", map: "downtown", difficulty: "normal", mutators: 0, goals: [catchIt, { kind: "under", s: 60 }, { kind: "chain", n: 4 }], blurb: "Normal speed. Chain your swings down the avenues." },
  { n: 3, name: "Snap Quiz", map: "downtown", difficulty: "normal", mutators: M_SNAP, goals: [catchIt, { kind: "yoink" }, { kind: "under", s: 65 }], blurb: "Webs snap after 1.6 s. Keep them short." },
  { n: 4, name: "Neon Alleys", map: "market", difficulty: "chill", mutators: 0, goals: [catchIt, { kind: "parkour", n: 6 }, { kind: "noFalls" }], blurb: "Low roofs, few anchors. Vault, climb and wall-kick." },
  { n: 5, name: "Hands Only", map: "market", difficulty: "normal", mutators: M_NOYOINK, goals: [catchIt, { kind: "chain", n: 5 }, { kind: "under", s: 80 }], blurb: "No lasso tonight. You have to touch him." },
  { n: 6, name: "Lights Out", map: "market", difficulty: "normal", mutators: M_NIGHT, goals: [catchIt, { kind: "yoink" }, { kind: "under", s: 55 }], blurb: "The market after dark." },
  { n: 7, name: "Sea Breeze", map: "docks", difficulty: "normal", mutators: M_WIND, goals: [catchIt, { kind: "under", s: 65 }, { kind: "noFalls" }], blurb: "Gusts off the water. Watch the arrow." },
  { n: 8, name: "Moon Jump", map: "docks", difficulty: "normal", mutators: M_WIND | M_LOWGRAV, goals: [catchIt, { kind: "chain", n: 5 }, { kind: "yoink" }], blurb: "Low gravity, long flights, same wind." },
  { n: 9, name: "Last Call", map: "docks", difficulty: "normal", mutators: M_WIND | M_SIXTY, goals: [catchIt, { kind: "under", s: 45 }, { kind: "parkour", n: 4 }], blurb: "Sixty seconds on the clock." },
  { n: 10, name: "Altitude", map: "towers", difficulty: "normal", mutators: M_SNAP, goals: [catchIt, { kind: "under", s: 55 }, { kind: "chain", n: 4 }], blurb: "Tall roofs, deep drops, snapping webs." },
  { n: 11, name: "High Winds", map: "towers", difficulty: "normal", mutators: M_SNAP | M_WIND, goals: [catchIt, { kind: "noFalls" }, { kind: "yoink" }], blurb: "Snapping webs and wind at altitude." },
  { n: 12, name: "Rugpull", map: "towers", difficulty: "degen", mutators: M_SNAP | M_WIND | M_ONELIFE, goals: [catchIt, { kind: "under", s: 32 }, { kind: "yoink" }], blurb: "Degen runner. One life. Don't fall." },
  // Round 7: Vertigo, the descending chase (swing bot, 300 seeds: L13 catch 97 % / no falls 94 % / chain 5 63 %;
  // L14 72 % / above 45 m 37 % / chain 5 71 %; L15 62 % / above 40 m 27 % / no falls 40 %). Round 11: his swing
  // routes take him below 40 m in almost every Degen round, so Street Level's line is 32 m (~25 % again).
  { n: 13, name: "Top Floor", map: "vertigo", difficulty: "chill", mutators: 0, goals: [catchIt, { kind: "noFalls" }, { kind: "chain", n: 5 }], blurb: "He starts at the top of the spiral. Step off the cliffs after him." },
  { n: 14, name: "Free Fall", map: "vertigo", difficulty: "normal", mutators: 0, goals: [catchIt, { kind: "above", y: 45 }, { kind: "chain", n: 5 }], blurb: "Dive after him and web the needles on the way down." },
  { n: 15, name: "Street Level", map: "vertigo", difficulty: "degen", mutators: M_SNAP, goals: [catchIt, { kind: "above", y: 32 }, { kind: "noFalls" }], blurb: "Degen runner, snapping webs. Catch him high." },
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
    case "above": return `catch him before he reaches street level (below ${o.y} m)`;
    case "parkour": return `catch him with ${o.n}+ parkour moves (wall runs, kicks, climbs, vaults, slides)`;
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
      case "above": return stats.runnerLow >= o.y;
      case "parkour": return stats.parkour >= o.n;
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

/**
 * A district opens in free play once its first campaign level has been caught (Downtown always; round 7:
 * Vertigo too, the new map is open from the start).
 */
export const ALWAYS_OPEN: readonly DistrictId[] = ["downtown", "vertigo"];
export function districtUnlocked(p: Progress, id: DistrictId): boolean {
  if (ALWAYS_OPEN.includes(id)) return true;
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
