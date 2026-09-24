// The game page: TITLE -> LOADING -> COUNTDOWN -> CHASE -> RESULTS over one canvas that is mounted
// once, plus TITLE -> PRACTICE (free swinging with your Radbro and George, no runner; pause -> Back
// to title). Restart / Retry create a fresh Round outside React (nothing remounts). ?bot=... runs the
// test bot (dev/test builds), ?tune adds sliders. A ghost link (?c&r&d&s&t&g) is decoded and verified
// on the title; PLAY then races that exact round with the ghost (game/ghost.ts, GhostView).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlayGame } from "../game/play.ts";
import { randomSeed } from "../game/play.ts";
import type { RadbroId } from "../game/round.ts";
import type { Difficulty } from "../sim/tuning.ts";
import { attachDom } from "../input/input.ts";
import { useUi, type GhostInfo } from "../ui/store.ts";
import { applySettings, getBestGhost, lastPicks, loadSettings, pickRunner, readChallenge, rememberPicks, saveSettings, type Settings, type StoredGhost } from "../ui/prefs.ts";
import { Loading, Pause, ResultsScreen, RoundHud, Title, Toast } from "../ui/screens.tsx";
import { CampaignScreen } from "../ui/campaignScreen.tsx";
import { LEVELS, loadProgress, type Level, type Progress } from "../game/campaign.ts";
import { unpackGhost, type GhostSpec } from "../game/ghost.ts";
import { GhostView } from "./GhostView.tsx";
import { S } from "../ui/strings.ts";
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
import { DISTRICT_MUTATORS, M_NIGHT } from "../game/mutators.ts";
import { NightLook } from "./cityLook.tsx";
import { PAGE_DISTRICT, gotoDistrict } from "./district.ts";

const DEV = import.meta.env.MODE !== "production";
const TunePanel = DEV ? lazy(() => import("./dev/TunePanel.tsx")) : null;
const params = new URLSearchParams(location.search);
const TUNE = DEV && params.has("tune");
const BOT = DEV ? botParams(location.search) : null;
/** ?lvl=N: open the campaign screen on level N (a campaign level in another district navigates here). */
const LVL = Number(params.get("lvl") ?? 0) | 0;

const canvasEl = () => document.querySelector("canvas");

/** A decoded ghost plus its verification (the title banner, the HUD tag, the results line). */
export type GhostChoice = { spec: GhostSpec; info: GhostInfo };

/** Replay the ghost headless (its own Round, no countdown; ~10-20 ms for a 90 s run) and judge the claim. */
function verifyGhost(game: PlayGame, spec: GhostSpec, source: GhostInfo["source"], older = false): GhostChoice {
  const run = game.makeGhostRun(spec, false);
  run.advance(spec.log.n + 1);
  const r = run.round, caught = r.phase === "caught";
  return {
    spec,
    info: {
      chaser: spec.chaser, status: run.verifies(spec.claimed) ? "verified" : "unverified", claimed: spec.claimed,
      time: caught ? r.stats.catchTime : null, kind: caught ? r.stats.catchKind : "", source, older,
    },
  };
}

/** `older`: a link from before versioned links (v < 2) - it is replayed as Downtown with no mutators. */
async function decodeGhost(game: PlayGame, g: StoredGhost, source: GhostInfo["source"], older = false): Promise<GhostChoice | null> {
  const dec = await unpackGhost(g.g);
  if (!dec) return null;
  return verifyGhost(game, { chaser: g.c, runner: g.r, difficulty: g.d, seed: g.s, claimed: g.t, log: dec.log, flags: dec.flags, mutators: g.mu ?? 0 }, source, older);
}
const applyAudio = (s: Settings) => { setAudioVolumes(s.music, s.sfx); setMuted(s.muted); setAudioLow(s.quality === "low"); };
/** Auto quality may switch to Low: on High, never picked by hand, never switched before (?autoq=0 = off). */
const AUTOQ_OFF = params.get("autoq") === "0";
const autoQualityAllowed = (s: Settings) => !AUTOQ_OFF && s.quality === "high" && !s.qualityChosen && !s.qualityAuto;
/** Touch play never uses pointer lock (spec §4 "Touch"). */
const isTouch = () => useUi.getState().touch;
const lockMouse = () => { if (!isTouch() && document.pointerLockElement !== canvasEl()) canvasEl()?.requestPointerLock(); };

