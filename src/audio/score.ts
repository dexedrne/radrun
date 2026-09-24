// The procedural score (pure: no WebAudio, Node tests import it). A minor, 16 steps a bar.
//   calm  - title / loading / results: 100 bpm, half-time kick + rim, shaker, pad chords, whole-note
//           bass, a sparse soft lead. 8-bar loop.
//   intro - the 3 s countdown: four-on-the-floor kick, offbeat hats, a pedal bass on A (plus the riser
//           and filter sweep music.ts adds). One bar, looped until GO.
//   chase - the round (and practice): 122 / 128 / 136 bpm on Chill / Normal / Degen. Kick on every beat,
//           snare on 2 and 4, offbeat hats, disco octave bass, a lead motif. 16 bars = A A' B A'' with
//           fills, and the melody seeds move on every 16-bar cycle (three cycles before it repeats).
//   layer - intensity 2 (he is within 20 m or panicking): 16th hats + a 16th arpeggio on top.
// Everything is a deterministic function of (mode, bar), so the loop varies by section, not by chance.

export type MusicMode = "off" | "calm" | "intro" | "chase";
export type Voice = "kick" | "snare" | "rim" | "hat" | "open" | "crash" | "bass" | "lead" | "arp" | "pad";
export type Note = { voice: Voice; step: number; midi: number; len: number; vel: number };
export type Bar = { base: Note[]; layer: Note[] };

export const STEPS = 16;
export const TEMPO = { calm: 100, intro: 128, chase: { chill: 122, normal: 128, degen: 136 } } as const;

type Chord = { pc: number; minor: boolean };
const ch = (pc: number, minor = false): Chord => ({ pc, minor });
const Am = ch(9, true), F = ch(5), C = ch(0), G = ch(7), Em = ch(4, true), Dm = ch(2, true), E = ch(4);

const PROG = {
  a: [Am, F, C, G],
  b: [F, G, Em, Am],
  calmA: [Am, F, C, G],
  calmB: [F, Em, Dm, E],
};

