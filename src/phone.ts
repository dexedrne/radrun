type Bridge = { device: { phone: boolean; touch: boolean; pad: boolean }; getGamepads(): (Gamepad | null)[] };
export const bridge = (): Bridge | undefined => (globalThis as typeof globalThis & { VyvansePad?: Bridge }).VyvansePad;
export const isPhone = (): boolean => bridge()?.device.phone ?? (typeof location !== 'undefined' && new URLSearchParams(location.search).get('device') === 'phone');
export const getPads = (): (Gamepad | null)[] => {
  try { return Array.from(bridge()?.getGamepads() ?? navigator.getGamepads?.() ?? []); } catch { return []; }
};
