// Canvas-side systems for the play page: PlayDriver (fixed steps, events -> UI store at 10 Hz, SFX and
// music, window.__play), ChaseFx (his rope and yours from the RightHand bones, red YOINK ring, blob shadow,
// the procedural money bag on the LeftHand + the catch hand-off, the lasso, the runner trail and the
// flying rug) and ScreenTracker (bubble anchor + edge arrow, DOM writes).
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, Group, LatheGeometry, Mesh, MeshBasicMaterial,
  PlaneGeometry, SRGBColorSpace, Vector2, Vector3,
} from "three";
import type { PlayGame } from "../game/play.ts";
import { RESULTS_AFTER, RUG } from "../game/play.ts";
import { COUNTDOWN_STEPS, RV_CAUGHT, RV_ESCAPED, RV_FALL, RV_GO, RV_YOINK, type RadbroId } from "../game/round.ts";
import { RE_CORNERED, RE_GASSED, RE_PANIC, RE_TAUNT } from "../runner/runner.ts";
import { EV_ATTACH, EV_BONK, EV_JUMP, EV_LAND, EV_POP, EV_RELEASE, RING_RUNNER } from "../sim/player.ts";
import { pushFeed, showBanner, showBubble, useUi, type Results } from "../ui/store.ts";
import { LINES, S, TAUNTS, medal } from "../ui/strings.ts";
import { getBest, ghostUrl, recordBest, saveBestGhost } from "../ui/prefs.ts";
import { encodeBytes, packBytes } from "../game/ghost.ts";
import { AutoQuality } from "./autoQuality.ts";
import { sfx } from "../audio/sfx.ts";
import { music } from "../audio/music.ts";
import { musicTarget } from "../audio/score.ts";
import { audioState, isMuted, outputLevel } from "../audio/engine.ts";
import { handWorld, rigs } from "./ActorsView.tsx";
import { FRAME } from "./frame.ts";
import { lowQuality } from "./quality.tsx";
import { hints } from "../ui/hints.ts";
import { MECH } from "../sim/tuning.ts";
import { LEVELS, evaluate, loadProgress, recordLevel, saveProgress, starCount } from "../game/campaign.ts";

const DEV = import.meta.env.MODE !== "production";

/** Bot pages (?bot=...) never show first-run tips. */
const BOT_PAGE = new URLSearchParams(location.search).has("bot");

/** Speech-bubble chatter pitch per runner (Hz). */
const VOICE: Record<RadbroId, number> = { "652": 640, "4764": 780, "2564": 540 };

// ---- driver --------------------------------------------------------------------------------------

export type PlayProbe = {
  screen: string;
  phase: string;
  runId: number;
  chaseSteps: number;
  clock: number;
  d: number;
  outcome: string;
  catchKind: string;
  catchTime: number;
  ring: number;
  /** Hook id you hang from, or -1. */
  rope: number;
  player: [number, number, number];
  runner: { p: [number, number, number]; mode: number; phase: number; edge: number; t: number; m: number; budget: number };
  runnerPhases: number[];
  /** Clips seen on the chaser / runner this round (animation smoke check). */
  clips: { chaser: string[]; runner: string[]; george: string[] };
  fps: number;
  frames: number;
  backend: string;
  /** AudioContext state ("none" before the first gesture), music mode / close-chase layer, notes and SFX played. */
  audio: { state: string; muted: boolean; music: string; layer: boolean; notes: number; sfx: number; rms?: number; peak?: number };
  /**
   * Ghosts: steps recorded this round; the raced ghost (its phase, chase steps, record length, catch
   * time, status); the ghost link of the last catch once packed.
   */
  ghost: { recorded: number; on: boolean; phase: string; steps: number; n: number; catchTime: number; status: string; p: [number, number, number] | null; url: string };
  /** Auto quality: the quality now, whether it may still switch, median fps of this round's window, switched. */
  autoQ: { quality: string; allowed: boolean; fps: number; fired: boolean };
};

