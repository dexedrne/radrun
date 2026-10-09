// Include BEFORE the game's input code. Copy this file into the game's own build.
// A preview may explicitly set data-launcher-origin; production trusts only vyvanse.beer.
(() => {
  const origin = document.currentScript?.dataset.launcherOrigin || 'https://vyvanse.beer';
  const native = navigator.getGamepads?.bind(navigator);
  const local = () => { try { return Array.from(native?.() || []); } catch { return []; } };
  let relayed = [];
  let received = -Infinity;
  let announced = new Map();
  const device = { phone: new URLSearchParams(window.location.search).get('device') === 'phone',
    touch: navigator.maxTouchPoints > 0, pad: local().some(p => p?.connected) };
  function notify(type, pad) {
    const event = new Event(type);
    Object.defineProperty(event, 'gamepad', { value: pad });
    window.dispatchEvent(event);
  }
  function connections(pads, nativePads) {
    const next = new Map(pads.filter(p => p && !nativePads[p.index]?.connected).map(p => [p.index, p]));
    const previous = announced;
    announced = next;
    for (const [i, p] of previous) if (!next.has(i) && !nativePads[i]?.connected) notify('gamepaddisconnected', { ...p, connected: false });
    for (const [i, p] of next) if (!previous.has(i)) notify('gamepadconnected', p);
  }
  function getGamepads() {
    const pads = local();
    if (performance.now() - received > 500 || document.hidden) relayed = [];
    connections(relayed, pads);
    for (const p of relayed) if (!pads[p.index]?.connected) pads[p.index] = p;
    return Array.from({ length: pads.length }, (_, i) => pads[i] || null);
  }
  const finite = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
  function valid(p) {
    return p && Number.isInteger(p.index) && finite(p.index, 0, 15) && p.connected === true &&
      typeof p.id === 'string' && p.id.length <= 256 && ['', 'standard'].includes(p.mapping) && Number.isFinite(p.timestamp) &&
      Array.isArray(p.axes) && p.axes.length <= 16 && p.axes.every(n => finite(n, -1, 1)) &&
      Array.isArray(p.buttons) && p.buttons.length <= 32 && p.buttons.every(b =>
        Array.isArray(b) && b.length === 2 && finite(b[0], 0, 1) && Number.isInteger(b[1]) && finite(b[1], 0, 3));
  }
  window.addEventListener('message', e => {
    if (e.source !== window.parent || e.origin !== origin) return;
    const d = e.data;
    if (d?.type === 'vyvanse:device' && ['phone', 'touch', 'pad'].every(k => typeof d[k] === 'boolean')) {
      Object.assign(device, { phone: d.phone, touch: d.touch, pad: d.pad });
      window.dispatchEvent(new CustomEvent('vyvanse:device', { detail: { ...device } }));
    } else if (d?.type === 'vyvanse:pads') {
      if (d.v === 1 && Array.isArray(d.pads) && d.pads.length <= 16 && d.pads.every(valid)) {
        received = performance.now();
        relayed = d.pads.map(p => ({ ...p, axes: [...p.axes], buttons: p.buttons.map(b =>
          ({ value: b[0], pressed: !!(b[1] & 1), touched: !!(b[1] & 2) })), vibrationActuator: null }));
      } else relayed = []; // a bad trusted snapshot must not preserve held buttons
      getGamepads();
    }
  });
  window.VyvansePad = { getGamepads, device };
  // Engines already polling navigator.getGamepads can keep doing so. Native pads win per slot.
  try { Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: getGamepads }); } catch { /* use VyvansePad.getGamepads */ }
  if (window.parent !== window) window.parent.postMessage({ type: 'vyvanse:ready' }, origin);
})();
