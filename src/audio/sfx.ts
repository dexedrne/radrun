// SFX, all into the SFX bus of audio/engine.ts. Sampled files (catalog.ts, loaded with the round) play
// when decoded; until then, or if a file fails, the synthesised version plays (it builds a few nodes per
// event; events are rare: a swing, a landing, a catch). The wind is one persistent loop (noise ->
// band-pass -> gain, swapped for the sampled wind loop once it decodes) that the game only steers
// (sfx.wind at <= 20 Hz), never rebuilds.
// Before the first user gesture, muted, tab hidden or SFX volume 0: every call is a no-op.
import { isLow, sfxOn, whenCreated, type Engine } from "./engine.ts";
import { SFX, SFX_FIRST, sfxPath, type SfxName } from "./catalog.ts";
import { loadSample, playBuffer, preloadSamples, sample } from "./samples.ts";

let played = 0;

function tone(e: Engine, type: OscillatorType, f0: number, f1: number, t: number, dur: number, peak: number, attack = 0.006): OscillatorNode {
  const o = e.ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = e.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(e.sfxGain);
  o.start(t);
  o.stop(t + dur + 0.03);
  return o;
}

function noise(e: Engine, type: BiquadFilterType, f0: number, f1: number, q: number, t: number, dur: number, peak: number, attackFrac = 0.25): void {
  const src = e.ac.createBufferSource();
  src.buffer = e.noise;
  const f = e.ac.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = e.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + Math.max(0.002, dur * attackFrac));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(e.sfxGain);
  src.start(t, Math.random() * 1.5);
  src.stop(t + dur + 0.05);
}

/** Run `f` with the live engine and "now" (+ delay), counting the sound for the probe. */
function at(delay: number, f: (e: Engine, t: number) => void): void {
  const e = sfxOn();
  if (!e) return;
  played++;
  f(e, e.ac.currentTime + 0.005 + delay);
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---- samples -------------------------------------------------------------------------------------
const lastPick = new Map<SfxName, number>();
/** Sampled one-shots playing now (Low quality caps them). */
let voices = 0;

/** A decoded variation of `name` (not the one played last time), or null. */
function pick(name: SfxName): AudioBuffer | null {
  const files = SFX[name];
  const n = isLow() ? 1 : files.length;
  const prev = lastPick.get(name) ?? -1;
  const start = Math.floor(Math.random() * n);
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (n > 1 && i === prev) continue;
    const b = sample(sfxPath(files[i]));
    if (b) { lastPick.set(name, i); return b; }
  }
  return n > 1 && prev >= 0 ? sample(sfxPath(files[prev])) : null;
}

/**
 * Play the sampled `name` (gain, slight random pitch); true if handled (played, or nothing may play
 * now), false = not loaded -> the caller synthesises it.
 */
function smp(name: SfxName, gain: number, delay = 0, detune = 0.04): boolean {
  const e = sfxOn();
  if (!e) return true;
  const b = pick(name);
  if (!b) return false;
  if (isLow() && voices >= 6) return true;
  played++;
  voices++;
  const { src } = playBuffer(e, b, e.sfxGain, e.ac.currentTime + 0.005 + delay, gain, 1 + (Math.random() * 2 - 1) * detune);
  src.addEventListener("ended", () => { voices--; });
  return true;
}

/** Soft / light / heavy landing sample by impact (m/s). */
function landSample(impact: number): boolean {
  const k = clamp01((impact - 2) / 14);
  return k < 0.04 ? smp("landLight", 0.25) : k < 0.45 ? smp("landLight", 0.4 + 0.6 * k) : smp("landHeavy", 0.45 + 0.5 * k);
}

/** Load the sampled SFX (with the round; not awaited). Low quality: only the first variation. */
export function preloadSfx(): void {
  const files = (n: SfxName) => (isLow() ? SFX[n].slice(0, 1) : SFX[n]).map(sfxPath);
  preloadSamples([sfxPath(SFX.beep[0]), sfxPath(SFX.go[0])], true);
  preloadSamples([...SFX_FIRST, ...(Object.keys(SFX) as SfxName[]).filter(n => !SFX_FIRST.includes(n) && n !== "wind")].flatMap(files));
  void loadSample(sfxPath(SFX.wind[0])).then(b => { if (b) sampledWind(b); });
}

// ---- wind: one persistent loop ---------------------------------------------------------------------
let wind: { src: AudioBufferSourceNode; f: BiquadFilterNode; g: GainNode; sampled: boolean } | null = null;
whenCreated(e => {
  const src = e.ac.createBufferSource();
  src.buffer = e.noise;
  src.loop = true;
  const f = e.ac.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = 0.8;
  f.frequency.value = 400;
  const g = e.ac.createGain();
  g.gain.value = 0;
  src.connect(f).connect(g).connect(e.sfxGain);
  src.start();
  wind = { src, f, g, sampled: false };
});

