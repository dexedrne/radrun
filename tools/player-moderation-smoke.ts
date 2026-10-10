import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { NET_VERSION, type Compat, type ServerMsg } from '../src/net/wire.ts';

const base = process.env.SPIDER_MOD_SERVER ?? 'http://127.0.0.1:6009', ui = process.env.SPIDER_MOD_UI;
const temp = process.env.TMPDIR ?? join(homedir(), '.cache/r3g-smoke/tmp');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>) {
  const end = Date.now() + 60_000;
  while (!await f()) { assert.ok(Date.now() < end, 'moderation smoke timed out'); await pause(20); }
}
async function room() {
  const r = await fetch(base + '/room', { method: 'POST', headers: { Origin: ui ?? 'http://127.0.0.1:6010' } });
  assert.equal(r.status, 200); return (await r.json() as { code: string }).code;
}
async function peer(code: string, name: string, compat: Compat) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws?room=' + code), got: ServerMsg[] = [];
  ws.addEventListener('message', event => { if (typeof event.data === 'string') got.push(JSON.parse(event.data)); });
  await until(() => ws.readyState === WebSocket.OPEN);
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  send({ t: 'hello', name, radbro: '652', touch: false, easy: false, district: 'downtown', compat });
  await until(() => got.some(m => m.t === 'welcome'));
  return { ws, got, send, welcome: got.find(m => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }> };
}
const code = await room(), compat = { v: NET_VERSION, build: 'moderation-smoke', link: 6, city: 'c', tuning: 't' };
const a = await peer(code, 'n1gg3r', compat), b = await peer(code, 'fuckyeah', compat);
try {
  assert.match(a.welcome.players.find(p => p.slot === a.welcome.slot)!.name, /^Player-/);
  await until(() => a.got.some(m => m.t === 'error' && m.code === 'name-replaced'));
  assert.equal(b.welcome.players.find(p => p.slot === b.welcome.slot)!.name, 'fuckyeah');
  a.send({ t: 'chat', text: 'n1gg3r' }); await until(() => a.got.some(m => m.t === 'error' && m.message === 'not sent'));
  assert.equal(JSON.stringify(b.got).includes('n1gg3r'), false);
  b.send({ t: 'report', slot: a.welcome.slot }); await until(() => b.got.some(m => m.t === 'error' && m.code === 'report-received'));
  console.log('Worker two-peer check: neutral name/private notice, profanity retained, unsupported chat private, report acknowledged');
} finally { a.ws.close(); b.ws.close(); }

if (ui) {
  await mkdir(temp, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true,
    userDataDir: join(temp, 'jevmod-spider-chrome'), timeout: 180_000, protocolTimeout: 180_000,
    args: ['--no-sandbox', '--mute-audio', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  let other: Awaited<ReturnType<typeof peer>> | undefined;
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', error => console.log('Browser error:', String(error)));
    await page.evaluateOnNewDocument(() => {
      const w = window as any, callbacks = new Map<number, FrameRequestCallback>(); let next = 0, timer: number | undefined;
      localStorage.setItem('rugrun.settings', JSON.stringify({ quality: 'low', qualityChosen: true, music: 0, sfx: 0, voice: 0, muted: true }));
      const flush = () => { timer = undefined; const batch = [...callbacks.values()]; callbacks.clear(); for (const cb of batch) cb(performance.now()); if (w.modPress) w.modPress.frames--; if (callbacks.size && timer === undefined) timer = window.setTimeout(flush, 20); };
      window.requestAnimationFrame = cb => { const id = ++next; callbacks.set(id, cb); if (timer === undefined) timer = window.setTimeout(flush, 20); return id; };
      window.cancelAnimationFrame = id => { callbacks.delete(id); };
      const pad = { id: 'Xbox Controller', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 })) };
      Object.defineProperty(navigator, 'getGamepads', { value: () => { const q = w.modPress; return [q && q.frames > 0 ? { ...pad, buttons: pad.buttons.map((b, i) => ({ ...b, pressed: q.buttons.includes(i), value: q.buttons.includes(i) ? 1 : 0 })) } : pad]; } });
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) { if (typeof data === 'string') { const m = JSON.parse(data); if (m.t === 'hello') w.modHello = m; } send.call(this, data); };
    });
    const press = async (button: number) => page.evaluate(async button => {
      const w = window as any, frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      w.modPress = { buttons: [button], frames: 1 }; await frame(); await frame(); w.modPress = null;
    }, button);
    const code = await room();
    await page.goto(ui + '/?tag&webgl2&room=' + code + '&relay=' + encodeURIComponent(base), { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForSelector('[data-testid="online-room"]', { timeout: 60_000 });
    other = await peer(code, 'n1gg3r', await page.evaluate(() => (window as any).modHello.compat));
    await press(13);
    for (let n = 0; n < 25; n++) {
      if (await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'online-player-list')) break;
      const button = await page.evaluate(() => {
        const target = document.querySelector('[data-testid="online-player-list"]')!.getBoundingClientRect(), current = document.activeElement!.getBoundingClientRect();
        const dx = target.x + target.width / 2 - current.x - current.width / 2, dy = target.y + target.height / 2 - current.y - current.height / 2;
        return Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 15 : 14 : dy > 0 ? 13 : 12;
      });
      await press(button);
    }
    console.log('Pad navigation snapshot:', await page.evaluate(() => ({ focus: document.activeElement?.textContent, pad: document.querySelector('[data-testid="pad-legend"]')?.textContent, rows: [...document.querySelectorAll('[data-pad-focus]')].map(e => e.textContent), buttons: [...document.querySelectorAll('[data-testid="online"] button')].map(e => e.textContent), presses: (window as any).modPress })));
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'online-player-list');
    await press(0); await page.waitForSelector('[data-player-list]');
    await press(0); await page.waitForSelector('[data-player-row] button[aria-pressed="true"]');
    await press(2); await page.waitForFunction(() => document.querySelector('[data-player-list]')?.textContent?.includes('Report received.'), { polling: 100 });
    await page.screenshot({ path: join(temp, 'jevmod-spider-player-list.png') });
    await press(1); await page.waitForFunction(() => !document.querySelector('[data-player-list]'), { polling: 100 });
    assert.ok(await page.$('[data-testid="online-room"]'));
    console.log('Controller UI: A mute, X report, B back; one muted screenshot');
  } finally { other?.ws.close(); await browser.close(); }
}
