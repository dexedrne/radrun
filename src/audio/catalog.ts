// The sampled audio under public/audio/ (pure: Node tests import it and check every file exists).
//   music/  loops (title + one chase loop per district) streamed through media elements; stings decoded
//   sfx/    one-shots (+ the wind loop), `_2` / `_3` = variations of the same sound
//   voice/  per-Radbro lines (keys match the bubbles in ui/strings.ts) + the announcer (a Milady)
// Everything here is optional at runtime: a file that fails to load falls back to the procedural sound.
import type { RadbroId } from "../game/round.ts";

/** Sampled SFX groups (variations picked at random, never the same one twice in a row). */
export const SFX = {
  thwip: ["rope_thwip", "rope_thwip_2", "rope_thwip_3"],
  fling: ["rope_release", "rope_release_2", "rope_release_3"],
  jump: ["jump", "jump_2", "jump_3"],
  landLight: ["land_light", "land_light_2", "land_light_3"],
  landHeavy: ["land_heavy", "land_heavy_2", "land_heavy_3"],
  bonk: ["bonk", "bonk_2", "bonk_3"],
  lasso: ["lasso_crack"],
  jingle: ["bag_grab", "bag_grab_2", "bag_grab_3"],
  beep: ["countdown_beep"],
  go: ["go_beep"],
  fall: ["fall_whistle"],
  meow: ["meow_happy", "meow_happy_2", "meow_happy_3"],
  sulky: ["meow_sulky", "meow_sulky_2", "meow_sulky_3"],
  /** Round 9: a web snaps (the round 4 balloon-pop samples, reused). */
  snap: ["balloon_pop", "balloon_pop_2", "balloon_pop_3"],
  gust: ["wind_gust"],
  rug: ["rug_swoosh"],
  wind: ["wind_loop"],
} as const satisfies Record<string, readonly string[]>;
export type SfxName = keyof typeof SFX;

/** Loaded first (the countdown needs them within a second of LOADING ending). */
export const SFX_FIRST: readonly SfxName[] = ["beep", "go", "thwip", "fling", "jump", "landLight"];

/** A Radbro's lines: `taunt_{i+1}` = TAUNTS[who][i]; caught / escaped = LINES; win = the chaser's cheer. */
export const VOICE_KEYS = [
  "countdown", "panic", "cornered", "gassed", "caught", "escaped",
  "taunt_1", "taunt_2", "taunt_3", "taunt_4", "taunt_5", "taunt_6", "win",
] as const;
export type VoiceKey = (typeof VOICE_KEYS)[number];
export const TAUNT_LINES = 6;
export const tauntKey = (i: number): VoiceKey => `taunt_${(((i % TAUNT_LINES) + TAUNT_LINES) % TAUNT_LINES) + 1}` as VoiceKey;

export const ANNOUNCER_KEYS = ["three", "two", "one", "go", "yoink", "tagged", "rekt", "rugged", "gassed", "new_best"] as const;
export type AnnouncerKey = (typeof ANNOUNCER_KEYS)[number];
/** Countdown number -> announcer line (3, 2, 1). */
export const COUNT_KEYS: Record<number, AnnouncerKey> = { 3: "three", 2: "two", 1: "one" };

export type Speaker = RadbroId | "announcer";

/** Music: the calm loop (title / loading / results), the countdown build and the end-of-round stings. */
export const MUSIC = {
  title: "title_calm",
  countdown: "sting_countdown",
  win: "sting_win",
  yoink: "sting_yoink",
  rugged: "sting_rugged",
} as const;

/**
 * Chase loop per district id. String keys on purpose: a district added later only needs its line here
 * (an unknown id plays Downtown's loop).
 */
export const CHASE_TRACK: Readonly<Record<string, string>> = {
  downtown: "chase_downtown",
  market: "chase_market",
  docks: "chase_docks",
  towers: "chase_towers",
  vertigo: "chase_vertigo",
};
export const chaseTrack = (district: string): string => CHASE_TRACK[district] ?? CHASE_TRACK.downtown;

export const sfxPath = (file: string): string => `sfx/${file}.mp3`;
export const voicePath = (who: Speaker, key: string): string => `voice/${who}/${key}.mp3`;
export const musicPath = (name: string): string => `music/${name}.mp3`;

/** Every file the game can request (relative to public/audio/). */
export function allAudioFiles(radbros: readonly RadbroId[]): string[] {
  const out: string[] = [];
  for (const files of Object.values(SFX)) for (const f of files) out.push(sfxPath(f));
  for (const who of radbros) for (const k of VOICE_KEYS) out.push(voicePath(who, k));
  for (const k of ANNOUNCER_KEYS) out.push(voicePath("announcer", k));
  for (const m of Object.values(MUSIC)) out.push(musicPath(m));
  for (const m of Object.values(CHASE_TRACK)) out.push(musicPath(m));
  return out;
}
