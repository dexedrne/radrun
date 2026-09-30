// Anti-cheat signals (docs/WAGER.md §6.2), computed by the referee from its canonical match and the relay's arrival
// times, never from anything a client claims. Metrics accumulate per PLAYER over the series (a human gets few Yoinks
// in one round) and each kind is reported once per player, with the round in which it first crossed its threshold.
// The thresholds are starting values: test/wager-relay-flags.test.ts checks that the repo's sharp TagBot is flagged
// and that bot play with human reaction times and mouse-like aim is not; calibrating them on real human sessions is
// still open (docs/WAGER.md §12).
import type { Flag, FlagKind, Side } from "../../../src/wager/log.ts";

export const FLAG_LIMITS = {
  /** reaction: median steps from the red ring to the Yoink press. */
  reactionMedianSteps: 18,
  reactionMinEvents: 5,
  /** ...or this many Yoinks faster than reactionFastSteps. */
  reactionFastSteps: 10,
  reactionFastCount: 3,
  /** A Yoink whose press follows another web press this closely is a spam press, not a reaction (not counted). */
  reactionSpamSteps: 30,
  /** aim: median yaw error (1024 units per turn) at Yoink and yank presses. */
  aimMedianUnits: 1,
  aimMinPresses: 5,
  /**
   * aim, tracking: the median yaw error, sampled every few steps while the holder chases his target within trackRange m
   * (free to move). A script aims at the target exactly; a hand on a mouse or stick does not.
   */
  trackRange: 15,
  trackMedianUnits: 2,
  trackMinSamples: 24,
  /** periodic: coefficient of variation of the intervals between web presses. */
  periodicCv: 0.03,
  periodicMinPresses: 12,
  /** late-inputs: median arrival slack (ms) or filled fraction, on a fast connection only. */
  lateSlackMs: 10,
  lateFillFrac: 0.05,
  lateMaxRttMs: 150,
} as const;

/** One player's evidence so far (plain data: it is persisted with the series). */
export type SideMetrics = {
  reactions: number[];
  aimErr: number[];
  intervals: number[];
  slackMs: number[];
  /** Steps filled while the player was connected, and the steps they had to send. */
  fills: number;
  steps: number;
  /** Histogram of the tracking error (index = yaw units, the last bin = wider). */
  track: number[];
  /** Lowest relay-measured round trip (ms; NO_RTT until measured). */
  rtt: number;
  /** Rounds whose end hash disagreed with the referee's / whose both client hashes agreed but not with the referee. */
  desync: number[];
  mismatch: number[];
};

/** "Not measured" (kept finite: the metrics are persisted as JSON). */
export const NO_RTT = 1e9;

export const emptyMetrics = (): SideMetrics =>
  ({ reactions: [], aimErr: [], intervals: [], slackMs: [], track: [], fills: 0, steps: 0, rtt: NO_RTT, desync: [], mismatch: [] });

/** The median of a histogram (index = value). */
export function histMedian(h: readonly number[]): number {
  const n = h.reduce((a, b) => a + (b ?? 0), 0);
  if (!n) return NaN;
  let acc = 0;
  for (let i = 0; i < h.length; i++) { acc += h[i] ?? 0; if (acc * 2 >= n) return i; }
  return h.length - 1;
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function cv(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean <= 0) return NaN;
  const v = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return Math.sqrt(v) / mean;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** The flags this player's evidence raises now (every kind that is over its threshold). */
export function evaluate(side: Side, m: SideMetrics, round: number, L = FLAG_LIMITS): Flag[] {
  const out: Flag[] = [];
  const add = (kind: FlagKind, value: number, limit: number, note?: string) => out.push({ side, kind, round, value: round2(value), limit, ...(note ? { note } : {}) });
  if (m.reactions.length >= L.reactionMinEvents && median(m.reactions) < L.reactionMedianSteps) {
    add("reaction", median(m.reactions), L.reactionMedianSteps, `median of ${m.reactions.length} Yoinks, steps`);
  } else {
    const fast = m.reactions.filter(r => r < L.reactionFastSteps).length;
    if (fast >= L.reactionFastCount) add("reaction", fast, L.reactionFastCount, `Yoinks under ${L.reactionFastSteps} steps`);
  }
  const tracked = m.track.reduce((a, b) => a + (b ?? 0), 0);
  if (m.aimErr.length >= L.aimMinPresses && median(m.aimErr) <= L.aimMedianUnits) {
    add("aim", median(m.aimErr), L.aimMedianUnits, `median yaw error of ${m.aimErr.length} Yoink / yank presses, 1/1024 turn`);
  } else if (tracked >= L.trackMinSamples && histMedian(m.track) <= L.trackMedianUnits) {
    add("aim", histMedian(m.track), L.trackMedianUnits, `median tracking error over ${tracked} chase steps, 1/1024 turn`);
  }
  if (m.intervals.length + 1 >= L.periodicMinPresses) {
    const c = cv(m.intervals);
    if (c < L.periodicCv) add("periodic", c, L.periodicCv, `${m.intervals.length + 1} web presses`);
  }
  if (m.rtt < L.lateMaxRttMs) {
    const slack = median(m.slackMs), frac = m.steps > 0 ? m.fills / m.steps : 0;
    if (m.slackMs.length >= 60 && slack < L.lateSlackMs) add("late-inputs", slack, L.lateSlackMs, `median arrival slack, ms (round trip ${Math.round(m.rtt)} ms)`);
    else if (frac > L.lateFillFrac) add("late-inputs", frac, L.lateFillFrac, `fraction of steps filled while connected (round trip ${Math.round(m.rtt)} ms)`);
  }
  if (m.desync.length) add("desync", m.desync.length, 0, `rounds ${m.desync.join(", ")}`);
  if (m.mismatch.length) add("result-mismatch", m.mismatch.length, 0, `rounds ${m.mismatch.join(", ")}: both clients agree, the referee differs`);
  return out;
}

/** Merge newly raised flags into the list: one per (side, kind), keeping the round it was first raised in. */
export function mergeFlags(have: Flag[], fresh: Flag[]): Flag[] {
  const out = [...have];
  for (const f of fresh) {
    const i = out.findIndex(g => g.side === f.side && g.kind === f.kind);
    if (i < 0) out.push(f);
    else out[i] = { ...f, round: out[i].round };
  }
  return out;
}
