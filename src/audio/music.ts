// Music: the sampled loops and stings (tracks.ts) when they are playable, else the procedural score
// (audio/score.ts) - so a slow or failed file never means silence.
// Procedural music (the score is audio/score.ts). A fixed voice graph built once when the context is
// created (kick, snare, rim, hats, crash, bass, lead + echo, arp, pad: oscillators and ONE looping noise
// source that run for the page's life); notes are only automation events on those voices, scheduled
// ~0.2 s ahead by a 25 ms lookahead timer ("a tale of two clocks"). No nodes per note, nothing per frame:
// PlayDriver calls music.update() each frame and it only compares a few values. Stings (catch / rugged)
// are the only one-shot music nodes, a handful per round.
import { engine, live, midiHz, musicOn, onLowChange, whenCreated, type Engine } from "./engine.ts";
import { barNotes, tempoFor, type MusicMode, type Note } from "./score.ts";
import { countdownTrack, holdTracks, stingTrack, trackProbe, updateTracks } from "./tracks.ts";

const AHEAD = 0.2;
const TICK_MS = 25;
/** Music filter cutoff per mode (the pause duck pulls it to PAUSED_CUTOFF). */
const CUTOFF: Record<MusicMode, number> = { off: 16000, calm: 3200, intro: 9000, chase: 16000 };
const PAUSED_CUTOFF = 520;

type V = {
  kick: { osc: OscillatorNode; g: GainNode };
  snare: { g: GainNode; tone: OscillatorNode; tg: GainNode };
  rim: { osc: OscillatorNode; g: GainNode };
  hat: GainNode;
  open: GainNode;
  crash: GainNode;
  bass: { osc: OscillatorNode; f: BiquadFilterNode; g: GainNode };
  lead: { a: OscillatorNode; b: OscillatorNode; f: BiquadFilterNode; g: GainNode; send: GainNode; delay: DelayNode };
  arp: { osc: OscillatorNode; g: GainNode };
  pad: { osc: OscillatorNode[]; g: GainNode };
};

let v: V | null = null;
let mode: MusicMode = "off";
let layerWant = false;
let layerOn = false;
let difficulty = "normal";
let paused = false;
let bar = 0;
let step = 0;
let next = 0;
let stepDur = 60 / 128 / 4;
let holdUntil = 0;
let scheduled = 0;
let padIdx = 0;

function build(e: Engine): V {
  const { ac, musicIn } = e;
  const gain = (to: AudioNode) => { const g = ac.createGain(); g.gain.value = 0; g.connect(to); return g; };
  const osc = (type: OscillatorType, to: AudioNode, hz = 110) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = hz; o.connect(to); o.start(); return o; };
  const filt = (type: BiquadFilterType, hz: number, q: number, to: AudioNode) => { const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = hz; f.Q.value = q; f.connect(to); return f; };
  // One looping noise source feeds every noisy drum through its own filter.
  const noise = ac.createBufferSource();
  noise.buffer = e.noise;
  noise.loop = true;
  noise.start();
  const hat = gain(musicIn), open = gain(musicIn), crash = gain(musicIn), snareG = gain(musicIn);
  noise.connect(filt("highpass", 8000, 0.7, hat));
  noise.connect(filt("highpass", 6000, 0.7, open));
  noise.connect(filt("highpass", 4200, 0.5, crash));
  noise.connect(filt("bandpass", 2200, 0.8, snareG));
  const kickG = gain(musicIn);
  const tg = gain(musicIn);
  const rimG = gain(musicIn);
  const bassG = gain(musicIn);
  const bassF = filt("lowpass", 400, 4, bassG);
  const leadG = gain(musicIn);
  const leadF = filt("lowpass", 2800, 1, leadG);
  // Lead echo: dotted-8th feedback delay, darkened each repeat (off in Low quality).
  const send = ac.createGain();
  send.gain.value = 0.26;
  const delay = ac.createDelay(2);
  const fb = ac.createGain();
  fb.gain.value = 0.32;
  const dark = filt("lowpass", 2200, 0.7, fb);
  send.connect(delay);
  delay.connect(dark);
  fb.connect(delay);
  delay.connect(musicIn);
  const arpG = gain(musicIn);
  const padG = gain(musicIn);
  const padF = filt("lowpass", 1400, 0.7, padG);
  const voices: V = {
    kick: { osc: osc("sine", kickG, 50), g: kickG },
    snare: { g: snareG, tone: osc("triangle", tg, 190), tg },
    rim: { osc: osc("triangle", rimG, 1650), g: rimG },
    hat, open, crash,
    bass: { osc: osc("sawtooth", bassF, 110), f: bassF, g: bassG },
    lead: { a: osc("square", leadF, 440), b: osc("sawtooth", leadF, 440), f: leadF, g: leadG, send, delay },
    arp: { osc: osc("square", filt("highpass", 600, 0.7, arpG), 880), g: arpG },
    pad: { osc: [0, 1, 2].map(() => osc("triangle", padF, 220)), g: padG },
  };
  voices.lead.b.detune.value = 9;
  onLowChange(low => {
    try {
      if (low) leadG.disconnect(send);
      else leadG.connect(send);
    } catch { /* already (dis)connected */ }
  });
  return voices;
}

