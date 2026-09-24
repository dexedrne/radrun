// Canyon probe (spec §16 test 10, run as a printing script, not a gate): a chain-swing bot using the
// real pickTarget, with +-2 m lateral start noise and +-10 deg aim noise per swing, runs down 12, 14 and
// 16 m streets between 24-34 m facades on a hand-made 3-block canyon. Reports mean along-street speed and
// the bonk rate on the bot's own (in-window) releases, per street width and release policy.
//   node tools/probe-canyon.ts [--trials 40]
import { deriveModel } from "../src/world/derive.ts";
import { DEFAULT_CONFIG } from "../src/world/generate.ts";
import { CityIndex, type CityModel, type Solid } from "../src/world/cityModel.ts";
import { createBody, emptyInput, stepBody, EV_ATTACH, EV_AUTORELEASE, EV_BONK, EV_FALL, EV_LAND, type SimWorld } from "../src/sim/player.ts";
import fs from "node:fs";
import path from "node:path";
import { applyTuningJson, type Tuning } from "../src/sim/tuning.ts";
import { mulberry32 } from "../src/sim/math.ts";

const trialsArg = process.argv.indexOf("--trials");
const TRIALS = trialsArg > 0 ? Number(process.argv[trialsArg + 1]) : 40;
// The player constants the game ships with (PLAYER overridden by public/levels/tuning.json).
const PLAYER_TUNING = applyTuningJson(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "public", "levels", "tuning.json"), "utf8"))).player;

/** Two rows of 3 blocks (2 x 2 roofs each) facing across a street of width W running along +x. */
export function canyon(W: number, seed: number): CityModel {
  const rand = mulberry32(seed);
  const solids: Solid[] = [];
  const pitch = 28 + W;
  const rowZ = [0, 28 + W];
  let prevTop = 29;
  for (const oz of rowZ) {
    for (let bx = 0; bx < 3; bx++) {
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        // 24-34 m, smooth-ish so alley pairs stay within 1 m and street pairs within 4 m.
        const top = Math.min(34, Math.max(24, Math.round((prevTop + (rand() * 2 - 1)) * 2) / 2));
        prevTop = top;
        const x0 = bx * pitch + i * 16, z0 = oz + j * 16;
        solids.push({ id: solids.length, kind: "roof", landable: true, x0, z0, x1: x0 + 12, z1: z0 + 12, top });
      }
    }
  }
  return deriveModel({ ...DEFAULT_CONFIG, street: W }, solids);
}

type Policy = { ahead: number; vyMin: number };
type Trial = { speed: number; releases: number; bonks: number; falls: number; landings: number; done: boolean };

function trial(model: CityModel, W: number, k: Tuning, pol: Policy, seed: number): Trial {
  const rand = mulberry32(seed);
  const world: SimWorld = { index: new CityIndex(model), hooks: model.hooks, lowestRoof: model.lowestRoof, runner: null };
  // Start on a row-A roof (first block), at its street-facing edge, lateral noise +-2 m inward/outward.
  const start = model.solids.find(s => s.x0 === 0 && s.z1 === 28)!;
  const lat = (rand() * 2 - 1) * 2;
  const z = Math.min(start.z1 - 0.4, start.z1 - 2 + lat);
  const b = createBody(4, start.top + 0.9, z, start.id);
  const endX = 3 * (28 + W) - W; // end of the third block
  const inp = emptyInput();
  let yawNoise = (rand() * 2 - 1) * 0.17453292519943295;
  let held = true, pressNext = true, cooldown = 0;
  let releases = 0, bonks = 0, falls = 0, landings = 0;
  const x0 = b.p.x;
  let steps = 0;
  const maxSteps = 120 * 20;
  while (steps < maxSteps && b.p.x < endX) {
    // Aim along +x with this swing's yaw noise; move forward.
    inp.aimX = Math.cos(yawNoise); inp.aimY = 0.3; inp.aimZ = Math.sin(yawNoise);
    inp.moveX = 1; inp.moveZ = 0;
    inp.jumpPressed = false;
    inp.webPressed = pressNext;
    inp.webHeld = held;
    pressNext = false;
    stepBody(b, inp, k, world);
    steps++;
    if (b.events & EV_FALL) { falls++; break; }
    if (b.events & EV_BONK) bonks++;
    if (b.events & EV_LAND) { landings++; held = true; pressNext = true; }
    if (b.events & EV_ATTACH) yawNoise = (rand() * 2 - 1) * 0.17453292519943295;
    if (b.ropeHook >= 0 && !(b.events & EV_ATTACH)) {
      const h = model.hooks[b.ropeHook];
      if (b.p.x - h.x >= pol.ahead && b.v.y >= pol.vyMin) {
        held = false; // release on the next step
        releases++;
        cooldown = 6;
      }
    } else if (!held && !b.grounded) {
      if (--cooldown <= 0) { held = true; pressNext = true; }
    }
    if (b.events & EV_AUTORELEASE) { held = false; cooldown = 6; }
  }
  const t = steps / 120;
  return { speed: (b.p.x - x0) / t, releases, bonks, falls, landings, done: b.p.x >= endX };
}

const widths = [12, 14, 16];
const policies: Policy[] = [];
for (const ahead of [-1, 0, 1, 2, 3, 4]) for (const vyMin of [-3, 0, 2]) policies.push({ ahead, vyMin });

console.log(`canyon probe (tuning.json: speedCap ${PLAYER_TUNING.speedCap}, releaseBoost ${PLAYER_TUNING.releaseBoost}, reelSpeed ${PLAYER_TUNING.reelSpeed}, ropeScale ${PLAYER_TUNING.ropeScale}): ${TRIALS} trials per width x policy, +-2 m lateral, +-10 deg aim noise; pass = >= 13 m/s and < 10% bonks`);
for (const W of widths) {
  let best: { pol: Policy; speed: number; bonkRate: number; done: number; falls: number } | null = null;
  const rows: string[] = [];
  for (const pol of policies) {
    let sp = 0, rel = 0, bonk = 0, done = 0, falls = 0;
    for (let i = 0; i < TRIALS; i++) {
      const r = trial(canyon(W, 100 + i), W, PLAYER_TUNING, pol, 1000 + i);
      sp += r.speed; rel += r.releases; bonk += r.bonks; done += r.done ? 1 : 0; falls += r.falls;
    }
    const speed = sp / TRIALS, bonkRate = rel ? bonk / rel : 0;
    rows.push(`  W=${W} ahead=${pol.ahead} vyMin=${pol.vyMin}: ${speed.toFixed(1)} m/s, bonks ${(bonkRate * 100).toFixed(0)}% of ${rel} releases, finished ${done}/${TRIALS}, falls ${falls}`);
    const score = (bonkRate < 0.1 ? 100 : 0) + speed * (done / TRIALS);
    const bscore = best ? (best.bonkRate < 0.1 ? 100 : 0) + best.speed * (best.done / TRIALS) : -1;
    if (score > bscore) best = { pol, speed, bonkRate, done, falls };
  }
  if (process.argv.includes("--all")) console.log(rows.join("\n"));
  const b = best!;
  const pass = b.speed >= 13 && b.bonkRate < 0.1; // spec criterion; falls are reported, not gated
  console.log(`W=${W} m: best policy ahead=${b.pol.ahead} vyMin=${b.pol.vyMin} -> ${b.speed.toFixed(1)} m/s, bonks ${(b.bonkRate * 100).toFixed(1)}%, finished ${b.done}/${TRIALS} (falls ${b.falls})  ${pass ? "PASS" : "fail"}`);
}
