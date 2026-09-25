// Small zustand UI store. The drivers push HUD numbers at 10 Hz so the canvas tree never re-renders.
import { create } from "zustand";
import type { RadbroId } from "../game/round.ts";
import { detectTouch } from "../input/touch.ts";
import { loadQuality, type Quality } from "./prefs.ts";

export type Hud = {
  speed: number;
  phase: "ground" | "air" | "rope" | "wall" | "ledge" | "slide";
  ring: number;
  chain: number;
  topSpeed: number;
  maxChain: number;
  falls: number;
  bonks: number;
  fps: number;
  steps: number;
  /** Round 9: parkour moves done (wall runs, wall jumps, climbs, vaults, slides). */
  parkour: number;
};

export type Screen = "boot" | "title" | "loading" | "countdown" | "chase" | "results" | "practice" | "campaign";

export type RoundHud = {
  clock: number;
  d: number;
  panic: boolean;
  gassed: boolean;
  /** "none" | "hook" (a building anchor is ringed) | "attached" | "runner" */
  ring: "none" | "hook" | "attached" | "runner";
  speed: number;
  countdown: number;
  fps: number;
  holdR: number;
  /** Swing chain now / best this round, top speed (m/s), falls (the practice panel shows these). */
  chain: number;
  maxChain: number;
  topSpeed: number;
  falls: number;
  /** Seconds since the chase started (campaign "under N s" objectives). */
  elapsed: number;
  /** Round 7: lowest roof top he has stood on (m; Vertigo's "street level" objective). */
  runnerLow: number;
  /** Round 9: parkour moves this round. */
  parkour: number;
  /**
   * Round 4 wind (wind mutator): level 0..1 of the current gust, warn 0..1 as the next one approaches,
   * and its push direction on screen (radians clockwise from "forward"); null when there is no wind.
   */
  wind: { level: number; warn: number; angle: number } | null;
  /** Web zip cooldown left as a fraction (1 = just used, 0 = ready; also 1 while zipping); -1 = no zip. */
  zip: number;
};

export type Results = {
  caught: boolean;
  kind: "tag" | "yoink" | "";
  time: number;
  closest: number;
  maxChain: number;
  topSpeed: number;
  falls: number;
  medal: string;
  best: number | null;
  newBest: boolean;
  runner: string;
  chaser: string;
  difficulty: string;
  seed: number;
  /** This run packed for a ghost link (game/ghost.ts), once ready (catches only). */
  ghostCode: string | null;
  /** Raced a ghost: its catch time (null = it never caught him) and whether the replay verified it. */
  vsGhost: { time: number | null; verified: boolean } | null;
  /** Round 4: the round's mutator bits (share links carry them). */
  mutators: number;
  /** Round 4 campaign level result: which objectives this run met, which stars are new, the level's stars. */
  campaign: { n: number; got: boolean[]; fresh: boolean[]; stars: boolean[]; totalStars: number } | null;
};

/** The ghost raced this round (HUD tag, GhostView). */
export type GhostInfo = {
  chaser: RadbroId;
  /** checking = the replay is still running; unverified = it does not reproduce the claimed time. */
  status: "checking" | "verified" | "unverified";
  /** A v1 link (made before round 4): an unverified replay is most likely just an older build. */
  older?: boolean;
  /** Claimed catch time (the link's t, or your stored best). */
  claimed: number;
  /** The replay's catch time / kind (null = the replay never caught him). */
  time: number | null;
  kind: "tag" | "yoink" | "";
  source: "link" | "best";
};

export type FeedLine = { id: number; text: string; t: number };

export type UiState = {
  pending: number;
  sceneReady: boolean;
  locked: boolean;
  /** Touch controls on (coarse pointer, ?touch, or the first touch on the page). */
  touch: boolean;
  backend: string;
  /** Graphics quality (pause -> Settings; remembered in localStorage). */
  quality: Quality;
  hud: Hud;
  screen: Screen;
  paused: boolean;
  round: RoundHud;
  results: Results | null;
  feed: FeedLine[];
  /** Centre banner ("rekt.", "GO!"), cleared by time. */
  banner: { text: string; t: number } | null;
  /** Runner speech bubble. */
  bubble: { text: string; t: number } | null;
  fade: number;
  /** The round's two Radbros once LOADING resolved (ActorsView mounts these). */
  pair: { chaser: RadbroId; runner: RadbroId } | null;
  /** LOADING progress 0..1 and the failed asset, if any. */
  load: { progress: number; error: string | null };
  /** First-run tip shown right now (ui/hints.ts), or null. */
  hint: { id: string; text: string } | null;
  /** The ghost raced in the current round, or null. */
  ghost: GhostInfo | null;
  /** Small notice (auto quality), cleared by time. */
  toast: { text: string; t: number } | null;
  /** Auto quality may switch this page to Low (High, not chosen by hand, not switched before). */
  autoQuality: boolean;
  /** PlayDriver's auto-quality check failed: PlayPage switches to Low once. */
  autoLow: boolean;
  /** Round 4: the campaign level being played (null = free play / practice) and the one selected on the campaign screen. */
  campaign: { n: number } | null;
  campaignSel: number;
};

export const useUi = create<UiState>(() => ({
  pending: 0,
  sceneReady: false,
  locked: false,
  touch: detectTouch(),
  backend: "",
  quality: loadQuality(),
  hud: { speed: 0, phase: "ground", ring: -1, chain: 0, topSpeed: 0, maxChain: 0, falls: 0, bonks: 0, fps: 0, steps: 0, parkour: 0 },
  screen: "boot",
  paused: false,
  round: { clock: 90, d: 0, panic: false, gassed: false, ring: "none", speed: 0, countdown: 3, fps: 0, holdR: 0, chain: 0, maxChain: 0, topSpeed: 0, falls: 0, elapsed: 0, runnerLow: Infinity, parkour: 0, wind: null, zip: 0 },
  results: null,
  feed: [],
  banner: null,
  bubble: null,
  fade: 0,
  pair: null,
  load: { progress: 0, error: null },
  hint: null,
  ghost: null,
  toast: null,
  autoQuality: false,
  autoLow: false,
  campaign: null,
  campaignSel: 1,
}));

let feedId = 0;
export function pushFeed(text: string): void {
  const now = performance.now();
  useUi.setState(s => ({ feed: [...s.feed.filter(f => now - f.t < 6000).slice(-4), { id: ++feedId, text, t: now }] }));
}
export function showBanner(text: string): void {
  useUi.setState({ banner: { text, t: performance.now() } });
}
/** The runner's bubble, `delay` s from now (lined up with his voice line). */
export function showBubble(text: string, delay = 0): void {
  useUi.setState({ bubble: { text, t: performance.now() + delay * 1000 } });
}
