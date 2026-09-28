// ?tune (dev/test builds only): live sliders over the sim + camera tuning and George's follow values.
// Save writes public/levels/tuning.json (incl. a "george" section) through the dev server (or
// downloads it outside `npm run dev`).
import { useState } from "react";
import { CAMERA, DIFFICULTIES, DIFFICULTY, MECH, PLAYER, STRUCTURES, STRUCTURES_DEFAULT, tuningToJson, type CameraTuning, type DifficultyParams, type DifficultyTable, type MechTuning, type StructureKnobs, type Tuning } from "../../sim/tuning.ts";
import { PAGE_DISTRICT } from "../district.ts";
import { saveLevelFile } from "./save.ts";
import { GEORGE, setGeorge, type GeorgeTunable } from "../../sidekick/george.ts";
import { GEORGE_RENDER, georgeToJson, resetGeorge, setGeorgeScale } from "../george.config.ts";

type Slider<K> = [K, number, number, number]; // key, min, max, step

/** Round 9 (spec §8): every sim number has a slider, grouped; ranges from the spec's table. */
const PLAYER_GROUPS: [string, Slider<keyof Tuning>[]][] = [
  ["movement", [
    ["gravity", 10, 40, 0.5], ["runSpeed", 5, 14, 0.25], ["jumpSpeed", 5, 14, 0.25], ["groundAccel", 20, 120, 1],
    ["groundBrake", 10, 100, 1], ["carryDecay", 0, 30, 0.5], ["airAccel", 0, 20, 0.5], ["speedCap", 15, 45, 0.5],
    ["coyoteTime", 0, 0.3, 0.01], ["jumpBuffer", 0, 0.3, 0.01], ["holdDelay", 0, 0.3, 0.01], ["failFloor", 0, 10, 0.25],
    ["bonkMinSpeed", 5, 25, 0.5], ["bonkRatio", 0.3, 1, 0.05], ["bonkLock", 0, 1, 0.05],
  ]],
  ["anchor search", [
    ["ropeMin", 4, 15, 0.25], ["ropeMax", 20, 60, 0.5], ["anchorMinAbove", 2, 12, 0.25], ["anchorAhead", 0, 25, 0.5],
    ["anchorAheadPerSpeed", 0, 1.5, 0.05], ["anchorUp", 6, 35, 0.5], ["anchorVelBias", 0, 1.5, 0.05], ["anchorRimBonus", 0, 8, 0.25],
    ["anchorAlternate", 0, 8, 0.25], ["hysteresis", 0, 8, 0.25], ["aimCos", 0, 0.9, 0.01], ["aimCosFall", -1, 0.9, 0.01],
    ["anchorArcPenalty", 0, 30, 0.5],
  ]],
  ["pendulum", [
    ["swingOut", 0, 20, 0.25], ["swingOutFree", 0, 1, 0.05], ["swingOutMin", 0, 10, 0.25], ["swingFloorClear", 2, 15, 0.25], ["swingReel", 0, 25, 0.5], ["swingGravity", 1, 2.5, 0.05],
    ["swingPump", 0, 15, 0.25], ["swingKeepSpeed", 1, 2.5, 0.05], ["swingReleaseCos", 0.2, 1, 0.01], ["swingRehook", 0, 0.5, 0.01],
    ["releaseBoost", 0, 8, 0.25], ["releaseUp", 0, 8, 0.25], ["autoReleaseBelow", 0, 6, 0.1], ["ropeSteer", 0, 15, 0.25], ["swingAlign", 0, 10, 0.25], ["losSteps", 1, 60, 1],
  ]],
  ["round 11: timing, web from a roof, walls", [
    ["releaseSweet", 0, 15, 0.25], ["swingSweetCos", 0.6, 1, 0.005], ["autoReleaseUp", 0, 8, 0.25], ["swingReelUp", 0, 10, 0.25],
    ["webLift", 0, 30, 0.5], ["webLiftClear", 0, 5, 0.1], ["swingAvoid", 0, 12, 0.25], ["swingAvoidT", 0, 2, 0.05], ["swingAvoidAir", 0, 2, 0.05], ["edgeAvoid", 0, 12, 0.25], ["edgeMargin", 0, 20, 0.5],
    ["wallUpKick", 0, 12, 0.25], ["wallPushOff", 0, 8, 0.25],
  ]],
  ["wall run / wall jump", [
    ["wallRunReach", 0.2, 1.5, 0.05], ["wallRunMinSpeed", 2, 12, 0.25], ["wallRunRatio", 0.3, 3, 0.05], ["wallRunMinBelowTop", 0, 4, 0.1],
    ["wallRunFallMax", -25, 0, 0.5], ["wallRunTime", 0.3, 3, 0.05], ["wallRunSpeed", 6, 20, 0.25], ["wallRunAccel", 0, 30, 0.5],
    ["wallRunGravity", 0, 1, 0.05], ["wallRunKick", 0, 8, 0.25], ["wallRunCooldown", 0, 1, 0.05], ["wallClimbSpeed", 4, 15, 0.25],
    ["wallClimbTime", 0.2, 1.5, 0.05], ["wallClimbKeep", 0, 1, 0.05], ["wallJumpOut", 2, 14, 0.25], ["wallJumpUp", 4, 15, 0.25], ["wallJumpKeep", 0, 1.2, 0.05],
    ["wallJumpGrace", 0, 0.4, 0.01],
  ]],
  ["ledge", [
    ["ledgeLow", 0, 1.5, 0.05], ["ledgeHigh", 1, 3.5, 0.05], ["ledgeMaxVy", -5, 12, 0.25], ["ledgeHang", 0, 1, 0.05],
    ["ledgeClimbTime", 0.1, 1, 0.05], ["ledgeExitSpeed", 0, 12, 0.25], ["ledgeJumpUp", 3, 12, 0.25],
  ]],
  ["vault", [["vaultMax", 0.5, 2.5, 0.05], ["vaultLook", 0.2, 2, 0.05], ["vaultMinSpeed", 1, 12, 0.25], ["vaultClear", 0, 1, 0.05]]],
  ["slide", [
    ["slideMinSpeed", 2, 12, 0.25], ["slideTime", 0.2, 2, 0.05], ["slideDecay", 0, 15, 0.25], ["slideSteer", 0, 15, 0.25],
    ["slideJumpFwd", 0, 8, 0.25], ["slideBuffer", 0, 0.6, 0.01],
  ]],
  ["landing", [["rollMinVy", -30, -5, 0.5], ["rollTime", 0, 1.2, 0.05], ["stumbleVy", -40, -10, 0.5], ["stumbleKeep", 0, 1, 0.05], ["stumbleLock", 0, 1, 0.05]]],
  ["double jump (player only)", [["airJumps", 0, 2, 1], ["doubleJumpSpeed", 3, 14, 0.25]]],
  // Round 12 (docs/specs/2026-09-26-round12-spider-tag.md §9): ranges from the spec's table.
  ["round 12: straight zip (E)", [
    ["zipSpeed", 8, 45, 0.5], ["zipPull", 2, 120, 1], ["zipCooldown", 0, 3, 0.05], ["zipMaxTime", 0.3, 3, 0.05], ["zipFlingUp", 0, 12, 0.25],
    ["zipLedgeSpeed", 0, 20, 0.25], ["zipLedgeUp", 0, 10, 0.25], ["zipReach", 15, 70, 0.5], ["zipLift", 0, 0.5, 0.01], ["zipAimMin", -0.9, 0, 0.01],
    ["zipAimMax", 0, 0.95, 0.01], ["zipRigAssist", 0, 3, 0.05], ["zipAssistCos", 0.8, 1, 0.002], ["zipFanCos", 0.8, 1, 0.002], ["zipStop", 0.3, 3, 0.05], ["zipKeep", 0, 1.2, 0.05],
    ["zipCharges", 1, 5, 1], ["zipRimReach", 0, 5, 0.1], ["zipPopWindow", 0, 0.6, 0.01], ["zipPopUp", 0, 22, 0.25], ["zipPopFwd", 0, 14, 0.25],
  ]],
  ["round 12: rig anchors (cables)", [["rigBonus", 0, 10, 0.25], ["rigEndInset", 0, 6, 0.1], ["rigSide", 0, 4, 0.05], ["rigSideFree", 0, 12, 0.25], ["rigNear", 0, 3, 0.05], ["rigNearAhead", 0, 20, 0.5]]],
  ["round 12: charge (hold C)", [
    ["chargeMin", 0, 0.4, 0.01], ["chargeTime", 0.2, 1.5, 0.01], ["chargeWalk", 0, 9, 0.25], ["chargeUp", 0, 25, 0.25], ["chargeFwd", 0, 16, 0.25],
    ["chargeWallOut", 0, 14, 0.25], ["chargeWallUp", 0, 16, 0.25], ["chargeHangMax", 0, 4, 0.05], ["chargeFling", 0, 16, 0.25], ["chargeFlingUp", 0, 10, 0.25],
    ["chargeAir", 0, 1, 0.01],
  ]],
  ["round 12: tech (player only)", [
    ["swingPerfectCos", 0.64, 0.97, 0.005], ["releasePerfect", 0, 8, 0.25], ["reboundWindow", 0, 0.3, 0.01], ["reboundKeep", 0, 1.2, 0.05],
    ["kickChainUp", 0, 3, 0.05], ["diveMinDrop", 0, 20, 0.5], ["diveSpeed", 0, 25, 0.25], ["diveGravity", 1, 3, 0.05], ["yankSpeed", 15, 45, 0.5],
    ["yankTime", 0.2, 1.5, 0.05], ["yankCooldown", 0, 6, 0.1], ["airTurn", 0, 5, 0.05], ["flowCap", 0, 5, 0.25], ["flowDecay", 0.5, 6, 0.1],
  ]],
  // The web-slinger swing (docs/specs/2026-09-27-web-slinger-swing.md): player only.
  ["web-slinger swing (player only)", [
    ["anchorHeightGain", 0, 1, 0.01], ["anchorHeightAhead", 0, 1, 0.01], ["anchorHeightFree", 0, 40, 0.5], ["anchorUpMax", 10, 50, 0.5],
    ["swingSurge", 0, 20, 0.25], ["swingSurgeCos", 0.5, 0.99, 0.005], ["swingReelPerSpeed", 0, 2, 0.05], ["releasePerfectUp", 0, 8, 0.25], ["autoReleaseKeep", 0, 1, 0.05],
  ]],
  ["corner swing (player only)", [
    ["cornerReach", 4, 25, 0.5], ["cornerMinSpeed", 0, 20, 0.5], ["cornerStick", 0.2, 1, 0.02], ["cornerGravity", 0, 1, 0.05],
    ["cornerBoost", 0, 10, 0.25], ["cornerMaxT", 0.3, 3, 0.05], ["cornerExitCos", 0.8, 1, 0.005],
  ]],
  ["dive (player only)", [["diveCap", 0, 70, 0.5], ["diveTurn", 0, 4, 0.05], ["diveCarryDecay", 0, 20, 0.25], ["diveKeep", 1, 4, 0.05], ["diveSwingT", 0, 1.5, 0.05]]],
];
const PLAYER_TOGGLES: (keyof Tuning)[] = ["wallRun", "ledgeGrab", "vault", "slide", "autoRelease", "bonk", "charge", "dive", "cornerSwing"];
const CAMERA_SLIDERS: Slider<keyof CameraTuning>[] = [
  ["fov", 55, 75, 1], ["sensitivity", 0.0005, 0.006, 0.0001], ["armGround", 3, 10, 0.25], ["armAir", 3, 12, 0.25],
  ["armRope", 3, 14, 0.25], ["armWall", 3, 12, 0.25], ["armBlend", 0.5, 10, 0.5], ["shoulder", 0, 1.5, 0.05], ["ropeBias", 0, 0.6, 0.05],
  ["ropeBiasMax", 0, 8, 0.25], ["fovBoost", 0, 25, 1], ["fovSpeedLo", 0, 20, 0.5], ["fovSpeedHi", 10, 45, 0.5], ["fovEase", 0.5, 10, 0.5],
  ["wallAway", 0, 3, 0.1], ["nearWallFor", 0, 2, 0.05], ["armMin", 0, 6, 0.1], ["dodgeRate", 0.5, 20, 0.5], ["webClear", 0, 2, 0.05], ["wallCam", 0, 4, 0.1],
  ["zipFov", 0, 15, 0.5], ["armZip", 3, 12, 0.25], ["armDive", 3, 14, 0.25], ["chargeArm", 0, 2, 0.05], ["chargeFov", 0, 8, 0.25],
  ["speedArm", 0, 5, 0.1], ["lagY", 0, 12, 0.25], ["lagYMax", 0, 4, 0.1], ["lookAhead", 0, 0.2, 0.005], ["lookAheadMax", 0, 4, 0.1], ["diveFov", 0, 12, 0.5],
];
/** Round 12 structure knobs (§9; per district, re-derived in the sandbox; Save -> npm run level -- --all bakes them). */
const STRUCTURE_SLIDERS: Slider<keyof StructureKnobs>[] = [
  ["cables", 0, 1, 0.01], ["cableTier1", 0.3, 0.95, 0.01], ["cableTier2", 0, 0.95, 0.01], ["cableMin", 8, 30, 0.5], ["cableSag", 0, 1.5, 0.05],
  ["rigApart", 6, 30, 0.5], ["cablePairs", 1, 2, 1], ["cableInset", 1, 8, 0.25], ["gantryMin", 10, 20, 0.25], ["gantryMax", 10, 24, 0.25], ["gantryMinL", 15, 60, 0.5], ["skybridge", 0, 0.5, 0.01],
  ["skybridgeLo", 0.2, 0.7, 0.01], ["skybridgeHi", 0.3, 0.8, 0.01], ["tanks", 0, 0.6, 0.01], ["tankLo", 5, 12, 0.25], ["tankHi", 6, 14, 0.25],
  ["boards", 0, 0.6, 0.01], ["boardLo", 4, 10, 0.25], ["boardHi", 5, 12, 0.25], ["stacks", 0, 0.5, 0.01], ["stackBelowLo", 2, 10, 0.25], ["stackBelowHi", 3, 15, 0.25],
];
const TOGGLES: (keyof CameraTuning)[] = ["invertY", "reducedMotion", "easyGrab"];

