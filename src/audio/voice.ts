// Voice lines (catalog.ts: the runner's bubbles, the chaser's cheer, the announcer). One speech timeline:
// a line waits for the one before it (up to `maxWait`, else it is skipped), `interrupt` cuts whatever
// is talking (the countdown, a catch), cooldowns keep taunts from stacking. Lines are scheduled on the
// AudioContext clock (no timers) and dip the music by ~4 dB while they play.
// say() returns false only when that line is not loaded (the caller then plays the chatter blips).
import type { RadbroId } from "../game/round.ts";
import { RADBROS } from "../game/round.ts";
import { live, voiceOn, type Engine } from "./engine.ts";
import { dropSamples, playBuffer, preloadSamples, sample } from "./samples.ts";
import { ANNOUNCER_KEYS, VOICE_KEYS, voicePath, type AnnouncerKey, type Speaker, type VoiceKey } from "./catalog.ts";

export type SayOpts = {
  /** Seconds from now. */
  delay?: number;
  /** Longest it may wait behind another line (s); default 0.3. */
  maxWait?: number;
  /** Cut the line that is talking. */
  interrupt?: boolean;
  /** Minimum seconds between lines of the same `group` (default: the speaker + key). */
  cooldown?: number;
  group?: string;
  gain?: number;
};

const GAP = 0.08;
const DIP = 0.63;
let freeAt = 0;
let said = 0;
const active: { src: AudioBufferSourceNode; g: GainNode; end: number }[] = [];
const last = new Map<string, number>();

function stopAll(e: Engine, t: number): void {
  for (const a of active) {
    if (a.end <= t) continue;
    a.g.gain.setTargetAtTime(0, t, 0.02);
    try { a.src.stop(t + 0.12); } catch { /* not started / stopped */ }
  }
  active.length = 0;
  freeAt = 0;
  e.talk.gain.cancelScheduledValues(t);
  e.talk.gain.setTargetAtTime(1, t, 0.1);
}

function dip(e: Engine, start: number, end: number): void {
  const p = e.talk.gain;
  p.cancelScheduledValues(start);
  p.setTargetAtTime(DIP, start, 0.05);
  p.setTargetAtTime(1, end, 0.3);
}

function sayAny(who: Speaker, key: string, o: SayOpts): boolean {
  const buf = sample(voicePath(who, key));
  if (!buf) return false;
  const e = voiceOn();
  if (!e) return true;
  const now = e.ac.currentTime;
  const group = o.group ?? `${who}:${key}`;
  const prev = last.get(group);
  if (o.cooldown && prev !== undefined && now - prev < o.cooldown) return true;
  const t0 = now + 0.01 + (o.delay ?? 0);
  if (o.interrupt) stopAll(e, t0);
  const start = Math.max(t0, freeAt + GAP);
  if (start - t0 > (o.maxWait ?? 0.3)) return true;
  const { src, g } = playBuffer(e, buf, e.voiceGain, start, o.gain ?? 1);
  const end = start + buf.duration;
  for (let i = active.length - 1; i >= 0; i--) if (active[i].end < now) active.splice(i, 1);
  active.push({ src, g, end });
  freeAt = end;
  last.set(group, now);
  dip(e, start, end);
  said++;
  return true;
}

export const voice = {
  /** A Radbro's line (runner bubbles, the chaser's cheer). */
  say: (who: RadbroId, key: VoiceKey, o: SayOpts = {}): boolean => sayAny(who, key, o),
  /** The announcer, a Milady (interrupts by default: she calls the round). */
  announce: (key: AnnouncerKey, o: SayOpts = {}): boolean => sayAny("announcer", key, { interrupt: true, ...o }),
  /** Cut every line (quit / restart). */
  hush: (): void => {
    const e = live();
    if (e) stopAll(e, e.ac.currentTime);
  },
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
