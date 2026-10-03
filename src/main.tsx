import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import PlayPage from "./app/PlayPage.tsx";
import { startBridge } from "./radbro/bridge.ts";
import { unlockAudio } from "./audio/engine.ts";
import { startPads } from "./input/padRuntime.ts";
import { PadRoot } from "./ui/pad.tsx";
import { startVyvanseHook } from "./ui/vyvanse.ts";
import { carryOldSaves } from "./ui/carry.ts";

window.addEventListener("error", e => console.error("[window.error]", e.message));
window.addEventListener("unhandledrejection", e => console.error("[unhandledrejection]", String(e.reason)));

// At spidertag.vyvanse.beer, once per browser: bring the saves over from the old address (ui/carry.ts).
carryOldSaves();
// Framed on radbro.fun: tell the portal what this is; the first click focuses the frame + unlocks the audio.
startBridge({ onFirstGesture: unlockAudio });
// Framed on vyvanse.beer: the pause menu and the title offer the way back to its menu (dev builds: a localhost parent too).
startVyvanseHook(import.meta.env.MODE !== "production");
// Gamepads (round 14): polled every frame, hot-plug, the last device used decides the prompts.
startPads();

const DEV = import.meta.env.MODE !== "production";
const EditorPage = DEV ? lazy(() => import("./app/dev/EditorPage.tsx")) : null;
const RouteView = DEV ? lazy(() => import("./app/dev/RouteView.tsx")) : null;
const SandboxPage = DEV ? lazy(() => import("./app/SandboxPage.tsx")) : null;
const PortraitPage = DEV ? lazy(() => import("./app/dev/PortraitPage.tsx")) : null;
const HatsPage = DEV ? lazy(() => import("./app/dev/HatsPage.tsx")) : null;
const BenchPage = DEV ? lazy(() => import("./app/dev/BenchPage.tsx")) : null;
const params = new URLSearchParams(location.search);
// SPIDER-TAG (?tag): its own lazy chunk, so the single-player page load does not grow.
const TagPage = lazy(() => import("./app/TagPage.tsx"));
// The unlisted wager beta (?wager, docs/WAGER.md §7): its own lazy chunk (viem and the wallet code live only there).
const WagerPage = lazy(() => import("./wager/WagerPage.tsx"));

// No StrictMode: the game lives outside React and the canvas is mounted exactly once.
function App() {
  const fallback = <div style={{ padding: 20 }}>loading…</div>;
  if (EditorPage && params.has("editor")) return <Suspense fallback={fallback}><EditorPage /></Suspense>;
  if (RouteView && params.has("routeview")) return <Suspense fallback={fallback}><RouteView /></Suspense>;
  if (PortraitPage && params.has("portrait")) return <Suspense fallback={fallback}><PortraitPage /></Suspense>;
  if (HatsPage && params.has("hats")) return <Suspense fallback={fallback}><HatsPage /></Suspense>;
  if (BenchPage && params.has("bench")) return <Suspense fallback={fallback}><BenchPage /></Suspense>;
  if (SandboxPage && (params.has("sandbox") || params.has("autoplay"))) return <Suspense fallback={fallback}><SandboxPage /></Suspense>;
  if (params.has("wager") || params.has("verify")) return <Suspense fallback={fallback}><WagerPage /></Suspense>;
  if (params.has("tag") || params.has("room")) return <Suspense fallback={fallback}><TagPage /></Suspense>;
  return <PlayPage />;
}

createRoot(document.getElementById("root")!).render(<><App /><PadRoot /></>);
