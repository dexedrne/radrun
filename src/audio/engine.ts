// The one AudioContext (spec §13 audio/): created on the first user gesture (PLAY / PRACTICE / the mute
// button / M), then kept for the page's life. Graph:
//   music voices -> musicIn -> musicFilter (mode cutoff / pause duck) -> duck -> musicGain (volume) -> talk -> master
//   music loops (tracks.ts) -> their own lift / pause filter ----------> duck
//   stings ----------------------------------------------------------------------> musicGain
//   SFX one-shots + wind -> sfxGain (volume) -> master
//   voice lines (voice.ts) -> voiceGain (volume) -> master; `talk` dips the music under them
//   master -> compressor -> destination
// Muted or tab hidden = the context is suspended (no audio thread work at all). Before the unlock every
// call is a no-op, and nothing here touches the DOM at import time (Node tests import the score only).

export type Engine = {
  ac: AudioContext;
  master: GainNode;
  musicIn: GainNode;
  musicFilter: BiquadFilterNode;
  duck: GainNode;
  musicGain: GainNode;
  sfxGain: GainNode;
  voiceGain: GainNode;
  /** Music dip under voice lines (voice.ts drives it). */
  talk: GainNode;
  /** 2 s of white noise, shared by every noisy voice. */
  noise: AudioBuffer;
};

let eng: Engine | null = null;
const vol = { music: 0.6, sfx: 0.8, voice: 0.9 };
let muted = false;
let hidden = false;
let low = false;
const onCreate: ((e: Engine) => void)[] = [];

/** Music/SFX volume curves: sliders are linear 0..1, loudness is closer to squared. */
const curve = (v: number) => v * v;

export function engine(): Engine | null {
  return eng;
}

/** The engine if the context is running and not muted (else null: skip the work). */
export function live(): Engine | null {
  return eng && !muted && eng.ac.state === "running" ? eng : null;
}

export function sfxOn(): Engine | null {
  return vol.sfx > 0 ? live() : null;
}
export function musicOn(): boolean {
  return vol.music > 0 && live() !== null;
}
export function voiceOn(): Engine | null {
  return vol.voice > 0 ? live() : null;
}
export function isLow(): boolean {
  return low;
}

/** Register setup that needs the context (music voices, the wind loop); runs now if it exists. */
export function whenCreated(f: (e: Engine) => void): void {
  if (eng) f(eng);
  else onCreate.push(f);
}

function wantRunning(): boolean {
  return !muted && !hidden;
}

function sync(): void {
  if (!eng) return;
  const { ac } = eng;
  try {
    if (wantRunning() && ac.state === "suspended") void ac.resume().catch(() => undefined);
    else if (!wantRunning() && ac.state === "running") void ac.suspend().catch(() => undefined);
  } catch {
    /* closed or unsupported: stay silent */
  }
}

/** Create / resume the context. Call from a user gesture (PLAY, PRACTICE, mute button, M key). */
export function unlockAudio(): void {
  try {
    if (!eng) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ac = new AC({ latencyHint: "interactive" });
      const master = ac.createGain();
      master.gain.value = 0.9;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 8;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      master.connect(comp).connect(ac.destination);
      const musicGain = ac.createGain();
      const sfxGain = ac.createGain();
      const duck = ac.createGain();
      const musicFilter = ac.createBiquadFilter();
      musicFilter.type = "lowpass";
      musicFilter.frequency.value = 16000;
      musicFilter.Q.value = 0.7;
      const musicIn = ac.createGain();
      const talk = ac.createGain();
      musicIn.connect(musicFilter).connect(duck).connect(musicGain).connect(talk).connect(master);
      sfxGain.connect(master);
      const voiceGain = ac.createGain();
      voiceGain.connect(master);
      const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const d = noise.getChannelData(0);
      let s = 0x9e3779b9;
      for (let i = 0; i < d.length; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
      }
      eng = { ac, master, musicIn, musicFilter, duck, musicGain, sfxGain, voiceGain, talk, noise };
      applyVolumes();
      // Tab hidden = suspend (the game pauses too); back = resume unless muted.
      document.addEventListener("visibilitychange", () => { hidden = document.hidden; sync(); });
      hidden = document.hidden;
      // Some browsers only resume inside a gesture: retry on the next one.
      const retry = () => sync();
      addEventListener("pointerdown", retry, { passive: true });
      addEventListener("keydown", retry);
      addEventListener("touchend", retry, { passive: true });
      for (const f of onCreate.splice(0)) {
        try { f(eng); } catch { /* a voice failing must not take the rest down */ }
      }
    }
    sync();
  } catch {
    eng = null;
  }
}

function applyVolumes(): void {
  if (!eng) return;
  const t = eng.ac.currentTime;
  eng.musicGain.gain.setTargetAtTime(curve(vol.music) * 0.55, t, 0.05);
  eng.sfxGain.gain.setTargetAtTime(curve(vol.sfx), t, 0.05);
  eng.voiceGain.gain.setTargetAtTime(curve(vol.voice) * 0.9, t, 0.05);
}

export function setAudioVolumes(music: number, sfx: number, voice = vol.voice): void {
  vol.music = Math.max(0, Math.min(1, music));
  vol.sfx = Math.max(0, Math.min(1, sfx));
  vol.voice = Math.max(0, Math.min(1, voice));
  applyVolumes();
}

export function setMuted(m: boolean): void {
  muted = m;
  sync();
}

export function isMuted(): boolean {
  return muted;
}

/** Low quality: the music drops its echo (see music.ts); only the first variation of each sampled SFX loads. */
export function setAudioLow(l: boolean): void {
  low = l;
  for (const f of lowListeners) f(l);
}
const lowListeners: ((l: boolean) => void)[] = [];
export function onLowChange(f: (l: boolean) => void): void {
  lowListeners.push(f);
  f(low);
}

export function audioState(): string {
  return eng ? eng.ac.state : "none";
}

/** Dev / test builds only (the probe): output level of the last ~20 ms, RMS and peak in dBFS. */
let meterNode: { an: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;
export function outputLevel(): { rms: number; peak: number } {
  if (!eng) return { rms: -120, peak: -120 };
  if (!meterNode) {
    const an = eng.ac.createAnalyser();
    an.fftSize = 1024;
    eng.master.connect(an);
    meterNode = { an, buf: new Float32Array(an.fftSize) };
  }
  const { an, buf } = meterNode;
  an.getFloatTimeDomainData(buf);
  let sum = 0, peak = 0;
  for (let i = 0; i < buf.length; i++) { const x = buf[i]; sum += x * x; const a = Math.abs(x); if (a > peak) peak = a; }
  const db = (x: number) => (x > 1e-6 ? 20 * Math.log10(x) : -120);
  return { rms: db(Math.sqrt(sum / buf.length)), peak: db(peak) };
}

export const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
