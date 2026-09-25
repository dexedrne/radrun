// Sampled music (catalog.ts). The calm loop (title / loading / results) and the district's chase loop
// stream through media elements (never decoded whole, never waited for); each has a fade gain into one
// bus: lift (close-chase high shelf) -> pause low-pass -> the engine's duck. The countdown build and the
// catch / rugged stings are short decoded one-shots into the music gain.
// music.ts asks every frame; a loop that is not playable yet (or failed) leaves the procedural score in
// charge, so the game never waits for a file and always has music. Crossfades are gain automation only.
import { engine, musicOn, whenCreated, type Engine } from "./engine.ts";
import { audioUrl, playBuffer, preloadSamples, sample } from "./samples.ts";
import { MUSIC, chaseTrack, musicPath } from "./catalog.ts";
import type { MusicMode } from "./score.ts";

type Track = { name: string; el: HTMLAudioElement; g: GainNode; failed: boolean; on: boolean; stopAt: number };

let bus: { lift: BiquadFilterNode; level: GainNode; lp: BiquadFilterNode } | null = null;
const tracks = new Map<string, Track>();
let cur: Track | null = null;
/** No loop until this context time (a sting is playing). */
let holdUntil = 0;
let countdownSrc: { src: AudioBufferSourceNode; g: GainNode } | null = null;
let introSampled = false;
let lifted = false;
let pausedNow = false;

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

const playable = (t: Track | null): t is Track => !!t && !t.failed && (t.el.readyState >= 3 || (t.on && t.el.readyState >= 2));

function fadeIn(e: Engine, t: Track, tau: number, fromStart: boolean): void {
  t.on = true;
  if (fromStart && t.el.paused) {
    try { t.el.currentTime = 0; } catch { /* not seekable yet */ }
  }
  if (t.el.paused) void t.el.play().catch(() => { t.failed = true; });
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

/** Start streaming the district's chase loop (with the round) and decode the countdown build + stings. */
export function preloadTracks(district: string): void {
  preloadSamples([musicPath(MUSIC.countdown)], true);
  preloadSamples([musicPath(MUSIC.win), musicPath(MUSIC.yoink), musicPath(MUSIC.rugged)]);
  const go = (e: Engine) => { track(e, chaseTrack(district)); };
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
  const name = mode === "calm" ? MUSIC.title : mode === "chase" ? chaseTrack(district) : null;
  const t = name ? track(e, name) : null;
  const ok = playable(t);
  const want = musicOn() && ok && now >= holdUntil ? t : null;
  if (want !== cur) {
    const toChase = mode === "chase";
    if (cur) fadeOut(e, cur, !musicOn() ? 0.05 : toChase || mode === "intro" ? 0.08 : cur.name === MUSIC.title ? 0.5 : 0.12);
    // GO: the countdown build cuts on the downbeat, so the chase loop starts at once, from bar 1.
    if (want) fadeIn(e, want, toChase && introSampled ? 0.01 : toChase ? 0.25 : 0.8, toChase);
    cur = want;
  }
  if (mode !== "intro") introSampled = false;
  // Left the countdown before GO (quit / restart): cut the build.
  if (countdownSrc && mode !== "intro" && mode !== "chase") stopCountdown(e);
  // Close-chase layer: the loop gets louder and brighter (the procedural layer would clash with it).
  if (layer !== lifted) {
    lifted = layer;
    bus.lift.gain.setTargetAtTime(layer ? 5 : 0, now, 0.25);
    bus.level.gain.setTargetAtTime(layer ? 1.2 : 1, now, 0.25);
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
