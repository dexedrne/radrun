// The game page: TITLE -> LOADING -> COUNTDOWN -> CHASE -> RESULTS over one canvas that is mounted
// once, plus TITLE -> PRACTICE (free swinging with your Radbro and George, no runner; pause -> Back
// to title). Restart / Retry create a fresh Round outside React (nothing remounts). ?bot=... runs the
// test bot (dev/test builds), ?tune adds sliders.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlayGame } from "../game/play.ts";
import { randomSeed } from "../game/play.ts";
import type { RadbroId } from "../game/round.ts";
import type { Difficulty } from "../sim/tuning.ts";
import { attachDom } from "../input/input.ts";
import { useUi } from "../ui/store.ts";
import { applySettings, lastPicks, loadSettings, pickRunner, readChallenge, rememberPicks, saveSettings, type Settings } from "../ui/prefs.ts";
import { Loading, Pause, ResultsScreen, RoundHud, Title } from "../ui/screens.tsx";
import { TouchControls } from "../ui/TouchControls.tsx";
import { enterFullscreen } from "../input/touch.ts";
import { bootPlay } from "./boot.ts";
import { SceneCanvas, playPrefab } from "./GameScene.tsx";
import { ChaseFx, PlayDriver, ScreenTracker } from "./PlayViews.tsx";
import { ActorsView, handWorld } from "./ActorsView.tsx";
import { AssetsBridge, loadManifest, manifestFor } from "./characters.ts";
import { MiladyView } from "./Milady.tsx";
import { GeorgeView } from "./GeorgeView.tsx";
import { CameraView } from "./CameraView.tsx";
import { FxView } from "./FxView.tsx";
import { botParams, startBot } from "./dev/BotDriver.ts";
import { setAudioLow, setAudioVolumes, setMuted, unlockAudio } from "../audio/engine.ts";
import type { Vector3 } from "three";

const DEV = import.meta.env.MODE !== "production";
const TunePanel = DEV ? lazy(() => import("./dev/TunePanel.tsx")) : null;
const params = new URLSearchParams(location.search);
const TUNE = DEV && params.has("tune");
const BOT = DEV ? botParams(location.search) : null;

const canvasEl = () => document.querySelector("canvas");
const applyAudio = (s: Settings) => { setAudioVolumes(s.music, s.sfx); setMuted(s.muted); setAudioLow(s.quality === "low"); };
/** Touch play never uses pointer lock (spec §4 "Touch"). */
const isTouch = () => useUi.getState().touch;
const lockMouse = () => { if (!isTouch() && document.pointerLockElement !== canvasEl()) canvasEl()?.requestPointerLock(); };

function Scene({ game }: { game: PlayGame }) {
  const prefab = useMemo(() => playPrefab(game, { nodes: [], materials: {} }), [game]);
  const hidePlayer = useCallback(() => game.mode !== "round", [game]);
  const ropeFrom = useCallback((out: Vector3) => handWorld(game.setup.chaser, "right", out) !== null, [game]);
  return (
    <SceneCanvas prefab={prefab}>
      <AssetsBridge />
      <PlayDriver game={game} />
      <ActorsView game={game} />
      <GeorgeView game={game} />
      <MiladyView game={game} />
      <CameraView game={game} ropeDrop={1} />
      <FxView game={game} hidePlayer={hidePlayer} ropeFrom={ropeFrom} />
      <ChaseFx game={game} />
      <ScreenTracker game={game} />
    </SceneCanvas>
  );
}