/** The sampled wind loop replaces the noise source (same gain; a low-pass opens with speed). */
function sampledWind(buf: AudioBuffer): void {
  const w = wind;
  if (!w || w.sampled) return;
  const ac = w.g.context;
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const f = ac.createBiquadFilter();
  f.type = "lowpass";
  f.Q.value = 0.5;
  f.frequency.value = 1200;
  src.connect(f).connect(w.g);
  src.start(ac.currentTime, Math.random() * buf.duration);
  try { w.src.stop(); w.f.disconnect(); } catch { /* already stopped */ }
  wind = { src, f, g: w.g, sampled: true };
  windLevel = -1;
}

let windLevel = 0;

/** A catch: George meows (formant synthesis: a sawtooth through two moving band-passes). */
function meow(e: Engine, t: number, sulky: boolean): void {
  const dur = sulky ? 0.75 : 0.5;
  const o = e.ac.createOscillator();
  o.type = "sawtooth";
  const p = sulky ? [430, 470, 320] : [520, 780, 470];
  o.frequency.setValueAtTime(p[0], t);
  o.frequency.exponentialRampToValueAtTime(p[1], t + dur * 0.3);
  o.frequency.exponentialRampToValueAtTime(p[2], t + dur);
  // Vibrato.
  const lfo = e.ac.createOscillator();
  lfo.frequency.value = 7;
  const lg = e.ac.createGain();
  lg.gain.value = 12;
  lfo.connect(lg).connect(o.frequency);
  const out = e.ac.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(sulky ? 0.32 : 0.42, t + 0.06);
  out.gain.setValueAtTime(sulky ? 0.3 : 0.4, t + dur * 0.6);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  // "m-e-o-w": formants open (ee), then round off (oo).
  const f1 = [[350, 950, 600], [1200, 2300, 1000]];
  for (const [i, fs] of f1.entries()) {
    const bp = e.ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = i === 0 ? 5 : 7;
    bp.frequency.setValueAtTime(fs[0], t);
    bp.frequency.exponentialRampToValueAtTime(fs[1], t + dur * 0.35);
    bp.frequency.exponentialRampToValueAtTime(fs[2], t + dur);
    const bg = e.ac.createGain();
    bg.gain.value = i === 0 ? 1 : 0.6;
    o.connect(bp).connect(bg).connect(out);
  }
  out.connect(e.sfxGain);
  o.start(t);
  lfo.start(t);
  o.stop(t + dur + 0.05);
  lfo.stop(t + dur + 0.05);
}

