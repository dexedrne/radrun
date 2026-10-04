// Sampled music (catalog.ts). The calm loop (title / loading / results) and the round's loop (the music style:
// the district's chill loop, or its chase loop) stream through media elements (never decoded whole, never waited
// for); each has a fade gain into one bus: lift (close-chase high shelf) -> pause low-pass -> the engine's duck.
// The countdown build and the catch / rugged stings are short decoded one-shots into the music gain.
// music.ts asks every frame; a loop that is not playable yet (or failed) leaves the procedural score in
// charge, so the game never waits for a file and always has music. Crossfades are gain automation only.
import { engine, musicOn, whenCreated, type Engine } from "./engine.ts";
import { audioUrl, playBuffer, preloadSamples, sample } from "./samples.ts";
import { MUSIC, musicPath, roundTrack, type MusicStyle } from "./catalog.ts";
import type { MusicMode } from "./score.ts";
import { soundLog } from "./debug.ts";

type Track = { name: string; el: HTMLAudioElement; g: GainNode; failed: boolean; on: boolean; stopAt: number };

let bus: { lift: BiquadFilterNode; level: GainNode; lp: BiquadFilterNode } | null = null;
const tracks = new Map<string, Track>();
let cur: Track | null = null;
/** No loop until this context time (a sting is playing). */
let holdUntil = 0;
let countdownSrc: { src: AudioBufferSourceNode; g: GainNode } | null = null;
let introSampled = false;
let lifted = false;
let liftStyle: MusicStyle | null = null;
let pausedNow = false;
let style: MusicStyle = "chill";
/** Rounds played (an unknown district rotates through the chill loops, one per round). */
let rotation = 0;
let wasChase = false;

/** Close-chase lift per style: high-shelf dB and level. Chill keeps it gentle (the same loop, a little brighter). */
const LIFT: Record<MusicStyle, { shelf: number; level: number }> = { chill: { shelf: 2, level: 1.08 }, chase: { shelf: 5, level: 1.2 } };

/** The music style (pause -> Settings); a change mid-round crossfades to the other loop. */
export function setMusicStyle(s: MusicStyle): void {
  style = s === "chase" ? "chase" : "chill";
}
export function musicStyle(): MusicStyle {
  return style;
}

whenCreated(e => {
  const lift = e.ac.createBiquadFilter();
  lift.type = "highshelf";
  lift.frequency.value = 3500;
  lift.gain.value = 0;
  const level = e.ac.createGain();
  const lp = e.ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 20000;
  lp.Q.value = 0.7;
  lift.connect(level).connect(lp).connect(e.duck);
  bus = { lift, level, lp };
  // Muted / tab hidden suspends the context: pause the elements too (no streaming, no drift).
  e.ac.addEventListener("statechange", () => {
    for (const t of tracks.values()) {
      if (e.ac.state !== "running") t.el.pause();
      else if (t.on) void t.el.play().catch(() => undefined);
    }
  });
  // The calm loop starts streaming as soon as there is a context (title / loading / results).
  track(e, MUSIC.title);
});

function track(e: Engine, name: string): Track | null {
  const have = tracks.get(name);
  if (have) return have;
  if (!bus || typeof Audio === "undefined") return null;
  const el = new Audio();
  el.preload = "auto";
  el.loop = true;
  el.src = audioUrl(musicPath(name));
  const g = e.ac.createGain();
  g.gain.value = 0;
  const t: Track = { name, el, g, failed: false, on: false, stopAt: 0 };
  el.addEventListener("error", () => { t.failed = true; });
  try {
    e.ac.createMediaElementSource(el).connect(g).connect(bus.lift);
  } catch {
    t.failed = true;
  }
  tracks.set(name, t);
  return t;
}

/** Ready to start, or already chosen and still going (a seek back to the top briefly drops readyState). */
const playable = (t: Track | null): t is Track => !!t && !t.failed && (t.el.readyState >= 3 || (t.on && (t.el.readyState >= 2 || t.el.seeking)));

function fadeIn(e: Engine, t: Track, tau: number, fromStart: boolean): void {
  t.on = true;
  if (fromStart && t.el.paused && t.el.currentTime > 0) {
    try { t.el.currentTime = 0; } catch { /* not seekable yet */ }
  }
  if (t.el.paused) void t.el.play().catch(() => { t.failed = true; });
  soundLog("music", t.name, true, { from: +t.el.currentTime.toFixed(2) });
  const p = t.g.gain, now = e.ac.currentTime;
  p.cancelScheduledValues(now);
  p.setTargetAtTime(1, now, tau);
}

function fadeOut(e: Engine, t: Track, tau: number): void {
  t.on = false;
  const p = t.g.gain, now = e.ac.currentTime;
  p.cancelScheduledValues(now);
  p.setTargetAtTime(0, now, tau);
  t.stopAt = now + tau * 6;
}

/** Decode the countdown build (small; it plays the moment the countdown starts). */
export function preloadCountdown(): void {
  preloadSamples([musicPath(MUSIC.countdown)], true);
}

/**
 * Start streaming the round's loop and decode the countdown build + stings. LOADING calls it once the round's models
 * are in: the loop (1-2 MB) and the stings are not needed before GO / the round's end, and would otherwise share the
 * line with the models the round waits for (the procedural score covers the loop until it can play).
 */
export function preloadTracks(district: string): void {
  preloadCountdown();
  preloadSamples([musicPath(MUSIC.win), musicPath(MUSIC.yoink), musicPath(MUSIC.rugged)]);
  const go = (e: Engine) => { track(e, roundTrack(style, district, rotation)); };
  const e = engine();
  if (e) go(e);
  else whenCreated(go);
}