/** Anything tunable: the Sandbox and the PlayGame (restructure: re-derive the structures from the knobs; sandbox only). */
export type Tunable = { tuning: Tuning; camera: CameraTuning; difficulty: DifficultyTable | null; retune(): void; restart(): void; restructure?(): void };

// George (visual only): follow distance, side offset, gait thresholds (m/s), playback-rate clamps.
const GEORGE_SLIDERS: Slider<GeorgeTunable>[] = [
  ["maxTrail", 0.5, 8, 0.1], ["delay", 6, 200, 1], ["side", 0, 2, 0.05], ["idleBelow", 0, 1, 0.01], ["walkBelow", 0.1, 2, 0.01],
  ["trotBelow", 0.3, 6, 0.05], ["rateMin", 0.2, 1.5, 0.05], ["rateMax", 1, 5, 0.1], ["runRateMin", 0.2, 1.5, 0.05], ["runRateMax", 1, 8, 0.1],
  ["airShow", 0, 3, 0.05], ["showRate", 1, 40, 0.5],
];

const MECH_SLIDERS: Slider<keyof MechTuning>[] = [
  ["snapTime", 0.5, 4, 0.05], ["windMax", 0, 20, 0.5], ["windGust", 0.5, 6, 0.1],
  ["windRamp", 0.05, 1.5, 0.05], ["windGapMin", 2, 30, 0.5], ["windGapMax", 3, 40, 0.5], ["windWarn", 0, 3, 0.1],
  ["lowGravity", 0.3, 1, 0.05], ["sixtyClock", 20, 90, 5],
];
const DIFF_SLIDERS: Slider<keyof DifficultyParams>[] = [
  ["base", 0.6, 2.5, 0.01], ["gStar", 8, 100, 0.5], ["mMin", 0.5, 1, 0.01], ["mMax", 1, 3.2, 0.01], ["panicBudget", 0, 80, 0.5],
  ["sigma", 0, 1.5, 0.05], ["yoinkRange", 2, 10, 0.1], ["taunt", 0, 3, 0.1], ["airMin", 0.6, 1, 0.01], ["airMax", 1, 3.2, 0.01], ["lead", 0, 30, 0.1],
  ["yankRange", 0, 25, 0.5],
];

