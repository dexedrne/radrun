// Touch-device detection, the phone quality default and fullscreen (spec §4 "Touch").
// `?touch` / `?touch=1` forces touch controls on, `?touch=0` off; otherwise a coarse primary pointer
// (phones, tablets) turns them on, and PlayPage also switches them on at the first touch.
import { isPhone } from "../phone.ts";
import { isFramed } from "../radbro/bridge.ts";

export function detectTouch(search: string = location.search): boolean {
  if (isPhone() || new URLSearchParams(search).get("device") === "phone") return true;
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

/** Canvas DPR: 1.5 on recent iPhones, 1.25 on other small phones and 1.5 elsewhere. */
export function canvasDpr(touch: boolean): [number, number] {
  return [1, isFastIPhone() ? 1.5 : isPhone() || (touch && smallScreen()) ? 1.25 : 1.5];
}

/** iPhone / iPod: no element fullscreen API in any browser there (all of them are WebKit). */
export function isIPhone(): boolean {
  try {
    return /iPhone|iPod/.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/** Recent iPhones expose at least six CPU cores and a 3x panel; older or unknown phones stay on Low. */
export function isFastIPhone(): boolean {
  try { return isIPhone() && navigator.hardwareConcurrency >= 6 && devicePixelRatio >= 3; } catch { return false; }
}

/** Launched from the Home Screen (manifest display mode, or iOS's navigator.standalone): no browser UI. */
export function isStandalone(): boolean {
  try {
    return matchMedia("(display-mode: fullscreen), (display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/**
 * An iPhone browser tab: the only ways to full screen are a swipe (toolbars minimise) or Add to Home Screen.
 * Not when framed (radbro.fun): the portal owns the page, so no swipe overlay, scroll room or home-screen tip.
 */
export const iphoneTab = (): boolean => isIPhone() && !isStandalone() && !isFramed();

/** Fullscreen where the browser allows it; iPhone Safari has no page fullscreen API. */
export function enterFullscreen(): void {
  try {
    if (document.fullscreenElement) return;
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    const req = el.requestFullscreen ? el.requestFullscreen({ navigationUI: "hide" }) : el.webkitRequestFullscreen?.();
    if (req && typeof (req as Promise<void>).catch === "function") void (req as Promise<void>).catch(() => undefined);
  } catch {
    /* no fullscreen API: fine */
  }
}
