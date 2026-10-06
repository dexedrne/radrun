// Fixed views, lighting and texture budgets. Uses the same browser driver as tools/shot.ts.
// RUGRUN_CHROME_PROFILE=<throwaway-dir> npm run pbr-shots -- <url> <output-dir> before|after
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [base = 'http://127.0.0.1:5270/', output, stage] = process.argv.slice(2);
const profile = process.env.RUGRUN_CHROME_PROFILE;
if (!profile || !output || !['before', 'after'].includes(stage)) throw new Error('Supply a throwaway RUGRUN_CHROME_PROFILE, URL, output directory and before|after');
const dest = path.resolve(output, stage);
fs.mkdirSync(dest, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium', headless: true, userDataDir: profile,
  args: [`--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1280, height: 720 },
});
console.log(`browser PID ${browser.process()?.pid}`);
const report = path.join(dest, 'renderer.json');
const previous = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')).records : [];
const records: Array<Record<string, unknown>> = previous, errors: string[] = [];
const flag = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
try {
  const page = await browser.newPage();
  page.on('pageerror', e => { errors.push(String(e)); console.error(String(e)); });
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.error(m.text().slice(0,300)); } });
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  const frames = (n: number) => page.evaluate(n => new Promise<void>(resolve => {
    let k = 0; const next = () => { if (++k >= n) resolve(); else requestAnimationFrame(next); }; requestAnimationFrame(next);
  }), n);
  for (const backend of flag('backends', 'webgpu,webgl2').split(',')) for (const quality of flag('qualities', 'high,low,mobile').split(',')) {
    if (backend === 'webgl2' && quality === 'mobile') continue;
    const settings = await page.evaluateOnNewDocument(quality => {
      localStorage.setItem('rugrun.v1', JSON.stringify({ settings: { quality: quality === 'low' ? 'low' : 'high', qualityChosen: true, muted: true } }));
    }, quality);
    await page.setViewport({ width: 1280, height: 720, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
    const url = new URL(base);
    url.search = `?autoq=0&milady=0${quality === 'mobile' ? '&touch=1' : '&touch=0'}${backend === 'webgl2' ? '&webgl2' : ''}`;
    await page.goto(url.href, { waitUntil: 'load', timeout: 120000 });
    console.log(`loaded ${backend} ${quality}`);
    await page.waitForFunction(() => !!document.querySelector('canvas'), { timeout: 120000 });
    await page.waitForFunction(async () => {
      const fiberUrl = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/@react-three_fiber.js'));
      if (!fiberUrl) return false;
      const fiber = await import(fiberUrl);
      const root = fiber._roots.get(document.querySelector('canvas'));
      if (!root?.store.getState().gl) return false;
      Object.assign(window, { __pbrStore: root.store });
      return true;
    }, { timeout: 120000 });
    await page.evaluate(async () => {
      const state = (window as any).__pbrStore.getState();
      const { bootPlay } = await import('/src/app/boot.ts' as string);
      const { useUi } = await import('/src/ui/store.ts' as string);
      const game = await bootPlay();
      game.paused = true;
      game.mode = 'round';
      useUi.setState({ screen: 'practice', paused: false, sceneReady: true });
      state.setFrameloop('always');
      Object.assign(window, { __pbrGame: game });
    });
    console.log(`renderer ready ${backend} ${quality}`);
    await frames(40);
    await page.waitForFunction(() => {
      const s = (window as any).__pbrStore.getState();
      let n = 0; s.scene.traverse((o: any) => { if (o.material?.map?.image) n++; });
      return n > 10;
    }, { timeout: 120000 });
    for (const lighting of quality === 'high' && flag('budget', '0') !== '1' ? ['day', 'night'] : ['day']) {
      await page.evaluate(lighting => { const g = (window as any).__pbrGame; g.setup.mutators = lighting === 'night' ? 64 : 0; }, lighting);
      // A dense, long street with nearby facade tiles, plus the busy skyline/rooftops.
      for (const view of quality === 'high' && flag('budget', '0') !== '1' ? ['canyon', 'rooftops'] : ['rooftops']) {
        await page.evaluate(view => {
          const g = (window as any).__pbrGame;
          const eye = view === 'canyon' ? { x: 33, y: 22, z: 45 } : { x: 110, y: 85, z: 155 };
          const at = view === 'canyon' ? { x: 65, y: 33, z: 100 } : { x: 175, y: 40, z: 95 };
          g.scriptedCamera = (e: any, a: any) => { Object.assign(e, eye); Object.assign(a, at); return true; };
        }, view);
        await frames(30);
        // Wait for generated maps if present; no frame-time comparisons on this busy host.
        if (stage === 'after') await page.waitForFunction(async () => {
          try { const m = await import('/src/app/pbr.ts' as string); return m.pbrLoads() === 0; } catch { return true; }
        }, { timeout: 120000 });
        await frames(12);
        const stats = await page.evaluate(() => {
          const { gl, scene, camera } = (window as any).__pbrStore.getState();
          const materials = new Set<any>();
          scene.traverse((o: any) => { const mm = o.material; if (mm) for (const m of Array.isArray(mm) ? mm : [mm]) materials.add(m); });
          const maps = [...materials].filter(m => m.map?.image?.src?.includes('/textures/') && m.isMeshStandardNodeMaterial);
          const tex = new Set<any>();
          for (const m of materials) for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) if (m[key]) tex.add(m[key]);
          let materialTextureBytes = 0, loadedTextureCorrection = 0;
          for (const t of tex) {
            const image = t.image; if (!image) continue;
            // r186 records bytes at first binding, possibly while TextureLoader has a 1x1
            // placeholder. Correct only already-uploaded material textures, using Info's own
            // format/mipmap accounting. Keep the raw counter for audit alongside the correction.
            const tracked = gl.info.memoryMap.get(t);
            if (typeof tracked === 'number' && image.complete !== false) loadedTextureCorrection += gl.info._getTextureMemorySize(t) - tracked;
            let w = image.width, h = image.height;
            do { materialTextureBytes += w * h * 4; if (!t.generateMipmaps || w === 1 && h === 1) break; w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2)); } while (true);
          }
          return { correctedTextureBytes: gl.info.memory.texturesSize + loadedTextureCorrection, loadedTextureCorrection, backend: gl.backend.constructor.name, textureBytes: gl.info.memory.texturesSize, textures: gl.info.memory.textures,
            materialTextureBytes, draws: gl.info.render.drawCalls, triangles: gl.info.render.triangles,
            levelMaterials: maps.length, normalMaterials: maps.filter(m => m.normalMap).length,
            roughnessMaterials: maps.filter(m => m.roughnessMap).length, camera: camera.getWorldPosition(camera.position.clone()).toArray(),
            pbrRequests: performance.getEntriesByType('resource').map(e => new URL(e.name).pathname).filter(u => /\/pbr\/.*\.png$/.test(u)) };
        });
        const file = `${backend}-${quality}-${lighting}-${view}.png`;
        // Clip to the canvas area; the camera and simulation remain fixed.
        await (await page.$('canvas'))!.screenshot({ path: path.join(dest, file) });
        const prior = records.findIndex(r => r.file === file);
        if (prior >= 0) records.splice(prior, 1);
        records.push({ quality, lighting, view, file, ...stats });
        fs.writeFileSync(path.join(dest, 'renderer.json'), JSON.stringify({ stage, viewport: [1280, 720], records, errors }, null, 2) + '\n');
        console.log(`${file}: ${(stats.correctedTextureBytes / 2 ** 20).toFixed(2)} MiB (loaded sizes), ${stats.draws} draws, ${stats.normalMaterials} normal materials`);
      }
    }
    if (stage === 'after' && quality === 'high' && flag('switch', '0') === '1') {
      const memory = () => page.evaluate(() => {
        const { gl, scene } = (window as any).__pbrStore.getState();
        const materials = new Set<any>();
        scene.traverse((o: any) => { for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) materials.add(m); });
        return { textureBytes: gl.info.memory.texturesSize, textures: gl.info.memory.textures, draws: gl.info.render.drawCalls,
          normalMaterials: [...materials].filter(m => m.normalMap?.image?.src?.includes('/textures/pbr/')).length };
      });
      const high = await memory();
      await page.evaluate(async () => {
        const { useUi } = await import('/src/ui/store.ts' as string);
        useUi.setState({ quality: 'low' });
      });
      await frames(30);
      await page.waitForFunction(async () => (await import('/src/app/pbr.ts' as string)).pbrLoads() === 0);
      await frames(20);
      const low = await memory();
      fs.writeFileSync(path.join(dest, `${backend}-switch.json`), JSON.stringify({ high, low, releasedBytes: high.textureBytes - low.textureBytes }, null, 2) + '\n');
      if (low.normalMaterials !== 0 || low.textureBytes >= high.textureBytes) throw new Error('High to Low did not release normal allocations');
      console.log(`${backend} High -> Low: released ${((high.textureBytes-low.textureBytes)/2**20).toFixed(2)} MiB`);
    }
    await page.removeScriptToEvaluateOnNewDocument(settings.identifier);
  }
} finally { await browser.close(); }
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
