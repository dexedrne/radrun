// Small zustand UI store. SimDriver pushes HUD numbers at 10 Hz so the canvas tree never re-renders.
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

export type UiState = {
  pending: number;
  sceneReady: boolean;
  locked: boolean;
  backend: string;
  hud: Hud;
};

export const useUi = create<UiState>(() => ({
  pending: 0,
  sceneReady: false,
  locked: false,
  backend: "",
  hud: { speed: 0, phase: "ground", ring: -1, chain: 0, topSpeed: 0, maxChain: 0, falls: 0, bonks: 0, fps: 0, steps: 0 },
}));
