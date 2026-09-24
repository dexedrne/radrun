// Small zustand UI store. The drivers push HUD numbers at 10 Hz so the canvas tree never re-renders.
import { create } from "zustand";

export type Hud = {
  speed: number;
  phase: "ground" | "air" | "rope";
  ring: number;
  chain: number;
  topSpeed: number;
  maxChain: number;
  falls: number;
  bonks: number;
  fps: number;
  steps: number;
};

export type Screen = "boot" | "title" | "loading" | "countdown" | "chase" | "results";

export type RoundHud = {
  clock: number;
  d: number;
  panic: boolean;
  gassed: boolean;
  /** "none" | "hook" | "attached" | "runner" */
  ring: "none" | "hook" | "attached" | "runner";
  speed: number;
  countdown: number;
  fps: number;
  holdR: number;
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
};

export type FeedLine = { id: number; text: string; t: number };

export type UiState = {
  pending: number;
  sceneReady: boolean;
  locked: boolean;
  backend: string;
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
};

export const useUi = create<UiState>(() => ({
  pending: 0,
  sceneReady: false,
  locked: false,
  backend: "",
  hud: { speed: 0, phase: "ground", ring: -1, chain: 0, topSpeed: 0, maxChain: 0, falls: 0, bonks: 0, fps: 0, steps: 0 },
  screen: "boot",
  paused: false,
  round: { clock: 90, d: 0, panic: false, gassed: false, ring: "none", speed: 0, countdown: 3, fps: 0, holdR: 0 },
  results: null,
  feed: [],
  banner: null,
  bubble: null,
  fade: 0,
}));

let feedId = 0;
export function pushFeed(text: string): void {
  const now = performance.now();
  useUi.setState(s => ({ feed: [...s.feed.filter(f => now - f.t < 6000).slice(-4), { id: ++feedId, text, t: now }] }));
}
export function showBanner(text: string): void {
  useUi.setState({ banner: { text, t: performance.now() } });
}
export function showBubble(text: string): void {
  useUi.setState({ bubble: { text, t: performance.now() } });
}
