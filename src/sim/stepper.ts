// Fixed-step accumulator (spec §5.1): frame delta capped at maxFrameDelta, at most maxSteps per frame,
// render interpolation alpha = acc / dt. Pure; shared by SimDriver and the determinism test.
import { DT, MAX_FRAME_DELTA, MAX_STEPS_PER_FRAME } from "./tuning.ts";

export class FixedStepper {
  acc = 0;
  readonly dt: number;
  readonly maxDelta: number;
  readonly maxSteps: number;

  constructor(dt = DT, maxDelta = MAX_FRAME_DELTA, maxSteps = MAX_STEPS_PER_FRAME) {
    this.dt = dt;
    this.maxDelta = maxDelta;
    this.maxSteps = maxSteps;
  }

  /** Adds a frame's delta and returns how many fixed steps to run now. */
  frame(delta: number): number {
    this.acc += Math.min(Math.max(delta, 0), this.maxDelta);
    let n = 0;
    while (this.acc >= this.dt && n < this.maxSteps) {
      this.acc -= this.dt;
      n++;
    }
    if (this.acc >= this.dt) this.acc = 0; // hit maxSteps: drop the backlog instead of spiralling
    return n;
  }

  get alpha(): number {
    return this.acc / this.dt;
  }

  reset(): void {
    this.acc = 0;
  }
}
