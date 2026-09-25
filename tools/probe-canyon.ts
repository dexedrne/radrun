// Canyon probe (round 9, docs/specs/2026-09-25-round9-movement.md §10: a printing script, not a gate): a
// chain-swinging player with the real building-anchor sim (findAnchor, pendulum, auto-release, wall runs)
// swings down a district's longest street lanes (default: the Towers avenues) and a synthetic 22 m canyon
// under 80-100 m towers. The policy is a player's: web held while a building is ringed ahead, let go past
// the pivot on the way up (velocity >= releaseTan x the horizontal speed), re-grab after 6 steps, steer
// toward the lane centre, +-10 deg aim noise per swing. Prints the chained speed along the lane (target
// ~20-24 m/s), swings, wall runs, bonks and falls.
//   node tools/probe-canyon.ts [--map towers] [--trials 24] [--release 0.4]
import fs from "node:fs";
import path from "node:path";
import { deriveModel } from "../src/world/derive.ts";
import { DEFAULT_CONFIG } from "../src/world/generate.ts";
import { CityIndex, type CityModel, type Solid } from "../src/world/cityModel.ts";
import { createBody, emptyInput, stepBody, EV_ATTACH, EV_BONK, EV_FALL, EV_LAND, EV_WALLRUN, type SimWorld } from "../src/sim/player.ts";
import { applyTuningJson, type Tuning } from "../src/sim/tuning.ts";
import { mulberry32 } from "../src/sim/math.ts";
import { streetLanes, type Lane } from "../src/game/bots.ts";
import { DISTRICTS, isDistrictId } from "../src/world/districts.ts";

