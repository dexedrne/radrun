// SPIDER-TAG wager: the canonical round construction and the authoritative replay (docs/WAGER.md §5). The referee
// (relay/wager) steps these matches as the inputs are sealed, the verify page (?wager&verify=<matchId>) and
// `npm run wager:verify` replay a published SeriesLog with the very same code. Runs in browsers, Workers and Node:
// no DOM, no three.js; the caller loads the city model and tuning.json.
import { TAG, TagMatch, type TagSlot, type TagTable } from "../game/tagMatch.ts";
import type { RadbroId } from "../game/radbros.ts";
import { Fnv1a } from "../sim/math.ts";
import type { Tuning } from "../sim/tuning.ts";
import { CityIndex, type CityModel } from "../world/cityModel.ts";
import { NET_VERSION } from "../net/wire.ts";
import { SELFTEST_HASH } from "../net/selftest.ts";
import { rulesHash, simId, type SimCompat } from "./eip712.ts";
import {
  COUNTDOWN_STEPS, STEP_HZ, deriveSeed, scoreRounds, seedCommit, seriesLogHash, sideOfSlot, slotOfAFor, wordsFromBase64,
  type RoundLog, type RoundResult, type SeriesLog, type Side,
} from "./log.ts";

/** A district's sim inputs: its city model, the player tuning and the tag table from tuning.json. */
export type SimAssets = { model: CityModel; index?: CityIndex; tuning: Tuning; tag?: Partial<TagTable> };

/** Every player-tuning key and the tag table, hashed (the same algorithm as the online lobby's compat check). */
export function tuningHash(t: Tuning, tag: TagTable): string {
  const h = new Fnv1a();
  const put = (o: Record<string, unknown>) => {
    for (const k of Object.keys(o).sort()) {
      const v = o[k];
      h.str(k);
      if (typeof v === "number") h.f64(v); else if (typeof v === "boolean") h.i32(v ? 1 : 0);
    }
  };
  put(t as unknown as Record<string, unknown>);
  put(tag as unknown as Record<string, unknown>);
  return h.hex();
}

/** The sim a client or the referee runs (compare with Rules.simId via eip712.simId). */
export const simCompat = (a: SimAssets): SimCompat =>
  ({ v: NET_VERSION, selftest: SELFTEST_HASH, tuning: tuningHash(a.tuning, { ...TAG, ...a.tag }), city: a.model.hash });

export const endStepFor = (roundSeconds: number): number => COUNTDOWN_STEPS + Math.round(roundSeconds * STEP_HZ);

/** A wager round's match: no assists for either slot, the countdown on, the round length from the terms. */
export function roundMatch(a: SimAssets, seed: number, roundSeconds: number, radbrosBySlot: [string, string]): TagMatch {
  const slots: TagSlot[] = radbrosBySlot.map(r => ({ radbro: r as RadbroId, touch: false, easy: false }));
  return new TagMatch({ model: a.model, index: a.index ?? (a.index = new CityIndex(a.model)), tuning: a.tuning, tag: a.tag, slots, seed, seconds: roundSeconds });
}

/** The round's winning sim slot by the match's standings, or "draw" when bag time, falls and tags are all equal. */
export function roundWinnerSlot(m: TagMatch): 0 | 1 | "draw" {
  if (m.bag[0] === m.bag[1] && m.falls[0] === m.falls[1] && m.tags[0] === m.tags[1]) return "draw";
  return m.standings()[0] as 0 | 1;
}

/** A finished round's result per player (index = Side). */
export function roundResult(m: TagMatch, slotOfA: 0 | 1): RoundResult {
  const bySide = (arr: ArrayLike<number>): [number, number] => [arr[slotOfA], arr[1 - slotOfA]];
  const w = roundWinnerSlot(m);
  return { winner: w === "draw" ? "draw" : sideOfSlot(w, slotOfA), bag: bySide(m.bag), falls: bySide(m.falls), tags: bySide(m.tags), hash: m.hash() >>> 0 };
}

export type RoundReplay = { round: number; steps: number; hash: number; result: RoundResult | null; ms: number };