export default function TunePanel({ game }: { game: Tunable }) {
  const [, force] = useState(0);
  // Structure knobs of this page's district: the value in effect (district override, else the default).
  const key = PAGE_DISTRICT === "downtown" ? "default" : PAGE_DISTRICT;
  const knob = (k: keyof StructureKnobs) => (STRUCTURES[key] as Partial<StructureKnobs> | undefined)?.[k] ?? STRUCTURES.default[k] ?? STRUCTURES_DEFAULT[k];
  const setKnob = (k: keyof StructureKnobs, v: number | boolean) => {
    if (!STRUCTURES[key]) (STRUCTURES as Record<string, Partial<StructureKnobs>>)[key] = {};
    (STRUCTURES[key] as Record<string, number | boolean>)[k] = v;
    game.restructure?.();
    force(n => n + 1);
  };
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
        <button onClick={() => { Object.assign(game.tuning, PLAYER); Object.assign(game.camera, CAMERA); resetGeorge(); bump(); }}>defaults</button>
        <button onClick={() => game.restart()}>respawn</button>
        <button
          onClick={async () => setStatus(await saveLevelFile("tuning.json", { ...tuningToJson(game.tuning, game.camera, game.difficulty ?? DIFFICULTY), george: georgeToJson() }))}
        >save</button>
      </div>
      {status && <div style={{ whiteSpace: "pre-wrap", opacity: 0.85, marginBottom: 6 }}>{status}</div>}
      {open && (
        <>
          <div style={{ opacity: 0.7, margin: "4px 0" }}>player (sim) — click the scene to capture the mouse, Esc to release</div>
          {PLAYER_TOGGLES.map(k => (
            <label key={k} style={{ display: "inline-block", marginRight: 8 }}>
              <input type="checkbox" checked={game.tuning[k] as boolean} onChange={e => { (game.tuning as Record<string, unknown>)[k] = e.target.checked; bump(); }} /> {k}
            </label>
          ))}
          {PLAYER_GROUPS.map(([title, list]) => (
            <div key={title}>
              <div style={{ opacity: 0.7, margin: "8px 0 4px" }}>{title}</div>
              {list.map(([k, min, max, step]) => row(k, game.tuning[k] as number, min, max, step, v => { (game.tuning as Record<string, unknown>)[k] = v; }))}
            </div>
          ))}
          <div style={{ opacity: 0.7, margin: "8px 0 4px" }}>camera + scheme</div>
          {CAMERA_SLIDERS.map(([k, min, max, step]) => row(k, game.camera[k] as number, min, max, step, v => { (game.camera as Record<string, unknown>)[k] = v; }))}
          {TOGGLES.map(k => (
            <label key={k} style={{ display: "block" }}>
              <input type="checkbox" checked={game.camera[k] as boolean} onChange={e => { (game.camera as Record<string, unknown>)[k] = e.target.checked; bump(); }} /> {k}
            </label>
          ))}
          {game.difficulty && DIFFICULTIES.map(d => (
            <div key={d}>
              <div style={{ opacity: 0.7, margin: "8px 0 4px" }}>runner: {d} (applies on the next round)</div>
              {DIFF_SLIDERS.map(([k, min, max, step]) => row(`${d}.${k}`, game.difficulty![d][k], min, max, step, v => { game.difficulty![d][k] = v; }))}
            </div>
          ))}
          <div style={{ opacity: 0.7, margin: "8px 0 4px" }}>
            structures: {PAGE_DISTRICT} (default + this district's overrides){game.restructure ? " - re-derived here" : " - a chase keeps the baked city; re-derived in ?sandbox"}
          </div>
          <label style={{ display: "block" }}>
            <input type="checkbox" checked={knob("gantry") as boolean} onChange={e => { setKnob("gantry", e.target.checked); }} /> gantry
          </label>
          {STRUCTURE_SLIDERS.map(([k, min, max, step]) => row(`st.${k}`, knob(k) as number, min, max, step, v => setKnob(k, v)))}
          <div style={{ opacity: 0.7, margin: "8px 0 4px" }}>mechanics (snapping webs / wind / low gravity / 60 s; next round)</div>
          {MECH_SLIDERS.map(([k, min, max, step]) => row(`mech.${k}`, MECH[k], min, max, step, v => { MECH[k] = v; }))}
          <div style={{ opacity: 0.7, margin: "8px 0 4px" }}>George (visual only; delay in 120 Hz steps, gaits in m/s)</div>
          {row("scale", GEORGE_RENDER.scale, 0.6, 2, 0.01, setGeorgeScale)}
          {GEORGE_SLIDERS.map(([k, min, max, step]) => row(`george.${k}`, GEORGE[k], min, max, step, v => setGeorge(k, v)))}
          <label style={{ display: "block" }}>
            <input type="checkbox" checked={game.tuning.zip} onChange={e => { game.tuning.zip = e.target.checked; bump(); }} /> zip (grounded LMB = jump + grab)
          </label>
          <label style={{ display: "block" }}>
            <input type="checkbox" checked={game.tuning.webZip} onChange={e => { game.tuning.webZip = e.target.checked; bump(); }} /> webZip (E / Shift / touch ZIP)
          </label>
        </>
      )}
    </div>
  );
}
