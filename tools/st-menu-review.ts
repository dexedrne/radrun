// Sequential title-menu clips; run under the same browser flock as st-review.ts.
import puppeteer from 'puppeteer-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const cache = join(homedir(), '.cache/r3g-smoke/tmp'), out = join(homedir(), 'Documents/spidertag/review/st-polish');
await mkdir(cache, { recursive: true }); const profile = await mkdtemp(join(cache, 'st-menu-'));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: profile, args: ['--no-sandbox', '--mute-audio', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  for (const [stage, port] of [['before', 6011], ['after', 6010]] as const) {
    const page = await browser.newPage(); await page.setViewport({ width: 800, height: 600 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('rugrun.v1', JSON.stringify({ visited: true, settings: { quality: 'low', muted: true } }));
      (window as any).reviewMenuButtons = [];
      Object.defineProperty(navigator, 'getGamepads', { value: () => [{ id: 'DualSense Wireless Controller', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, (_, i) => ({ pressed: (window as any).reviewMenuButtons.includes(i), value: (window as any).reviewMenuButtons.includes(i) ? 1 : 0 })) }] });
    });
    await page.goto(`http://127.0.0.1:${port}/?webgl2`, { waitUntil: 'networkidle0' }); await wait(1000);
    const c = await page.createCDPSession(), frames: { data: string; time: number }[] = [];
    c.on('Page.screencastFrame', e => { frames.push({ data: e.data, time: e.metadata.timestamp ?? 0 }); void c.send('Page.screencastFrameAck', { sessionId: e.sessionId }); });
    await c.send('Page.startScreencast', { format: 'jpeg', quality: 75 });
    for (let i = 0; i < 5; i++) { await page.evaluate(() => { (window as any).reviewMenuButtons = [13]; }); await wait(180); await page.evaluate(() => { (window as any).reviewMenuButtons = []; }); await wait(820); }
    await c.send('Page.stopScreencast');
    const lines: string[] = [];
    for (let n = 0; n < frames.length; n++) {
      const file = join(profile, `${stage}-${n}.jpg`); await writeFile(file, Buffer.from(frames[n].data, 'base64'));
      lines.push(`file '${file}'`, `duration ${n + 1 < frames.length ? Math.max(.033, frames[n + 1].time - frames[n].time) : 1}`);
    }
    lines.push(`file '${join(profile, `${stage}-${frames.length - 1}.jpg`)}'`);
    const list = join(profile, `${stage}.txt`); await writeFile(list, lines.join('\n'));
    execFileSync(process.env.FFMPEG ?? 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30', '-t', '5', '-an', '-c:v', 'libvpx-vp9', '-threads', '1', '-b:v', '500k', '-deadline', 'realtime', '-cpu-used', '8', join(out, `${stage}-menu.webm`)]);
    console.log(stage, frames.length, 'menu frames'); await page.close();
  }
} finally { await browser.close(); await rm(profile, { recursive: true, force: true }); }
