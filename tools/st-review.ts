// Run under the shared browser flock. Two isolated peers in ONE muted browser.
import puppeteer from 'puppeteer-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const stage = process.argv[2] ?? 'before';
const ui = process.env.REVIEW_UI ?? 'http://127.0.0.1:6010';
const relay = process.env.REVIEW_RELAY ?? 'http://127.0.0.1:6009';
const out = join(homedir(), 'Documents/spidertag/review/st-polish');
const cache = join(homedir(), '.cache/r3g-smoke/tmp');
await mkdir(cache, { recursive: true }); await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(cache, 'st-polish-'));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: profile, protocolTimeout: 60000,
  args: ['--no-sandbox', '--mute-audio', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
console.log('browser pid', browser.process()?.pid);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const errors: string[] = [];
try {
  const contexts = await Promise.all([browser.createBrowserContext(), browser.createBrowserContext()]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  for (const page of pages) {
    await page.setViewport({ width: 640, height: 480 });
    page.on('pageerror', e => { errors.push(String(e)); console.log('pageerror', String(e)); });
    page.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('rugrun.v1', JSON.stringify({ visited: true, settings: { quality: 'low', qualityChosen: true, muted: true, music: 0, sfx: 0, voice: 0 } }));
      const replace = history.replaceState.bind(history);
      history.replaceState = (data, title, url) => { const u = new URL(String(url), location.href); if (location.search.includes('webgl2')) u.searchParams.set('webgl2', ''); replace(data, title, u); };
      const w = window as any;
      w.reviewPad = { axes: [0, 0, 0, 0], held: [] };
      Object.defineProperty(navigator, 'getGamepads', { value: () => [{ id: 'Sony DualSense Wireless Controller', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), axes: w.reviewPad.axes,
        buttons: Array.from({ length: 18 }, (_, i) => ({ pressed: w.reviewPad.held.includes(i), touched: w.reviewPad.held.includes(i), value: w.reviewPad.held.includes(i) ? 1 : 0 })) }] });
      // Avoid saturating the shared software GPU. Video is encoded at 30 fps; render rate is documented separately.
      const callbacks = new Map<number, FrameRequestCallback>(); let next = 0, timer: number | undefined;
      const flush = () => { timer = undefined; const batch = [...callbacks.values()]; callbacks.clear(); for (const cb of batch) cb(performance.now()); if (callbacks.size && timer === undefined) timer = window.setTimeout(flush, 250); };
      window.requestAnimationFrame = cb => { const id = ++next; callbacks.set(id, cb); if (timer === undefined) timer = window.setTimeout(flush, 250); return id; };
      window.cancelAnimationFrame = id => { callbacks.delete(id); };
      w.reviewFrames = []; let last = performance.now();
      const frame = (t: number) => { w.reviewFrames.push(t - last); last = t; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    });
  }
  // Capture the menu before bringing up the second 3D view.
  await pages[0].setViewport({ width: 800, height: 600 });
  await pages[0].goto(ui + '/?webgl2', { waitUntil: 'networkidle0' }); await sleep(2000);
  await pages[0].screenshot({ path: join(out, `${stage}-title.png`) });
  await pages[0].setViewport({ width: 720, height: 960 }); await sleep(1000);
  await pages[0].screenshot({ path: join(out, `${stage}-unfolded-title.png`) });
  await pages[0].setViewport({ width: 640, height: 480 });
  console.log('menus saved');
  const room = await (await fetch(relay + '/room', { method: 'POST' })).json() as { code: string };
  const url = `${ui}/?tag&webgl2&room=${room.code}&secs=60&relay=${relay}`;
  await Promise.all(pages.map(p => p.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 })));
  await Promise.all(pages.map(p => p.waitForSelector('[data-testid="online-ready"]', { timeout: 120000 })));
  await Promise.all(pages.map(p => p.waitForFunction("async () => Boolean((await import('/src/app/characters.ts')).assetsRef.current)", { timeout: 120000 })));
  const loaded = await Promise.all(pages.map(p => p.evaluate("import('/src/app/TagPage.tsx').then(m => m.loadRadbros(['652']))")));
  if (loaded.some(ok => !ok)) throw new Error('review character preload failed');
  await sleep(1500);
  await pages[0].screenshot({ path: join(out, `${stage}-lobby.png`) });
  console.log('lobby saved');
  // READY through the DualSense Options mapping, after both rosters load.
  for (let press = 0; press < 2; press++) for (const p of pages) { await p.evaluate(() => { (window as any).reviewPad.held = [9]; }); await sleep(650); await p.evaluate(() => { (window as any).reviewPad.held = []; }); await sleep(400); }
  await Promise.all(pages.map(p => p.waitForFunction(() => window.__tag?.screen === 'match', { timeout: 120000 })));
  console.log('match ready');
  for (let i = 0; i < pages.length; i++) { const c = await pages[i].createCDPSession(); const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(out, `${stage}-spawn-${i + 1}.png`), Buffer.from(shot.data, 'base64')); }
  await sleep(1500);
  const frames: { data: string; at: number }[][] = [[], []];
  const sessions = await Promise.all(pages.map(p => p.createCDPSession()));
  for (let i = 0; i < 2; i++) {
    sessions[i].on('Page.screencastFrame', e => { frames[i].push({ data: e.data, at: e.metadata.timestamp ?? 0 }); void sessions[i].send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {}); });
    await pages[i].evaluate(i => {
      const w = window as any; w.reviewPad = { axes: [i ? -.25 : .25, -.8, .08, -.1], held: [0, 7] };
      setTimeout(() => { w.reviewPad.held = [7]; }, 1500);
      setTimeout(() => { w.reviewPad.held = []; }, 5000);
    }, i);
    await sessions[i].send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 640, maxHeight: 480 });
  }
  console.log('recording'); await sleep(8000);
  for (const c of sessions) void c.send('Page.stopScreencast').catch(() => {});
  for (let i = 0; i < 2; i++) {
    const list = frames[i].filter(f => f.at - frames[i][0].at <= 8); if (!list.length) throw new Error('no captured frames');
    await writeFile(join(out, `${stage}-peer-${i + 1}.jpg`), Buffer.from(list.at(-1)!.data, 'base64'));
    await rm(join(out, `${stage}-peer-${i + 1}.png`), { force: true });
    const lines: string[] = [];
    for (let n = 0; n < list.length; n++) {
      const file = join(profile, `peer-${i}-${n}.jpg`); await writeFile(file, Buffer.from(list[n].data, 'base64'));
      lines.push(`file '${file}'`, `duration ${n + 1 < list.length ? Math.max(.033, list[n + 1].at - list[n].at) : Math.max(.033, 8 - (list[n].at - list[0].at))}`);
    }
    lines.push(`file '${join(profile, `peer-${i}-${list.length - 1}.jpg`)}'`);
    const concat = join(profile, `peer-${i}.txt`); await writeFile(concat, lines.join('\n'));
    execFileSync(process.env.FFMPEG ?? 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'fps=30', '-t', '8', '-an', '-c:v', 'libvpx-vp9', '-threads', '1', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', join(out, `${stage}-peer-${i + 1}.webm`)]);
  }
  const metrics = [];
  for (const p of pages) metrics.push(await p.evaluate(() => ({ room: window.__room, tag: window.__tag, frames: (window as any).reviewFrames.slice(-180) })).catch(e => ({ captureError: String(e) })));
  await writeFile(join(out, `${stage}-metrics.json`), JSON.stringify({ metrics, errors, renderThrottleMs: 250 }, null, 2));
  console.log('saved', stage, 'peer videos and pictures');
} finally {
  const pid = browser.process()?.pid;
  const kill = setTimeout(() => { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} } }, 5000);
  await browser.close().catch(() => {}); clearTimeout(kill); await rm(profile, { recursive: true, force: true });
}
