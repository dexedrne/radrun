// Round 4 mutators (docs/specs/2026-09-24-round4-depth.md §3): bit flags on a round. All are
// deterministic and part of the round options, the ghost link and (where they touch the sim) the hash.
// Pops, wind, low gravity, no Yoink, one life and the 60 s clock change the player's round; night is
// visual only. The runner is never affected (he plays his baked track).
import type { DistrictId } from "../world/districts.ts";

export const M_POPS = 1;
export const M_WIND = 2;
export const M_LOWGRAV = 4;
export const M_NOYOINK = 8;
export const M_ONELIFE = 16;
export const M_SIXTY = 32;
export const M_NIGHT = 64;
export const M_ALL = 127;

export type MutatorInfo = { bit: number; id: string; name: string; blurb: string };
export const MUTATORS: readonly MutatorInfo[] = [
  { bit: M_POPS, id: "pops", name: "Popping balloons", blurb: "About half the balloons pop when you let go; they grow back after a few seconds." },
  { bit: M_WIND, id: "wind", name: "Wind", blurb: "Gusts push you sideways in the air. The arrow warns you a second early." },
  { bit: M_LOWGRAV, id: "lowgrav", name: "Low gravity", blurb: "Floaty jumps and long, slow swings." },
  { bit: M_NOYOINK, id: "noyoink", name: "No YOINK", blurb: "No lasso: you have to touch him." },
  { bit: M_ONELIFE, id: "onelife", name: "One life", blurb: "Fall once and he rugs you." },
  { bit: M_SIXTY, id: "sixty", name: "60 seconds", blurb: "A 60 s clock instead of 90." },
  { bit: M_NIGHT, id: "night", name: "Night", blurb: "Dark sky, close fog, glowing balloons." },
];

/** Mechanics a district always uses in free play (campaign levels set their own). */
export const DISTRICT_MUTATORS: Readonly<Record<DistrictId, number>> = { downtown: 0, market: 0, docks: M_WIND, towers: M_POPS, vertigo: 0 };

export const hasMut = (m: number, bit: number): boolean => (m & bit) !== 0;
export const mutNames = (m: number): string[] => MUTATORS.filter(x => hasMut(m, x.bit)).map(x => x.name);
