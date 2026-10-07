// The roster (Radbros #652, #4764, #2564, #723 the cowboy, since 2026-09-25 #3171 the halo, and since 2026-10-02 the
// owner's two Retardios, ids retardio555 / retardio85): every
// Radbro ships a web GLB, a clip pack, clip meta with every clip the game commands and a title portrait;
// every per-character table covers him; links carry him by id (and older links still decode); the runner
// is drawn from the others; and which Radbro you play never changes the round (ghost links stay exact).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodePack } from "../src/route/trackPack.ts";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { Round, RADBROS, charFile, charName, charTag, isRadbroId, portraitPath, type RadbroId } from "../src/game/round.ts";
import { runBotRound } from "../src/game/bots.ts";
import { emptyInput } from "../src/sim/player.ts";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { LINES, PERSONA, RADBRO_COLOR, TAUNTS } from "../src/ui/strings.ts";
import CLIP_META from "../src/generated/clips.meta.json" with { type: "json" };

// prefs.ts reads the page's district from location at import time.
(globalThis as { location?: unknown }).location = { href: "https://rugrun.test/", search: "" };
const { readChallenge, challengeUrl, ghostUrl, pickRunner } = await import("../src/ui/prefs.ts");

const pub = (f: string) => new URL(`../public/${f}`, import.meta.url);
/** Every clip the animation machine commands (the dive clips are cut-list fallbacks only). */
const USED = ["Idle", "Casual_Walk", "Run_02", "Lean_Forward_Sprint", "Regular_Jump", "Grab_Bar_and_Swing_Forward", "Rope_Hang_Idle",
  "Big_Wave_Hello", "Victory_Cheer", "Falling_Down", "Fishing_Cast", "Waltz"];

test("roster: the main four lead the seven Radbros and two Retardios", () => {
  assert.deepEqual([...RADBROS], ["4764", "652", "3704", "3710", "723", "3171", "retardio555", "retardio85", "2564"]);
});

test("roster: Retardio ids, files and names stay apart from the Radbro token numbers", () => {
  assert.equal(charFile("652"), "radbro652");
  assert.equal(charFile("retardio555"), "retardio555");
  assert.equal(portraitPath("retardio85"), "/ui/retardio85.webp");
  assert.equal(charTag("4764"), "#4764");
  assert.equal(charTag("retardio85"), "#85");
  assert.equal(charName("723"), "Radbro #723");
  assert.equal(charName("retardio555"), "Retardio #555");
  assert.ok(isRadbroId("retardio555") && isRadbroId("retardio85"));
  assert.ok(!isRadbroId("555") && !isRadbroId("85"), "a bare number is a Radbro token, never a Retardio");
});

test("roster: every Radbro has its GLB, clip pack, portrait and full clip meta", () => {
  const meta = CLIP_META as Record<string, { clipPack: boolean; clips: Record<string, { duration: number; handHeight?: number }> }>;
  assert.deepEqual(Object.keys(meta).sort(), [...RADBROS].sort());
  for (const id of RADBROS) {
    for (const f of [`models/${charFile(id)}.glb`, `models/${charFile(id)}.clips.glb`, `ui/${charFile(id)}.webp`]) assert.ok(fs.existsSync(pub(f)), f);
    assert.ok(meta[id].clipPack, `#${id} clip pack`);
    for (const c of USED) assert.ok(meta[id].clips[c]?.duration > 0, `#${id} ${c}`);
    const h = meta[id].clips.Rope_Hang_Idle.handHeight ?? 0;
    assert.ok(h > 1 && h < 1.8, `#${id} rope hand height ${h}`);
  }
});

test("roster: every Radbro has taunts, catch / escape lines, a persona and card colours", () => {
  for (const id of RADBROS) {
    assert.ok(TAUNTS[id].length >= 4, `#${id} taunts`);
    assert.ok(LINES.caught[id] && LINES.escaped[id], `#${id} lines`);
    assert.ok(PERSONA[id], `#${id} persona`);
    assert.match(RADBRO_COLOR[id].body, /^#[0-9a-f]{6}$/);
  }
  assert.ok(TAUNTS["723"].includes("nice day for it"));
});

test("links: #723 round-trips as chaser and runner; older three-Radbro links still decode", () => {
  const c = readChallenge(new URL(challengeUrl("723", "2564", "normal", 33.3)).search);
  assert.equal(c.c, "723");
  assert.equal(c.r, "2564");
  const g = readChallenge(new URL(ghostUrl("652", "723", "degen", 41.26, 99, "abcdEFGH_-12")).search);
  assert.equal(g.c, "652");
  assert.equal(g.r, "723");
  assert.equal(g.g, "abcdEFGH_-12");
  const old = readChallenge("?c=652&r=4764&d=normal&s=5&t=40.0&g=abcdEFGH_-12");
  assert.deepEqual([old.c, old.r, old.d, old.s, old.v], ["652", "4764", "normal", 5, 1]);
  const bad = readChallenge("?c=999&r=723");
  assert.equal(bad.c, null);
  assert.equal(bad.r, "723");
  const rt = readChallenge(new URL(ghostUrl("retardio555", "retardio85", "normal", 30, 7, "abcdEFGH_-12")).search);
  assert.deepEqual([rt.c, rt.r], ["retardio555", "retardio85"]);
  const mix = readChallenge(new URL(challengeUrl("652", "retardio85", "degen", 20)).search);
  assert.deepEqual([mix.c, mix.r], ["652", "retardio85"]);
});

test("runner pool: the link's runner if valid, else one of the other three at random", () => {
  for (const chaser of RADBROS) {
    const seen = new Set<RadbroId>();
    for (let i = 0; i < 400; i++) seen.add(pickRunner(chaser, null));
    assert.deepEqual([...seen].sort(), RADBROS.filter(r => r !== chaser).sort(), `chaser #${chaser}`);
  }
  assert.equal(pickRunner("723", "652"), "652");
  assert.notEqual(pickRunner("723", "723"), "723");
});

test("the Radbro you pick never changes the round (same seed -> same hash and catch step)", () => {
  const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
  const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
  const tuning = applyTuningJson(JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8")));
  const pack = decodePack(fs.readFileSync(lv("runner.pack.bin")));
  const index = new CityIndex(model);
  const run = (chaser: RadbroId, runner: RadbroId) => {
    const round = new Round({ model, index, pack, difficulty: "chill", params: tuning.difficulty.chill, tuning: tuning.player, chaser, runner, seed: 24, countdown: false });
    const r = runBotRound(round, { kind: "swing", k: 1, yoink: true }, emptyInput());
    return `${r.steps}/${r.caught}/${round.hash()}`;
  };
  const base = run("652", "4764");
  assert.equal(run("3704", "3710"), base);
  assert.equal(run("3710", "3704"), base);
  assert.equal(run("723", "652"), base);
  assert.equal(run("2564", "723"), base);
  assert.equal(run("retardio555", "retardio85"), base);
  assert.equal(run("retardio85", "652"), base);
});