function Scene({ game }: { game: PlayGame }) {
  const prefab = useMemo(() => playPrefab(game, { nodes: [], materials: {} }), [game]);
  const hidePlayer = useCallback(() => game.mode !== "round", [game]);
  const ropeFrom = useCallback((out: Vector3) => handWorld(game.setup.chaser, "right", out) !== null, [game]);
  const isNight = useCallback(() => game.mode === "round" && ((game.setup.mutators ?? 0) & M_NIGHT) !== 0, [game]);
  return (
    <SceneCanvas prefab={prefab}>
      <AssetsBridge />
      <PlayDriver game={game} />
      <ActorsView game={game} />
      <GeorgeView game={game} />
      <GhostView game={game} />
      <MiladyView game={game} />
      <CameraView game={game} ropeDrop={1} />
      <FxView game={game} hidePlayer={hidePlayer} ropeFrom={ropeFrom} />
      <ChaseFx game={game} />
      <ScreenTracker game={game} />
      <NightLook isNight={isNight} />
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
  const autoLow = useUi(s => s.autoLow);
  /** The link's ghost (null: none, or it failed to decode) and whether it is still decoding. */
  const [linkGhost, setLinkGhost] = useState<GhostChoice | null>(null);
  const [linkGhostBusy, setLinkGhostBusy] = useState(false);
  const ghostActive = !!linkGhost && linkGhost.spec.chaser === chaser && linkGhost.spec.difficulty === difficulty;
  const [bestGhost, setBestGhost] = useState<StoredGhost | null>(null);
  /** Round 4: campaign progress (re-read on every title / campaign screen) and the free-play mutators. */
  const [progress, setProgress] = useState<Progress>(() => loadProgress());
  const [freeMut, setFreeMut] = useState<number>(() => challenge.mu || DISTRICT_MUTATORS[PAGE_DISTRICT]);

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

  // A ghost link: decode + verify once the game exists (the replay needs the city and the pack).
  useEffect(() => {
    if (!game || BOT) return;
    const { c, r, d, s, t, g, mu, v } = challenge;
    if (!c || !r || !d || s === null || t === null || !g) return;
    setLinkGhostBusy(true);
    void decodeGhost(game, { c, r, d, s, t, g, mu }, "link", v < 2).then(ch => { setLinkGhost(ch); setLinkGhostBusy(false); });
  }, [game, challenge]);

  // Your kept best run for the picked chaser x difficulty (title: "race your best").
  useEffect(() => {
    if (screen === "title" || screen === "boot") setBestGhost(getBestGhost(chaser, difficulty, freeMut));
    if (screen === "title" || screen === "campaign") setProgress(loadProgress());
  }, [chaser, difficulty, screen, freeMut]);

  // Scene ready -> title (or straight into the bot round, through LOADING).
  useEffect(() => {
    if (!game || !ready || screen !== "boot") return;
    if (BOT) {
      void loadPair(BOT.c, BOT.r).then(ok => {
        if (!ok) return;
        // &lvl=N on a bot page: score the round as campaign level N (pass the level's d / mu too).
        if (LVL >= 1 && LVL <= LEVELS.length) useUi.setState({ campaign: { n: LVL } });
        // No gesture on a bot page: the context starts suspended and resumes at the first click / key.
        unlockAudio();
        startBot(game, BOT);
        useUi.setState({ screen: "countdown", results: null });
      });
    } else if (LVL >= 1 && LVL <= LEVELS.length) useUi.setState({ screen: "campaign", campaignSel: LVL });
    else useUi.setState({ screen: "title" });
  }, [game, ready, screen]);

  const setPaused = useCallback((p: boolean) => {
    if (!game) return;
    game.paused = p;
    useUi.setState({ paused: p });
  }, [game]);

  /**
   * Start a round (a ghost race: its exact round - seed, pair, difficulty, mutators - with the ghost
   * beside you; a campaign level: its difficulty and mutators, scored against its objectives).
   */
  const begin = useCallback((seed: number, practice = false, ghost: GhostChoice | null = null, level: Level | null = null) => {
    if (!game) return;
    const runner = ghost ? ghost.spec.runner : pickRunner(chaser, level ? null : challenge.r);
    const ch = ghost ? ghost.spec.chaser : chaser, d = ghost ? ghost.spec.difficulty : level ? level.difficulty : difficulty;
    useUi.setState({ results: null, feed: [], banner: null, bubble: null, paused: false, campaign: level ? { n: level.n } : null });
    void loadPair(ch, runner).then(ok => {
      if (!ok) return;
      game.paused = false;
      const mutators = ghost ? ghost.spec.mutators ?? 0 : level ? level.mutators : freeMut;
      game.startRound({ chaser: ch, runner, difficulty: d, seed: ghost ? ghost.spec.seed : seed, mutators }, practice, ghost?.spec ?? null);
      useUi.setState({ screen: practice ? "practice" : "countdown", ghost: ghost ? ghost.info : null });
      lockMouse();
    });
  }, [game, chaser, difficulty, challenge, freeMut]);

  const onPlay = useCallback(() => {
    rememberPicks(chaser, difficulty);
    unlockAudio();
    if (isTouch()) enterFullscreen();
    else canvasEl()?.requestPointerLock();
    begin(randomSeed(), false, ghostActive ? linkGhost : null);
  }, [begin, chaser, difficulty, ghostActive, linkGhost]);

  const onRaceBest = useCallback(() => {
    if (!game || !bestGhost) return;
    rememberPicks(chaser, difficulty);
    unlockAudio();
    if (isTouch()) enterFullscreen();
    else canvasEl()?.requestPointerLock();
    void decodeGhost(game, bestGhost, "best").then(ch => { if (ch) begin(ch.spec.seed, false, ch); });
  }, [game, bestGhost, begin, chaser, difficulty]);

  const onPractice = useCallback(() => {
    rememberPicks(chaser, difficulty);
    unlockAudio();
    if (isTouch()) enterFullscreen();
    else canvasEl()?.requestPointerLock();
    begin(randomSeed(), true);
  }, [begin, chaser, difficulty]);

  /** A campaign level: in another district that is a navigation (?map=..&lvl=N -> campaign screen). */
  const startLevel = useCallback((n: number) => {
    const level = LEVELS[n - 1];
    if (!level) return;
    if (level.map !== PAGE_DISTRICT) { gotoDistrict(level.map, { lvl: String(n) }); return; }
    rememberPicks(chaser, difficulty);
    unlockAudio();
    if (isTouch()) enterFullscreen();
    else canvasEl()?.requestPointerLock();
    useUi.setState({ campaignSel: n });
    begin(randomSeed(), false, null, level);
  }, [begin, chaser, difficulty]);

  const toLevels = useCallback(() => {
    if (!game) return;
    game.toTitle();
    document.exitPointerLock?.();
    useUi.setState(s => ({ screen: "campaign", results: null, paused: false, ghost: null, campaignSel: s.campaign?.n ?? s.campaignSel, campaign: null }));
  }, [game]);

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
    useUi.setState({ screen: "title", results: null, paused: false, ghost: null, campaign: null });
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
    useUi.setState({ autoQuality: autoQualityAllowed(s) });
    applySettings(game.camera, s);
    applyAudio(s);
    game.retune();
  };
  useEffect(() => { if (settings) useUi.setState({ autoQuality: autoQualityAllowed(settings) }); }, [settings]);
  // Auto quality asked for Low (PlayDriver): switch once, remember it, tell the player.
  useEffect(() => {
    if (!autoLow || !settings) return;
    useUi.setState({ autoLow: false });
    if (!autoQualityAllowed(settings)) return;
    setSettings({ ...settings, quality: "low", qualityAuto: true });
    useUi.setState({ toast: { text: S.autoLow, t: performance.now() } });
  }, [autoLow, settings]);
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
          muted={settings.muted} onMute={toggleMute} ghost={linkGhost} ghostBusy={linkGhostBusy} ghostActive={ghostActive}
          bestGhost={ghostActive ? null : bestGhost} onRaceBest={onRaceBest}
          progress={progress} freeMut={freeMut} setFreeMut={setFreeMut} onCampaign={() => useUi.setState({ screen: "campaign" })} />
      )}
      {screen === "campaign" && <CampaignScreen onStart={startLevel} onBack={() => useUi.setState({ screen: "title" })} ready={ready} />}
      {screen === "loading" && <Loading onRetry={() => begin(randomSeed())} onMenu={toMenu} />}
      {(inRound || screen === "results") && <RoundHud reducedMotion={settings.reducedMotion} easyGrab={settings.easyGrab} practice={practice} muted={settings.muted} onMute={toggleMute} />}
      {touch && inRound && !paused && !BOT && <TouchControls input={game.input} onPause={() => setPaused(true)} noRunner={practice} />}
      {screen === "results" && <ResultsScreen onRetry={retry} onMenu={toMenu} onNext={startLevel} onLevels={toLevels} />}
      <Toast />
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
