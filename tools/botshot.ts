// Real-time headless browser run of the test bot (prints; not a build gate):
//   RUGRUN_CHROME_PROFILE=<throwaway dir> node tools/botshot.ts [url] [outDir]
// Default url: ?bot=follow&k=1.3&seed=123&d=chill&c=652&r=4764 on the dev server (?bot=swing: the
// page freezes 0.25 s into each swing; saves three such shots, no prediction). Waits for CAUGHT or
// ESCAPED via window.__play, saves countdown / mid-chase / results screenshots, compares the catch
// step with the Node prediction (same seed, same bot) and lists console errors.
// Always launches Chromium with a THROWAWAY --user-data-dir (required; never a real profile).
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { decodePack } from "../src/route/trackPack.ts";
import { Round } from "../src/game/round.ts";
import { runBotRound } from "../src/game/bots.ts";
import { emptyInput } from "../src/sim/player.ts";
import type { Difficulty } from "../src/sim/tuning.ts";

const profile = process.env.RUGRUN_CHROME_PROFILE;
if (!profile) {
  console.error("set RUGRUN_CHROME_PROFILE to a throwaway Chromium profile directory");
  process.exit(2);
}
const url = process.argv[2] ?? "http://localhost:4870/?bot=follow&k=1.3&seed=123&d=chill&c=652&r=4764";
const outDir = path.resolve(process.argv[3] ?? ".local/shots");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(profile, { recursive: true });

