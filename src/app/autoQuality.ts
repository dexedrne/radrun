// Auto quality: during the first ~10 s of each CHASE on High, collect frame times (after a short warm-up
// that hides shader / pipeline hitches). If the median frame time says the game runs below ~40 fps, ask
// once to switch to Low. The page does the switch, shows a toast, and remembers it; it never switches
// back and never overrides a quality the player picked in Settings. Pure (no three.js) so Node tests it.

export const AUTO_Q = {
  /** Seconds of chase ignored first (hitches while the chase starts). */
  warmup: 1.5,
  /** The measurement ends at this chase time (s). */
  window: 10,
  /** Fewest frames the verdict needs (a 5 fps device still gets ~40). */
  minFrames: 20,
  /** Below this median fps: switch. */
  fps: 40,
} as const;

export class AutoQuality {
  private readonly times: number[] = [];
  private chaseT = 0;
  private runId = -1;
  private judged = false;
  /** The check failed once (the switch was asked for); nothing more happens after that. */
  fired = false;

  /**
   * One rendered frame. `active` = a real round's chase is running unpaused on High with auto quality
   * allowed. Returns true exactly once: on the frame the check fails.
   */
  frame(dt: number, runId: number, active: boolean): boolean {
    if (this.fired) return false;
    if (runId !== this.runId) {
      this.runId = runId;
      this.times.length = 0;
      this.chaseT = 0;
      this.judged = false;
    }
    if (!active || this.judged) return false;
    this.chaseT += dt;
    if (this.chaseT < AUTO_Q.warmup) return false;
    if (this.chaseT <= AUTO_Q.window) {
      if (dt > 0 && dt < 1) this.times.push(dt);
      return false;
    }
    this.judged = true;
    if (this.times.length < AUTO_Q.minFrames) return false;
    const sorted = this.times.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (median > 1 / AUTO_Q.fps) {
      this.fired = true;
      return true;
    }
    return false;
  }

  /** Median fps of the current window so far (probe). */
  get fps(): number {
    if (!this.times.length) return 0;
    const sorted = this.times.slice().sort((a, b) => a - b);
    return 1 / sorted[sorted.length >> 1];
  }
}