declare global {
  interface Window {
    __play?: PlayProbe;
  }
}

function buildResults(game: PlayGame): Results {
  const r = game.round, st = r.stats, s = game.setup;
  const mu = s.mutators ?? 0;
  const caught = r.phase === "caught";
  const best = getBest(s.chaser, s.difficulty, mu);
  let newBest = false;
  if (caught) {
    const prev = recordBest(s.chaser, s.difficulty, st.catchTime, mu);
    newBest = prev === null || st.catchTime < prev;
  }
  // Round 4 campaign: evaluate this level's objectives and keep the stars (best-of).
  let campaign: Results["campaign"] = null;
  const camp = useUi.getState().campaign;
  const level = camp ? LEVELS.find(l => l.n === camp.n) : undefined;
  if (level && !game.ghostSpec) {
    const got = evaluate(level, r.phase, st, r.clock);
    const p = loadProgress();
    const fresh = recordLevel(p, level.n, got, caught ? st.catchTime : null);
    saveProgress(p);
    campaign = { n: level.n, got, fresh, stars: p.stars[level.n], totalStars: starCount(p) };
  }
  const gi = useUi.getState().ghost;
  const vsGhost = game.ghostSpec && gi ? { time: gi.time, verified: gi.status === "verified" } : null;
  // Pack this run for a ghost link (async deflate); a new personal best is kept as your best ghost.
  if (caught && game.recording && game.log.n === r.chaseSteps) {
    const bytes = encodeBytes(game.log, game.roundFlags), runId = game.runId, t = st.catchTime;
    void packBytes(bytes).then(code => {
      if (newBest) saveBestGhost({ c: s.chaser, r: s.runner, d: s.difficulty, s: s.seed, t, g: code, mu });
      if (game.runId === runId) useUi.setState(u => (u.results ? { results: { ...u.results, ghostCode: code } } : {}));
    }, () => undefined);
  }
  return {
    caught, kind: st.catchKind, time: st.catchTime, closest: st.closest, maxChain: st.maxChain, topSpeed: st.topSpeed, falls: st.falls,
    medal: caught ? medal(s.difficulty, st.catchTime) : "", best, newBest, runner: s.runner, chaser: s.chaser, difficulty: s.difficulty,
    seed: s.seed, ghostCode: null, vsGhost, mutators: mu, campaign,
  };
}