function setTempo(bpm: number): void {
  stepDur = 60 / bpm / 4;
  const e = engine();
  if (e && v) v.lead.delay.delayTime.setValueAtTime(stepDur * 3, e.ac.currentTime);
}

/** Colour of the pitched voices per mode (soft for calm). */
function colour(m: MusicMode): void {
  if (!v) return;
  const soft = m === "calm";
  v.lead.a.type = soft ? "triangle" : "square";
  v.lead.b.type = soft ? "sine" : "sawtooth";
  v.lead.f.frequency.value = soft ? 1600 : 2800;
}

function gains(): AudioParam[] {
  if (!v) return [];
  return [v.kick.g.gain, v.snare.g.gain, v.snare.tg.gain, v.rim.g.gain, v.hat.gain, v.open.gain, v.crash.gain, v.bass.g.gain, v.lead.g.gain, v.arp.g.gain, v.pad.g.gain];
}

/** Silence every voice from `t` (drops notes already scheduled after it). */
function hush(t: number): void {
  for (const p of gains()) {
    p.cancelScheduledValues(t);
    p.setTargetAtTime(0, t, 0.03);
  }
}

function filterTo(e: Engine, hz: number, tau = 0.08): void {
  const f = e.musicFilter.frequency, t = e.ac.currentTime;
  f.cancelScheduledValues(t);
  f.setTargetAtTime(hz, t, tau);
}

function play(n: Note, t: number): void {
  if (!v) return;
  const hz = n.midi > 0 ? midiHz(n.midi) : 0;
  const dur = n.len * stepDur;
  scheduled++;
  switch (n.voice) {
    case "kick": {
      const f = v.kick.osc.frequency;
      f.setValueAtTime(155, t);
      f.exponentialRampToValueAtTime(46, t + 0.12);
      v.kick.g.gain.setValueAtTime(0.95 * n.vel, t);
      v.kick.g.gain.setTargetAtTime(0, t + 0.012, mode === "calm" ? 0.1 : 0.075);
      break;
    }
    case "snare":
      v.snare.g.gain.setValueAtTime(0.55 * n.vel, t);
      v.snare.g.gain.setTargetAtTime(0, t + 0.004, 0.05);
      v.snare.tone.frequency.setValueAtTime(230, t);
      v.snare.tone.frequency.exponentialRampToValueAtTime(165, t + 0.06);
      v.snare.tg.gain.setValueAtTime(0.35 * n.vel, t);
      v.snare.tg.gain.setTargetAtTime(0, t + 0.004, 0.035);
      break;
    case "rim":
      v.rim.g.gain.setValueAtTime(0.28 * n.vel, t);
      v.rim.g.gain.setTargetAtTime(0, t + 0.002, 0.012);
      break;
    case "hat":
      v.hat.gain.setValueAtTime(0.3 * n.vel, t);
      v.hat.gain.setTargetAtTime(0, t + 0.002, 0.016);
      break;
    case "open":
      v.open.gain.setValueAtTime(0.26 * n.vel, t);
      v.open.gain.setTargetAtTime(0, t + 0.004, 0.055);
      break;
    case "crash":
      v.crash.gain.setValueAtTime(0.22 * n.vel, t);
      v.crash.gain.setTargetAtTime(0, t + 0.01, 0.4);
      break;
    case "bass": {
      const soft = mode === "calm";
      v.bass.osc.frequency.setValueAtTime(hz, t);
      v.bass.f.frequency.setValueAtTime(soft ? 380 : 380 + 1500 * n.vel, t);
      v.bass.f.frequency.setTargetAtTime(soft ? 260 : 240, t + 0.005, soft ? 0.2 : 0.07);
      v.bass.g.gain.setTargetAtTime(0.4 * n.vel, t, 0.004);
      v.bass.g.gain.setTargetAtTime(0, t + dur * 0.9, 0.025);
      break;
    }
    case "lead": {
      v.lead.a.frequency.setValueAtTime(hz, t);
      v.lead.b.frequency.setValueAtTime(hz, t);
      v.lead.g.gain.setTargetAtTime((mode === "calm" ? 0.22 : 0.14) * n.vel, t, 0.006);
      v.lead.g.gain.setTargetAtTime(0, t + dur * 0.85, 0.05);
      break;
    }
    case "arp":
      v.arp.osc.frequency.setValueAtTime(hz, t);
      v.arp.g.gain.setValueAtTime(0.1 * n.vel, t);
      v.arp.g.gain.setTargetAtTime(0, t + 0.004, 0.035);
      break;
    case "pad": {
      const o = v.pad.osc[padIdx++ % 3];
      o.frequency.setTargetAtTime(hz, t, 0.04);
      if (padIdx % 3 === 1) {
        v.pad.g.gain.setTargetAtTime(0.1 * n.vel, t, 0.35);
        v.pad.g.gain.setTargetAtTime(0.02, t + dur * 0.75, 0.3);
      }
      break;
    }
  }
}

