// Settings, personal bests and challenge links. localStorage is optional (every access try/catch).
import { RADBROS, type RadbroId } from "../game/round.ts";
import { DIFFICULTIES, type CameraTuning, type Difficulty } from "../sim/tuning.ts";

const KEY = "rugrun.v1";

type Stored = {
  settings?: Partial<Settings>;
  bests?: Record<string, number>;
  chaser?: RadbroId;
  difficulty?: Difficulty;
  visited?: boolean;
  /** First-run tips already shown (ui/hints.ts). */
  hints?: Record<string, boolean>;
};

/** Low = pixel ratio 1, no anti-aliasing (after a reload), no blob shadows / runner trail, fewer rooftop props. */
export type Quality = "low" | "high";

export type Settings = { sensitivity: number; invertY: boolean; fov: number; reducedMotion: boolean; easyGrab: boolean; volume: number; quality: Quality };

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
  const s = load().settings ?? {};
  return {
    sensitivity: s.sensitivity ?? cam.sensitivity,
    invertY: s.invertY ?? cam.invertY,
    fov: s.fov ?? cam.fov,
    reducedMotion: s.reducedMotion ?? cam.reducedMotion,
    easyGrab: s.easyGrab ?? cam.easyGrab,
    volume: s.volume ?? 0.8,
    quality: s.quality === "low" ? "low" : "high",
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

export function getBest(chaser: string, d: string): number | null {
  const b = load().bests?.[`${chaser}:${d}`];
  return typeof b === "number" ? b : null;
}
/** Records a catch time; returns the previous best (null if none). */
export function recordBest(chaser: string, d: string, t: number): number | null {
  const s = load();
  const key = `${chaser}:${d}`;
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

export type Challenge = { c: RadbroId | null; r: RadbroId | null; d: Difficulty | null; t: number | null };

/** ?c=<chaser>&r=<runner>&d=<chill|normal|degen>&t=<seconds>; invalid fields are ignored one by one. */
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
  return { c, r, d, t };
}

export function challengeUrl(chaser: string, runner: string, d: string, t: number): string {
  const u = new URL(location.href);
  u.search = `?c=${chaser}&r=${runner}&d=${d}&t=${t.toFixed(1)}`;
  u.hash = "";
  return u.toString();
}

/** Runner selection at PLAY (spec §20 item 2): the link's r if valid and != chaser, else random. */
export function pickRunner(chaser: RadbroId, linkRunner: RadbroId | null): RadbroId {
  if (linkRunner && linkRunner !== chaser) return linkRunner;
  const others = RADBROS.filter(r => r !== chaser);
  return others[Math.floor(Math.random() * others.length)];
}
