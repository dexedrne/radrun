// Title-card portraits: renders ?portrait=<id> for each Radbro in headless Chromium and writes
// public/ui/radbro<id>.webp (transparent 3/4 bust in the Idle pose, from the game's own GLBs).
//   npm run dev   (in another shell)
//   RUGRUN_CHROME_PROFILE=<throwaway dir> node tools/portraits.ts [baseUrl] [extra query, e.g. "&yaw=35"]
// Always launches Chromium with a THROWAWAY --user-data-dir (required; never a real profile).
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const profile = process.env.RUGRUN_CHROME_PROFILE;
if (!profile) {
  console.error("set RUGRUN_CHROME_PROFILE to a throwaway Chromium profile directory");
  process.exit(2);
}
const base = process.argv[2] ?? "http://localhost:4870/";
const extra = process.argv[3] ?? "";
const outDir = path.resolve(import.meta.dirname, "..", "public", "ui");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(profile, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium",
  headless: true,
  userDataDir: profile,
  args: [`--user-data-dir=${profile}`, "--use-angle=swiftshader", "--window-size=900,600"],
  defaultViewport: { width: 900, height: 600 },
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log(`pageerror: ${(e as Error).message ?? String(e)}`));
  page.on("console", m => { if (m.type() === "error") console.log(`console.error: ${m.text()}`); });
  for (const id of ["652", "4764", "2564"]) {
    await page.goto(`${base}?portrait=${id}${extra}`, { waitUntil: "load" });
    let r: { done: boolean; dataUrl?: string; error?: string } | undefined;
    for (let i = 0; i < 120; i++) {
      r = await page.evaluate(() => window.__portrait);
      if (r?.done) break;
      await sleep(500);
    }
    if (!r?.dataUrl) throw new Error(`#${id}: ${r?.error ?? "timed out"}`);
    const bytes = Buffer.from(r.dataUrl.split(",")[1], "base64");
    const out = path.join(outDir, `radbro${id}.webp`);
    fs.writeFileSync(out, bytes);
    console.log(`portraits: ${path.relative(process.cwd(), out)} (${(bytes.length / 1024).toFixed(1)} KB)`);
  }
} finally {
  await browser.close();
}