const tones = (c: Chord) => [c.pc, (c.pc + (c.minor ? 3 : 4)) % 12, (c.pc + 7) % 12];
/** Bass root in E2..D#3 (110 Hz = A2). */
const bassRoot = (c: Chord) => 40 + ((c.pc - 4 + 12) % 12);
/** Chord tones in [lo, hi], ascending. */
function span(c: Chord, lo: number, hi: number): number[] {
  const t = tones(c);
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (t.includes(m % 12)) out.push(m);
  return out;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lead rhythms: [step, length] per bar. */
const RHYTHM: [number, number][][] = [
  [[0, 3], [3, 3], [6, 2], [8, 2], [10, 2], [12, 4]],
  [[0, 2], [2, 2], [4, 4], [10, 2], [12, 2], [14, 2]],
  [[0, 4], [6, 2], [8, 2], [11, 1], [12, 4]],
  [[2, 2], [4, 2], [6, 2], [8, 4], [12, 2], [14, 2]],
  [[0, 1], [2, 1], [3, 2], [6, 2], [8, 3], [11, 3], [14, 2]],
  [[0, 2], [3, 3], [7, 1], [8, 2], [10, 6]],
];
const CALM_RHYTHM: [number, number][][] = [
  [[0, 6], [8, 4], [12, 4]],
  [[2, 4], [8, 8]],
  [[0, 4], [6, 2], [8, 6]],
];

/** A two-bar motif as (step, len, index into the chord's lead tones). */
type Motif = { step: number; len: number; idx: number }[][];

function motif(seed: number, rhythms: [number, number][][], maxIdx: number): Motif {
  const r = rng(seed);
  let idx = 2 + Math.floor(r() * 2);
  const bars: Motif = [];
  for (let b = 0; b < 2; b++) {
    const rh = rhythms[Math.floor(r() * rhythms.length)];
    bars.push(rh.map(([step, len]) => {
      const moves = [-2, -1, -1, 0, 1, 1, 2];
      idx = Math.max(0, Math.min(maxIdx, idx + moves[Math.floor(r() * moves.length)]));
      return { step, len, idx };
    }));
  }
  return bars;
}

function leadBar(m: Motif, which: number, chord: Chord, lo: number, hi: number, vel: number, land: boolean): Note[] {
  const pool = span(chord, lo, hi);
  const bar = m[which];
  return bar.map((n, i) => {
    const last = land && i === bar.length - 1;
    // Land the phrase on the lowest chord root in range.
    const midi = last ? pool.find(p => p % 12 === chord.pc) ?? pool[0] : pool[Math.min(pool.length - 1, n.idx)];
    return { voice: "lead" as const, step: n.step, midi, len: n.len, vel: vel * (i === 0 ? 1 : 0.85) };
  });
}

const drum = (voice: Voice, steps: number[], vel: number | number[]): Note[] =>
  steps.map((step, i) => ({ voice, step, midi: 0, len: 1, vel: Array.isArray(vel) ? vel[i % vel.length] : vel }));

/** Chase bar `bar` (any integer >= 0). */
function chaseBar(bar: number): Bar {
  const cycle = Math.floor(bar / 16) % 3;
  const inLoop = bar % 16;
  const section = Math.floor(inLoop / 4); // 0 A, 1 A', 2 B, 3 A''
  const i = inLoop % 4;
  const prog = section === 2 ? PROG.b : PROG.a;
  const chord = prog[i];
  const root = bassRoot(chord);
  const base: Note[] = [];
  // Drums.
  base.push(...drum("kick", [0, 4, 8, 12], [1, 0.9, 0.95, 0.9]));
  const fill = i === 3 && (section === 1 || section === 3);
  if (fill) base.push(...drum("snare", [4, 10, 12, 13, 14, 15], [0.9, 0.35, 0.55, 0.65, 0.8, 1]));
  else base.push(...drum("snare", [4, 12], 0.9));
  if (section === 2) base.push(...drum("snare", [7, 15], 0.28));
  base.push(...drum("open", [2, 6, 10, 14], [0.5, 0.42, 0.5, 0.42]));
  if (i === 0) base.push(...drum("crash", [0], section === 0 ? 0.9 : 0.6));
  // Bass: disco octaves (A sections), a galloping root/fifth (B).
  if (section === 2) {
    const pat: [number, number][] = [[0, 0], [3, 0], [4, 7], [6, 0], [8, 0], [11, 0], [12, 7], [14, 12]];
    for (const [s, o] of pat) base.push({ voice: "bass", step: s, midi: root + o, len: s === 3 || s === 11 ? 1 : 2, vel: s % 4 === 0 ? 1 : 0.8 });
  } else {
    for (let s = 0; s < 16; s += 2) base.push({ voice: "bass", step: s, midi: root + (s % 4 === 2 ? 12 : 0), len: s % 4 === 2 ? 1 : 2, vel: s % 4 === 0 ? 1 : 0.75 });
  }
  // Lead: a two-bar motif stated, restated with a landing; A' and B get their own motifs.
  const seedA = 101 + cycle * 7919, seedA2 = 202 + cycle * 7919, seedB = 303 + cycle * 7919;
  const m = motif(section === 1 ? seedA2 : section === 2 ? seedB : seedA, RHYTHM, 5);
  base.push(...leadBar(m, i % 2, chord, 64, 86, section === 2 ? 0.8 : 0.9, i === 3));
  // Intensity layer: 16th hats + a rising 16th arpeggio.
  const layer: Note[] = [];
  const arp = span(chord, 69, 93);
  for (let s = 0; s < 16; s++) {
    layer.push({ voice: "hat", step: s, midi: 0, len: 1, vel: s % 2 === 0 ? 0.32 : 0.2 });
    layer.push({ voice: "arp", step: s, midi: arp[(s % 4) + (s >= 8 ? 1 : 0)] ?? arp[0], len: 1, vel: s % 4 === 0 ? 0.5 : 0.36 });
  }
  return { base, layer };
}

function calmBar(bar: number): Bar {
  const inLoop = bar % 8;
  const cycle = Math.floor(bar / 8) % 2;
  const prog = inLoop < 4 ? PROG.calmA : PROG.calmB;
  const chord = prog[inLoop % 4];
  const root = bassRoot(chord);
  const base: Note[] = [];
  base.push(...drum("kick", [0, 7, 10], [0.55, 0.35, 0.45]));
  base.push(...drum("rim", [4, 12], [0.4, 0.45]));
  base.push(...drum("hat", [0, 2, 4, 6, 8, 10, 12, 14], [0.16, 0.1, 0.13, 0.1]));
  base.push({ voice: "bass", step: 0, midi: root, len: 6, vel: 0.8 });
  base.push({ voice: "bass", step: 6, midi: root + 7, len: 2, vel: 0.55 });
  base.push({ voice: "bass", step: 8, midi: root, len: 8, vel: 0.7 });
  for (const midi of span(chord, 57, 71).slice(0, 3)) base.push({ voice: "pad", step: 0, midi, len: 16, vel: 0.5 });
  const m = motif(505 + cycle * 31, CALM_RHYTHM, 4);
  if (inLoop % 4 !== 3) base.push(...leadBar(m, inLoop % 2, chord, 67, 84, 0.5, false));
  return { base, layer: [] };
}

function introBar(): Bar {
  const base: Note[] = [];
  base.push(...drum("kick", [0, 4, 8, 12], 0.85));
  base.push(...drum("open", [2, 6, 10, 14], 0.3));
  for (let s = 0; s < 16; s += 2) base.push({ voice: "bass", step: s, midi: 45, len: 1, vel: s % 4 === 0 ? 0.85 : 0.6 });
  return { base, layer: [] };
}

const cache = new Map<string, Bar>();
/** The notes of one bar, sorted by step. */
export function barNotes(mode: MusicMode, bar: number): Bar {
  const key = mode === "chase" ? `c${bar % 48}` : mode === "calm" ? `m${bar % 16}` : mode;
  let b = cache.get(key);
  if (!b) {
    b = mode === "chase" ? chaseBar(bar) : mode === "calm" ? calmBar(bar) : mode === "intro" ? introBar() : { base: [], layer: [] };
    b.base.sort((x, y) => x.step - y.step);
    b.layer.sort((x, y) => x.step - y.step);
    cache.set(key, b);
  }
  return b;
}

export function tempoFor(mode: MusicMode, difficulty: string): number {
  if (mode === "calm") return TEMPO.calm;
  if (mode === "intro") return TEMPO.intro;
  return (TEMPO.chase as Record<string, number>)[difficulty] ?? TEMPO.chase.normal;
}

// ---- what should be playing ----------------------------------------------------------------------

export type MusicInput = {
  /** Title, loading or boot screen. */
  title: boolean;
  results: boolean;
  practice: boolean;
  phase: "countdown" | "chase" | "caught" | "escaped" | "";
  /** Distance to him (m). */
  d: number;
  panic: boolean;
  gassed: boolean;
};

/** Close-chase layer: on under 20 m (or while he panics), off again past 24 m (hysteresis). */
export const LAYER_ON = 20;
export const LAYER_OFF = 24;

export function musicTarget(i: MusicInput, layerWas: boolean): { mode: MusicMode; layer: boolean } {
  if (i.title || i.results) return { mode: "calm", layer: false };
  if (i.phase === "countdown") return { mode: "intro", layer: false };
  if (i.phase === "caught" || i.phase === "escaped") return { mode: "calm", layer: false };
  if (i.practice) return { mode: "chase", layer: false };
  const near = i.d < LAYER_ON || (layerWas && i.d < LAYER_OFF);
  return { mode: "chase", layer: near || (i.panic && !i.gassed) };
}
