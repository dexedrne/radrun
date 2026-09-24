// Link-preview assets: public/og.jpg (1200x630 OG / Twitter card: a mid-swing frame from the game with
// the RUG RUN logo, the pitch and the three Radbro portraits) and public/apple-touch-icon.png (180 px,
// from public/favicon.svg).
//   npm run dev   (in another shell)
//   RUGRUN_CHROME_PROFILE=<throwaway dir> node tools/og-image.ts [--url <game url>] [--pick N] [--bg <png>] [--bg-out <png>]
// --url defaults to the dev server's ?bot=swing round (the page freezes 0.25 s into each swing); --pick
// takes the Nth frozen swing (default 0). --bg skips the game and composites over an existing frame;
// --bg-out also saves the raw frame. Always launches Chromium with a THROWAWAY --user-data-dir.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { RADBRO_COLOR } from "../src/ui/strings.ts";

const profile = process.env.RUGRUN_CHROME_PROFILE;
if (!profile) {
  console.error("set RUGRUN_CHROME_PROFILE to a throwaway Chromium profile directory");
  process.exit(2);
}
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const url = arg("--url", "http://localhost:4870/?bot=swing&seed=77&c=2564&r=652");
const pick = Number(arg("--pick", "0"));
const bgIn = arg("--bg", "");
const bgOut = arg("--bg-out", "");
const root = path.resolve(import.meta.dirname, "..");
const pub = path.join(root, "public");
const W = 1200, H = 630;
fs.mkdirSync(profile, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium",
  headless: true,
  userDataDir: profile,
  args: [`--user-data-dir=${profile}`, "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dataUrl = (file: string, mime: string) => `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log(`pageerror: ${(e as Error).message ?? String(e)}`));
  page.on("console", m => { if (m.type() === "error") console.log(`console.error: ${m.text()}`); });

  // 1. The frame: the Nth frozen swing of the bot round, DOM overlays hidden.
  let bg: string;
  if (bgIn) bg = dataUrl(bgIn, "image/png");
  else {
    await page.goto(url, { waitUntil: "load" });
    const t0 = Date.now();
    let seen = 0, shot: Uint8Array | null = null;
    while (!shot && Date.now() - t0 < 150_000) {
      const frozen = await page.evaluate(() => Boolean((window as unknown as { __frozen?: boolean }).__frozen));
      if (frozen) {
        if (seen++ === pick) {
          await sleep(500); // let the paused frame settle
          await page.evaluate(() => {
            const c = document.querySelector("canvas");
            if (!c) return;
            const keep = new Set<Element>();
            for (let e: Element | null = c; e; e = e.parentElement) keep.add(e);
            document.querySelectorAll("body *").forEach(e => { if (!keep.has(e) && !c.contains(e)) (e as HTMLElement).style.visibility = "hidden"; });
          });
          await sleep(300);
          shot = await page.screenshot({ type: "png" });
        } else {
          await page.evaluate(() => (window as unknown as { __unfreeze: () => void }).__unfreeze());
          await sleep(1200);
        }
      }
      await sleep(80);
    }
    if (!shot) throw new Error(`no frozen swing #${pick} within 150 s`);
    if (bgOut) fs.writeFileSync(bgOut, shot);
    bg = `data:image/png;base64,${Buffer.from(shot).toString("base64")}`;
  }

  // 2. The card.
  const cards = (["652", "4764", "2564"] as const).map(id => `
    <div class="card">
      <div class="bust" style="background: radial-gradient(circle at 50% 38%, ${RADBRO_COLOR[id].body}88, ${RADBRO_COLOR[id].accent}33 62%, rgba(0,0,0,0.35))">
        <img src="${dataUrl(path.join(pub, "ui", `radbro${id}.webp`), "image/webp")}">
      </div>
      <div class="id">#${id}</div>
    </div>`).join("");
  const html = `<!doctype html><html><head><style>
    * { margin: 0; box-sizing: border-box; }
    body { width: ${W}px; height: ${H}px; overflow: hidden; position: relative; font-family: "JetBrains Mono", "DejaVu Sans Mono", monospace; color: #fff; background: #141833; }
    .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(10,12,30,0.86) 0%, rgba(10,12,30,0.62) 38%, rgba(10,12,30,0) 66%), linear-gradient(0deg, rgba(10,12,30,0.55), rgba(10,12,30,0) 34%); }
    .logo { position: absolute; left: 58px; top: 56px; font-weight: 800; font-size: 118px; line-height: 1; letter-spacing: 8px; text-shadow: 6px 6px 0 #ff3d7f, 12px 12px 0 rgba(0,0,0,0.4); }
    .pitch { position: absolute; left: 62px; top: 214px; width: 700px; font-weight: 700; font-size: 29px; line-height: 1.3; text-shadow: 0 2px 6px rgba(0,0,0,0.7); }
    .pitch b { color: #ffd23f; }
    .cta { position: absolute; left: 62px; bottom: 58px; display: flex; gap: 14px; align-items: center; font-size: 21px; font-weight: 700; }
    .play { background: #ff3d7f; padding: 12px 26px; border-radius: 10px; letter-spacing: 2px; font-weight: 800; box-shadow: 0 6px 20px rgba(0,0,0,0.35); }
    .url { opacity: 0.92; text-shadow: 0 2px 6px rgba(0,0,0,0.8); }
    .cards { position: absolute; right: 40px; top: 44px; display: flex; flex-direction: column; gap: 12px; }
    .card { display: flex; align-items: center; gap: 10px; background: rgba(14,16,30,0.72); border: 2px solid rgba(255,255,255,0.22); border-radius: 14px; padding: 6px 14px 6px 6px; box-shadow: 0 6px 22px rgba(0,0,0,0.35); }
    .bust { width: 150px; height: 150px; border-radius: 10px; overflow: hidden; }
    .bust img { width: 150px; height: 150px; display: block; }
    .id { font-weight: 800; font-size: 22px; writing-mode: vertical-rl; transform: rotate(180deg); letter-spacing: 2px; }
  </style></head><body>
    <img class="bg" src="${bg}">
    <div class="shade"></div>
    <div class="logo">RUG RUN</div>
    <div class="pitch">He swiped your bag. 90 seconds.<br>Swing across the rooftops and <b>YOINK</b> him.</div>
    <div class="cta"><span class="play">PLAY FREE</span><span class="url">radbro-rug-run.vercel.app</span></div>
    <div class="cards">${cards}</div>
  </body></html>`;
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const og = path.join(pub, "og.jpg");
  fs.writeFileSync(og, await page.screenshot({ type: "jpeg", quality: 86 }));
  console.log(`og-image: ${path.relative(root, og)} (${(fs.statSync(og).size / 1024).toFixed(1)} KB)`);

  // 3. apple-touch-icon.png from favicon.svg.
  await page.setViewport({ width: 180, height: 180, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:#141833"><img src="${dataUrl(path.join(pub, "favicon.svg"), "image/svg+xml")}" style="width:180px;height:180px;display:block"></body></html>`, { waitUntil: "load" });
  const icon = path.join(pub, "apple-touch-icon.png");
  fs.writeFileSync(icon, await page.screenshot({ type: "png" }));
  console.log(`og-image: ${path.relative(root, icon)} (${(fs.statSync(icon).size / 1024).toFixed(1)} KB)`);
} finally {
  await browser.close();
}
