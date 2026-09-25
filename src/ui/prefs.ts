// Settings, personal bests and challenge links. localStorage is optional (every access try/catch).
import { RADBROS, type RadbroId } from "../game/round.ts";
import { DIFFICULTIES, type CameraTuning, type Difficulty } from "../sim/tuning.ts";
import { PAGE_DISTRICT } from "../app/district.ts";

const KEY = "rugrun.v1";

type Stored = {
  settings?: Partial<Settings>;
  bests?: Record<string, number>;
  chaser?: RadbroId;
  difficulty?: Difficulty;
  visited?: boolean;
  /** First-run tips already shown (ui/hints.ts). */
  hints?: Record<string, boolean>;
  /** Your personal-best run per chaser:difficulty (game/ghost.ts link string). */
  ghosts?: Record<string, StoredGhost>;
};

/** A kept run: the round (chaser, runner, difficulty, seed), its catch time and the packed record. */
/** mu = the round's mutator bits (round 4; missing = 0). */
export type StoredGhost = { c: RadbroId; r: RadbroId; d: Difficulty; s: number; t: number; g: string; mu?: number };

/** Low = pixel ratio 1, no anti-aliasing (after a reload), no blob shadows / runner trail, fewer rooftop props. */
export type Quality = "low" | "high";

/**
 * music / sfx / voice = volume sliders 0..1; muted = the mute button / M key (both in pause -> Settings too).
 * qualityChosen = the player picked Low / High in Settings (auto quality never overrides that);
 * qualityAuto = auto quality already switched to Low once (it never switches back).
 */
export type Settings = {
  sensitivity: number; invertY: boolean; fov: number; reducedMotion: boolean; easyGrab: boolean; quality: Quality;
  music: number; sfx: number; voice: number; muted: boolean; qualityChosen: boolean; qualityAuto: boolean;
};

function load(): Stored {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Stored;
  } catch {
    return {};
  }
}
function save(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: fine */
  }
}

export function loadSettings(cam: CameraTuning): Settings {
  const s = (load().settings ?? {}) as Partial<Settings> & { volume?: number };
  const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
  return {
    sensitivity: s.sensitivity ?? cam.sensitivity,
    invertY: s.invertY ?? cam.invertY,
    fov: s.fov ?? cam.fov,
    reducedMotion: s.reducedMotion ?? cam.reducedMotion,
    easyGrab: s.easyGrab ?? cam.easyGrab,
    quality: s.quality === "low" ? "low" : "high",
    // Round 1-3 had one "volume" (SFX only): it becomes the SFX volume.
    music: num(s.music, 0.6),
    sfx: num(s.sfx, num(s.volume, 0.8)),
    voice: num(s.voice, 0.9),
    muted: s.muted === true,
    qualityChosen: s.qualityChosen === true,
    qualityAuto: s.qualityAuto === true,
  };
}

/** The stored quality (read before the canvas exists). Default High; on touch devices High already
 * caps the pixel ratio (1.25 on phones, 1.5 on tablets; see input/touch.ts canvasDpr). */
export function loadQuality(): Quality {
  return load().settings?.quality === "low" ? "low" : "high";
}
export function saveSettings(settings: Settings): void {
  const s = load();
  s.settings = settings;
  save(s);
}
export function applySettings(cam: CameraTuning, s: Settings): void {
  cam.sensitivity = s.sensitivity;
  cam.invertY = s.invertY;
  cam.fov = s.fov;
  cam.reducedMotion = s.reducedMotion;
  cam.easyGrab = s.easyGrab;
}

/** First-run tips (ui/hints.ts): seen flags, remembered across visits. */
export function hintsSeen(): Record<string, boolean> {
  return { ...(load().hints ?? {}) };
}
export function markHintSeen(id: string): void {
  const s = load();
  s.hints = { ...(s.hints ?? {}), [id]: true };
  save(s);
}
export function resetHintsSeen(): void {
  const s = load();
  delete s.hints;
  save(s);
}

/** Best-time / kept-ghost key: Downtown keeps the original `chaser:difficulty`; other districts add `:map`. */
export const bestKey = (chaser: string, d: string, mu = 0): string =>
  (PAGE_DISTRICT === "downtown" ? `${chaser}:${d}` : `${chaser}:${d}:${PAGE_DISTRICT}`) + (mu ? `:m${mu}` : "");

export function getBest(chaser: string, d: string, mu = 0): number | null {
  const b = load().bests?.[bestKey(chaser, d, mu)];
  return typeof b === "number" ? b : null;
}
/** Records a catch time; returns the previous best (null if none). */
export function recordBest(chaser: string, d: string, t: number, mu = 0): number | null {
  const s = load();
  const key = bestKey(chaser, d, mu);
  const prev = s.bests?.[key] ?? null;
  if (prev === null || t < prev) {
    s.bests = { ...(s.bests ?? {}), [key]: t };
    save(s);
  }
  return prev;
}

