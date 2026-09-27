// One online match (multiplayer design §3.4): the TagMatch + Rollback of this client, fed by the relay. Implements the play
// page's NetLink: the relay clock decides how many steps to run each frame, the local word is queued inputDelay steps
// ahead and sent at 30 Hz (4 steps per INPUT; never two INPUTs closer than SEND_GAP_MS unless one is full, so the
// catch-up after a hitch or a hidden tab goes out as a few big messages), the other player's words roll the match
// back when they differ from the prediction, and every 60 confirmed steps a state hash rides along for the relay to
// compare. At the horn, once every input is in, the final hash goes to the relay in `end`.
//
// The session is built the moment `start` arrives (before the models load), so the other player's first inputs
// queue in its rollback instead of being dropped.
import { TagMatch, type TagSlot } from "../game/tagMatch.ts";
import type { NetLink } from "../game/tagGame.ts";
import type { Tuning } from "../sim/tuning.ts";
import type { CityIndex, CityModel } from "../world/cityModel.ts";
import { Rollback } from "./rollback.ts";
import type { Transport } from "./transport.ts";
import { MAX_INPUT_COUNT, MSG_ACK, MSG_DESYNC, MSG_INPUT_OUT, decodeDesync, decodeRelayInput, encodeInput, type StartMsg } from "./wire.ts";

const STEP_MS = 1000 / 120;
/** Local words per INPUT message in steady play (30 Hz at 120 Hz). */
export const SEND_EVERY = 4;
/**
 * Never two INPUTs closer than this (ms), unless a full one (MAX_INPUT_COUNT words) is queued: at most 40 a second,
 * whatever the frame rate, however far behind (the relay closes a socket past 90 messages a second).
 */
export const SEND_GAP_MS = 25;
/** Leftover words wait at most this long (ms) for the next INPUT. */
const SEND_WAIT_MS = 40;
/** Steps a frame may run while catching up with the relay clock. */
export const MAX_STEPS_PER_FRAME = 30;

/** The transport as the session uses it (tests drive it with a fake clock). */
export type SessionTransport = Pick<Transport, "relayNow" | "sendJson" | "sendBinary">;

export class OnlineSession implements NetLink {
  readonly local: number;
  readonly match: TagMatch;
  readonly rb: Rollback;
  readonly start: StartMsg;
  private readonly t: SessionTransport;
  private readonly out: number[] = [];
  private outFirst: number;
  private readonly hashQ: [number, number][] = [];
  private lastSend = -Infinity;
  private waitSince = -1;
  alpha = 0;
  desyncs = 0;
  stallFrames = 0;
  endSent = false;
  /** INPUT messages sent (stats). */
  inputsSent = 0;
  /** Steps the match is behind the relay clock after the last frame's steps (stats). */
  behind = 0;
  /** Set when the other player's inputs could not be applied (the match cannot go on). */
  broken: string | null = null;
  /** Called once when the result is final (the final hash). */
  onFinal: ((hash: number) => void) | null = null;

  constructor(o: { model: CityModel; index: CityIndex; tuning: Tuning; start: StartMsg; local: number; transport: SessionTransport }) {
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
      if (!m || m.slot === this.local || m.slot >= this.match.n || this.broken) return;
      try {
        this.rb.receive(m.slot, m.firstStep, m.words);
      } catch (e) {
        this.broken = String((e as Error).message ?? e);
        console.error("[radrun-online] can't apply the other player's inputs:", this.broken);
      }
    } else if (b[0] === MSG_DESYNC) {
      const step = decodeDesync(b);
      this.desyncs++;
      console.warn(`[radrun-online] the relay saw different state hashes at step ${step}; slot hashes now`, this.match.slotHashes());
    } else if (b[0] === MSG_ACK) {
      /* relay progress: informational in phase 1 */
    }
  }

  /** Steps to run this frame: whatever the relay clock says we are behind (at most MAX_STEPS_PER_FRAME). */
  stepsFor(_delta: number): number {
    const m = this.match, rb = this.rb;
    const now = this.t.relayNow();
    const exact = (now - this.start.startAtMs) / STEP_MS;
    rb.catchUp();
    this.pump(now);
    if (exact <= 0) { this.alpha = 0; this.waitSince = -1; return 0; }
    const target = Math.min(Math.floor(exact), m.endStep);
    this.alpha = m.step >= m.endStep ? 1 : Math.min(1, Math.max(0, exact - Math.floor(exact)));
    // Waiting on the other player: the next step would predict past maxRollback, or the horn has gone and the result
    // waits on his last inputs.
    const starved = m.step < m.endStep ? target > m.step && m.step + 1 - rb.confirmed > rb.maxRollback : !rb.final;
    if (!starved) this.waitSince = -1;
    else if (this.waitSince < 0) this.waitSince = now;
    const n = Math.max(0, Math.min(MAX_STEPS_PER_FRAME, target - m.step));
    this.behind = target - m.step - n;
    return n;
  }

  /** How long (ms) the match has been waiting for the other player's inputs (0 = it is not). */
  get waitMs(): number {
    return this.waitSince < 0 ? 0 : Math.max(0, this.t.relayNow() - this.waitSince);
  }

  step(word: number): boolean {
    const rb = this.rb, m = this.match;
    if (rb.nextLocal <= m.endStep && rb.nextLocal <= m.step + 1 + rb.inputDelay) {
      rb.addLocal(word);
      this.out.push(word);
    }
    const n = this.out.length;
    if (n >= MAX_INPUT_COUNT || (n && rb.nextLocal > m.endStep)) this.flush();
    else if (n >= SEND_EVERY) {
      const now = this.t.relayNow();
      if (now - this.lastSend >= SEND_GAP_MS) this.flush(now);
    }
    const ok = rb.advance();
    if (!ok && m.step < m.endStep) this.stallFrames++;
    return ok;
  }

  get final(): boolean {
    return this.rb.final;
  }

  /** Send what is queued (the last words, or any that waited long enough), the next confirmed hash, and the final hash once the result is final. */
  private pump(now: number): void {
    if (this.out.length && (this.rb.nextLocal > this.match.endStep || now - this.lastSend >= SEND_WAIT_MS)) this.flush(now);
    this.hashQ.push(...this.rb.takeHashes());
    if (this.rb.final && !this.endSent) {
      this.endSent = true;
      const h = this.match.hash();
      this.t.sendJson({ t: "end", step: this.match.step, hash: h, bag: [...this.match.bag] });
      this.onFinal?.(h);
    }
  }

  private flush(now = this.t.relayNow()): void {
    if (!this.out.length) return;
    const hq = this.hashQ.shift();
    this.t.sendBinary(encodeInput({ firstStep: this.outFirst, words: this.out, ...(hq ? { hashStep: hq[0], hash: hq[1] } : {}) }));
    this.outFirst += this.out.length;
    this.out.length = 0;
    this.lastSend = now;
    this.inputsSent++;
  }
}
