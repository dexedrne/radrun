// WebAudio one-shots (spec §13 audio/sfx.ts): synthesized, no files. One master gain (settings volume).
// The context is created/resumed on the first user gesture (PLAY); before that every call is a no-op.

type Ctx = { ac: AudioContext; master: GainNode; noise: AudioBuffer };
let ctx: Ctx | null = null;
let volume = 0.8;
let muted = false;

export function unlockAudio(): void {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      const master = ac.createGain();
      master.gain.value = volume * 0.5;
      master.connect(ac.destination);
      const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      ctx = { ac, master, noise };
    }
    if (ctx.ac.state === "suspended") void ctx.ac.resume();
  } catch {
    ctx = null;
  }
}

export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (ctx) ctx.master.gain.value = volume * 0.5;
}

export function setMuted(m: boolean): void {
  muted = m;
}

function ready(): Ctx | null {
  if (!ctx || muted || volume <= 0 || ctx.ac.state !== "running") return null;
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number, delay = 0): void {
  const c = ready();
  if (!c) return;
  const t = c.ac.currentTime + delay;
  const o = c.ac.createOscillator();
  const g = c.ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, gain: number, f0: number, f1: number, q = 1, delay = 0): void {
  const c = ready();
  if (!c) return;
  const t = c.ac.currentTime + delay;
  const src = c.ac.createBufferSource();
  src.buffer = c.noise;
  const bp = c.ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = q;
  bp.frequency.setValueAtTime(f0, t);
  bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(c.master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

export const sfx = {
  whoosh: () => noise(0.32, 0.5, 500, 2400, 0.8),
  jump: () => tone(260, 0.12, "square", 0.08, 520),
  grab: () => { tone(900, 0.06, "triangle", 0.18, 1400); noise(0.08, 0.25, 3000, 1500, 2); },
  land: () => { tone(120, 0.12, "sine", 0.35, 60); noise(0.1, 0.2, 800, 300, 1); },
  bonk: () => { tone(180, 0.2, "square", 0.2, 70); noise(0.15, 0.35, 600, 200, 1.5); },
  yoink: () => { noise(0.25, 0.4, 1200, 5000, 1); tone(440, 0.18, "sawtooth", 0.12, 1320); },
  blip: () => tone(1250, 0.05, "square", 0.06, 1600),
  beep: (go = false) => tone(go ? 1046 : 523, go ? 0.35 : 0.14, "square", 0.12),
  fall: () => tone(700, 0.7, "triangle", 0.18, 90),
  meow: () => { tone(620, 0.22, "sawtooth", 0.08, 880); tone(880, 0.25, "sawtooth", 0.06, 540, 0.2); },
  caught: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, "square", 0.1, undefined, i * 0.09)),
  escaped: () => [392, 370, 349, 262].forEach((f, i) => tone(f, i === 3 ? 0.7 : 0.3, "triangle", 0.14, i === 3 ? 180 : undefined, i * 0.28)),
};