export function PlayDriver({ game }: { game: PlayGame }) {
  const acc = useRef(0);
  const fps = useRef(60);
  const frames = useRef(0);
  const phases = useRef(new Set<number>());
  const clips = useRef({ chaser: new Set<string>(), runner: new Set<string>(), george: new Set<string>() });
  const lastRun = useRef(-1);
  const lines = useRef(0);
  const beep = useRef(4);
  const audio = useRef({ layer: false, windAcc: 0, rms: -120, peak: -120, maxPeak: -120, gusting: false });
  const ghostPhase = useRef("");
  const autoQ = useRef(new AutoQuality());
  useFrame((_, delta) => {
    game.frame(delta);
    frames.current++;
    fps.current = fps.current * 0.95 + (1 / Math.max(delta, 1e-3)) * 0.05;
    const r = game.round, run = r.runner, who = game.setup.runner;
    if (game.runId !== lastRun.current) {
      lastRun.current = game.runId;
      phases.current.clear();
      clips.current.chaser.clear();
      clips.current.runner.clear();
      clips.current.george.clear();
      beep.current = 4;
      hints.newRun();
      if (game.mode === "round" && !game.practice) { showBubble(S.countdownBubble); sfx.chatter(VOICE[who]); music.countdown(COUNTDOWN_STEPS / 120); }
    }
    phases.current.add(run.pose.phase);
    const ch = rigs.get(game.setup.chaser), rn = rigs.get(who);
    if (ch?.player.current) clips.current.chaser.add(ch.player.current);
    if (rn?.player.current) clips.current.runner.add(rn.player.current);
    if (game.mode === "round") clips.current.george.add(game.george.clip);
    // Countdown beeps 3-2-1.
    if (game.mode === "round" && r.phase === "countdown") {
      const n = Math.ceil(r.countdown / 120);
      if (n < beep.current && n > 0) { beep.current = n; sfx.beep(); }
    }
    // Events -> strings (§12) + SFX.
    const ev = game.roundEvents, rev = game.runnerEvents, pe = game.frameEvents;
    if (ev & RV_GO) { useUi.setState({ screen: "chase" }); showBanner(S.go); sfx.beep(true); }
    if (ev & RV_FALL) { showBanner(S.fall); pushFeed(S.fall); useUi.setState({ fade: performance.now() }); sfx.fall(); }
    const b = r.player;
    const sp = Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z);
    if (r.phase === "chase") {
      if (pe & EV_JUMP) sfx.jump();
      if (pe & EV_ATTACH) sfx.thwip();
      if (pe & EV_RELEASE) sfx.fling(sp);
      if ((pe & EV_LAND) && !(ev & RV_FALL)) sfx.land(-b.landVy);
      if (pe & EV_BONK) sfx.bonk();
      if (pe & EV_POP) sfx.pop();
      const g = r.nextGust();
      const gusting = !!g && g.level > 0;
      if (gusting && !audio.current.gusting) sfx.gust();
      audio.current.gusting = gusting;
    }
    if (rev & RE_TAUNT) { const t = TAUNTS[who]; showBubble(t[lines.current++ % t.length]); sfx.chatter(VOICE[who]); }
    if (rev & RE_PANIC) { showBubble(S.panicBubble); sfx.chatter(VOICE[who] * 1.25); }
    if (rev & RE_CORNERED) { showBubble(S.corneredBubble); sfx.chatter(VOICE[who] * 1.1); }
    if (rev & RE_GASSED) pushFeed(S.gassedFeed);
    // The ghost's catch (its own round): a feed line.
    const gh = game.ghost, gph = gh && game.mode === "round" ? gh.round.phase : "";
    if (gph !== ghostPhase.current) {
      if (gph === "caught" && gh && !r.over) pushFeed(`${S.ghost} ${gh.round.stats.catchKind === "yoink" ? "yoinked" : "tagged"} him · ${gh.round.stats.catchTime.toFixed(1)} s`);
      ghostPhase.current = gph;
    }
    if (ev & (RV_CAUGHT | RV_ESCAPED)) {
      if (ev & RV_ESCAPED) { showBanner(S.escape); showBubble(LINES.escaped[who]); music.sting("escaped"); sfx.rug(); sfx.meow(true); }
      else {
        const yoink = r.stats.catchKind === "yoink";
        showBanner(yoink ? `${S.yoink}!` : "TAGGED!");
        showBubble(LINES.caught[who]);
        if (ev & RV_YOINK) sfx.yoink();
        music.sting(yoink ? "yoink" : "caught");
        sfx.jingle();
        sfx.meow();
      }
      useUi.setState({ results: buildResults(game) });
    }
    if (game.mode === "round" && r.over && game.endT > RESULTS_AFTER[r.phase === "caught" ? "caught" : "escaped"] && useUi.getState().screen !== "results") {
      useUi.setState({ screen: "results" });
    }

    const st = useUi.getState();
    // Music: calm on the title / results, the intro in the countdown, the chase groove (+ the close-chase
    // layer under 20 m or while he panics) in the round, ducked while paused. Acts only on changes.
    const inRound = game.mode === "round";
    const tgt = musicTarget({
      title: !inRound || st.screen === "title" || st.screen === "loading" || st.screen === "boot",
      results: st.screen === "results", practice: game.practice, phase: inRound ? r.phase : "",
      d: r.d, panic: run.band.panic, gassed: run.band.gassed,
    }, audio.current.layer);
    audio.current.layer = tgt.layer;
    music.update(tgt, { difficulty: game.setup.difficulty, paused: game.paused });
    // Wind while airborne / on the rope (20 Hz).
    audio.current.windAcc += delta;
    if (audio.current.windAcc >= 0.05) {
      audio.current.windAcc = 0;
      sfx.wind(sp, inRound && !game.paused && r.phase === "chase" && !b.grounded);
    }
    const mp = music.probe();
    // Auto quality: the first ~10 s of each real chase on High (never on bot pages).
    const aq = autoQ.current;
    const ui = useUi.getState();
    if (aq.frame(delta, game.runId, !BOT_PAGE && ui.autoQuality && ui.quality === "high" && game.mode === "round" && !game.practice && !game.paused && r.phase === "chase")) {
      useUi.setState({ autoLow: true });
    }
    const gr = gh?.round, res = ui.results;
    window.__play = {
      screen: st.screen, phase: r.phase, runId: game.runId, chaseSteps: r.chaseSteps, clock: r.clock, d: r.d,
      outcome: r.phase === "caught" ? "CAUGHT" : r.phase === "escaped" ? "ESCAPED" : "", catchKind: r.stats.catchKind, catchTime: r.stats.catchTime,
      ring: b.ringId, rope: b.ropeHook, player: [b.p.x, b.p.y, b.p.z],
      runner: { p: [run.p.x, run.p.y, run.p.z], mode: run.mode, phase: run.pose.phase, edge: run.edge, t: run.t, m: run.band.m, budget: run.band.budget },
      runnerPhases: [...phases.current], clips: { chaser: [...clips.current.chaser], runner: [...clips.current.runner], george: [...clips.current.george] },
      fps: fps.current, frames: frames.current, backend: st.backend,
      audio: {
        state: audioState(), muted: isMuted(), music: mp.mode, layer: mp.layer, notes: mp.scheduled, sfx: sfx.played(),
        ...(DEV ? { rms: audio.current.rms, peak: audio.current.maxPeak } : {}),
      },
      ghost: {
        recorded: game.log.n, on: !!gh, phase: gr ? gr.phase : "", steps: gr ? gr.chaseSteps : 0, n: gh ? gh.log.n : 0,
        catchTime: gr ? gr.stats.catchTime : 0, status: ui.ghost?.status ?? "", p: gh ? [game.ghostP.x, game.ghostP.y, game.ghostP.z] : null,
        url: res?.ghostCode ? ghostUrl(res.chaser, res.runner, res.difficulty, res.time, res.seed, res.ghostCode, res.mutators) : "",
      },
      autoQ: { quality: ui.quality, allowed: ui.autoQuality, fps: aq.fps, fired: aq.fired },
    };
    acc.current += delta;
    if (acc.current >= 0.1) {
      const dt = acc.current;
      acc.current = 0;
      if (DEV) {
        const lv = outputLevel();
        audio.current.rms = lv.rms;
        audio.current.maxPeak = Math.max(audio.current.maxPeak, lv.peak);
      }
      const ring = b.ringId === RING_RUNNER ? "runner" : b.ropeHook >= 0 ? "attached" : b.ringId >= 0 ? "hook" : "none";
      const rs = r.stats;
      // Wind (HUD only): push direction relative to the camera (forward = up on screen).
      const g = r.nextGust();
      let wind: { level: number; warn: number; angle: number } | null = null;
      if (g && r.phase === "chase" && (g.level > 0 || g.inSeconds <= MECH.windWarn)) {
        const yaw = game.rig.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
        wind = { level: g.level, warn: g.level > 0 ? 1 : 1 - g.inSeconds / MECH.windWarn, angle: Math.atan2(g.dx * rx + g.dz * rz, g.dx * fx + g.dz * fz) };
      }
      useUi.setState({
        round: {
          clock: r.clock, d: r.d, panic: run.band.panic, gassed: run.band.gassed, ring, speed: sp,
          countdown: r.countdown / 120, fps: fps.current, holdR: st.round.holdR,
          chain: b.chainCount, maxChain: rs.maxChain, topSpeed: rs.topSpeed, falls: rs.falls, elapsed: r.clock0 - r.clock, wind,
        },
      });
      // First-run tips (chase / practice only, never on bot pages).
      hints.tick(dt, {
        active: !BOT_PAGE && game.mode === "round" && !game.paused && (st.screen === "chase" || st.screen === "practice") && r.phase === "chase",
        grounded: b.grounded, rope: b.ropeHook >= 0, ring, chain: b.chainCount, touch: st.touch, easyGrab: game.camera.easyGrab,
      });
    }
  }, FRAME.sim);
  return null;
}