/**
 * Every frame (from music.update): steer the loops. Returns true when the sampled music has this mode
 * (the procedural score then stays silent).
 */
export function updateTracks(mode: MusicMode, layer: boolean, district: string, paused: boolean): boolean {
  const e = engine();
  if (!e || !bus) return false;
  const now = e.ac.currentTime;
  // A round's music ended: the next round of an unknown district takes the next chill loop.
  if (wasChase && mode !== "chase") rotation++;
  wasChase = mode === "chase";
  const name = mode === "calm" ? MUSIC.title : mode === "chase" ? roundTrack(style, district, rotation) : null;
  const t = name ? track(e, name) : null;
  const ok = playable(t);
  // The style changed mid-round: the loop playing keeps going until the other one can take over (a crossfade, no gap).
  const keep = mode === "chase" && !!t && !t.failed && !ok && !!cur && cur.name !== MUSIC.title && playable(cur);
  const want = musicOn() && now >= holdUntil ? (ok ? t : keep ? cur : null) : null;
  if (want !== cur) {
    const toChase = mode === "chase";
    if (cur) fadeOut(e, cur, !musicOn() ? 0.05 : toChase || mode === "intro" ? 0.08 : cur.name === MUSIC.title ? 0.5 : 0.12);
    // GO: the countdown build cuts on the downbeat, so the chase loop starts at once, from bar 1 (a chill loop
    // eases in over a beat's first few tens of ms).
    if (want) fadeIn(e, want, toChase && introSampled ? (style === "chill" ? 0.05 : 0.01) : toChase ? 0.25 : 0.8, toChase);
    cur = want;
  }
  if (mode !== "intro") introSampled = false;
  // Left the countdown before GO (quit / restart): cut the build.
  if (countdownSrc && mode !== "intro" && mode !== "chase") stopCountdown(e);
  // Close-chase layer: the loop gets louder and brighter (the procedural layer would clash with it); on Chill only
  // a little.
  if (layer !== lifted || style !== liftStyle) {
    lifted = layer;
    liftStyle = style;
    bus.lift.gain.setTargetAtTime(layer ? LIFT[style].shelf : 0, now, 0.25);
    bus.level.gain.setTargetAtTime(layer ? LIFT[style].level : 1, now, 0.25);
  }
  if (paused !== pausedNow) {
    pausedNow = paused;
    bus.lp.frequency.setTargetAtTime(paused ? 520 : 20000, now, 0.08);
  }
  for (const x of tracks.values()) {
    if (!x.on && !x.el.paused && now >= x.stopAt) {
      x.el.pause();
      if (x.name !== MUSIC.title) {
        try { x.el.currentTime = 0; } catch { /* fine */ }
      }
    }
  }
  if (mode === "intro") return introSampled;
  if (mode === "calm" && now < holdUntil) return true;
  return want !== null;
}

function stopCountdown(e: Engine): void {
  if (!countdownSrc) return;
  const now = e.ac.currentTime;
  countdownSrc.g.gain.setTargetAtTime(0, now, 0.03);
  try { countdownSrc.src.stop(now + 0.2); } catch { /* ended */ }
  countdownSrc = null;
}

/** The countdown build, trimmed so its downbeat cut lands on GO (`seconds` from now). */
export function countdownTrack(seconds: number): boolean {
  const e = engine();
  const buf = sample(musicPath(MUSIC.countdown));
  if (e) stopCountdown(e);
  introSampled = false;
  if (!e || !buf || !musicOn()) return false;
  const now = e.ac.currentTime;
  const offset = Math.max(0, buf.duration - seconds);
  countdownSrc = playBuffer(e, buf, e.musicGain, now + 0.02, 0.9, 1, offset);
  soundLog("music", MUSIC.countdown, true);
  const src = countdownSrc.src;
  src.addEventListener("ended", () => { if (countdownSrc?.src === src) countdownSrc = null; });
  introSampled = true;
  return true;
}

/** End-of-round sting; true if the sampled one played. The calm loop comes back under its tail. */
export function stingTrack(kind: "caught" | "yoink" | "escaped"): boolean {
  const e = engine();
  if (!e) return false;
  if (countdownSrc) stopCountdown(e);
  const buf = sample(musicPath(kind === "escaped" ? MUSIC.rugged : kind === "yoink" ? MUSIC.yoink : MUSIC.win));
  if (!buf || !musicOn()) return false;
  const now = e.ac.currentTime;
  if (cur) { fadeOut(e, cur, 0.06); cur = null; }
  playBuffer(e, buf, e.musicGain, now + 0.03, 0.85);
  soundLog("music", kind === "escaped" ? MUSIC.rugged : kind === "yoink" ? MUSIC.yoink : MUSIC.win, true);
  holdUntil = now + Math.max(1, buf.duration - 1.2);
  return true;
}

/** The procedural sting played instead: keep the loops quiet for that long. */
export function holdTracks(seconds: number): void {
  const e = engine();
  if (!e) return;
  if (cur) { fadeOut(e, cur, 0.06); cur = null; }
  holdUntil = e.ac.currentTime + seconds;
}

export function trackProbe(): { track: string; ready: number; failed: number } {
  let ready = 0, failed = 0;
  for (const t of tracks.values()) {
    if (t.failed) failed++;
    else if (t.el.readyState >= 3) ready++;
  }
  return { track: cur ? cur.name : "", ready, failed };
}