// Node prediction.
const q = new URL(url).searchParams;
const levels = path.resolve(import.meta.dirname, "..", "public", "levels");
const tj = applyTuningJson(JSON.parse(fs.readFileSync(path.join(levels, "tuning.json"), "utf8")));
const model = JSON.parse(fs.readFileSync(path.join(levels, "city.model.json"), "utf8"));
const pack = decodePack(fs.readFileSync(path.join(levels, "runner.pack.bin")));
const d = (q.get("d") === "normal" ? "normal" : "chill") as Difficulty;
const round = new Round({ model, pack, difficulty: d, params: tj.difficulty[d], tuning: tj.player, chaser: "652", runner: "4764", seed: Number(q.get("seed") ?? 123) >>> 0, countdown: false });
const swing = q.get("bot") === "swing";
const predicted = swing ? { caught: false, kind: "", steps: -1, time: 0 } : runBotRound(round, { kind: "follow", k: Number(q.get("k") ?? 1.3), yoink: q.get("bot") === "yoink" }, emptyInput());
if (!swing) console.log(`node prediction: ${predicted.caught ? "CAUGHT" : "ESCAPED"} (${predicted.kind || "-"}) at chase step ${predicted.steps} (${predicted.time.toFixed(2)} s)`);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium",
  headless: true,
  userDataDir: profile,
  args: [`--user-data-dir=${profile}`, "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--window-size=1280,720"],
  defaultViewport: { width: 1280, height: 720 },
});
const log: string[] = [];
const errors: string[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type P = { screen: string; phase: string; rope: number; player: [number, number, number]; chaseSteps: number; clock: number; d: number; outcome: string; catchKind: string; catchTime: number; ring: number; runner: { phase: number; mode: number }; runnerPhases: number[]; clips?: { chaser: string[]; runner: string[]; george?: string[] }; fps: number; backend: string };
try {
  const page = await browser.newPage();
  page.on("console", m => { const t = `console.${m.type()}: ${m.text()}`; log.push(t); if (m.type() === "error") errors.push(t); });
  page.on("pageerror", e => { const t = `pageerror: ${(e as Error).message ?? String(e)}`; log.push(t); errors.push(t); });
  page.on("response", r => { if (r.status() >= 400) log.push(`http ${r.status()}: ${r.url()}`); });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load" });
  const shots = { countdown: false, chase: false, catch: false, results: false };
  let last: P | null = null;
  let firstChase = 0;
  let swingShots = 0, swingShotAt = 0;
  while (Date.now() - t0 < 240_000) {
    last = (await page.evaluate(() => (window as unknown as { __play?: unknown }).__play ?? null)) as P | null;
    if (last) {
      if (!shots.countdown && last.screen === "countdown" && Date.now() - t0 > 3000) {
        await sleep(900);
        await page.screenshot({ path: path.join(outDir, "bot-countdown.png") });
        shots.countdown = true;
        log.push(`SHOT countdown at wall ${Date.now() - t0} ms`);
      }
      if (last.phase === "chase" && !firstChase) firstChase = Date.now();
      // ?bot=swing: two shots while the player hangs from a balloon, then stop.
      const frozen = swing && (await page.evaluate(() => Boolean((window as unknown as { __frozen?: boolean }).__frozen)));
      if (frozen) {
        await sleep(400); // let the paused frame settle (camera, mixers keep rendering)
        last = (await page.evaluate(() => (window as unknown as { __play?: unknown }).__play ?? null)) as P;
      }
      if (frozen && Date.now() - swingShotAt < 1500) await page.evaluate(() => (window as unknown as { __unfreeze: () => void }).__unfreeze());
      else if (frozen) {
        swingShotAt = Date.now();
        const f = path.join(outDir, `bot-swing-${swingShots++}.png`);
        await page.screenshot({ path: f });
        log.push(`SHOT swing at chase step ${last.chaseSteps}: rope ${last.rope}, player ${JSON.stringify(last.player.map(v => +v.toFixed(1)))}, clips ${JSON.stringify(last.clips?.chaser.slice(-4))}, fps ${last.fps.toFixed(1)}`);
        await page.evaluate(() => (window as unknown as { __unfreeze: () => void }).__unfreeze());
        if (swingShots >= 3) break;
      }
      if (swing && firstChase && Date.now() - firstChase > 60_000) break;
      // Mid-chase: prefer a moment with him on the rope, else ~4 s into the chase.
      if (!shots.chase && last.phase === "chase" && (last.chaseSteps > 240 && (last.runner.phase === 2 || Date.now() - firstChase > 4000))) {
        await page.screenshot({ path: path.join(outDir, "bot-midchase.png") });
        shots.chase = true;
        log.push(`SHOT mid-chase at chase step ${last.chaseSteps}: ${JSON.stringify({ d: +last.d.toFixed(1), runnerPhase: last.runner.phase, ring: last.ring, fps: +last.fps.toFixed(1) })}`);
      }
      if (last.outcome && !shots.catch) {
        await page.screenshot({ path: path.join(outDir, "bot-catch.png") });
        shots.catch = true;
        log.push(`SHOT catch (${last.outcome} ${last.catchKind})`);
      }
      if (last.outcome && last.screen === "results" && !shots.results) {
        await sleep(2500);
        await page.screenshot({ path: path.join(outDir, "bot-results.png") });
        shots.results = true;
        log.push(`SHOT results`);
        break;
      }
    }
    await sleep(60);
  }
  if (!last?.outcome) log.push(`NO outcome within 240 s; last probe ${JSON.stringify(last)}`);
  console.log(`browser: ${last?.outcome || "none"} (${last?.catchKind || "-"}) at chase step ${last?.chaseSteps} (${last?.catchTime?.toFixed(2)} s), backend ${last?.backend}, runner phases seen ${JSON.stringify(last?.runnerPhases)}`);
  if (last?.outcome && !swing) console.log(`catch step vs node: ${last.chaseSteps - predicted.steps} (must be within +-1)`);
  console.log(`clips seen: chaser ${JSON.stringify(last?.clips?.chaser)} runner ${JSON.stringify(last?.clips?.runner)} george ${JSON.stringify(last?.clips?.george)}`);
} catch (e) {
  log.push(`FATAL: ${(e as Error)?.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(log.join("\n"));
console.log(`console errors: ${errors.length}`);
console.log(`screenshots in ${path.relative(process.cwd(), outDir)}`);
