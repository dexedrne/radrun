// How often the runner talks in a chase (pure: Node tests drive it; PlayDriver owns one). The Radbros
// mostly react (a laugh, a scoff, a hum) and rarely say a word; the announcer does the talking.
//   taunt     he waves at every junction, but a sound + bubble only on a 50% roll, at most 2 a round,
//             25 s apart, at most one of them worded; reactions are picked twice as often as words and
//             the same slot never plays twice in a row (across rounds too)
//   panic     the first of the round, then again only 20 s after the last one, at most 2 a round
//   cornered  once a round
//   countdown every round after a menu (title / level pick), then one retry / next in three
// Times are the round clock (chase steps / 120), not wall time. The sim never sees any of this.

export const TAUNT_MAX = 2;
export const TAUNT_GAP = 25;
export const TAUNT_ODDS = 0.5;
export const PANIC_MAX = 2;
export const PANIC_GAP = 20;
export const COUNTDOWN_EVERY = 3;

/** Taunt slot weights: slots 0-3 reactions (2), 4-5 words (1). */
export const TAUNT_WEIGHT: readonly number[] = [2, 2, 2, 2, 1, 1];
export const isWorded = (slot: number): boolean => TAUNT_WEIGHT[slot] === 1;

export class Chatter {
  private taunts: number[] = [];
  private lastTaunt = -Infinity;
  private lastSlot = -1;
  private panics = 0;
  private lastPanic = -Infinity;
  private cornered = 0;
  private again = 0;
  private rand: () => number;

  constructor(rand: () => number = Math.random) {
    this.rand = rand;
  }

  /**
   * A new round. `fromMenu`: the player came from the title or the level list (else a retry / next).
   * Returns whether the runner voices his countdown line this round.
   */
  startRound(fromMenu: boolean): boolean {
    this.taunts = [];
    this.lastTaunt = -Infinity;
    this.panics = 0;
    this.lastPanic = -Infinity;
    this.cornered = 0;
    this.again = fromMenu ? 0 : this.again + 1;
    return this.again % COUNTDOWN_EVERY === 0;
  }

  /** He reached a junction far ahead (t = round clock, s): the taunt slot to voice, or -1 (he just waves). */
  taunt(t: number): number {
    if (this.taunts.length >= TAUNT_MAX || t - this.lastTaunt < TAUNT_GAP) return -1;
    if (this.rand() >= TAUNT_ODDS) return -1;
    const worded = this.taunts.some(isWorded);
    const ok = TAUNT_WEIGHT.map((w, i) =>
      this.taunts.includes(i) || i === this.lastSlot || (worded && isWorded(i)) ? 0 : w);
    const sum = ok.reduce((a, b) => a + b, 0);
    if (!sum) return -1;
    let x = this.rand() * sum, slot = 0;
    while (slot < ok.length - 1 && (x -= ok[slot]) >= 0) slot++;
    while (!ok[slot]) slot--; // float edge: never land on a zero-weight slot
    this.taunts.push(slot);
    this.lastTaunt = t;
    this.lastSlot = slot;
    return slot;
  }

  /** He panics: voice it (and show the bubble)? */
  panic(t: number): boolean {
    if (this.panics >= PANIC_MAX || t - this.lastPanic < PANIC_GAP) return false;
    this.panics++;
    this.lastPanic = t;
    return true;
  }

  /** He is cornered: voice it (once a round)? */
  corner(): boolean {
    return this.cornered++ === 0;
  }
}