/** LOADING (spec §20 item 4): preload the round pair's GLBs, then mount their nodes. */
async function loadPair(chaser: RadbroId, runner: RadbroId): Promise<boolean> {
  useUi.setState({ screen: "loading", load: { progress: 0, error: null } });
  const failed = await loadManifest(manifestFor(chaser, runner), f => useUi.setState({ load: { progress: f, error: null } }));
  if (failed) {
    useUi.setState(s => ({ load: { progress: s.load.progress, error: failed } }));
    return false;
  }
  const cur = useUi.getState().pair;
  if (!cur || cur.chaser !== chaser || cur.runner !== runner) {
    useUi.setState({ pair: { chaser, runner } });
    // Let ActorsView mount the character nodes before the round starts.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  return true;
}

export default function PlayPage() {
  const [game, setGame] = useState<PlayGame | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const challenge = useMemo(() => readChallenge(location.search), []);
  const picks = useMemo(() => lastPicks(), []);
  const [chaser, setChaser] = useState<RadbroId>(challenge.c ?? picks.chaser);
  const [difficulty, setDifficulty] = useState<Difficulty>(challenge.d ?? picks.difficulty);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const screen = useUi(s => s.screen);
  const paused = useUi(s => s.paused);
  const ready = useUi(s => s.sceneReady);
  const touch = useUi(s => s.touch);
  const rHeld = useRef<number | null>(null);
  const muteRef = useRef<() => void>(() => undefined);

  // Touch: switch on at the first touch anywhere; that tap (and PLAY) also asks for fullscreen +
  // landscape. The game picks up the wider aim cone / Yoink bonus from the next round.
  useEffect(() => {
    const onTouch = () => { if (!useUi.getState().touch) useUi.setState({ touch: true }); };
    const onEnd = () => { if (!BOT) enterFullscreen(); removeEventListener("touchend", onEnd); };
    addEventListener("touchstart", onTouch, { passive: true });
    addEventListener("touchend", onEnd);
    return () => { removeEventListener("touchstart", onTouch); removeEventListener("touchend", onEnd); };
  }, []);
  useEffect(() => { game?.setTouch(touch); }, [game, touch]);

  useEffect(() => {
    bootPlay().then(g => {
      const s = loadSettings(g.camera);
      applySettings(g.camera, s);
      applyAudio(s);
      g.retune();
      setSettingsState(s);
      setGame(g);
    }, e => setErr(String(e)));
  }, []);

  // Scene ready -> title (or straight into the bot round, through LOADING).
  useEffect(() => {
    if (!game || !ready || screen !== "boot") return;
    if (BOT) {
      void loadPair(BOT.c, BOT.r).then(ok => {
        if (!ok) return;
        // No gesture on a bot page: the context starts suspended and resumes at the first click / key.
        unlockAudio();
        startBot(game, BOT);
        useUi.setState({ screen: "countdown", results: null });
      });
    } else useUi.setState({ screen: "title" });
  }, [game, ready, screen]);

  const setPaused = useCallback((p: boolean) => {
    if (!game) return;
    game.paused = p;
    useUi.setState({ paused: p });
  }, [game]);

  const begin = useCallback((seed: number, practice = false) => {
    if (!game) return;
    const runner = pickRunner(chaser, challenge.r);
    useUi.setState({ results: null, feed: [], banner: null, bubble: null, paused: false });
    void loadPair(chaser, runner).then(ok => {
      if (!ok) return;
      game.paused = false;
      game.startRound({ chaser, runner, difficulty, seed }, practice);
      useUi.setState({ screen: practice ? "practice" : "countdown" });
      lockMouse();
    });
  }, [game, chaser, difficulty, challenge]);

  const onPlay = useCallback(() => {
    rememberPicks(chaser, difficulty);
    unlockAudio();
    if (isTouch()) enterFullscreen();
    else canvasEl()?.requestPointerLock();
    begin(randomSeed());
  }, [begin, chaser, difficulty]);

  const onPractice = useCallback(() => {
    rememberPicks(chaser, difficulty);
    unlockAudio();
    if (isTouch()) enterFullscreen();
    else canvasEl()?.requestPointerLock();
    begin(randomSeed(), true);
  }, [begin, chaser, difficulty]);

  const retry = useCallback(() => {
    if (!game || game.mode !== "round") return;
    useUi.setState({ results: null, feed: [], banner: null, bubble: null, paused: false });
    game.paused = false;
    // Practice: same seed = the same start roof.
    game.retry(BOT ? (game.setup.seed + 1) >>> 0 : game.practice ? game.setup.seed : randomSeed());
    useUi.setState({ screen: game.practice ? "practice" : "countdown" });
    if (!BOT) lockMouse();
  }, [game]);

  const toMenu = useCallback(() => {
    if (!game) return;
    game.toTitle();
    document.exitPointerLock?.();
    useUi.setState({ screen: "title", results: null, paused: false });
  }, [game]);

  // Input + pointer lock + keys.
  useEffect(() => {
    if (!game) return;
    const el = canvasEl() ?? document.body;
    const detach = attachDom(game.input, el, locked => {
      useUi.setState({ locked });
      const sc = useUi.getState().screen;
      if (!locked && !BOT && !TUNE && (sc === "countdown" || sc === "chase" || sc === "practice")) setPaused(true);
      if (locked) setPaused(false);
    });
    const kd = (e: KeyboardEvent) => {
      if (e.code === "KeyM" && !e.repeat) { muteRef.current(); return; }
      if (e.code !== "KeyR" || e.repeat) return;
      const sc = useUi.getState().screen;
      if (sc === "results") retry();
      else if (sc === "countdown" || sc === "chase" || sc === "practice") rHeld.current = performance.now();
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "KeyR") { rHeld.current = null; useUi.setState(s => ({ round: { ...s.round, holdR: 0 } })); }
    };
    const iv = setInterval(() => {
      if (rHeld.current === null) return;
      const f = (performance.now() - rHeld.current) / 1000;
      if (f >= 1) { rHeld.current = null; retry(); }
      else useUi.setState(s => ({ round: { ...s.round, holdR: f } }));
    }, 50);
    // A click on the canvas mid-round re-captures the mouse (e.g. a lock request the browser refused).
    const click = () => {
      const sc = useUi.getState().screen;
      if (!BOT && !isTouch() && (sc === "countdown" || sc === "chase" || sc === "practice") && document.pointerLockElement !== el) el.requestPointerLock?.();
    };
    // Phones: leaving the tab / locking the screen mid-round pauses.
    const vis = () => {
      const sc = useUi.getState().screen;
      if (document.hidden && !BOT && (sc === "countdown" || sc === "chase" || sc === "practice")) setPaused(true);
    };
    document.addEventListener("visibilitychange", vis);
    el.addEventListener("click", click);
    addEventListener("keydown", kd);
    addEventListener("keyup", ku);
    return () => { detach(); document.removeEventListener("visibilitychange", vis); el.removeEventListener("click", click); removeEventListener("keydown", kd); removeEventListener("keyup", ku); clearInterval(iv); };
  }, [game, retry, setPaused]);

  // Results: free the mouse so the buttons work.
  useEffect(() => {
    if (screen === "results" && document.pointerLockElement) document.exitPointerLock();
  }, [screen]);

  // ?tune: clicking the canvas captures the mouse.
  useEffect(() => {
    if (!game || !TUNE) return;
    const el = canvasEl();
    const click = () => el?.requestPointerLock();
    el?.addEventListener("click", click);
    return () => el?.removeEventListener("click", click);
  }, [game]);

  const setSettings = (s: Settings) => {
    if (!game) return;
    setSettingsState(s);
    saveSettings(s);
    if (s.quality !== useUi.getState().quality) useUi.setState({ quality: s.quality });
    applySettings(game.camera, s);
    applyAudio(s);
    game.retune();
  };
  // Mute button (title + HUD) and the M key; a gesture, so it also unlocks the audio.
  const toggleMute = () => {
    if (!settings) return;
    setSettings({ ...settings, muted: !settings.muted });
    unlockAudio();
  };
  muteRef.current = toggleMute;

  if (err) return <div style={{ padding: 20 }}>Failed to load: {err}</div>;
  if (!game || !settings) return <div style={{ padding: 20 }}>loading…</div>;
  const practice = screen === "practice";
  const inRound = screen === "countdown" || screen === "chase" || practice;
  return (
    <>
      <Scene game={game} />
      {(screen === "boot" || screen === "title") && (
        <Title chaser={chaser} setChaser={setChaser} difficulty={difficulty} setDifficulty={setDifficulty} challenge={challenge} onPlay={onPlay} onPractice={onPractice} ready={ready}
          muted={settings.muted} onMute={toggleMute} />
      )}
      {screen === "loading" && <Loading onRetry={() => begin(randomSeed())} onMenu={toMenu} />}
      {(inRound || screen === "results") && <RoundHud reducedMotion={settings.reducedMotion} easyGrab={settings.easyGrab} practice={practice} muted={settings.muted} onMute={toggleMute} />}
      {touch && inRound && !paused && !BOT && <TouchControls input={game.input} onPause={() => setPaused(true)} noRunner={practice} />}
      {screen === "results" && <ResultsScreen onRetry={retry} onMenu={toMenu} />}
      {paused && inRound && (
        <Pause
          settings={settings}
          setSettings={setSettings}
          onResume={() => (touch ? setPaused(false) : canvasEl()?.requestPointerLock())}
          onRestart={() => { setPaused(false); retry(); }}
          onQuit={toMenu}
          practice={practice}
        />
      )}
      {TunePanel && TUNE && (
        <Suspense fallback={null}>
          <TunePanel game={game} />
        </Suspense>
      )}
    </>
  );
}
