// Canvas-side systems for the play page: PlayDriver (fixed steps, events -> UI store at 10 Hz,
// window.__probe), ActorsView (box stand-ins for the three Radbros, keyed by id), RunnerFx (his rope,
// red YOINK ring, blob shadow, bag, rug) and ScreenTracker (bubble anchor + edge arrow, DOM writes).
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { usePrefab, type GameObject, type Prefab } from "react-three-game";
import { DoubleSide, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import type { PlayGame } from "../game/play.ts";
import { RADBROS, RV_CAUGHT, RV_ESCAPED, RV_FALL, RV_GO, type RadbroId } from "../game/round.ts";
import { RE_CORNERED, RE_GASSED, RE_PANIC, RE_TAUNT, RM_EDGE } from "../runner/runner.ts";
import { RING_RUNNER } from "../sim/player.ts";
import { PHASE_ROPE } from "../route/trackPack.ts";
import { pushFeed, showBanner, showBubble, useUi, type Results } from "../ui/store.ts";
import { RADBRO_COLOR, S, TAUNTS, medal } from "../ui/strings.ts";
import { getBest, recordBest } from "../ui/prefs.ts";
import { box } from "./GameScene.tsx";
import { FRAME } from "./frame.ts";

// ---- prefab nodes -------------------------------------------------------------------------------

/** One node per Radbro (keyed by id): body box, visor, and a head child that turns. */
export function radbroActors(): { nodes: GameObject[]; materials: Prefab["materials"] } {
  const materials: Prefab["materials"] = {};
  const nodes: GameObject[] = [];
  for (const id of RADBROS) {
    const c = RADBRO_COLOR[id];
    materials[`rb${id}`] = { color: c.body, roughness: 0.75, metalness: 0 };
    materials[`rb${id}a`] = { color: c.accent, roughness: 0.6, metalness: 0 };
    nodes.push({
      id: `rb-${id}`,
      components: { transform: { type: "Transform", properties: { position: [0, -500, 0] } } },
      children: [
        box(`rb-${id}-body`, [0, -0.2, 0], [0.7, 1.4, 0.5], `rb${id}`),
        {
          id: `rb-${id}-head`,
          components: { transform: { type: "Transform", properties: { position: [0, 0.72, 0] } } },
          children: [
            box(`rb-${id}-skull`, [0, 0, 0], [0.5, 0.42, 0.46], `rb${id}`),
            box(`rb-${id}-visor`, [0, 0.03, 0.22], [0.44, 0.12, 0.06], `rb${id}a`),
            box(`rb-${id}-hat`, [0, 0.26, 0], [0.54, 0.1, 0.5], `rb${id}a`),
          ],
        },
      ],
    });
  }
  return { nodes, materials };
}

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
  player: [number, number, number];
  runner: { p: [number, number, number]; mode: number; phase: number; edge: number; t: number; m: number; budget: number };
  runnerPhases: number[];
  fps: number;
  frames: number;
  backend: string;
};

declare global {
  interface Window {
    __play?: PlayProbe;
  }
}

function buildResults(game: PlayGame): Results {
  const r = game.round, st = r.stats, s = game.setup;
  const caught = r.phase === "caught";
  const best = getBest(s.chaser, s.difficulty);
  let newBest = false;
  if (caught) {
    const prev = recordBest(s.chaser, s.difficulty, st.catchTime);
    newBest = prev === null || st.catchTime < prev;
  }
  return {
    caught, kind: st.catchKind, time: st.catchTime, closest: st.closest, maxChain: st.maxChain, topSpeed: st.topSpeed, falls: st.falls,
    medal: caught ? medal(s.difficulty, st.catchTime) : "", best, newBest, runner: s.runner, chaser: s.chaser, difficulty: s.difficulty,
  };
}

