// iPhone browser tabs have no page fullscreen API; Add to Home Screen launches without browser UI.
// Nothing here renders or changes anything outside an iPhone browser tab.
import { useState } from "react";
import { iphoneTab } from "../input/touch.ts";
import { btn } from "./screens.tsx";

const TIP_KEY = "rr.tip.homeScreen";

const read = (s: () => Storage, k: string) => { try { return s().getItem(k); } catch { return null; } };
const write = (s: () => Storage, k: string) => { try { s().setItem(k, "1"); } catch { /* private mode: fine */ } };

/** Title: a one-time tip (iPhone browser tab only) that Add to Home Screen plays full screen. */
export function HomeScreenTip() {
  const [gone, setGone] = useState(() => read(() => localStorage, TIP_KEY) === "1");
  if (gone || !iphoneTab()) return null;
  const close = () => { write(() => localStorage, TIP_KEY); setGone(true); };
  return (
    <div data-testid="homescreen-tip" style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 6, background: "rgba(14,16,30,0.78)", border: "1px solid rgba(159,230,255,0.6)", borderRadius: 8, padding: "3px 4px 3px 10px", fontSize: 11 }}>
      <span><b style={{ color: "#9fe6ff" }}>fullscreen:</b> Share → Add to Home Screen</span>
      <button onClick={close} aria-label="hide this tip" data-testid="homescreen-tip-close"
        style={{ ...btn(false), minWidth: 44, minHeight: 44, padding: "1px 8px", fontSize: 12, lineHeight: 1.4, touchAction: "manipulation" }}>✕</button>
    </div>
  );
}
