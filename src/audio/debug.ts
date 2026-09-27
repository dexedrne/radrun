// ?sfxdebug: every sound the game asks for is logged to window.__sfxLog (and console.debug): SFX with whether it
// actually played (false = no audio yet, muted, hidden tab or SFX volume 0), music tracks / stings / the procedural
// score as they start. For headless checks (does this page make sound, and only once per event); off otherwise.
import { audioState, engine } from "./engine.ts";

export const SOUND_DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("sfxdebug");

export type SoundLogRow = { kind: "sfx" | "music"; name: string; played: boolean; state: string; t: number; ac: number } & Record<string, unknown>;

export function soundLog(kind: SoundLogRow["kind"], name: string, played: boolean, extra: Record<string, unknown> = {}): void {
  if (!SOUND_DEBUG) return;
  const row: SoundLogRow = { kind, name, played, state: audioState(), t: Math.round(performance.now()), ac: +(engine()?.ac.currentTime ?? 0).toFixed(3), ...extra };
  const w = window as unknown as { __sfxLog?: SoundLogRow[] };
  (w.__sfxLog ??= []).push(row);
  console.debug("[sound]", JSON.stringify(row));
}
