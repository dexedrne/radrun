// One online match (multiplayer design §3.4): the TagMatch + Rollback of this client, fed by the relay. Implements the play
// page's NetLink: the relay clock decides how many steps to run each frame, the local word is queued inputDelay steps
// ahead and sent at 30 Hz (4 steps per INPUT; never two INPUTs closer than SEND_GAP_MS unless one is full, so the
// catch-up after a hitch or a hidden tab goes out as a few big messages), the other player's words roll the match
// back when they differ from the prediction, and every 60 confirmed steps a state hash rides along for the relay to
// compare. At the horn, once every input is in, the final hash goes to the relay in `end`.
//
// The session is built the moment `start` arrives (before the models load), so the other player's first inputs
// queue in its rollback instead of being dropped.
//
// Wager rounds (docs/WAGER.md §5.3, §7.4; `wager: true`): the relay is authoritative. A FILL replaces the word of a
// late or dropped slot, this client's own included (the match rolls back to it), words the relay already filled for
// this client are never sent, and after a reconnect the relay's sealed words from step 1 on (both slots) are kept
// back past the rollback rings' reach and applied as the match catches up. The live relay never sends any of this.
import { TagMatch, type TagSlot } from "../game/tagMatch.ts";
import type { NetLink } from "../game/tagGame.ts";
import type { Tuning } from "../sim/tuning.ts";
import type { CityIndex, CityModel } from "../world/cityModel.ts";
import { Rollback } from "./rollback.ts";
import type { Transport } from "./transport.ts";
import { MAX_INPUT_COUNT, MSG_ACK, MSG_DESYNC, MSG_FILL, MSG_INPUT_OUT, decodeDesync, decodeFill, decodeRelayInput, encodeInput, type StartMsg } from "./wire.ts";

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
/**
 * Wager rounds predict this far ahead of the other player's newest word (72 steps, 600 ms) instead of the online
 * default. The sealed release hands over a step only once both words are in, so the other player's words arrive a
 * whole round trip of this player's later than in the live mode, or only at their deadline when filled (up to
 * lateMs + 150 ms, plus this player's one-way time). Stalling on them would also hold back this player's own words
 * (they are sampled as the match steps), which then miss their own deadlines and get filled: at a 280 ms round trip
 * almost every step was.
 */
