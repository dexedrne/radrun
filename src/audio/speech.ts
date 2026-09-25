// The speech timeline (pure: no WebAudio, Node tests drive it). voice.ts asks it where each line goes and
// plays what it says to play / cuts what it says to cut. One line at a time: a line waits for the one
// before it (up to `maxWait`, else it is dropped), an interrupting line cuts the lines of its priority
// or lower, cooldowns keep taunts from stacking.
// Round end is its own call: it cuts everything queued or talking, plays at most ONE announcer call and
// then at most ONE Radbro reply after it, and closes the timeline, so nothing else (chase chatter, a
// cheer, a results-screen line, a second call from a re-render) can speak until the next round starts.
// It fires once per run id.
import type { RadbroId } from "../game/round.ts";
import type { AnnouncerKey, VoiceKey } from "./catalog.ts";

/** Priorities: chase chatter < announcer calls (countdown, GO, rekt) < the round-end pair. */
export const PRI = { chatter: 1, call: 2, final: 3 } as const;

/** Silence between two lines (s). */
export const GAP = 0.08;
/** Scheduling lead (s): a line never starts in the past. */
export const LEAD = 0.01;

export type Line = { id: number; who: string; key: string; start: number; end: number; pri: number };

export type Ask = {
  who: string;
  key: string;
  /** The line's length (s). */
  dur: number;
  /** Seconds from now. */
  delay?: number;
  /** Longest it may wait behind another line (s); default 0.3. */
  maxWait?: number;
  /** Cut the lines of this priority or lower. */
  interrupt?: boolean;
  /** Minimum seconds between lines of the same `group` (default: who + key). */
  cooldown?: number;
  group?: string;
  pri?: number;
};

/** What to do now: start these lines (at their `start`), cut these (already started or queued). */
export type Plan = { play: Line[]; cut: Line[]; drop?: string };

export class Speech {
  private lines: Line[] = [];
  private last = new Map<string, number>();
  private id = 1;
  /** False after a round end / hush: nothing speaks until the next round starts. */
  private open = true;
  /** The run whose round end was voiced (a second call for it is ignored). */
  private ended = -1;

  /** Lines queued or talking at `now`. */
  pending(now: number): Line[] {
    return this.lines.filter(l => l.end > now);
  }

  isOpen(): boolean {
    return this.open;
  }

  private prune(now: number): void {
    this.lines = this.pending(now);
  }

  private freeAt(lines: Line[]): number {
    let t = -Infinity;
    for (const l of lines) t = Math.max(t, l.end);
    return t;
  }

  /** A chase line (or a countdown / GO / rekt call). */
  say(now: number, a: Ask): Plan {
    this.prune(now);
    if (!this.open) return { play: [], cut: [], drop: "closed" };
    const group = a.group ?? `${a.who}:${a.key}`;
    const prev = this.last.get(group);
    if (a.cooldown && prev !== undefined && now - prev < a.cooldown) return { play: [], cut: [], drop: "cooldown" };
    const pri = a.pri ?? PRI.chatter;
    const t0 = now + LEAD + (a.delay ?? 0);
    const cut = a.interrupt ? this.lines.filter(l => l.pri <= pri) : [];
    const keep = a.interrupt ? this.lines.filter(l => l.pri > pri) : this.lines;
    const start = Math.max(t0, this.freeAt(keep) + GAP);
    if (start - t0 > (a.maxWait ?? 0.3)) return { play: [], cut: [], drop: "busy" };
    const line: Line = { id: this.id++, who: a.who, key: a.key, start, end: start + a.dur, pri };
    this.lines = [...keep, line];
    this.last.set(group, now);
    return { play: [line], cut };
  }

  /**
   * The round is over (catch, escape, time-up): cut everything, then the announcer's call and, after it,
   * one Radbro reply (either may be null: not loaded). Once per run; closes the timeline.
   */
  roundEnd(now: number, run: number, call: Ask | null, reply: Ask | null): Plan {
    if (run === this.ended) return { play: [], cut: [], drop: "again" };
    this.ended = run;
    const cut = this.pending(now);
    this.lines = [];
    this.open = false;
    const play: Line[] = [];
    let t = now + LEAD;
    for (const a of [call, reply]) {
      if (!a) continue;
      const start = t + (a.delay ?? 0);
      const line: Line = { id: this.id++, who: a.who, key: a.key, start, end: start + a.dur, pri: PRI.final };
      play.push(line);
      t = line.end + GAP;
    }
    this.lines = play;
    return { play, cut };
  }

  /** A new round (PLAY, Retry, Next level): cut what is left of the last one and open the timeline. */
  startRound(now: number): Plan {
    const cut = this.pending(now);
    this.lines = [];
    this.last.clear();
    this.open = true;
    this.ended = -1;
    return { play: [], cut };
  }

  /** Quit to a menu: cut everything; stays closed until the next round. */
  hush(now: number): Plan {
    const cut = this.pending(now);
    this.lines = [];
    this.open = false;
    return { play: [], cut };
  }
}

/**
 * The round-end pair: the announcer calls it (a new personal best beats the catch call), then the runner
 * answers with the line his bubble shows. The chaser's cheer and the rest stay quiet.
 */
export function roundEndVoice(o: { caught: boolean; yoink: boolean; newBest: boolean; runner: RadbroId }): {
  call: AnnouncerKey;
  reply: { who: RadbroId; key: VoiceKey };
} {
  if (!o.caught) return { call: "rugged", reply: { who: o.runner, key: "escaped" } };
  return { call: o.newBest ? "new_best" : o.yoink ? "yoink" : "tagged", reply: { who: o.runner, key: "caught" } };
}
