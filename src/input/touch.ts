// Touch-device detection, the phone quality default and fullscreen (spec §4 "Touch").
// `?touch` / `?touch=1` forces touch controls on, `?touch=0` off; otherwise a coarse primary pointer
// (phones, tablets) turns them on, and PlayPage also switches them on at the first touch.

export function detectTouch(search: string = location.search): boolean {
  const q = new URLSearchParams(search).get("touch");
  if (q !== null) return q !== "0";
  try {
    return matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** A phone-sized screen (shorter side <= 480 CSS px). */
export function smallScreen(): boolean {
  try {
    return Math.min(screen.width, screen.height) <= 480;
  } catch {
    return false;
  }
}

/** Canvas dpr range: touch devices cap at 1.5 (1.25 on phones); desktop keeps r3g's [1, 1.5]. */
export function canvasDpr(touch: boolean): [number, number] {
  return [1, touch && smallScreen() ? 1.25 : 1.5];
}

/** Fullscreen + landscape lock where the browser allows it (Android Chrome); silently ignored elsewhere. */
export function enterFullscreen(): void {
  try {
    if (document.fullscreenElement) return;
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    const req = el.requestFullscreen ? el.requestFullscreen({ navigationUI: "hide" }) : (el.webkitRequestFullscreen?.(), undefined);
    const orient = (screen as Screen & { orientation?: { lock?: (o: string) => Promise<void> } }).orientation;
    Promise.resolve(req)
      .then(() => orient?.lock?.("landscape"))
      .catch(() => {});
  } catch {
    /* no fullscreen API: fine */
  }
}