const arg = (name: string, def: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const TRIALS = Number(arg("--trials", "24"));
const MAP = arg("--map", "towers");
const REL_TAN = Number(arg("--release", "0.4"));
const ROOT = path.resolve(import.meta.dirname, "..", "public");
// The player constants the game ships with (PLAYER overridden by public/levels/tuning.json).
const K: Tuning = applyTuningJson(JSON.parse(fs.readFileSync(path.join(ROOT, "levels", "tuning.json"), "utf8"))).player;

/** A 22 m avenue along +x between rows of ~50 m roofs and 80-100 m towers (8 blocks, alleys 4 m). */
export function tallCanyon(seed: number): CityModel {
  const rand = mulberry32(seed);
  const solids: Solid[] = [];
  for (const [z0, z1] of [[0, 18], [40, 58]]) {
    for (let i = 0; i < 16; i++) {
      const x0 = i * 22, tall = rand() < 0.45;
      const top = tall ? 80 + Math.floor(rand() * 21) : 48 + Math.floor(rand() * 5);
      solids.push({ id: solids.length, kind: tall ? "tower" : "roof", landable: !tall, x0, z0, x1: x0 + 18, z1, top });
    }
  }
  return deriveModel({ ...DEFAULT_CONFIG, street: 22, autoHooks: false }, solids);
}

type Trial = { speed: number; dist: number; swings: number; walls: number; bonks: number; fell: boolean; landed: boolean };

/** One run down lane L (along +/-), starting airborne over the lane at `y` with 12 m/s along it. */
function trial(model: CityModel, world: SimWorld, L: Lane, dir: 1 | -1, y: number, seed: number): Trial {
  const rand = mulberry32(seed);
  const a0 = dir > 0 ? L.lo + 4 : L.hi - 4, aEnd = dir > 0 ? L.hi - 4 : L.lo + 4;
  const lat0 = L.c + (rand() * 2 - 1) * 3;
  const b = createBody(L.along === 0 ? a0 : lat0, y, L.along === 0 ? lat0 : a0, -1);
  b.grounded = false;
  if (L.along === 0) b.v.x = 12 * dir; else b.v.z = 12 * dir;
  const inp = emptyInput();
  let noise = (rand() * 2 - 1) * 0.1745, held = true, press = true, cool = 0;
  let swings = 0, walls = 0, bonks = 0, steps = 0;
  const along = () => (L.along === 0 ? b.p.x : b.p.z);
  const lat = () => (L.along === 0 ? b.p.z : b.p.x);
  let fell = false, landed = false;
  while (steps < 120 * 20 && (along() - aEnd) * dir < 0) {
    const ax = L.along === 0 ? dir : noise, az = L.along === 0 ? noise : dir;
    inp.aimX = ax; inp.aimY = 0.3; inp.aimZ = az;
    const steer = Math.max(-0.8, Math.min(0.8, (L.c - lat()) * 0.25));
    inp.moveX = L.along === 0 ? dir : steer; inp.moveZ = L.along === 0 ? steer : dir;
    inp.webHeld = held; inp.webPressed = press; press = false;
    stepBody(b, inp, K, world);
    steps++;
    if (b.events & EV_FALL) { fell = true; break; }
    if (b.events & EV_LAND) { landed = true; break; }
    if (b.events & EV_BONK) bonks++;
    if (b.events & EV_WALLRUN) walls++;
    if (b.events & EV_ATTACH) { swings++; noise = (rand() * 2 - 1) * 0.1745; }
    if (b.ropeSolid >= 0 && !(b.events & EV_ATTACH)) {
      const pa = L.along === 0 ? b.ropeP.x : b.ropeP.z;
      const hs = Math.sqrt(b.v.x * b.v.x + b.v.z * b.v.z);
      if ((along() - pa) * dir >= 0 && b.v.y > 0 && b.v.y >= REL_TAN * hs) { held = false; cool = 6; }
    } else if (!held && --cool <= 0) { held = true; press = true; }
  }
  const dist = (along() - a0) * dir;
  return { speed: dist / (steps / 120), dist, swings, walls, bonks, fell, landed };
}

function report(name: string, runs: Trial[]): void {
  const n = runs.length || 1;
  const mean = (f: (t: Trial) => number) => runs.reduce((s, t) => s + f(t), 0) / n;
  const long = runs.filter(t => t.dist >= 60);
  const chained = long.length ? long.reduce((s, t) => s + t.speed, 0) / long.length : 0;
  console.log(`${name}: chained ${chained.toFixed(1)} m/s over ${long.length}/${runs.length} runs >= 60 m (all: ${mean(t => t.speed).toFixed(1)} m/s, ` +
    `${mean(t => t.dist).toFixed(0)} m), swings ${mean(t => t.swings).toFixed(1)}, wall runs ${mean(t => t.walls).toFixed(1)}, bonks ${mean(t => t.bonks).toFixed(2)}, ` +
    `falls ${runs.filter(t => t.fell).length}, roof landings ${runs.filter(t => t.landed).length}  ${chained >= 20 && chained <= 24.5 ? "(target 20-24)" : "(target 20-24: tune)"}`);
}

console.log(`canyon probe (tuning.json: speedCap ${K.speedCap}, swingGravity ${K.swingGravity}, swingPump ${K.swingPump}, swingReleaseCos ${K.swingReleaseCos}, ` +
  `anchorAhead ${K.anchorAhead}+${K.anchorAheadPerSpeed}v, release tan ${REL_TAN}), ${TRIALS} trials per lane`);

// 1. A district's longest lanes (both directions).
if (isDistrictId(MAP)) {
  const model: CityModel = JSON.parse(fs.readFileSync(path.join(ROOT, DISTRICTS[MAP].dir, "city.model.json"), "utf8"));
  const world: SimWorld = { index: new CityIndex(model), runner: null };
  const lanes = streetLanes(model).slice().sort((p, q) => (q.hi - q.lo) - (p.hi - p.lo)).slice(0, 4);
  const roofs = model.solids.filter(s => s.landable).map(s => s.top).sort((a, b) => a - b);
  const y = roofs[Math.floor(roofs.length / 2)] + 2;
  const runs: Trial[] = [];
  lanes.forEach((L, li) => { for (let i = 0; i < TRIALS; i++) runs.push(trial(model, world, L, i % 2 ? -1 : 1, y, 1000 * li + i)); });
  report(`${MAP} (${lanes.length} longest lanes, start ${y.toFixed(0)} m)`, runs);
}

// 2. The synthetic canyon (22 m avenue, towers 80-100 m).
{
  const runs: Trial[] = [];
  for (let i = 0; i < TRIALS; i++) {
    const model = tallCanyon(100 + i);
    const world: SimWorld = { index: new CityIndex(model), runner: null };
    const L: Lane = { along: 0, c: 29, lo: 0, hi: 16 * 22 - 4 };
    runs.push(trial(model, world, L, 1, 52, 7 + i));
  }
  report("synthetic 22 m canyon (towers 80-100 m)", runs);
}