// ---- procedural props ----------------------------------------------------------------------------

/** Low-poly money bag (~70 tris): a lathed sack + a tie. */
function makeBag(): Group {
  const pts = [[0, 0], [0.11, 0.015], [0.18, 0.08], [0.19, 0.16], [0.14, 0.24], [0.06, 0.28], [0.045, 0.3], [0.08, 0.35]].map(([x, y]) => new Vector2(x, y));
  const g = new Group();
  const sack = new Mesh(new LatheGeometry(pts, 6), new MeshBasicMaterial({ color: "#d8a843" }));
  const tie = new Mesh(new LatheGeometry([new Vector2(0.055, 0.275), new Vector2(0.065, 0.3), new Vector2(0.05, 0.315)], 6), new MeshBasicMaterial({ color: "#6b3f17" }));
  // "$" badge: a flat quad with a canvas texture.
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "#d8a843"; x.fillRect(0, 0, 64, 64);
    x.fillStyle = "#3b5d16"; x.font = "bold 52px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("$", 32, 36);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const badge = new Mesh(new PlaneGeometry(0.2, 0.2), new MeshBasicMaterial({ map: tex, transparent: true }));
  badge.position.set(0, 0.15, 0.19);
  g.add(sack, tie, badge);
  g.traverse(o => (o.frustumCulled = false));
  return g;
}