function tick(): void {
  const e = live();
  if (!e || !v) return;
  const now = e.ac.currentTime;
  if (mode === "off" || !musicOn()) { next = Math.max(next, now); return; }
  // Fell behind (a long frame, a throttled timer): drop what was missed instead of a burst.
  if (next < now - 0.1) next = now + 0.03;
  const horizon = now + AHEAD;
  while (next < horizon) {
    if (next < holdUntil) { next = holdUntil; continue; }
    if (step % 4 === 0) layerOn = layerWant;
    padIdx = 0;
    const b = barNotes(mode, bar);
    for (const n of b.base) if (n.step === step) play(n, next);
    if (layerOn) for (const n of b.layer) if (n.step === step) play(n, next);
    next += stepDur;
    if (++step >= 16) { step = 0; bar++; }
  }
}

function switchTo(m: MusicMode): void {
  const from = mode;
  mode = m;
  const e = engine();
  if (!e || !v) return;
  const now = e.ac.currentTime;
  if (m === "off") { hush(now); return; }
  setTempo(tempoFor(m, difficulty));
  colour(m);
  if (!paused) filterTo(e, CUTOFF[m], m === "chase" ? 0.02 : 0.15);
  if (from === "intro" && m === "chase") {
    // GO: the next free 16th becomes the downbeat of bar 0.
    step = 0;
    bar = 0;
    return;
  }
  hush(now);
  bar = 0;
  step = m === "intro" ? 8 : 0;
  next = Math.max(now + 0.06, holdUntil);
}

let timerOn = false;
whenCreated(e => {
  v = build(e);
  if (!timerOn) { timerOn = true; setInterval(tick, TICK_MS); }
  const m = mode;
  mode = "off";
  if (m !== "off") switchTo(m);
});

/** The music the game wants now (called every frame; acts only on changes). */
function update(target: { mode: MusicMode; layer: boolean }, opts: { difficulty: string; paused: boolean; district?: string }): void {
  difficulty = opts.difficulty;
  layerWant = target.layer;
  const sampled = updateTracks(target.mode, target.layer, opts.district ?? "downtown", opts.paused);
  const m = sampled ? "off" : target.mode;
  if (m !== mode) switchTo(m);
  if (opts.paused !== paused) {
    paused = opts.paused;
    const e = engine();
    if (e) {
      filterTo(e, paused ? PAUSED_CUTOFF : CUTOFF[mode], 0.08);
      e.duck.gain.setTargetAtTime(paused ? 0.55 : 1, e.ac.currentTime, 0.08);
    }
  }
}

