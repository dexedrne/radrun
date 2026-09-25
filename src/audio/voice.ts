// Voice lines (catalog.ts: the runner's bubbles, the chaser's cheer, the announcer) on one speech timeline
// (speech.ts decides, this file plays): a line waits for the one before it (up to `maxWait`, else it is
// skipped), `interrupt` cuts whatever is talking at its priority or lower (the countdown, GO, rekt),
// cooldowns keep taunts from stacking. The round end is one call (roundEnd): it cuts the chase lines,
// plays the announcer's call then one Radbro reply, and nothing else speaks until the next round.
// Lines are scheduled on the AudioContext clock (no timers) and dip the music by ~4 dB while they play.
// say() tells the caller whether the line plays (and when it starts), is not loaded (the caller plays the
// chatter blips) or was dropped (busy / cooldown / closed: nothing plays, so no bubble either).
// ?vodebug logs every line started / cut / dropped (time, speaker, key, caller) to window.__voiceLog.
import type { RadbroId } from "../game/round.ts";
import { RADBROS } from "../game/round.ts";
import { engine, voiceOn, type Engine } from "./engine.ts";
import { dropSamples, playBuffer, preloadSamples, sample } from "./samples.ts";
import { ANNOUNCER_KEYS, VOICE_KEYS, voicePath, type AnnouncerKey, type Speaker, type VoiceKey } from "./catalog.ts";
import { PRI, Speech, type Ask, type Plan } from "./speech.ts";

export type SayOpts = {
  /** Seconds from now. */
  delay?: number;
  /** Longest it may wait behind another line (s); default 0.3. */
  maxWait?: number;
  /** Cut the line that is talking (its priority or lower). */
  interrupt?: boolean;
  /** Minimum seconds between lines of the same `group` (default: the speaker + key). */
  cooldown?: number;
  group?: string;
  gain?: number;
};

/**
 * What say() did: the seconds until the line starts (it plays; `delay` when voices are off), or why nothing
 * plays: "missing" (not loaded: the caller plays the chatter blips) / "dropped" (busy, cooldown or closed).
 */
export type Said = number | "missing" | "dropped";

const DIP = 0.63;
const speech = new Speech();
const playing = new Map<number, { src: AudioBufferSourceNode; g: GainNode; end: number }>();
let said = 0;

// ---- ?vodebug ------------------------------------------------------------------------------------
const DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("vodebug");
function debug(ev: string, x: Record<string, unknown>): void {
  if (!DEBUG) return;
  const caller = (new Error().stack ?? "").split("\n").slice(1).filter(l => !l.includes("/audio/voice.ts")).slice(0, 2)
    .map(l => l.trim().replace(/\?[^:)]*/, "")).join(" < ");
  const row = { ev, t: +(engine()?.ac.currentTime ?? 0).toFixed(3), ...x, caller };
  const w = window as unknown as { __voiceLog?: unknown[] };
  (w.__voiceLog ??= []).push(row);
  console.debug("[voice]", JSON.stringify(row));
}

function cut(e: Engine, plan: Plan, now: number): void {
  for (const l of plan.cut) {
    const a = playing.get(l.id);
    playing.delete(l.id);
    if (!a || a.end <= now) continue;
    a.g.gain.cancelScheduledValues(now);
    a.g.gain.setTargetAtTime(0, now, 0.02);
    try { a.src.stop(now + 0.12); } catch { /* not started / stopped */ }
    debug("cut", { who: l.who, key: l.key });
  }
  if (plan.cut.length && !speech.pending(now).length) {
    e.talk.gain.cancelScheduledValues(now);
    e.talk.gain.setTargetAtTime(1, now, 0.1);
  }
}

function play(e: Engine, plan: Plan, bufs: Map<string, AudioBuffer>, gain: number): void {
  const now = e.ac.currentTime;
  cut(e, plan, now);
  for (const [id, a] of playing) if (a.end < now) playing.delete(id);
  for (const l of plan.play) {
    const buf = bufs.get(`${l.who}:${l.key}`)!;
    const { src, g } = playBuffer(e, buf, e.voiceGain, l.start, gain);
    playing.set(l.id, { src, g, end: l.end });
    const p = e.talk.gain;
    p.cancelScheduledValues(l.start);
    p.setTargetAtTime(DIP, l.start, 0.05);
    p.setTargetAtTime(1, l.end, 0.3);
    said++;
    debug("start", { who: l.who, key: l.key, start: +l.start.toFixed(3), end: +l.end.toFixed(3) });
  }
}