export function lastPicks(): { chaser: RadbroId; difficulty: Difficulty; firstVisit: boolean } {
  const s = load();
  const d = s.difficulty && (DIFFICULTIES as readonly string[]).includes(s.difficulty) ? s.difficulty : "chill";
  return { chaser: s.chaser ?? "652", difficulty: s.visited ? d : "chill", firstVisit: !s.visited };
}
export function rememberPicks(chaser: RadbroId, difficulty: Difficulty): void {
  const s = load();
  s.chaser = chaser;
  s.difficulty = difficulty;
  s.visited = true;
  save(s);
}

/**
 * s = the round seed and g = the packed ghost (both only in ghost links); v = link version (1 = no v);
 * mu = mutator bits (round 4; v1 links: 0).
 */
export type Challenge = { c: RadbroId | null; r: RadbroId | null; d: Difficulty | null; t: number | null; s: number | null; g: string | null; v: number; mu: number };

/**
 * ?c=<chaser>&r=<runner>&d=<chill|normal|degen>&t=<seconds>[&s=<seed>&g=<ghost>]; invalid fields are
 * ignored one by one.
 */
export function readChallenge(search: string): Challenge {
  const q = new URLSearchParams(search);
  const id = (v: string | null) => (v && (RADBROS as readonly string[]).includes(v) ? (v as RadbroId) : null);
  const c = id(q.get("c"));
  let r = id(q.get("r"));
  if (r && r === c) r = null;
  const dv = q.get("d");
  const d = dv && (DIFFICULTIES as readonly string[]).includes(dv) ? (dv as Difficulty) : null;
  const tv = Number(q.get("t"));
  const t = q.has("t") && isFinite(tv) && tv > 0 && tv <= 90 ? Math.round(tv * 10) / 10 : null;
  const sv = q.get("s") ?? "";
  const s = /^\d{1,10}$/.test(sv) && Number(sv) <= 0xffffffff ? Number(sv) : null;
  const gv = q.get("g") ?? "";
  const g = /^[A-Za-z0-9_-]{8,60000}$/.test(gv) ? gv : null;
  const vv = Number(q.get("v"));
  const v = q.has("v") && Number.isInteger(vv) && vv > 0 ? vv : 1;
  const mv = Number(q.get("mu"));
  const mu = q.has("mu") && Number.isInteger(mv) && mv >= 0 ? mv & 127 : 0;
  return { c, r, d, t, s, g, v, mu };
}

/**
 * Link format version (round 4): v=2 links carry the district (m=, omitted for Downtown) and later the
 * mutators (mu=); a link without v is a v1 link = Downtown, no mutators.
 */
export const LINK_VERSION = 2;
const mapParam = () => (PAGE_DISTRICT === "downtown" ? "" : `&m=${PAGE_DISTRICT}`);

const muParam = (mu: number) => (mu ? `&mu=${mu}` : "");

export function challengeUrl(chaser: string, runner: string, d: string, t: number, mu = 0): string {
  const u = new URL(location.href);
  u.search = `?v=${LINK_VERSION}${mapParam()}${muParam(mu)}&c=${chaser}&r=${runner}&d=${d}&t=${t.toFixed(1)}`;
  u.hash = "";
  return u.toString();
}

/** A ghost link: the exact round (seed, pair, difficulty), the claimed time and the packed run. */
export function ghostUrl(chaser: string, runner: string, d: string, t: number, seed: number, g: string, mu = 0): string {
  const u = new URL(location.href);
  u.search = `?v=${LINK_VERSION}${mapParam()}${muParam(mu)}&c=${chaser}&r=${runner}&d=${d}&s=${seed >>> 0}&t=${t.toFixed(1)}&g=${g}`;
  u.hash = "";
  return u.toString();
}

/** Your kept personal-best run for a chaser x difficulty, if any. */
export function getBestGhost(chaser: string, d: string, mu = 0): StoredGhost | null {
  const g = load().ghosts?.[bestKey(chaser, d, mu)];
  return g && typeof g.g === "string" && typeof g.s === "number" && typeof g.t === "number" ? g : null;
}
/** Keep a run as the personal-best ghost (only if it is still the best for its chaser x difficulty). */
export function saveBestGhost(g: StoredGhost): void {
  const s = load();
  const key = bestKey(g.c, g.d, g.mu ?? 0);
  const best = s.bests?.[key];
  if (typeof best === "number" && g.t > best + 1e-9) return;
  s.ghosts = { ...(s.ghosts ?? {}), [key]: g };
  save(s);
}

/** Runner selection at PLAY (spec §20 item 2): the link's r if valid and != chaser, else random. */
export function pickRunner(chaser: RadbroId, linkRunner: RadbroId | null): RadbroId {
  if (linkRunner && linkRunner !== chaser) return linkRunner;
  const others = RADBROS.filter(r => r !== chaser);
  return others[Math.floor(Math.random() * others.length)];
}
