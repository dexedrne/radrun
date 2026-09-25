// iPhone browser tabs (spec §4 "Touch"). iOS has no element fullscreen API, and in landscape Safari's
// toolbars take ~50 px of a ~390 px screen. Two ways out:
// - Safari minimises its toolbars when the page scrolls. The game is a fixed layer (#root), so the page
//   gets a little scroll room behind it (html.rr-scroll in index.html) and, while the toolbars show in
//   landscape outside a running round, an overlay asks for one swipe up. The overlay is not a scroller,
//   so the swipe scrolls the page. Rounds are unaffected: the touch controls are touch-action: none.
// - Add to Home Screen launches with no browser UI at all (manifest.webmanifest); a one-time tip on the
//   title says so.
// Nothing here renders or changes anything outside an iPhone browser tab.
import { useEffect, useState } from "react";
import { iphoneTab } from "../input/touch.ts";
import { btn, panel, useViewport } from "./screens.tsx";

const TIP_KEY = "rr.tip.homeScreen";
const SWIPE_KEY = "rr.swipeLater";

const read = (s: () => Storage, k: string) => { try { return s().getItem(k); } catch { return null; } };
const write = (s: () => Storage, k: string) => { try { s().setItem(k, "1"); } catch { /* private mode: fine */ } };

/** Once per page: scroll room behind the fixed game layer (a no-op outside an iPhone browser tab). */
export function useIphoneScrollRoom(): void {
  useEffect(() => {
    if (iphoneTab()) document.documentElement.classList.add("rr-scroll");
  }, []);
}

/** Landscape with the toolbars showing: the visible height is well short of the screen's short side. */
function barsShowing(w: number, h: number): boolean {
  const short = Math.min(screen.width, screen.height);
  return w > h && short - h > 30;
}

/** "Swipe up for fullscreen" while Safari's toolbars show in landscape (`show`: not mid-round). */
export function SwipeUp({ show }: { show: boolean }) {
  const { w, h } = useViewport();
  const [later, setLater] = useState(() => read(() => sessionStorage, SWIPE_KEY) === "1");
  if (!show || later || !iphoneTab() || !barsShowing(w, h)) return null;
  const notNow = () => { write(() => sessionStorage, SWIPE_KEY); setLater(true); };
  return (
    <div data-testid="swipe-up" style={{ position: "fixed", inset: 0, zIndex: 45, display: "grid", placeItems: "center", background: "rgba(8,10,22,0.6)", touchAction: "pan-y" }}>
      <div style={{ ...panel, textAlign: "center", maxWidth: "min(440px, 80vw)", padding: "12px 18px" }}>
        <div style={{ font: "900 34px/1 ui-monospace, monospace", color: "#ffd23f", animation: "rr-swipe 1.1s ease-in-out infinite" }}>↑</div>
        <div style={{ font: "800 16px ui-monospace, monospace", letterSpacing: 1, marginTop: 6 }}>swipe up for fullscreen</div>
        <div style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>no browser bars at all: Share → Add to Home Screen</div>
        <button onClick={notNow} data-testid="swipe-later" style={{ ...btn(false), marginTop: 10, padding: "5px 14px", fontSize: 12, touchAction: "manipulation" }}>not now</button>
      </div>
    </div>
  );
}

/** Title: a one-time tip (iPhone browser tab only) that Add to Home Screen plays full screen. */
export function HomeScreenTip() {
  const [gone, setGone] = useState(() => read(() => localStorage, TIP_KEY) === "1");
  if (gone || !iphoneTab()) return null;
  const close = () => { write(() => localStorage, TIP_KEY); setGone(true); };
  return (
    <div data-testid="homescreen-tip" style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 6, background: "rgba(14,16,30,0.78)", border: "1px solid rgba(159,230,255,0.6)", borderRadius: 8, padding: "3px 4px 3px 10px", fontSize: 11 }}>
      <span><b style={{ color: "#9fe6ff" }}>fullscreen:</b> Share → Add to Home Screen</span>
      <button onClick={close} aria-label="hide this tip" data-testid="homescreen-tip-close"
        style={{ ...btn(false), padding: "1px 8px", fontSize: 12, lineHeight: 1.4, touchAction: "manipulation" }}>✕</button>
    </div>
  );
}
