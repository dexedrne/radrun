// npm run balance -- [--n 200] [--set chill.gStar=18 ...] [--only swing] [--map market | --all]
// Balance bots (spec §16 test 9, printed, never a build gate): follower rounds at k x the pack's
// along-path speed x base, the camper, and the swinging chaser (game/bots.ts SwingBot: the real player
// sim, chain-swinging down the streets; round 9: with the moves, zipping back up onto the roofs), over seeds 1..n with the difficulty table from
// public/levels/tuning.json (plus --set overrides). Prints catch rate and catch-time quantiles (of the
// caught rounds) next to the targets.
import fs from "node:fs";
import path from "node:path";
import { applyTuningJson, type Difficulty, type DifficultyTable, type Tuning } from "../src/sim/tuning.ts";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { decodePack, type Pack } from "../src/route/trackPack.ts";
import { Round } from "../src/game/round.ts";
import { runBotRound, type BotOptions } from "../src/game/bots.ts";
import { emptyInput } from "../src/sim/player.ts";
import { DISTRICTS, DISTRICT_IDS, isDistrictId, type DistrictId } from "../src/world/districts.ts";

const PUBLIC = path.resolve(import.meta.dirname, "..", "public");
const LEVELS = path.join(PUBLIC, "levels");

export type Row = { label: string; target: string; caught: number; n: number; median: number; p25: number; p75: number; yoinks: number; pass: boolean | null };

const q = (xs: number[], f: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(f * xs.length))] : NaN);

export function runConfig(model: CityModel, index: CityIndex, pack: Pack, tuning: Tuning, table: DifficultyTable, d: Difficulty, bot: BotOptions, n: number, seed0 = 1, mutators = 0, district: DistrictId = "downtown"): { times: number[]; caught: number; yoinks: number } {
  const times: number[] = [];
  let caught = 0, yoinks = 0;
  const inp = emptyInput();
  for (let s = 0; s < n; s++) {
    const round = new Round({ model, index, pack, difficulty: d, params: table[d], tuning, chaser: "652", runner: "4764", seed: seed0 + s, countdown: false, mutators, district });
    const r = runBotRound(round, bot, inp);
    if (r.caught) { caught++; times.push(r.time); if (r.kind === "yoink") yoinks++; }
  }
  times.sort((a, b) => a - b);
  return { times, caught, yoinks };
}

export function balance(n: number, table: DifficultyTable, tuning: Tuning, model: CityModel, pack: Pack, only?: string, district: DistrictId = "downtown"): Row[] {
  const index = new CityIndex(model);
  const cfgs: { label: string; d: Difficulty; bot: BotOptions; target: string; check: (c: number, med: number) => boolean }[] = [
    // The follower rows are info since round 10 (PLAY.md: his swing-first routes are longer and double back, and a
    // follower glued to his track outlasts his panic budget); their old targets are shown for reference.
    { label: "normal follow k=1.0", d: "normal", bot: { kind: "follow", k: 1.0, yoink: true }, target: "(info; was ~0% caught)", check: () => true },
    { label: "normal follow k=1.2", d: "normal", bot: { kind: "follow", k: 1.2, yoink: true }, target: "(info; was median 35-70 s)", check: () => true },
    { label: "chill  follow k=1.0", d: "chill", bot: { kind: "follow", k: 1.0, yoink: true }, target: "(info; was >=90%, median 60-75 s)", check: () => true },
    { label: "normal camper", d: "normal", bot: { kind: "camper", k: 1.0, yoink: true }, target: "<25% caught", check: c => c < 0.25 * n },
    { label: "chill  follow k=1.3 (browser bot)", d: "chill", bot: { kind: "follow", k: 1.3, yoink: false }, target: "(info)", check: () => true },
    // The swinging chaser (real player sim; round 3): what a strong human swinger gets. Round 9: with the full
    // moveset (double jump, slide and the web zip it climbs back onto the roofs with - he zips up the tall
    // podiums too), since every player has them; the classic swinger without them is info only.
    { label: "chill  swing", d: "chill", bot: { kind: "swing", k: 1, yoink: true, moves: true }, target: "(info: forgiving)", check: () => true },
    { label: "normal swing", d: "normal", bot: { kind: "swing", k: 1, yoink: true, moves: true }, target: "median 25-40 s", check: (c, m) => c > 0 && m >= 25 && m <= 40 },
    { label: "degen  swing", d: "degen", bot: { kind: "swing", k: 1, yoink: true, moves: true }, target: "50-95% caught, median 40-70 s", check: (c, m) => c < 0.95 * n && c >= 0.5 * n && m >= 40 && m <= 70 },
    { label: "chill  swing, no zip", d: "chill", bot: { kind: "swing", k: 1, yoink: true }, target: "(info)", check: () => true },
    { label: "normal swing, no zip", d: "normal", bot: { kind: "swing", k: 1, yoink: true }, target: "(info)", check: () => true },
    { label: "degen  swing, no zip", d: "degen", bot: { kind: "swing", k: 1, yoink: true }, target: "(info)", check: () => true },
  ];
  return cfgs.filter(c => !only || c.label.includes(only)).map(c => {
    const r = runConfig(model, index, pack, tuning, table, c.d, c.bot, n, 1, 0, district);
    const med = q(r.times, 0.5);
    return { label: c.label, target: c.target, caught: r.caught, n, median: med, p25: q(r.times, 0.25), p75: q(r.times, 0.75), yoinks: r.yoinks, pass: c.check(r.caught, med) };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const n = Number(arg("n") ?? 200);
  const tj = JSON.parse(fs.readFileSync(path.join(LEVELS, "tuning.json"), "utf8"));
  const { player, difficulty } = applyTuningJson(tj);
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--set") continue;
    const [k, v] = process.argv[i + 1].split("=");
    const [d, f] = k.split(".") as [Difficulty, string];
    (difficulty[d] as Record<string, number>)[f] = Number(v);
  }
  const only = arg("only");
  const mapArg = arg("map");
  if (mapArg !== undefined && !isDistrictId(mapArg)) throw new Error(`unknown --map ${mapArg} (${DISTRICT_IDS.join(", ")})`);
  const maps: DistrictId[] = process.argv.includes("--all") ? [...DISTRICT_IDS] : [(mapArg as DistrictId | undefined) ?? "downtown"];
  const t0 = Date.now();
  console.log(`balance: ${n} rounds per row`);
  console.log(`  chill  ${JSON.stringify(difficulty.chill)}\n  normal ${JSON.stringify(difficulty.normal)}\n  degen  ${JSON.stringify(difficulty.degen)}`);
  for (const id of maps) {
    const dir = path.join(PUBLIC, DISTRICTS[id].dir);
    const model: CityModel = JSON.parse(fs.readFileSync(path.join(dir, "city.model.json"), "utf8"));
    const pack = decodePack(fs.readFileSync(path.join(dir, "runner.pack.bin")));
    console.log(`${id}: pack ${pack.hash} (${pack.junctions.length} junctions, ${pack.edges.length} edges)`);
    for (const r of balance(n, difficulty, player, model, pack, only, id)) {
      const pct = ((100 * r.caught) / r.n).toFixed(0).padStart(3);
      console.log(`  ${r.label.padEnd(34)} caught ${pct}%  median ${isNaN(r.median) ? "  -  " : r.median.toFixed(1).padStart(5)} s  (p25 ${isNaN(r.p25) ? "-" : r.p25.toFixed(1)}, p75 ${isNaN(r.p75) ? "-" : r.p75.toFixed(1)})  yoinks ${r.yoinks}   target ${r.target}  ${r.pass ? "ok" : "MISS"}`);
    }
  }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
