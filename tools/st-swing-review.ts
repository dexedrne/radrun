// A single-view swing/animation review using the existing deterministic developer swinger.
import puppeteer from 'puppeteer-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const out = join(homedir(), 'Documents/spidertag/review/st-polish'), cache = join(homedir(), '.cache/r3g-smoke/tmp');
await mkdir(cache, { recursive: true }); const profile = await mkdtemp(join(cache, 'st-swing-'));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: profile, protocolTimeout: 60000, args: ['--no-sandbox', '--mute-audio', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  for (const [stage, port] of [['before', 6011], ['after', 6010]] as const) {
    const page = await browser.newPage(); await page.setViewport({ width: 640, height: 480 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('rugrun.v1', JSON.stringify({ visited: true, settings: { quality: 'low', qualityChosen: true, muted: true, music: 0, sfx: 0, voice: 0 } }));
      window.requestAnimationFrame = cb => window.setTimeout(() => cb(performance.now()), 100);
      window.cancelAnimationFrame = id => clearTimeout(id);
      setInterval(() => (window as any).__unfreeze?.(), 500);
    });
    const errors: string[] = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/?bot=swing&seed=77&c=652&r=4764&d=normal&webgl2`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__play && window.__play.rope >= 0', { timeout: 180000 });
    const c = await page.createCDPSession(), frames: { data: string; time: number }[] = [];
    c.on('Page.screencastFrame', e => { frames.push({ data: e.data, time: e.metadata.timestamp ?? 0 }); void c.send('Page.screencastFrameAck', { sessionId: e.sessionId }); });
    await c.send('Page.startScreencast', { format: 'jpeg', quality: 70 }); await wait(8000);
    void c.send('Page.stopScreencast').catch(() => {});
    const selected = frames.filter(f => f.time - frames[0].time <= 8); if (!selected.length) throw new Error('no swing frames');
    const lines: string[] = [];
    for (let n = 0; n < selected.length; n++) {
      const file = join(profile, `${stage}-${n}.jpg`); await writeFile(file, Buffer.from(selected[n].data, 'base64'));
      lines.push(`file '${file}'`, `duration ${n + 1 < selected.length ? Math.max(.033, selected[n + 1].time - selected[n].time) : Math.max(.033, 8 - (selected[n].time - selected[0].time))}`);
    }
    lines.push(`file '${join(profile, `${stage}-${selected.length - 1}.jpg`)}'`);
    const list = join(profile, `${stage}.txt`); await writeFile(list, lines.join('\n'));
    await writeFile(join(out, `${stage}-swing.jpg`), Buffer.from(selected.at(-1)!.data, 'base64'));
    execFileSync(process.env.FFMPEG ?? 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30', '-t', '8', '-an', '-c:v', 'libvpx-vp9', '-threads', '1', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', join(out, `${stage}-swing.webm`)]);
    await writeFile(join(out, `${stage}-swing.json`), JSON.stringify({ frames: selected.length, errors, probe: await page.evaluate('window.__play') }, null, 2));
    console.log(stage, selected.length, 'swing frames', errors); await page.close();
  }
} finally { const pid = browser.process()?.pid; const timer = setTimeout(() => { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} } }, 5000); await browser.close().catch(() => {}); clearTimeout(timer); await rm(profile, { recursive: true, force: true }); }
