// Runs the verbatim 2D prototype (kinematic.ts + level.ts) once with its tuned one-button script at a
// fixed 120 Hz and writes the per-step state to trace.json. The script is sampled per fixed step from
// the sim clock, exactly like the prototype's headless "kinematic" run.
//   node test/fixtures/proto/dump-trace.ts
import fs from "node:fs";
import { LEVEL, SCRIPTS, TUNING, scriptInput } from "./level.ts";
import { FIXED_DT, createKinematic, stepKinematic } from "./kinematic.ts";

type Row = [number, number, number, number, number, number, number, number]; // x y vx vy grounded roof anchor held

const s = createKinematic(LEVEL);
const rows: Row[] = [];
const landings: number[] = [];
let prev = false;
let step = 0;
while (s.phase !== "dead" && s.phase !== "done" && step < 10000) {
  const inp = scriptInput(s.t, prev, SCRIPTS.kinematic);
  const wasGrounded = s.grounded;
  stepKinematic(s, FIXED_DT, inp, LEVEL, TUNING);
  prev = inp.swingHeld;
  step++;
  if (!wasGrounded && s.grounded) landings.push(step);
  rows.push([s.x, s.y, s.vx, s.vy, s.grounded ? 1 : 0, s.roof, s.rope ? s.rope.anchor : -1, inp.swingHeld ? 1 : 0]);
}

const out = {
  note: "Per-step state of the 2D prototype's tuned scripted run (kinematic.ts + level.ts, SCRIPTS.kinematic, fixed 1/120 s). Row = [x, y, vx, vy, grounded, roof, anchor, held] AFTER each step.",
  dt: FIXED_DT,
  script: SCRIPTS.kinematic,
  steps: rows.length,
  simT: s.t,
  phase: s.phase,
  landings,
  log: s.log,
  rows,
};
fs.writeFileSync(new URL("./trace.json", import.meta.url), JSON.stringify(out));
console.log(`trace: ${rows.length} steps, t=${s.t.toFixed(2)} s, phase=${s.phase}, landings at steps ${landings.join(",")}`);