function sayAny(who: Speaker, key: string, o: SayOpts, pri: number): Said {
  const buf = sample(voicePath(who, key));
  if (!buf) return "missing";
  const e = voiceOn();
  if (!e) return o.delay ?? 0;
  const now = e.ac.currentTime;
  const plan = speech.say(now, { ...o, who, key, dur: buf.duration, pri });
  if (plan.drop) {
    debug("drop", { who, key, why: plan.drop });
    return "dropped";
  }
  play(e, plan, new Map([[`${who}:${key}`, buf]]), o.gain ?? 1);
  return Math.max(0, plan.play[0].start - now);
}

/** A plan with nothing to start (a new round, a quit): cut what it names. */
function cutOnly(f: (now: number) => Plan): void {
  const e = engine();
  const now = e ? e.ac.currentTime : 0;
  const plan = f(now);
  if (e) cut(e, plan, now);
}

export const voice = {
  /** A Radbro's line (runner bubbles, the countdown quip). Show its bubble only when this is not "dropped". */
  say: (who: RadbroId, key: VoiceKey, o: SayOpts = {}): Said => sayAny(who, key, o, PRI.chatter),
  /** The announcer, a Milady (interrupts by default: she calls the countdown, GO, a fall). */
  announce: (key: AnnouncerKey, o: SayOpts = {}): Said => sayAny("announcer", key, { interrupt: true, ...o }, PRI.call),
  /**
   * The round is over: cut every queued / talking line, then the announcer's `call` and one Radbro
   * `reply` after it; nothing else speaks until roundStart. Once per `run` (a repeat is ignored).
   */
  roundEnd: (run: number, call: AnnouncerKey, reply: { who: RadbroId; key: VoiceKey }): void => {
    const e = voiceOn();
    const now = e ? e.ac.currentTime : 0;
    const bufs = new Map<string, AudioBuffer>();
    const ask = (who: Speaker, key: string): Ask | null => {
      const b = sample(voicePath(who, key));
      if (!b) return null;
      bufs.set(`${who}:${key}`, b);
      return { who, key, dur: b.duration };
    };
    const plan = speech.roundEnd(now, run, ask("announcer", call), ask(reply.who, reply.key));
    if (plan.drop) debug("drop", { who: "announcer", key: call, why: plan.drop });
    if (e) play(e, plan, bufs, 1);
    else cutOnly(() => plan);
  },
  /** A new round (PLAY, Retry, Next level): cut the last round's lines and open the timeline. */
  roundStart: (): void => cutOnly(now => speech.startRound(now)),
  /** Cut every line (quit to a menu). */
  hush: (): void => cutOnly(now => speech.hush(now)),
  /** That line is decoded (else the caller plays the chatter blips). */
  has: (who: RadbroId, key: VoiceKey): boolean => !!sample(voicePath(who, key)),
  said: () => said,
};

/**
 * Load the round's lines (not awaited: LOADING never waits for audio): the announcer, the runner's
 * lines, the chaser's cheer. Other Radbros' lines are dropped.
 */
export function preloadVoices(chaser: RadbroId, runner: RadbroId): void {
  for (const id of RADBROS) if (id !== chaser && id !== runner) dropSamples(`voice/${id}/`);
  const count: AnnouncerKey[] = ["three", "two", "one", "go"];
  preloadSamples(count.map(k => voicePath("announcer", k)), true);
  preloadSamples(VOICE_KEYS.filter(k => k !== "win").map(k => voicePath(runner, k)));
  preloadSamples(ANNOUNCER_KEYS.filter(k => !count.includes(k)).map(k => voicePath("announcer", k)));
  preloadSamples([voicePath(chaser, "win")]);
}