/** Flying rug: a subdivided 2 x 1.2 m plane (vertex ripple each frame) with a painted pattern. */
function makeRug(): { mesh: Mesh; base: Float32Array } {
  const geo = new PlaneGeometry(2, 1.2, 16, 8);
  const c = document.createElement("canvas");
  c.width = 256; c.height = 154;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "#b0124f"; x.fillRect(0, 0, 256, 154);
    x.strokeStyle = "#f2c14e"; x.lineWidth = 10; x.strokeRect(12, 12, 232, 130);
    x.strokeStyle = "#1c2a6b"; x.lineWidth = 5; x.strokeRect(26, 26, 204, 102);
    x.fillStyle = "#f2c14e";
    for (let i = 0; i < 5; i++) { x.beginPath(); x.moveTo(64 + i * 32, 77 - 22); x.lineTo(80 + i * 32, 77); x.lineTo(64 + i * 32, 77 + 22); x.lineTo(48 + i * 32, 77); x.closePath(); x.fill(); }
    x.fillStyle = "#fff4d6";
    for (let i = 0; i < 12; i++) { x.fillRect(0, 8 + i * 12, 6, 4); x.fillRect(250, 8 + i * 12, 6, 4); }
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(geo, new MeshBasicMaterial({ map: tex, side: DoubleSide }));
  mesh.frustumCulled = false;
  return { mesh, base: (geo.getAttribute("position").array as Float32Array).slice() };
}

const TRAIL_N = 160;