export const sfx = {
  /** Rope attach: a noisy "thwip" (band-passed noise + a falling sine). */
  thwip: () => smp("thwip", 0.55) || at(0, (e, t) => {
    noise(e, "bandpass", 5200, 1300, 3, t, 0.1, 0.5, 0.1);
    tone(e, "sine", 2400, 520, t, 0.09, 0.22, 0.003);
    tone(e, "triangle", 1300, 900, t + 0.01, 0.05, 0.06, 0.002);
  }),
  /** Let go of the rope: a short fling whoosh, brighter when fast. */
  fling: (speed: number) => smp("fling", 0.3 + 0.45 * clamp01(speed / 20)) || at(0, (e, t) => {
    const k = clamp01(speed / 20);
    noise(e, "bandpass", 500 + 400 * k, 1800 + 1800 * k, 0.9, t, 0.26 + 0.1 * k, 0.18 + 0.25 * k, 0.35);
  }),
  jump: () => smp("jump", 0.4) || at(0, (e, t) => tone(e, "square", 240, 470, t, 0.1, 0.05)),
  /** Landing thud; impact = downward speed (m/s) at touch-down. */
  land: (impact: number) => landSample(impact) || at(0, (e, t) => {
    const k = clamp01((impact - 2) / 14);
    if (k < 0.04) { noise(e, "bandpass", 900, 500, 1, t, 0.06, 0.08, 0.1); return; }
    tone(e, "sine", 95 + 45 * k, 42, t, 0.12 + 0.12 * k, 0.25 + 0.55 * k, 0.003);
    noise(e, "lowpass", 900 + 900 * k, 180, 0.8, t, 0.1 + 0.12 * k, 0.12 + 0.4 * k, 0.05);
  }),
  /** Wall bonk: a hollow cartoon "bonk". */
  bonk: () => smp("bonk", 0.7) || at(0, (e, t) => {
    tone(e, "triangle", 540, 250, t, 0.16, 0.3, 0.002);
    tone(e, "sine", 170, 70, t, 0.24, 0.38, 0.002);
    noise(e, "bandpass", 1500, 700, 2, t, 0.05, 0.25, 0.05);
  }),
  /** YOINK: the lasso whips out and cracks. */
  yoink: () => smp("lasso", 0.75, 0, 0) || at(0, (e, t) => {
    noise(e, "bandpass", 350, 3200, 1.2, t, 0.17, 0.35, 0.7);
    tone(e, "sawtooth", 180, 900, t, 0.16, 0.05);
    noise(e, "highpass", 2500, 2500, 0.7, t + 0.16, 0.035, 0.9, 0.05);
    tone(e, "square", 2200, 1400, t + 0.16, 0.02, 0.25, 0.001);
  }),
  /** The bag changes hands: a coin jingle. */
  jingle: () => smp("jingle", 0.5, 0.12) || at(0.12, (e, t) => {
    const f = [2637, 3322, 2960, 3951, 3136, 4186, 3520];
    f.forEach((hz, i) => {
      const s = t + i * 0.045 + (i % 2) * 0.012;
      tone(e, "sine", hz, hz, s, 0.22, 0.09, 0.002);
      tone(e, "sine", hz * 2.76, hz * 2.76, s, 0.08, 0.03, 0.001);
    });
    noise(e, "highpass", 6000, 6000, 0.7, t, 0.35, 0.05, 0.1);
  }),
  /** Countdown 3-2-1 and GO. */
  beep: (go = false) => smp(go ? "go" : "beep", go ? 0.4 : 0.32, 0, 0) || at(0, (e, t) => {
    if (go) {
      tone(e, "square", 880, 880, t, 0.12, 0.09);
      tone(e, "square", 1318, 1318, t + 0.1, 0.32, 0.1);
      tone(e, "sine", 659, 659, t + 0.1, 0.32, 0.12);
    } else {
      tone(e, "square", 660, 660, t, 0.13, 0.08);
      tone(e, "sine", 1320, 1320, t, 0.1, 0.05);
    }
  }),
  /** Speech-bubble chatter: 2-4 quick blips around the speaker's pitch. */
  chatter: (base = 700) => at(0, (e, t) => {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const hz = base * (0.85 + Math.random() * 0.45);
      tone(e, "square", hz, hz * (1 + (Math.random() - 0.5) * 0.3), t + i * 0.065, 0.05, 0.045, 0.003);
    }
  }),
  /** Off the city ("rekt."): a falling whistle. */
  fall: () => smp("fall", 0.5, 0, 0) || at(0, (e, t) => tone(e, "triangle", 900, 110, t, 0.75, 0.14, 0.02)),
  /** George after a catch (sulky after an escape). */
  meow: (sulky = false) => smp(sulky ? "sulky" : "meow", 0.55, sulky ? 0.9 : 0.55) || at(sulky ? 0.9 : 0.55, (e, t) => meow(e, t, sulky)),
  /** Round 4: a fragile balloon pops (a sharp burst + a rubbery squeak). */
  pop: () => smp("pop", 0.6) || at(0, (e, t) => {
    noise(e, "highpass", 1800, 900, 0.8, t, 0.05, 0.55, 0.05);
    tone(e, "square", 1400, 300, t, 0.06, 0.12, 0.001);
  }),
  /** Round 4: a wind gust starts (a rising, breathy swell). */
  gust: () => smp("gust", 0.55, 0, 0.02) || at(0, (e, t) => {
    noise(e, "bandpass", 300, 900, 0.7, t, 1.6, 0.22, 0.9);
    noise(e, "bandpass", 700, 1500, 1.2, t + 0.3, 1.2, 0.12, 0.8);
  }),
  /** The rug swoops in. */
  rug: () => smp("rug", 0.65, 0, 0) || at(0, (e, t) => {
    noise(e, "bandpass", 250, 1400, 1.1, t, 0.9, 0.3, 0.5);
    tone(e, "sine", 70, 140, t + 0.2, 0.6, 0.18, 0.2);
  }),
  /**
   * Wind while airborne / on the rope, louder and brighter with speed (m/s). Call at <= 20 Hz; it only
   * sets two automation targets on the persistent loop.
   */
  wind: (speed: number, airborne: boolean) => {
    const w = wind;
    if (!w) return;
    const e = sfxOn();
    const k = airborne && e ? clamp01((speed - 5) / 15) : 0;
    const level = k * k * (w.sampled ? 0.5 : 0.32);
    if (level === windLevel || (level > 0 && Math.abs(level - windLevel) < 0.004)) return;
    windLevel = level;
    const now = w.g.context.currentTime;
    w.g.gain.setTargetAtTime(level, now, 0.12);
    w.f.frequency.setTargetAtTime(w.sampled ? 900 + 260 * speed : 300 + 90 * speed, now, 0.12);
  },
  played: () => played,
};