export function PlayDriver({ game }: { game: PlayGame }) {
  const acc = useRef(0);
  const fps = useRef(60);
  const frames = useRef(0);
  const phases = useRef(new Set<number>());
  const lastRun = useRef(-1);
  const taunts = useRef(0);
  useFrame((_, delta) => {
    game.frame(delta);
    frames.current++;
    fps.current = fps.current * 0.95 + (1 / Math.max(delta, 1e-3)) * 0.05;
    const r = game.round, run = r.runner;
    if (game.runId !== lastRun.current) {
      lastRun.current = game.runId;
      phases.current.clear();
      if (game.mode === "round") showBubble(S.countdownBubble);
    }
    phases.current.add(run.pose.phase);
    // Events -> strings (§12).
    const ev = game.roundEvents, rev = game.runnerEvents;
    if (ev & RV_GO) { useUi.setState({ screen: "chase" }); showBanner(S.go); }
    if (ev & RV_FALL) { showBanner(S.fall); pushFeed(S.fall); useUi.setState({ fade: performance.now() }); }
    if (rev & RE_TAUNT) showBubble(TAUNTS[game.setup.runner][taunts.current++ % TAUNTS[game.setup.runner].length]);
    if (rev & RE_PANIC) showBubble(S.panicBubble);
    if (rev & RE_CORNERED) showBubble(S.corneredBubble);
    if (rev & RE_GASSED) pushFeed(S.gassedFeed);
    if (ev & (RV_CAUGHT | RV_ESCAPED)) {
      if (ev & RV_ESCAPED) { showBanner(S.escape); showBubble("gm, bagholder"); }
      else showBanner(r.stats.catchKind === "yoink" ? `${S.yoink}!` : "TAGGED!");
      useUi.setState({ results: buildResults(game) });
    }
    if (game.mode === "round" && r.over && game.endT > 1.4 && useUi.getState().screen !== "results") useUi.setState({ screen: "results" });

    const st = useUi.getState();
    const b = r.player;
    window.__play = {
      screen: st.screen, phase: r.phase, runId: game.runId, chaseSteps: r.chaseSteps, clock: r.clock, d: r.d,
      outcome: r.phase === "caught" ? "CAUGHT" : r.phase === "escaped" ? "ESCAPED" : "", catchKind: r.stats.catchKind, catchTime: r.stats.catchTime,
      ring: b.ringId, player: [b.p.x, b.p.y, b.p.z],
      runner: { p: [run.p.x, run.p.y, run.p.z], mode: run.mode, phase: run.pose.phase, edge: run.edge, t: run.t, m: run.band.m, budget: run.band.budget },
      runnerPhases: [...phases.current], fps: fps.current, frames: frames.current, backend: st.backend,
    };
    acc.current += delta;
    if (acc.current >= 0.1) {
      acc.current = 0;
      const sp = Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z);
      const ring = b.ringId === RING_RUNNER ? "runner" : b.ropeHook >= 0 ? "attached" : b.ringId >= 0 ? "hook" : "none";
      useUi.setState({
        round: {
          clock: r.clock, d: r.d, panic: run.band.panic, gassed: run.band.gassed, ring, speed: sp,
          countdown: r.countdown / 120, fps: fps.current, holdR: st.round.holdR,
        },
      });
    }
  }, FRAME.sim);
  return null;
}

// ---- actors --------------------------------------------------------------------------------------

type Facing = { yaw: number };

function faceToward(f: Facing, vx: number, vz: number, delta: number, rate = 12): void {
  if (vx * vx + vz * vz < 0.25) return;
  const want = Math.atan2(vx, vz);
  let d = want - f.yaw;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  f.yaw += d * Math.min(1, rate * delta);
}

