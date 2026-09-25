// ?sandbox (currently also the default page): free-roam swinging, no runner. HUD, pointer lock,
// pause overlay, R = restart; ?tune adds sliders; ?autoplay drives a scripted chain swing (screenshots).
import { lazy, Suspense, useEffect, useState } from "react";
import type { Sandbox } from "../game/sandbox.ts";
import { attachDom } from "../input/input.ts";
import { useUi } from "../ui/store.ts";
import { bootGame } from "./boot.ts";
import { GameScene } from "./GameScene.tsx";
import { autoplayScript } from "./autoplay.ts";

const TunePanel = import.meta.env.MODE !== "production" ? lazy(() => import("./dev/TunePanel.tsx")) : null;

const params = new URLSearchParams(location.search);
const AUTOPLAY = params.has("autoplay");
const TUNE = params.has("tune") && import.meta.env.MODE !== "production";

function canvasEl(): HTMLElement | null {
  return document.querySelector("canvas");
}

function Hud({ game }: { game: Sandbox }) {
  const hud = useUi(s => s.hud);
  const locked = useUi(s => s.locked);
  const ready = useUi(s => s.sceneReady);
  const backend = useUi(s => s.backend);
  const [hints, setHints] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setHints(false), 10000);
    return () => clearTimeout(t);
  }, []);
  const ringColor = hud.phase === "rope" ? "#3ddc84" : hud.ring >= 0 ? "#ffe14d" : "rgba(255,255,255,0.8)";
  const panel: React.CSSProperties = { position: "fixed", zIndex: 10, background: "rgba(12,16,28,0.62)", padding: "6px 9px", borderRadius: 6, pointerEvents: "none" };
  return (
    <>
      <div style={{ position: "fixed", left: "50%", top: "50%", width: 8, height: 8, marginLeft: -4, marginTop: -4, borderRadius: 4, background: ringColor, boxShadow: "0 0 0 1.5px rgba(0,0,0,0.5)", zIndex: 10, pointerEvents: "none" }} />
      <div style={{ ...panel, left: 8, top: 8 }}>
        <div><b>RADRUN</b> · sandbox {AUTOPLAY ? "· autoplay" : ""}</div>
        <div>{hud.speed.toFixed(1)} m/s · {hud.phase} · chain {hud.chain}</div>
        <div style={{ opacity: 0.8 }}>top {hud.topSpeed.toFixed(1)} m/s · best chain {hud.maxChain} · falls {hud.falls} · bonks {hud.bonks}</div>
        <div style={{ opacity: 0.6 }}>{backend || "…"} · {hud.fps.toFixed(0)} fps{ready ? "" : " · loading city…"}</div>
      </div>
      {hints && (
        <div style={{ ...panel, left: 8, bottom: 8, opacity: 0.85 }}>
          mouse look · WASD run · Space jump · LMB (hold) web onto the ringed balloon, release to let go · R restart · Esc pause
          {game.camera.easyGrab ? " · easy grab: hold Space to swing" : ""}
        </div>
      )}
      {!locked && !AUTOPLAY && !TUNE && (
        <div
          onClick={() => canvasEl()?.requestPointerLock()}
          style={{ position: "fixed", inset: 0, zIndex: 20, display: "grid", placeItems: "center", background: "rgba(8,10,20,0.35)", cursor: "pointer" }}
        >
          <div style={{ background: "rgba(12,16,28,0.85)", padding: "18px 26px", borderRadius: 10, textAlign: "center" }}>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 2 }}>RADRUN</div>
            <div style={{ marginTop: 6 }}>free-swing sandbox — click to play</div>
          </div>
        </div>
      )}
    </>
  );
}

export default function SandboxPage() {
  const [game, setGame] = useState<Sandbox | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    bootGame().then(setGame, e => setErr(String(e)));
  }, []);
  useEffect(() => {
    if (!game) return;
    if (AUTOPLAY) game.input.script = autoplayScript({ get body() { return game.body; }, rig: game.rig, model: game.model, stats: game.stats, spawnYaw: game.model.spawn.yaw });
    const el = canvasEl() ?? document.body;
    const detach = attachDom(game.input, el, locked => {
      useUi.setState({ locked });
      if (!AUTOPLAY && !TUNE) game.paused = !locked;
    });
    if (!AUTOPLAY && !TUNE) game.paused = true;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyR" && !e.repeat) game.restart();
    };
    addEventListener("keydown", onKey);
    return () => {
      detach();
      removeEventListener("keydown", onKey);
    };
  }, [game]);
  // In ?tune, clicking the canvas locks the pointer (the panel stays usable when unlocked).
  useEffect(() => {
    if (!game || !TUNE) return;
    const el = canvasEl();
    const click = () => el?.requestPointerLock();
    el?.addEventListener("click", click);
    return () => el?.removeEventListener("click", click);
  }, [game]);
  if (err) return <div style={{ padding: 20 }}>Failed to load: {err}</div>;
  if (!game) return <div style={{ padding: 20 }}>loading…</div>;
  return (
    <>
      <GameScene game={game} />
      <Hud game={game} />
      {TunePanel && TUNE && (
        <Suspense fallback={null}>
          <TunePanel game={game} />
        </Suspense>
      )}
    </>
  );
}
