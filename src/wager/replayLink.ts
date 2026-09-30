// SPIDER-TAG wager client: watch a logged round in the 3D view (docs/WAGER.md §7.3 "Watch"). A NetLink that feeds the
// log's words to a fresh round match at real time (or faster), so the existing TagGame, scene and HUD render it with no
// renderer changes. The words are the referee's, so what you watch is exactly what was refereed.
import type { NetLink } from "../game/tagGame.ts";
import type { TagMatch } from "../game/tagMatch.ts";
import { roundMatch, type SimAssets } from "./replay.ts";
import { wordsFromBase64, type RoundLog, type SeriesLog, type Side } from "./log.ts";

const HZ = 120;

export class ReplayLink implements NetLink {
  readonly local: number;
  readonly match: TagMatch;
  alpha = 0;
  waitMs = 0;
  /** Playback speed (1 = real time). */
  speed = 1;
  paused = false;
  onFresh: (() => void) | null = null;
  private readonly w: [Float64Array, Float64Array];
  private readonly last: number;
  private t = 0;
  private readonly pair = [0, 0];

  /** Watch round `r` of the log from player `view`'s Radbro. */
  constructor(assets: SimAssets, log: Pick<SeriesLog, "roundSeconds" | "radbros">, r: RoundLog, view: Side) {
    const bySlot: [string, string] = r.slotOfA === 0 ? [log.radbros[0], log.radbros[1]] : [log.radbros[1], log.radbros[0]];
    this.match = roundMatch(assets, r.seed, log.roundSeconds, bySlot);
    this.w = [wordsFromBase64(r.words[0]), wordsFromBase64(r.words[1])];
    this.last = r.lastStep;
    this.local = view === 0 ? r.slotOfA : 1 - r.slotOfA;
  }

  get final(): boolean {
    return this.match.step >= this.last;
  }

  stepsFor(delta: number): number {
    if (!this.paused) this.t += Math.min(delta, 0.25) * this.speed;
    const exact = this.t * HZ;
    const target = Math.min(this.last, Math.floor(exact));
    this.alpha = this.final ? 1 : Math.min(1, Math.max(0, exact - Math.floor(exact)));
    return Math.max(0, Math.min(target - this.match.step, 240));
  }

  step(_word: number): boolean {
    const m = this.match, s = m.step;
    if (s >= this.last) return false;
    this.pair[0] = this.w[0][s];
    this.pair[1] = this.w[1][s];
    m.stepWords(this.pair);
    this.onFresh?.();
    return true;
  }
}