export function ActorsView({ game }: { game: PlayGame }) {
  const prefab = usePrefab();
  const tmp = useMemo(() => ({
    up: new Vector3(0, 1, 0), dir: new Vector3(), q: new Quaternion(), qYaw: new Quaternion(), qTilt: new Quaternion(),
    chaser: { yaw: 0 } as Facing, runner: { yaw: 0 } as Facing, head: 0, xAxis: new Vector3(1, 0, 0),
  }), []);
  useFrame((_, delta) => {
    const s = game.setup;
    const inRound = game.mode === "round";
    const r = game.round;
    for (const id of RADBROS as readonly RadbroId[]) {
      const o = prefab.getObject(`rb-${id}`);
      if (!o) continue;
      const isChaser = inRound && id === s.chaser, isRunner = inRound && id === s.runner;
      o.visible = isChaser || isRunner;
      if (!o.visible) { o.position.set(0, -500, 0); continue; }
      const p = isChaser ? game.renderP : game.runnerP;
      o.position.set(p.x, p.y, p.z);
      const f = isChaser ? tmp.chaser : tmp.runner;
      if (isChaser) {
        const b = r.player;
        if (r.phase === "countdown") f.yaw = Math.atan2(game.runnerP.x - p.x, game.runnerP.z - p.z);
        else if (r.over) faceToward(f, game.runnerP.x - p.x, game.runnerP.z - p.z, delta, 4);
        else faceToward(f, b.v.x, b.v.z, delta);
      } else {
        const run = r.runner;
        if (r.phase === "countdown") f.yaw = Math.atan2(game.renderP.x - p.x, game.renderP.z - p.z);
        else if (r.phase === "caught") faceToward(f, game.renderP.x - p.x, game.renderP.z - p.z, delta, 4);
        else if (run.mode === RM_EDGE) faceToward(f, game.runnerVel.x, game.runnerVel.z, delta);
      }
      tmp.qYaw.setFromAxisAngle(tmp.up, f.yaw);
      // Rope tilt: body-up toward the hook.
      let hookId = -1;
      if (isChaser && r.player.ropeHook >= 0) hookId = r.player.ropeHook;
      if (isRunner && r.runner.pose.phase === PHASE_ROPE && !r.over) hookId = r.runner.pose.ref;
      if (hookId >= 0) {
        const h = game.model.hooks[hookId];
        tmp.dir.set(h.x - p.x, h.y - p.y, h.z - p.z).normalize();
        tmp.qTilt.setFromUnitVectors(tmp.up, tmp.dir);
        tmp.q.multiplyQuaternions(tmp.qTilt, tmp.qYaw);
      } else if (isRunner && r.phase === "caught") {
        // He flops.
        tmp.qTilt.setFromAxisAngle(tmp.xAxis, -Math.min(1.45, game.endT * 4));
        tmp.q.multiplyQuaternions(tmp.qYaw, tmp.qTilt);
      } else tmp.q.copy(tmp.qYaw);
      o.quaternion.slerp(tmp.q, Math.min(1, 14 * delta));
      // Runner head: look-back at you, then the head turn toward the chosen exit (the tell).
      if (isRunner) {
        const head = prefab.getObject(`rb-${id}-head`);
        const run = r.runner;
        let want = 0;
        if (run.headX !== 0 || run.headZ !== 0) want = Math.atan2(run.headX, run.headZ) - f.yaw;
        else if (run.lookAt || r.phase === "countdown") want = Math.atan2(game.renderP.x - p.x, game.renderP.z - p.z) - f.yaw;
        while (want > Math.PI) want -= 2 * Math.PI;
        while (want < -Math.PI) want += 2 * Math.PI;
        want = Math.max(-1.4, Math.min(1.4, want));
        tmp.head += (want - tmp.head) * Math.min(1, 16 * delta);
        if (head) head.rotation.set(0, tmp.head, 0);
      }
    }
  }, FRAME.actors);
  return null;
}

// ---- runner FX -----------------------------------------------------------------------------------

