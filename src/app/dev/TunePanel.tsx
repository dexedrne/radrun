// ?tune (dev/test builds only): live sliders over the sim + camera tuning. Save writes
// public/levels/tuning.json through the dev server (or downloads it outside `npm run dev`).
import { useState } from "react";
import { CAMERA, DIFFICULTY, PLAYER, tuningToJson, type CameraTuning, type DifficultyParams, type DifficultyTable, type Tuning } from "../../sim/tuning.ts";
import { saveLevelFile } from "./save.ts";

type Slider<K> = [K, number, number, number]; // key, min, max, step

const PLAYER_SLIDERS: Slider<keyof Tuning>[] = [
  ["gravity", 10, 40, 0.5], ["runSpeed", 5, 14, 0.25], ["jumpSpeed", 5, 14, 0.25], ["groundAccel", 20, 120, 1],
  ["groundBrake", 10, 100, 1], ["carryDecay", 0, 30, 0.5], ["airAccel", 0, 20, 0.5], ["speedCap", 15, 40, 0.5],
  ["aimRadius", 10, 24, 0.25], ["hookMinAbove", 0, 4, 0.1], ["scoreAhead", 0, 14, 0.5], ["scoreUp", 0, 14, 0.5],
  ["hysteresis", 0, 6, 0.25], ["ropeScale", 0.4, 1.1, 0.01], ["reelSpeed", 0, 15, 0.25], ["ropeSteer", 0, 15, 0.25],
  ["releaseBoost", 0, 8, 0.25], ["autoReleaseBelow", 0, 4, 0.1], ["bonkMinSpeed", 5, 25, 0.5], ["bonkRatio", 0.3, 1, 0.05],
  ["bonkLock", 0, 1, 0.05], ["coyoteTime", 0, 0.3, 0.01], ["jumpBuffer", 0, 0.3, 0.01], ["holdDelay", 0, 0.3, 0.01],
];
const CAMERA_SLIDERS: Slider<keyof CameraTuning>[] = [
  ["fov", 55, 75, 1], ["sensitivity", 0.0005, 0.006, 0.0001], ["armGround", 3, 10, 0.25], ["armAir", 3, 12, 0.25],
  ["armRope", 3, 14, 0.25], ["armBlend", 0.5, 10, 0.5], ["shoulder", 0, 1.5, 0.05], ["ropeBias", 0, 0.6, 0.05],
  ["fovBoost", 0, 25, 1], ["fovEase", 0.5, 10, 0.5],
];
const TOGGLES: (keyof CameraTuning)[] = ["invertY", "reducedMotion", "easyGrab"];

/** Anything tunable: the Sandbox and the PlayGame. */
export type Tunable = { tuning: Tuning; camera: CameraTuning; difficulty: DifficultyTable | null; retune(): void; restart(): void };

const DIFF_SLIDERS: Slider<keyof DifficultyParams>[] = [
  ["base", 0.6, 1.4, 0.01], ["gStar", 8, 45, 0.5], ["mMin", 0.5, 1, 0.01], ["mMax", 1, 1.5, 0.01], ["panicBudget", 0, 60, 0.5],
  ["sigma", 0, 1.5, 0.05], ["yoinkRange", 2, 10, 0.1], ["taunt", 0, 3, 0.1], ["airMin", 0.6, 1, 0.01], ["airMax", 1, 1.5, 0.01],
];

export default function TunePanel({ game }: { game: Tunable }) {
  const [, force] = useState(0);
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(true);
  const bump = () => { game.retune(); force(n => n + 1); };
  const row = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void) => (
    <label key={label} style={{ display: "grid", gridTemplateColumns: "118px 1fr 52px", gap: 6, alignItems: "center" }}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => { set(Number(e.target.value)); bump(); }} />
      <span style={{ textAlign: "right" }}>{+value.toFixed(4)}</span>
    </label>
  );
  return (
    <div style={{ position: "fixed", right: 8, top: 8, bottom: 8, width: 320, overflow: "auto", zIndex: 30, background: "rgba(12,16,28,0.86)", padding: 10, borderRadius: 8, font: "11px/1.5 ui-monospace, monospace" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
        <b style={{ flex: 1 }}>?tune</b>
        <button onClick={() => setOpen(!open)}>{open ? "hide" : "show"}</button>
        <button onClick={() => { Object.assign(game.tuning, PLAYER); Object.assign(game.camera, CAMERA); bump(); }}>defaults</button>
        <button onClick={() => game.restart()}>respawn</button>
        <button
          onClick={async () => setStatus(await saveLevelFile("tuning.json", tuningToJson(game.tuning, game.camera, game.difficulty ?? DIFFICULTY)))}
        >save</button>
      </div>
      {status && <div style={{ whiteSpace: "pre-wrap", opacity: 0.85, marginBottom: 6 }}>{status}</div>}
      {open && (
        <>
          <div style={{ opacity: 0.7, margin: "4px 0" }}>player (sim) — click the scene to capture the mouse, Esc to release</div>
          {PLAYER_SLIDERS.map(([k, min, max, step]) => row(k, game.tuning[k] as number, min, max, step, v => { (game.tuning as Record<string, unknown>)[k] = v; }))}
          <div style={{ opacity: 0.7, margin: "8px 0 4px" }}>camera + scheme</div>
          {CAMERA_SLIDERS.map(([k, min, max, step]) => row(k, game.camera[k] as number, min, max, step, v => { (game.camera as Record<string, unknown>)[k] = v; }))}
          {TOGGLES.map(k => (
            <label key={k} style={{ display: "block" }}>
              <input type="checkbox" checked={game.camera[k] as boolean} onChange={e => { (game.camera as Record<string, unknown>)[k] = e.target.checked; bump(); }} /> {k}
            </label>
          ))}
          {game.difficulty && (["chill", "normal"] as const).map(d => (
            <div key={d}>
              <div style={{ opacity: 0.7, margin: "8px 0 4px" }}>runner: {d} (applies on the next round)</div>
              {DIFF_SLIDERS.map(([k, min, max, step]) => row(`${d}.${k}`, game.difficulty![d][k], min, max, step, v => { game.difficulty![d][k] = v; }))}
            </div>
          ))}
          <label style={{ display: "block" }}>
            <input type="checkbox" checked={game.tuning.zip} onChange={e => { game.tuning.zip = e.target.checked; bump(); }} /> zip (grounded LMB = jump + grab)
          </label>
        </>
      )}
    </div>
  );
}
