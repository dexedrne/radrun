// Real-time headless screenshot of ?sandbox&autoplay mid-swing (smoke check, not a test gate).
//   RUGRUN_CHROME_PROFILE=<throwaway dir> [SHOT_WAIT_MS=15000] node tools/shot.ts [url] [out.png]
// Always launches Chromium with a THROWAWAY --user-data-dir (required; never a real profile).
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const profile = process.env.RUGRUN_CHROME_PROFILE;
if (!profile) {
  console.error("set RUGRUN_CHROME_PROFILE to a throwaway Chromium profile directory");
  process.exit(2);
}
const url = process.argv[2] ?? "http://localhost:4870/?sandbox&autoplay";
const out = path.resolve(process.argv[3] ?? ".local/shots/sandbox-swing.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(profile, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium",
  headless: true,
  userDataDir: profile,
  args: [`--user-data-dir=${profile}`, "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--window-size=1280,720"],
  defaultViewport: { width: 1280, height: 720 },
});
const log: string[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type P = { step: number; p: number[]; v: number[]; grounded: boolean; ropeHook: number; ringId: number; fps: number; frames: number; stats: Record<string, number> };
try {
  const page = await browser.newPage();
  page.on("console", m => log.push(`console.${m.type()}: ${m.text()}`));
  page.on("pageerror", e => log.push(`pageerror: ${(e as Error).message ?? String(e)}`));
  page.on("response", r => { if (r.status() >= 400) log.push(`http ${r.status()}: ${r.url()}`); });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load" });
  let shot = false;
  const waitMs = Number(process.env.SHOT_WAIT_MS ?? 0);
  if (waitMs > 0) {
    // Plain mode (e.g. ?editor): wait, then screenshot.
    await sleep(waitMs);
    await page.screenshot({ path: out });
    shot = true;
    log.push(`SHOT after ${waitMs} ms`);
  }
  let attachStep = -1;
  let last: P | null = null;
  while (!shot && Date.now() - t0 < 120_000) {
    last = (await page.evaluate(() => (window as unknown as { __probe?: unknown }).__probe ?? null)) as P | null;
    if (last) {
      if (last.ropeHook >= 0 && attachStep < 0) attachStep = last.step;
      if (last.ropeHook < 0) attachStep = -1;
      // Mid-swing: on the rope for >= 0.25 s of sim time, after the city has had time to stream in.
      if (attachStep >= 0 && last.step - attachStep >= 30 && Date.now() - t0 > 8000) {
        await page.screenshot({ path: out });
        shot = true;
        log.push(`SHOT at wall ${Date.now() - t0} ms: ${JSON.stringify({ step: last.step, p: last.p.map(v => +v.toFixed(2)), ropeHook: last.ropeHook, ringId: last.ringId, fps: +last.fps.toFixed(1), stats: last.stats, cam: (last as unknown as { cam: unknown }).cam })}`);
        break;
      }
    }
    await sleep(50);
  }
  if (!shot) {
    await page.screenshot({ path: out });
    log.push(`NO mid-swing moment within 120 s; saved a fallback shot. last probe: ${JSON.stringify(last)}`);
  }
} catch (e) {
  log.push(`FATAL: ${(e as Error)?.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(log.join("\n"));
console.log(`screenshot: ${path.relative(process.cwd(), out)}`);