/** Replay one logged round from its words (steps 1..lastStep). */
export function replayRound(a: SimAssets, log: Pick<SeriesLog, "roundSeconds" | "radbros">, r: RoundLog): RoundReplay {
  const t0 = performance.now();
  const bySlot: [string, string] = r.slotOfA === 0 ? [log.radbros[0], log.radbros[1]] : [log.radbros[1], log.radbros[0]];
  const m = roundMatch(a, r.seed, log.roundSeconds, bySlot);
  if (m.endStep !== r.endStep) throw new Error(`round ${r.round}: endStep ${r.endStep} != ${m.endStep}`);
  const w0 = wordsFromBase64(r.words[0]), w1 = wordsFromBase64(r.words[1]);
  if (w0.length !== r.lastStep || w1.length !== r.lastStep) throw new Error(`round ${r.round}: ${w0.length}/${w1.length} words for ${r.lastStep} steps`);
  const pair = [0, 0];
  for (let s = 0; s < r.lastStep; s++) { pair[0] = w0[s]; pair[1] = w1[s]; m.stepWords(pair); }
  const full = r.lastStep === r.endStep && m.over;
  return { round: r.round, steps: r.lastStep, hash: m.hash() >>> 0, result: full ? roundResult(m, r.slotOfA) : null, ms: performance.now() - t0 };
}

export type SeriesVerdict = {
  ok: boolean;
  problems: string[];
  rounds: RoundReplay[];
  /** From the replayed rounds (a forfeit or a void is the relay's logged decision; the replay checks the rounds before it). */
  score: [number, number];
  winner: Side | null;
};

/**
 * Check a published series: the log hash, the seed commit and every round's seed and slot, the steps 1..inputDelay
 * being empty, and every finished round replaying to the logged result; then that the outcome follows from them.
 * `assets` must be the district in log.rules with the same sim (simCompat) the referee used.
 */
export function verifySeries(log: SeriesLog, assets: SimAssets): SeriesVerdict {
  const problems: string[] = [];
  const say = (m: string) => problems.push(m);
  if (seriesLogHash(log) !== log.logHash) say("the log hash does not match the log");
  if (rulesHash(log.rules) !== log.rulesHash) say("the rules hash does not match the rules");
  const mine = simCompat(assets);
  if (simId(mine) !== log.rules.simId) say(`this page's sim (${mine.v}/${mine.tuning}/${mine.city}) differs from the match's: replay it on build ${log.compat.build}`);
  if (seedCommit(log.seed.relaySecret) !== log.seed.commit) say("the relay's seed secret does not match its commit");
  const rounds: RoundReplay[] = [];
  const winners: (Side | "draw")[] = [];
  const seed1 = log.rounds[0]?.seed ?? 0;
  for (const r of log.rounds) {
    const seed = deriveSeed(log.seed.relaySecret, log.seed.shares, r.round);
    if (seed !== r.seed) say(`round ${r.round}: seed ${r.seed} is not the committed seed ${seed}`);
    if (slotOfAFor(r.round, seed, seed1) !== r.slotOfA) say(`round ${r.round}: player A's slot breaks the first-holder rule`);
    let rep: RoundReplay;
    try {
      rep = replayRound(assets, log, r);
      const w0 = wordsFromBase64(r.words[0]), w1 = wordsFromBase64(r.words[1]);
      for (let s = 0; s < Math.min(r.inputDelay, r.lastStep); s++) if (w0[s] !== 0 || w1[s] !== 0) { say(`round ${r.round}: step ${s + 1} is inside the input delay but not empty`); break; }
    } catch (e) {
      say(String((e as Error).message ?? e));
      continue;
    }
    rounds.push(rep);
    if (r.result) {
      if (!rep.result) say(`round ${r.round}: logged as finished but the words stop before the horn`);
      else {
        if (rep.result.winner !== r.result.winner) say(`round ${r.round}: the replay's winner (${rep.result.winner}) differs from the log's (${r.result.winner})`);
        if (rep.result.hash !== r.result.hash) say(`round ${r.round}: final state hash ${rep.result.hash.toString(16)} != logged ${r.result.hash.toString(16)}`);
        winners.push(rep.result.winner);
      }
    }
  }
  const sc = scoreRounds(winners);
  const o = log.outcome;
  if (o.reason === "played") {
    if (!sc.done) say("the outcome says the rounds decided it, but they do not");
    else if (sc.void ? o.kind !== "void" : o.kind !== "win" || o.winner !== sc.winner) say("the outcome differs from the replayed rounds");
  } else if (o.reason === "draws") {
    if (!sc.void) say("the series is void for draws, but the replay has too few drawn rounds");
  } else if (o.reason === "review") {
    // The owner's review voided a held series: it was held once decided (by the rounds or a forfeit), so the rounds
    // may well have decided it. A review can only void.
    if (o.kind !== "void") say("a review can only void a series");
  } else if (sc.done) {
    say(`the rounds already decided the series before the logged ${o.reason}`);
  }
  if (o.kind === "void" && o.winner !== null) say("a void has no winner");
  return { ok: problems.length === 0, problems, rounds, score: sc.score, winner: sc.winner };
}