/** A countdown starts: restart the intro half a bar early so GO lands near a downbeat; filter sweep + riser. */
function countdown(seconds: number): void {
  holdUntil = 0; // a Retry during the catch sting starts the intro right away
  if (countdownTrack(seconds)) {
    switchTo("off");
    return;
  }
  mode = "off";
  switchTo("intro");
  const e = live();
  if (!e || !musicOn()) return;
  const t = e.ac.currentTime;
  const f = e.musicFilter.frequency;
  f.cancelScheduledValues(t);
  f.setValueAtTime(700, t);
  f.exponentialRampToValueAtTime(CUTOFF.intro, t + seconds);
  // Riser: noise swept up, into the music gain after the filter.
  const src = e.ac.createBufferSource();
  src.buffer = e.noise;
  src.loop = true;
  const bp = e.ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 2.5;
  bp.frequency.setValueAtTime(400, t);
  bp.frequency.exponentialRampToValueAtTime(6000, t + seconds);
  const g = e.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + seconds - 0.05);
  g.gain.setTargetAtTime(0, t + seconds - 0.03, 0.02);
  src.connect(bp).connect(g).connect(e.musicGain);
  src.start(t, Math.random());
  src.stop(t + seconds + 0.2);
}

// ---- stings --------------------------------------------------------------------------------------

function note(e: Engine, type: OscillatorType, hz: number, t: number, dur: number, peak: number, lp = 4000): OscillatorNode {
  const o = e.ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(hz, t);
  const f = e.ac.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = lp;
  const g = e.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  g.gain.setTargetAtTime(0, t + dur * 0.7, dur * 0.18);
  o.connect(f).connect(g).connect(e.musicGain);
  o.start(t);
  o.stop(t + dur + 0.3);
  return o;
}

function crashAt(e: Engine, t: number, peak: number, tau: number): void {
  const src = e.ac.createBufferSource();
  src.buffer = e.noise;
  const hp = e.ac.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 4500;
  const g = e.ac.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.setTargetAtTime(0, t + 0.01, tau);
  src.connect(hp).connect(g).connect(e.musicGain);
  src.start(t, Math.random());
  src.stop(t + tau * 6);
}

/** CAUGHT / YOINK: an A-major flourish (the minor loop resolves up), a held chord and a crash. Rugged:
 * a sad trombone "wah wah wah waaah". The groove stops for the sting; calm music follows it. */
function sting(kind: "caught" | "yoink" | "escaped"): void {
  const e = live();
  if (!e) return;
  const now = e.ac.currentTime, t = now + 0.03;
  hush(now);
  if (stingTrack(kind)) return;
  holdTracks(kind === "escaped" ? 2.9 : 1.7);
  if (kind === "escaped") {
    const seq: [number, number][] = [[62, 0.34], [61, 0.34], [60, 0.34], [59, 1.25]];
    let at = t;
    for (const [m, dur] of seq) {
      const last = dur > 1;
      const o = note(e, "sawtooth", midiHz(m), at, dur, 0.16, 900);
      o.detune.setValueAtTime(-30, at);
      o.detune.linearRampToValueAtTime(0, at + 0.08);
      if (last) {
        // Vibrato + droop on the last note.
        const lfo = e.ac.createOscillator();
        lfo.frequency.value = 5.5;
        const depth = e.ac.createGain();
        depth.gain.setValueAtTime(0, at);
        depth.gain.linearRampToValueAtTime(14, at + 0.4);
        lfo.connect(depth).connect(o.detune);
        lfo.start(at);
        lfo.stop(at + dur + 0.3);
        o.frequency.setValueAtTime(midiHz(m), at + dur * 0.55);
        o.frequency.exponentialRampToValueAtTime(midiHz(m) * 0.9, at + dur);
      }
      at += dur;
    }
    holdUntil = t + 2.9;
  } else {
    const run = kind === "yoink" ? [69, 73, 76, 81, 85] : [69, 73, 76, 81];
    run.forEach((m, i) => note(e, "square", midiHz(m), t + i * 0.07, 0.13, 0.1, 3500));
    const at = t + run.length * 0.07;
    for (const m of [69, 73, 76, 81]) {
      note(e, "sawtooth", midiHz(m), at, 1.0, 0.07, 2600);
      note(e, "square", midiHz(m) * 1.003, at, 1.0, 0.035, 1800);
    }
    note(e, "sine", midiHz(45), at, 1.0, 0.25, 800);
    crashAt(e, at, 0.25, 0.45);
    holdUntil = at + 1.7;
  }
  next = Math.max(next, holdUntil);
  bar = 0;
  step = 0;
}

export const music = {
  update,
  countdown,
  sting,
  probe: () => ({ mode, layer: layerOn, scheduled, ...trackProbe() }),
};