/** Ribbon of the runner's last 2 s (camera-facing, tapering toward the tail). */
function makeTrail(): { mesh: Mesh; pos: Float32Array; pts: Float32Array; times: Float32Array } {
  const geo = new BufferGeometry();
  const pos = new Float32Array(TRAIL_N * 2 * 3);
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  const idx: number[] = [];
  for (let i = 0; i < TRAIL_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  geo.setIndex(idx);
  geo.setDrawRange(0, 0);
  const mesh = new Mesh(geo, new MeshBasicMaterial({ color: "#ff5ab4", transparent: true, opacity: 0.32, side: DoubleSide, depthWrite: false }));
  mesh.frustumCulled = false;
  return { mesh, pos, pts: new Float32Array(TRAIL_N * 3), times: new Float32Array(TRAIL_N) };
}

// ---- chase FX ------------------------------------------------------------------------------------

export function ChaseFx({ game }: { game: PlayGame }) {
  const rope = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const shadow = useRef<Mesh>(null);
  const lasso = useRef<Mesh>(null);
  const loop = useRef<Mesh>(null);
  const bag = useMemo(makeBag, []);
  const rug = useMemo(makeRug, []);
  const trail = useMemo(makeTrail, []);
  const ringMat = useMemo(() => new MeshBasicMaterial({ color: "#ff3355", transparent: true, opacity: 0.95, depthTest: false, side: DoubleSide }), []);
  const tmp = useMemo(() => ({
    a: new Vector3(), b: new Vector3(), c: new Vector3(), up: new Vector3(0, 1, 0), t: 0, trailN: 0, trailHead: 0, trailAcc: 0,
    hand: new Vector3(), from: new Vector3(), bagT: -1, runId: -1,
  }), []);

  const beam = (m: Mesh, a: Vector3, b: Vector3) => {
    const len = a.distanceTo(b);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(tmp.up, tmp.c.copy(b).sub(a).normalize());
    m.scale.set(1, len, 1);
  };

  useFrame((state, rawDelta) => {
    const delta = rawDelta * game.timeScale;
    tmp.t += delta;
    // Practice has no runner: none of his FX (rope, ring, shadow, bag, trail).
    const inRound = game.mode === "round" && !game.practice;
    const r = game.round, p = game.runnerP, pl = game.renderP;
    const s = game.setup;
    if (game.runId !== tmp.runId) { tmp.runId = game.runId; tmp.trailN = 0; tmp.bagT = -1; }
    const low = lowQuality();

    // His rope: RightHand -> balloon.
    const hookId = inRound && !r.over ? game.runnerRopeHook : -1;
    const ro = rope.current;
    if (ro) {
      ro.visible = hookId >= 0;
      if (hookId >= 0) {
        const h = game.model.hooks[hookId];
        if (!handWorld(s.runner, "right", tmp.a)) tmp.a.set(p.x, p.y + 0.25, p.z);
        tmp.b.set(h.x, h.y, h.z);
        beam(ro, tmp.a, tmp.b);
      }
    }
    // Red YOINK ring around him.
    const rm = ring.current;
    if (rm) {
      rm.visible = inRound && r.phase === "chase" && r.player.ringId === RING_RUNNER;
      if (rm.visible) {
        rm.position.set(p.x, p.y + 0.1, p.z);
        rm.quaternion.copy(state.camera.quaternion);
        const k = 1.1 + 0.1 * Math.sin(tmp.t * 14);
        rm.scale.set(k, k, k);
      }
    }
    // Blob shadow under him.
    const sh = shadow.current;
    if (sh) {
      sh.visible = inRound && !low;
      const g = game.index.groundBelow(p.x, p.z, p.y - 0.9 + 0.05);
      sh.position.set(p.x, g + 0.03, p.z);
      const k = 1 / (1 + Math.max(0, p.y - 0.9 - g) * 0.06);
      sh.scale.set(k, k, k);
    }
    // The bag: his LeftHand; on a catch it pops over to yours (0.35 s arc).
    bag.visible = inRound;
    if (inRound) {
      const caught = r.phase === "caught";
      if (caught && tmp.bagT < 0) { tmp.bagT = 0; tmp.from.copy(bag.position); }
      if (!handWorld(s.runner, "left", tmp.a)) tmp.a.set(p.x + 0.4, p.y - 0.1, p.z);
      tmp.a.y -= 0.3;
      if (caught) {
        tmp.bagT += rawDelta;
        if (!handWorld(s.chaser, "left", tmp.b)) tmp.b.set(pl.x + 0.4, pl.y - 0.1, pl.z);
        tmp.b.y -= 0.3;
        const k = Math.min(1, tmp.bagT / 0.35);
        bag.position.lerpVectors(tmp.from, tmp.b, k);
        bag.position.y += Math.sin(k * Math.PI) * 1.2;
        bag.rotation.y += rawDelta * 8 * (1 - k);
      } else bag.position.copy(tmp.a);
    }
    // Lasso (Yoink): your RightHand -> a loop around his waist, then reeled in.
    const la = lasso.current, lo = loop.current;
    const lassoOn = inRound && r.phase === "caught" && r.stats.catchKind === "yoink" && game.endT < 1.0;
    if (la && lo) {
      la.visible = lo.visible = lassoOn;
      if (lassoOn) {
        if (!handWorld(s.chaser, "right", tmp.a)) tmp.a.set(pl.x, pl.y + 0.4, pl.z);
        tmp.b.set(p.x, p.y - 0.2, p.z);
        beam(la, tmp.a, tmp.b);
        lo.position.copy(tmp.b);
        lo.rotation.set(Math.PI / 2, 0, 0);
        const k = 1 - Math.min(1, game.endT / 0.25) * 0.55;
        lo.scale.set(k, k, k);
      }
    }
    // Runner trail: his last 2 s, sampled at ~40 Hz.
    const tr = trail;
    tr.mesh.visible = inRound && r.phase === "chase" && !low;
    if (low) tmp.trailN = 0;
    if (tr.mesh.visible) {
      tmp.trailAcc += rawDelta;
      if (tmp.trailAcc >= 0.025) {
        tmp.trailAcc = 0;
        const i = tmp.trailHead;
        tr.pts[i * 3] = p.x; tr.pts[i * 3 + 1] = p.y + 0.1; tr.pts[i * 3 + 2] = p.z;
        tr.times[i] = tmp.t;
        tmp.trailHead = (i + 1) % TRAIL_N;
        tmp.trailN = Math.min(TRAIL_N, tmp.trailN + 1);
      }
      // Build newest -> oldest, only samples younger than 2 s.
      const cam = state.camera.position;
      let n = 0;
      for (let j = 0; j < tmp.trailN; j++) {
        const i = (tmp.trailHead - 1 - j + TRAIL_N) % TRAIL_N;
        if (tmp.t - tr.times[i] > 2) break;
        const x = tr.pts[i * 3], y = tr.pts[i * 3 + 1], z = tr.pts[i * 3 + 2];
        const k = (tmp.trailHead - 2 - j + TRAIL_N) % TRAIL_N;
        const px = j + 1 < tmp.trailN ? tr.pts[k * 3] : x, py = j + 1 < tmp.trailN ? tr.pts[k * 3 + 1] : y, pz = j + 1 < tmp.trailN ? tr.pts[k * 3 + 2] : z;
        tmp.c.set(x - px, y - py, z - pz);
        tmp.b.set(cam.x - x, cam.y - y, cam.z - z);
        tmp.a.crossVectors(tmp.c, tmp.b);
        const l = tmp.a.length();
        if (l > 1e-6) tmp.a.multiplyScalar(1 / l); else tmp.a.set(0, 1, 0);
        const w = 0.28 * (1 - (tmp.t - tr.times[i]) / 2);
        const o = n * 6;
        tr.pos[o] = x + tmp.a.x * w; tr.pos[o + 1] = y + tmp.a.y * w; tr.pos[o + 2] = z + tmp.a.z * w;
        tr.pos[o + 3] = x - tmp.a.x * w; tr.pos[o + 4] = y - tmp.a.y * w; tr.pos[o + 5] = z - tmp.a.z * w;
        n++;
      }
      tr.mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
      (tr.mesh.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    }
    // Flying rug: swoops in from behind him (RUG.arrive s), then carries him off; the cloth ripples.
    const rg = rug.mesh;
    rg.visible = inRound && r.phase === "escaped";
    if (rg.visible) {
      const e = r.pack.edges[r.runner.mode === 0 ? r.runner.edge : r.runner.next];
      const ex = e ? e.exitX : 1, ez = e ? e.exitZ : 0;
      const k = Math.min(1, game.endT / RUG.arrive);
      const inv = 1 - k;
      tmp.a.set(p.x - ex * 14 * inv, p.y - 0.95 + 5 * inv * inv, p.z - ez * 14 * inv);
      rg.position.copy(tmp.a);
      rg.rotation.set(-Math.PI / 2 + 0.15 * inv, 0, 0);
      rg.rotation.z = Math.atan2(-ez, ex); // long side along his exit
      const pos = rg.geometry.getAttribute("position") as BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = rug.base[i], y = rug.base[i + 1];
        arr[i + 2] = Math.sin(x * 3.2 + tmp.t * 9) * 0.07 + Math.sin(y * 4 + tmp.t * 6) * 0.035;
      }
      pos.needsUpdate = true;
    }
  }, FRAME.fx);
  return (
    <>
      <mesh ref={rope} visible={false}>
        <cylinderGeometry args={[0.04, 0.04, 1, 6]} />
        <meshBasicMaterial color="#fafafa" />
      </mesh>
      <mesh ref={lasso} visible={false}>
        <cylinderGeometry args={[0.045, 0.045, 1, 6]} />
        <meshBasicMaterial color="#ffcf4d" />
      </mesh>
      <mesh ref={loop} visible={false}>
        <torusGeometry args={[0.55, 0.05, 6, 20]} />
        <meshBasicMaterial color="#ffcf4d" />
      </mesh>
      <mesh ref={ring} material={ringMat} renderOrder={11} visible={false}>
        <ringGeometry args={[1.0, 1.3, 36]} />
      </mesh>
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <circleGeometry args={[0.65, 20]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.3} depthWrite={false} />
      </mesh>
      <primitive object={bag} />
      <primitive object={rug.mesh} />
      <primitive object={trail.mesh} />
    </>
  );
}

// ---- screen tracker (bubble anchor + edge arrow) -------------------------------------------------

export function ScreenTracker({ game }: { game: PlayGame }) {
  const v = useMemo(() => new Vector3(), []);
  useFrame(state => {
    const bubble = document.getElementById("rr-bubble");
    const arrow = document.getElementById("rr-arrow");
    const inRound = game.mode === "round" && !game.practice;
    const cam = state.camera;
    const p = game.runnerP;
    v.set(p.x, p.y + 1.3, p.z).project(cam);
    const w = state.size.width, h = state.size.height;
    const behind = v.z > 1;
    const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
    if (bubble) {
      bubble.style.visibility = inRound && !behind && sx > -50 && sx < w + 50 ? "visible" : "hidden";
      bubble.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
    }
    if (arrow) {
      const on = inRound && game.round.phase === "chase" && (behind || sx < 0 || sx > w || sy < 0 || sy > h);
      arrow.style.visibility = on ? "visible" : "hidden";
      if (on) {
        let dx = sx - w / 2, dy = sy - h / 2;
        if (behind) { dx = -dx; dy = -dy; }
        const a = Math.atan2(dy, dx);
        const rx = w / 2 - 48, ry = h / 2 - 48;
        const k = Math.min(rx / Math.max(1e-6, Math.abs(Math.cos(a))), ry / Math.max(1e-6, Math.abs(Math.sin(a))));
        const ax = w / 2 + Math.cos(a) * k, ay = h / 2 + Math.sin(a) * k;
        arrow.style.transform = `translate(${ax.toFixed(1)}px, ${ay.toFixed(1)}px) translate(-50%, -50%) rotate(${a.toFixed(3)}rad)`;
      }
    }
  }, FRAME.fx);
  return null;
}
