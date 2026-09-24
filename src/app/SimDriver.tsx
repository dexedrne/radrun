// 120 Hz accumulator -> fixed steps; interpolation; 10 Hz UI store push; window.__probe.
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Sandbox } from "../game/sandbox.ts";
import { useUi } from "../ui/store.ts";
import { FRAME } from "./frame.ts";

export type Probe = {
  step: number;
  t: number;
  p: [number, number, number];
  v: [number, number, number];
  grounded: boolean;
  ropeHook: number;
  ringId: number;
  chain: number;
  fps: number;
  frames: number;
  stats: Sandbox["stats"];
  cam: { arm: number; armUsed: number; pos: [number, number, number]; yaw: number; pitch: number };
};

declare global {
  interface Window {
    __probe?: Probe;
  }
}

export function SimDriver({ game }: { game: Sandbox }) {
  const uiAcc = useRef(0);
  const fps = useRef(60);
  const frames = useRef(0);
  useFrame((_, delta) => {
    game.frame(delta);
    frames.current++;
    fps.current = fps.current * 0.95 + (1 / Math.max(delta, 1e-3)) * 0.05;
    const b = game.body;
    const speed = Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z);
    window.__probe = {
      step: b.step, t: b.t, p: [b.p.x, b.p.y, b.p.z], v: [b.v.x, b.v.y, b.v.z], grounded: b.grounded,
      ropeHook: b.ropeHook, ringId: b.ringId, chain: b.chainCount, fps: fps.current, frames: frames.current, stats: game.stats,
      cam: { arm: game.rig.arm, armUsed: game.rig.armUsed, pos: [game.rig.pos.x, game.rig.pos.y, game.rig.pos.z], yaw: game.rig.yaw, pitch: game.rig.pitch },
    };
    uiAcc.current += delta;
    if (uiAcc.current >= 0.1) {
      uiAcc.current = 0;
      const st = game.stats;
      useUi.setState({
        hud: {
          speed, phase: b.ropeHook >= 0 ? "rope" : b.grounded ? "ground" : "air", ring: b.ringId, chain: b.chainCount,
          topSpeed: st.topSpeed, maxChain: st.maxChain, falls: st.falls, bonks: st.bonks, fps: fps.current, steps: st.steps,
        },
      });
    }
  }, FRAME.sim);
  return null;
}