export function RunnerFx({ game }: { game: PlayGame }) {
  const rope = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const shadow = useRef<Mesh>(null);
  const bag = useRef<Mesh>(null);
  const rug = useRef<Mesh>(null);
  const lasso = useRef<Mesh>(null);
  const ringMat = useMemo(() => new MeshBasicMaterial({ color: "#ff3355", transparent: true, opacity: 0.95, depthTest: false, side: DoubleSide }), []);
  const tmp = useMemo(() => ({ a: new Vector3(), b: new Vector3(), up: new Vector3(0, 1, 0), t: 0 }), []);
  useFrame((state, delta) => {
    tmp.t += delta;
    const inRound = game.mode === "round";
    const r = game.round, p = game.runnerP, pl = game.renderP;
    const hookId = inRound && !r.over ? game.runnerRopeHook : -1;
    const ro = rope.current;
    if (ro) {
      ro.visible = hookId >= 0;
      if (hookId >= 0) {
        const h = game.model.hooks[hookId];
        tmp.a.set(p.x, p.y + 0.25, p.z);
        tmp.b.set(h.x, h.y, h.z);
        const len = tmp.a.distanceTo(tmp.b);
        ro.position.copy(tmp.a).add(tmp.b).multiplyScalar(0.5);
        ro.quaternion.setFromUnitVectors(tmp.up, tmp.b.sub(tmp.a).normalize());
        ro.scale.set(1, len, 1);
      }
    }
    const rm = ring.current;
    if (rm) {
      rm.visible = inRound && r.phase === "chase" && r.player.ringId === RING_RUNNER;
      if (rm.visible) {
        rm.position.set(p.x, p.y + 0.2, p.z);
        rm.quaternion.copy(state.camera.quaternion);
        const s = 1.1 + 0.1 * Math.sin(tmp.t * 14);
        rm.scale.set(s, s, s);
      }
    }
    const sh = shadow.current;
    if (sh) {
      sh.visible = inRound;
      const g = game.index.groundBelow(p.x, p.z, p.y - 0.9 + 0.05);
      sh.position.set(p.x, g + 0.03, p.z);
      const s = 1 / (1 + Math.max(0, p.y - 0.9 - g) * 0.06);
      sh.scale.set(s, s, s);
    }
    const bg = bag.current;
    if (bg) {
      bg.visible = inRound;
      const holder = r.phase === "caught" ? pl : p;
      bg.position.set(holder.x + 0.45, holder.y - 0.1 + (r.phase === "caught" ? 0.25 * Math.abs(Math.sin(tmp.t * 5)) : 0), holder.z);
      bg.rotation.y += delta * 2;
    }
    const rg = rug.current;
    if (rg) {
      rg.visible = inRound && r.phase === "escaped";
      if (rg.visible) {
        rg.position.set(p.x, p.y - 1.0, p.z);
        rg.rotation.set(-Math.PI / 2 + 0.12 * Math.sin(tmp.t * 6), 0, 0.1 * Math.sin(tmp.t * 4));
      }
    }
    const la = lasso.current;
    if (la) {
      la.visible = inRound && r.phase === "caught" && r.stats.catchKind === "yoink" && game.endT < 1.4;
      if (la.visible) {
        tmp.a.set(pl.x, pl.y + 0.4, pl.z);
        tmp.b.set(p.x, p.y, p.z);
        const len = tmp.a.distanceTo(tmp.b);
        la.position.copy(tmp.a).add(tmp.b).multiplyScalar(0.5);
        la.quaternion.setFromUnitVectors(tmp.up, tmp.b.sub(tmp.a).normalize());
        la.scale.set(1, len, 1);
      }
    }
  }, FRAME.fx);
  return (
    <>
      <mesh ref={rope} visible={false}>
        <cylinderGeometry args={[0.045, 0.045, 1, 6]} />
        <meshBasicMaterial color="#fafafa" />
      </mesh>
      <mesh ref={lasso} visible={false}>
        <cylinderGeometry args={[0.05, 0.05, 1, 6]} />
        <meshBasicMaterial color="#ffcf4d" />
      </mesh>
      <mesh ref={ring} material={ringMat} renderOrder={11} visible={false}>
        <ringGeometry args={[1.0, 1.3, 36]} />
      </mesh>
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <circleGeometry args={[0.65, 20]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.3} depthWrite={false} />
      </mesh>
      <mesh ref={bag} visible={false}>
        <icosahedronGeometry args={[0.28, 1]} />
        <meshBasicMaterial color="#e7b416" />
      </mesh>
      <mesh ref={rug} visible={false}>
        <planeGeometry args={[2.2, 1.3, 6, 3]} />
        <meshBasicMaterial color="#c2185b" side={DoubleSide} />
      </mesh>
    </>
  );
}

// ---- screen tracker (bubble anchor + edge arrow) -------------------------------------------------

export function ScreenTracker({ game }: { game: PlayGame }) {
  const v = useMemo(() => new Vector3(), []);
  useFrame(state => {
    const bubble = document.getElementById("rr-bubble");
    const arrow = document.getElementById("rr-arrow");
    const inRound = game.mode === "round";
    const cam = state.camera;
    const p = game.runnerP;
    v.set(p.x, p.y + 1.6, p.z).project(cam);
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
