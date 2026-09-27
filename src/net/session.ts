// One online match (multiplayer design §3.4): the TagMatch + Rollback of this client, fed by the relay. Implements the play
// page's NetLink: the relay clock decides how many steps to run each frame, the local word is queued inputDelay steps
// ahead and sent at 30 Hz (4 steps per INPUT, the last ones at once), the other player's words roll the match back
// when they differ from the prediction, and every 60 confirmed steps a state hash rides along for the relay to
// compare. At the horn, once every input is in, the final hash goes to the relay in `end`.
import { TagMatch, type TagSlot } from "../game/tagMatch.ts";
import type { NetLink } from "../game/tagGame.ts";
import type { Tuning } from "../sim/tuning.ts";
import type { CityIndex, CityModel } from "../world/cityModel.ts";
import { Rollback } from "./rollback.ts";
import type { Transport } from "./transport.ts";
import { MSG_ACK, MSG_DESYNC, MSG_INPUT_OUT, decodeDesync, decodeRelayInput, encodeInput, type StartMsg } from "./wire.ts";

const STEP_MS = 1000 / 120;
/** Local words per INPUT message (30 Hz at 120 Hz). */
export const SEND_EVERY = 4;

export class OnlineSession implements NetLink {
  readonly local: number;
  readonly match: TagMatch;
  readonly rb: Rollback;
  readonly start: StartMsg;
  private readonly t: Transport;
  private readonly out: number[] = [];
  private outFirst: number;
  private readonly hashQ: [number, number][] = [];
  alpha = 0;
  desyncs = 0;
  stallFrames = 0;
  endSent = false;
  /** Called once when the result is final (the final hash). */
  onFinal: ((hash: number) => void) | null = null;

  constructor(o: { model: CityModel; index: CityIndex; tuning: Tuning; start: StartMsg; local: number; transport: Transport }) {
    const s = o.start;
    this.start = s;
    this.local = o.local;
    this.t = o.transport;
    const slots: TagSlot[] = s.slots.map(p => ({ radbro: p.radbro as TagSlot["radbro"], touch: p.touch, easy: p.easy, name: p.name }));
    this.match = new TagMatch({ model: o.model, index: o.index, tuning: o.tuning, slots, seed: s.seed, seconds: s.config.seconds });
    this.rb = new Rollback(this.match, o.local, { inputDelay: s.inputDelay });
    this.outFirst = this.rb.nextLocal;
  }

  /** Wire the transport's binary frames into the rollback. */
  onBinary(b: Uint8Array): void {
    if (b[0] === MSG_INPUT_OUT) {
      const m = decodeRelayInput(b);
      if (m && m.slot !== this.local && m.slot < this.match.n) this.rb.receive(m.slot, m.firstStep, m.words);
    } else if (b[0] === MSG_DESYNC) {
      const step = decodeDesync(b);
      this.desyncs++;
      console.warn(`[radrun-online] the relay saw different state hashes at step ${step}; slot hashes now`, this.match.slotHashes());
    } else if (b[0] === MSG_ACK) {
      /* relay progress: informational in phase 1 */
    }
  }

  /** Steps to run this frame: whatever the relay clock says we are behind (at most 30). */
  stepsFor(_delta: number): number {
    const m = this.match;
    const exact = (this.t.relayNow() - this.start.startAtMs) / STEP_MS;
    this.rb.catchUp();
    this.pump();
    if (exact <= 0) { this.alpha = 0; return 0; }
    const target = Math.min(Math.floor(exact), m.endStep);
    this.alpha = m.step >= m.endStep ? 1 : Math.min(1, Math.max(0, exact - Math.floor(exact)));
    const n = Math.max(0, Math.min(30, target - m.step));
    return n;
  }

  step(word: number): boolean {
    const rb = this.rb, m = this.match;
    if (rb.nextLocal <= m.endStep && rb.nextLocal <= m.step + 1 + rb.inputDelay) {
      rb.addLocal(word);
      this.out.push(word);
    }
    if (this.out.length >= SEND_EVERY || (this.out.length && rb.nextLocal > m.endStep)) this.flush();
    const ok = rb.advance();
    if (!ok && m.step < m.endStep) this.stallFrames++;
    return ok;
  }

  get final(): boolean {
    return this.rb.final;
  }

  /** Send what is queued, the next confirmed hash, and the final hash once the result is final. */
  private pump(): void {
    if (this.out.length && this.rb.nextLocal > this.match.endStep) this.flush();
    this.hashQ.push(...this.rb.takeHashes());
    if (this.rb.final && !this.endSent) {
      this.endSent = true;
      const h = this.match.hash();
      this.t.sendJson({ t: "end", step: this.match.step, hash: h, bag: [...this.match.bag] });
      this.onFinal?.(h);
    }
  }

  private flush(): void {
    if (!this.out.length) return;
    const hq = this.hashQ.shift();
    this.t.sendBinary(encodeInput({ firstStep: this.outFirst, words: this.out, ...(hq ? { hashStep: hq[0], hash: hq[1] } : {}) }));
    this.outFirst += this.out.length;
    this.out.length = 0;
  }
}
