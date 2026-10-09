import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA } from "../src/sim/tuning.ts";
import { loadSettings, saveSettings, loadQuality } from '../src/ui/prefs.ts';
import { canvasDpr, detectTouch } from '../src/input/touch.ts';

test('phone contract wins over saved HIGH and touch=0, even with no hardware hints', () => {
  const page = globalThis as typeof globalThis & { VyvansePad?: { device: { phone: boolean } } };
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let saved = JSON.stringify({ settings: { quality: 'high' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => saved, setItem: (_: string, v: string) => { saved = v; } } });
  page.VyvansePad = { device: { phone: true } };
  try {
    assert.equal(loadQuality(), 'low');
    const settings = loadSettings({ ...CAMERA });
    assert.equal(settings.quality, 'low');
    saveSettings({ ...settings, muted: true });
    assert.equal(JSON.parse(saved).settings.quality, 'high');
    assert.equal(detectTouch('?touch=0'), true);
    assert.deepEqual(canvasDpr(false), [1, 1.25]);
  } finally {
    delete page.VyvansePad;
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
  assert.equal(loadQuality(), 'high');
  assert.equal(detectTouch('?touch=0'), false);
  assert.deepEqual(canvasDpr(false), [1, 1.5]);
});