export const WAGER_MAX_ROLLBACK = 72;

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
  /** Wager round: the relay's FILLs and sealed words are final (see the header). */
  readonly wager: boolean;
  /** Per slot: relay words past the rollback rings' reach, applied in order as the match catches up (wager rounds). */
  private readonly backlog: { first: number; words: number[]; force: boolean }[][];
  private kept = 0;
  /** Words the relay filled for this slot (stats). */
  filled = 0;
  /** The newest own step the relay holds as final (filled, or sealed and sent back after a reconnect): never sent again. */
  private relayOwnTo = 0;
  /** Steps left in this frame (stepsFor's count): a wager round sends its words at the frame's last step. */
  private frameLeft = 0;

  constructor(o: { model: CityModel; index: CityIndex; tuning: Tuning; start: StartMsg; local: number; transport: SessionTransport; wager?: boolean }) {
    const s = o.start;
    this.start = s;
    this.local = o.local;
    this.t = o.transport;
    this.wager = !!o.wager;
    const slots: TagSlot[] = s.slots.map(p => ({ radbro: p.radbro as TagSlot["radbro"], touch: p.touch, easy: p.easy, name: p.name }));
    this.match = new TagMatch({ model: o.model, index: o.index, tuning: o.tuning, slots, seed: s.seed, seconds: s.config.seconds });
    this.rb = new Rollback(this.match, o.local, { inputDelay: s.inputDelay, ...(this.wager ? { maxRollback: WAGER_MAX_ROLLBACK } : {}) });
    this.backlog = Array.from({ length: this.match.n }, () => []);
    this.outFirst = this.rb.nextLocal;
  }

  /** Wire the transport's binary frames into the rollback. */
  onBinary(b: Uint8Array): void {
    if (b[0] === MSG_INPUT_OUT) {
      const m = decodeRelayInput(b);
      if (!m || m.slot >= this.match.n || this.broken) return;
      if (m.slot === this.local && !this.wager) return;
      this.take(m.slot, m.firstStep, m.words, m.slot === this.local);
    } else if (b[0] === MSG_FILL && this.wager) {
      const f = decodeFill(b);
      if (!f || f.slot >= this.match.n || this.broken) return;
      if (f.slot === this.local) this.filled += f.count;
      this.take(f.slot, f.firstStep, new Array<number>(f.count).fill(f.word), true);
    } else if (b[0] === MSG_DESYNC) {
      const step = decodeDesync(b);
      this.desyncs++;
      console.warn(`[radrun-online] the relay saw different state hashes at step ${step}; slot hashes now`, this.match.slotHashes());
    } else if (b[0] === MSG_ACK) {
      /* relay progress: informational in phase 1 */
    }
  }

  /** Relay words into the rollback: the part within the rings' reach now, the rest kept back in order (wager rounds). */
  private take(slot: number, first: number, words: number[], force: boolean): void {
    if (!this.wager) {
      try {
        this.rb.receive(slot, first, words);
      } catch (e) {
        this.broken = String((e as Error).message ?? e);
        console.error("[radrun-online] can't apply the other player's inputs:", this.broken);
      }
      return;
    }
    if (slot === this.local) this.relayOwnTo = Math.max(this.relayOwnTo, first + words.length - 1);
    this.backlog[slot].push({ first, words, force });
    this.kept++;
    this.drain();
  }

  /** Apply the kept-back words the match can now take, each slot's oldest first. */
  private drain(): void {
    const top = this.rb.horizon - 1;
    for (let slot = 0; slot < this.backlog.length && !this.broken; slot++) {
      const q = this.backlog[slot];
      while (q.length) {
        const b = q[0];
        if (b.first > top) break;
        const n = Math.min(b.words.length, top - b.first + 1);
        try {
          for (let k = 0; k < n; k++) {
            if (b.force) this.rb.force(slot, b.first + k, b.words[k]);
            else this.rb.receive(slot, b.first + k, [b.words[k]]);
          }
        } catch (e) {
          this.broken = String((e as Error).message ?? e);
          console.error("[radrun-online] can't apply the relay's inputs:", this.broken);
          return;
        }
        if (n < b.words.length) { q[0] = { ...b, first: b.first + n, words: b.words.slice(n) }; break; }
        q.shift();
        this.kept--;
      }
    }
  }

  /** Steps to run this frame: whatever the relay clock says we are behind (at most MAX_STEPS_PER_FRAME). */
  stepsFor(_delta: number): number {
    const m = this.match, rb = this.rb;
    const now = this.t.relayNow();
    const exact = (now - this.start.startAtMs) / STEP_MS;
    if (this.kept) this.drain();
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
    this.frameLeft = n;
    return n;
  }

  /** How long (ms) the match has been waiting for the other player's inputs (0 = it is not). */
  get waitMs(): number {
    return this.waitSince < 0 ? 0 : Math.max(0, this.t.relayNow() - this.waitSince);
  }

  step(word: number): boolean {
    const rb = this.rb, m = this.match;
    if (rb.nextLocal <= m.endStep && rb.nextLocal <= m.step + 1 + rb.inputDelay) {
      if (this.wager && (rb.nextLocal <= this.relayOwnTo || rb.has(this.local, rb.nextLocal))) {
        // The relay filled this step already (this client was late or away): its word stands, so skip it.
        this.flush();
        rb.nextLocal++;
        this.outFirst = rb.nextLocal;
      } else {
        rb.addLocal(word);
        this.out.push(word);
      }
    }
    const n = this.out.length;
    this.frameLeft--;
    if (n >= MAX_INPUT_COUNT || (n && rb.nextLocal > m.endStep)) this.flush();
    else if (this.wager ? n > 0 && this.frameLeft <= 0 : n >= SEND_EVERY) {
      // Wager rounds send what the frame sampled at its last step (every word has a deadline: at a low frame rate,
      // words held for the next frame would miss it); the live mode sends every SEND_EVERY words. Both keep the gap.
      const now = this.t.relayNow();
      if (now - this.lastSend >= SEND_GAP_MS) this.flush(now);
    }
    const ok = rb.advance();
    if (!ok && m.step < m.endStep) this.stallFrames++;
    if (this.kept) this.drain();
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
