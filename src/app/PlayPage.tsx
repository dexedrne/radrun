// The game page: TITLE -> LOADING -> COUNTDOWN -> CHASE -> RESULTS over one canvas that is mounted
// once. Restart / Retry create a fresh Round outside React (nothing remounts). ?bot=... runs the test
// bot (dev/test builds), ?tune adds sliders.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlayGame } from "../game/play.ts";
import { randomSeed } from "../game/play.ts";
import type { RadbroId } from "../game/round.ts";
import type { Difficulty } from "../sim/tuning.ts";
import { attachDom } from "../input/input.ts";
import { useUi } from "../ui/store.ts";
import { applySettings, lastPicks, loadSettings, pickRunner, readChallenge, rememberPicks, saveSettings, type Settings } from "../ui/prefs.ts";
import { Loading, Pause, ResultsScreen, RoundHud, Title } from "../ui/screens.tsx";
import { bootPlay } from "./boot.ts";
import { SceneCanvas, playPrefab } from "./GameScene.tsx";
import { ActorsView, PlayDriver, RunnerFx, ScreenTracker, radbroActors } from "./PlayViews.tsx";
import { CameraView } from "./CameraView.tsx";
import { FxView } from "./FxView.tsx";
import { botParams, startBot } from "./dev/BotDriver.ts";

const DEV = import.meta.env.MODE !== "production";
const TunePanel = DEV ? lazy(() => import("./dev/TunePanel.tsx")) : null;
const params = new URLSearchParams(location.search);
const TUNE = DEV && params.has("tune");
const BOT = DEV ? botParams(location.search) : null;

const canvasEl = () => document.querySelector("canvas");

function Scene({ game }: { game: PlayGame }) {
  const prefab = useMemo(() => playPrefab(game, radbroActors()), [game]);
  const hidePlayer = useCallback(() => game.mode !== "round", [game]);
  return (
    <SceneCanvas prefab={prefab}>
      <PlayDriver game={game} />
      <ActorsView game={game} />
      <CameraView game={game} />
      <FxView game={game} hidePlayer={hidePlayer} />
      <RunnerFx game={game} />
      <ScreenTracker game={game} />
    </SceneCanvas>
  );
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
  const rHeld = useRef<number | null>(null);

  useEffect(() => {
    bootPlay().then(g => {
      const s = loadSettings(g.camera);
      applySettings(g.camera, s);
      g.retune();
      setSettingsState(s);
      setGame(g);
    }, e => setErr(String(e)));
  }, []);

  // Scene ready -> title (or straight into the bot round).
  useEffect(() => {
    if (!game || !ready || screen !== "boot") return;
    if (BOT) {
      startBot(game, BOT);
      useUi.setState({ screen: "countdown", results: null });
    } else useUi.setState({ screen: "title" });
  }, [game, ready, screen]);

  const setPaused = useCallback((p: boolean) => {
    if (!game) return;
    game.paused = p;
    useUi.setState({ paused: p });
  }, [game]);

  const begin = useCallback((seed: number) => {
    if (!game) return;
    useUi.setState({ screen: "loading", results: null, feed: [], banner: null, bubble: null, paused: false });
    // LOADING: the manifest (chaser, runner, their clip packs, George) arrives with the models in M4;
    // with box stand-ins everything is already resident, so the round starts on the next frame.
    requestAnimationFrame(() => {
      game.paused = false;
      game.startRound({ chaser, runner: pickRunner(chaser, challenge.r), difficulty, seed });
      useUi.setState({ screen: "countdown" });
    });
  }, [game, chaser, difficulty, challenge]);

  const onPlay = useCallback(() => {
    rememberPicks(chaser, difficulty);
    canvasEl()?.requestPointerLock();
    begin(randomSeed());
  }, [begin, chaser, difficulty]);

  const retry = useCallback(() => {
    if (!game || game.mode !== "round") return;
    useUi.setState({ results: null, feed: [], banner: null, bubble: null, paused: false });
    game.paused = false;
    game.retry(BOT ? (game.setup.seed + 1) >>> 0 : randomSeed());
    useUi.setState({ screen: "countdown" });
    if (!BOT && document.pointerLockElement !== canvasEl()) canvasEl()?.requestPointerLock();
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
      if (!locked && !BOT && !TUNE && (sc === "countdown" || sc === "chase")) setPaused(true);
      if (locked) setPaused(false);
    });
    const kd = (e: KeyboardEvent) => {
      if (e.code !== "KeyR" || e.repeat) return;
      const sc = useUi.getState().screen;
      if (sc === "results") retry();
      else if (sc === "countdown" || sc === "chase") rHeld.current = performance.now();
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
    addEventListener("keydown", kd);
    addEventListener("keyup", ku);
    return () => { detach(); removeEventListener("keydown", kd); removeEventListener("keyup", ku); clearInterval(iv); };
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
    applySettings(game.camera, s);
    game.retune();
  };

  if (err) return <div style={{ padding: 20 }}>Failed to load: {err}</div>;
  if (!game || !settings) return <div style={{ padding: 20 }}>loading…</div>;
  const inRound = screen === "countdown" || screen === "chase";
  return (
    <>
      <Scene game={game} />
      {(screen === "boot" || screen === "title") && (
        <Title chaser={chaser} setChaser={setChaser} difficulty={difficulty} setDifficulty={setDifficulty} challenge={challenge} onPlay={onPlay} ready={ready} />
      )}
      {screen === "loading" && <Loading progress={1} />}
      {(inRound || screen === "results") && <RoundHud reducedMotion={settings.reducedMotion} easyGrab={settings.easyGrab} />}
      {screen === "results" && <ResultsScreen onRetry={retry} onMenu={toMenu} />}
      {paused && inRound && (
        <Pause
          settings={settings}
          setSettings={setSettings}
          onResume={() => canvasEl()?.requestPointerLock()}
          onRestart={() => { setPaused(false); retry(); }}
          onQuit={toMenu}
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
