// Verify that a ready player reconnects into a fresh, unready lobby.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const cache = join(homedir(), '.cache/r3g-smoke/tmp'); await mkdir(cache, { recursive: true });
const profile = await mkdtemp(join(cache, 'st-rejoin-'));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: profile, args: ['--no-sandbox', '--mute-audio', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let peer: WebSocket | undefined;
try {
  const page = await browser.newPage(); await page.setViewport({ width: 720, height: 960 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('rugrun.v1', JSON.stringify({ visited: true, settings: { quality: 'low', qualityChosen: true, muted: true } }));
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) { if (typeof data === 'string') { const m = JSON.parse(data); if (m.t === 'hello') { (window as any).reviewHello = m; (window as any).reviewSocket = this; } } send.call(this, data); };
  });
  const r = await fetch('http://127.0.0.1:6009/room', { method: 'POST' }), room = await r.json() as { code: string };
  await page.goto(`http://127.0.0.1:6010/?tag&webgl2&room=${room.code}&relay=http://127.0.0.1:6009`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.reviewHello');
  const hello = await page.evaluate(() => (window as any).reviewHello);
  peer = new WebSocket('ws://127.0.0.1:6009/ws?room=' + room.code);
  await new Promise<void>((resolve, reject) => { peer!.onopen = () => resolve(); peer!.onerror = () => reject(new Error('peer failed')); });
  peer.send(JSON.stringify({ ...hello, name: 'review-player' }));
  await page.waitForFunction(() => { const b = document.querySelector('[data-testid="online-ready"]') as HTMLButtonElement | null; return b && !b.disabled && b.textContent === 'READY'; });
  await page.click('[data-testid="online-ready"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="online-ready"]')?.textContent === 'NOT READY');
  await page.evaluate(() => (window as any).reviewSocket.close(1000, 'review reconnect'));
  await page.waitForSelector('[data-testid="online-rejoin"]'); await page.click('[data-testid="online-rejoin"]');
  await page.waitForFunction(() => { const b = document.querySelector('[data-testid="online-ready"]') as HTMLButtonElement | null; return b && !b.disabled && b.textContent === 'READY'; });
  assert.equal(await page.evaluate(() => window.__room?.players), 2);
  await page.screenshot({ path: join(homedir(), 'Documents/spidertag/review/st-polish/after-rejoin.png') });
  console.log('PASS: ready → socket close → REJOIN ROOM → fresh unready lobby, two peers, unfolded viewport');
} finally { peer?.close(); await browser.close(); await rm(profile, { recursive: true, force: true }); }
