// Pockit Milady cameo (spec §11 + errata 6): she runs the balloon stand (decor.json node tagged
// Data {kind: "miladyStand"}). Decoration only: never solid, never in the sim, and the game never
// waits for her.
//  - N is chosen once per page load; the file is fetched after PLAY from jsDelivr at a pinned Pockit
//    commit, falling back to raw.githubusercontent (10 s timeout). 404 / timeout / parse error -> an
//    info log and the stand without a host.
//  - Parse, unlit swap, retarget and mount only happen on the title, in COUNTDOWN or at RESULTS, never
//    mid-chase. Idle, Big Wave Hello and Victory Cheer are retargeted from the chaser's clip pack.
//  - Blinks (only if the file binds "blink"), slow head look-at toward you, head down on an escape.
//  - ?milady=<1..3333> picks a file, ?milady=0 disables her (tests).
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useAssetRuntime } from "react-three-game";
import { AnimationMixer, Group, LoopOnce, LoopRepeat, Quaternion, Vector3, type AnimationAction, type AnimationClip, type Material, type Mesh, type MeshStandardMaterial } from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { VRM } from "@pixiv/three-vrm";
import type { PlayGame } from "../game/play.ts";
import type { RadbroId } from "../game/round.ts";
import { parseVrm } from "../vrm/loadVrm.ts";
import { MESHY_RIG, retargetClip } from "../vrm/retarget.ts";
import { clipsPath } from "./characters.ts";
import { useUi } from "../ui/store.ts";
import { FRAME } from "./frame.ts";

/** prnthh/Pockit main at the time of writing; bump deliberately. */
export const POCKIT_SHA = "8009d19eb16815e2f5e39f0fb7adaac69cf691c8";
const POCKIT_COUNT = 3333;
const TIMEOUT_MS = 10_000;
const CLIPS = ["Idle", "Big_Wave_Hello", "Victory_Cheer"] as const;

const q = new URLSearchParams(location.search);
const forced = q.has("milady") ? Number(q.get("milady")) : NaN;
export const MILADY_N = Number.isInteger(forced) && forced >= 0 && forced <= POCKIT_COUNT ? forced : 1 + Math.floor(Math.random() * POCKIT_COUNT);

export const miladyUrls = (n: number) => [
  `https://cdn.jsdelivr.net/gh/prnthh/Pockit@${POCKIT_SHA}/web/${n}.vrm`,
  `https://raw.githubusercontent.com/prnthh/Pockit/${POCKIT_SHA}/web/${n}.vrm`,
];

let fetching: Promise<{ buf: ArrayBuffer; url: string } | null> | null = null;

/** Start (once) the background fetch of her file. Called on PLAY; never awaited by the game. */
export function startMiladyFetch(): void {
  if (fetching || MILADY_N === 0) return;
  fetching = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      for (const url of miladyUrls(MILADY_N)) {
        try {
          const r = await fetch(url, { mode: "cors", signal: ctl.signal });
          if (r.ok) return { buf: await r.arrayBuffer(), url };
          console.info(`[milady] ${r.status} for ${url}`);
        } catch (e) {
          if (ctl.signal.aborted) break;
          console.info(`[milady] fetch failed for ${url}: ${String(e)}`);
        }
      }
      console.info("[milady] no file; the stand stays without a host");
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
}

type Stand = { x: number; y: number; z: number; yaw: number };

/** Her stand from decor.json (Data kind "miladyStand"), transform copied once. */
async function findStand(): Promise<Stand | null> {
  try {
    const d = await (await fetch(`/levels/decor.json?v=${Date.now()}`)).json();
    type N = { components?: Record<string, { type?: string; properties?: Record<string, unknown> }>; children?: N[] };
    let hit: Stand | null = null;
    const walk = (n: N, ox: number, oy: number, oz: number) => {
      const t = n.components?.transform?.properties ?? {};
      const p = (t.position as number[] | undefined) ?? [0, 0, 0];
      const r = (t.rotation as number[] | undefined) ?? [0, 0, 0];
      const x = ox + p[0], y = oy + p[1], z = oz + p[2];
      const data = n.components?.data?.properties?.data as { kind?: string } | undefined;
      if (!hit && data?.kind === "miladyStand") hit = { x, y, z, yaw: r[1] ?? 0 };
      for (const c of n.children ?? []) walk(c, x, y, z);
    };
    walk(d.root, 0, 0, 0);
    return hit;
  } catch {
    return null;
  }
}

function unlit(vrm: VRM): void {
  vrm.scene.traverse(o => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const convert = (m: Material) => {
      const src = m as MeshStandardMaterial;
      const out = new MeshBasicNodeMaterial({ map: src.map ?? null, color: src.color });
      Object.assign(out, { transparent: src.transparent, opacity: src.opacity, side: src.side, alphaTest: src.alphaTest, depthWrite: src.depthWrite });
      m.dispose();
      return out;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });
}

type Host = { vrm: VRM; mixer: AnimationMixer; clips: Map<string, AnimationClip>; chaser: RadbroId | ""; blink: boolean; cur: AnimationAction | null; curName: string };

export function MiladyView({ game }: { game: PlayGame }) {
  const assets = useAssetRuntime();
  const group = useMemo(() => new Group(), []);
  const state = useRef<{ stand: Stand | null; buf: { buf: ArrayBuffer; url: string } | null; busy: boolean; failed: boolean; host: Host | null; blinkT: number; blinkAt: number; look: number; nod: number; phase: string }>({
    stand: null, buf: null, busy: false, failed: false, host: null, blinkT: -1, blinkAt: 2, look: 0, nod: 0, phase: "",
  });
  const tmp = useMemo(() => ({ q: new Quaternion(), v: new Vector3() }), []);
  const screen = useUi(s => s.screen);

  useEffect(() => {
    void findStand().then(s => {
      state.current.stand = s;
      if (!s) return;
      // The stand's origin is the counter's base centre on the roof; she stands 1.25 m behind it,
      // facing the counter's front (+z local).
      const bx = s.x - Math.sin(s.yaw) * 1.25, bz = s.z - Math.cos(s.yaw) * 1.25;
      group.position.set(bx, s.y, bz);
      group.rotation.set(0, s.yaw, 0);
    });
  }, [group]);

  // PLAY starts the fetch (the only place the page reaches outside the dist).
  useEffect(() => {
    if (screen === "loading" || screen === "countdown") startMiladyFetch();
  }, [screen]);

  useFrame((_, rawDelta) => {
    const st = state.current;
    const r = game.round;
    const quiet = game.mode === "title" || r.phase !== "chase"; // never parse / retarget mid-chase
    if (fetching && !st.host && !st.buf && !st.failed && !st.busy) {
      st.busy = true;
      void fetching.then(b => { st.buf = b; st.failed = !b; st.busy = false; });
    }
    // Parse + unlit swap.
    if (st.buf && !st.host && !st.busy && quiet) {
      st.busy = true;
      const { buf, url } = st.buf;
      void parseVrm(buf, url).then(({ vrm }) => {
        unlit(vrm);
        const em = vrm.expressionManager;
        const blink = !!em?.getExpression("blink") && (em.getExpression("blink")?.binds.length ?? 0) > 0;
        st.host = { vrm, mixer: new AnimationMixer(vrm.scene), clips: new Map(), chaser: "", blink, cur: null, curName: "" };
        group.add(vrm.scene);
        console.info(`[milady] #${MILADY_N} mounted (${vrm.meta?.metaVersion === "0" ? "VRM0" : "VRM1"}, blink ${blink ? "bound" : "none"}, ${(em?.expressions ?? []).filter(e => e.binds.length > 0).length} bound expressions)`);
      }, e => {
        console.info(`[milady] parse failed: ${String(e)}`);
        st.failed = true;
      }).finally(() => { st.busy = false; st.buf = null; });
    }
    const h = st.host;
    group.visible = !!h;
    if (!h) return;
    // Retarget from the chaser's pack (once per chaser), only when quiet.
    const chaser = useUi.getState().pair?.chaser;
    if (chaser && h.chaser !== chaser && quiet) {
      const pack = assets.getModel(clipsPath(chaser));
      if (pack) {
        const t0 = performance.now();
        h.mixer.stopAllAction();
        h.cur = null;
        h.curName = "";
        h.clips.clear();
        for (const c of (pack as unknown as { animations: AnimationClip[] }).animations) {
          if ((CLIPS as readonly string[]).includes(c.name)) h.clips.set(c.name, retargetClip(c, pack, h.vrm, MESHY_RIG, { inPlace: true, alignRestPose: true }));
        }
        h.chaser = chaser;
        console.info(`[milady] retargeted ${h.clips.size} clips from #${chaser} in ${Math.round(performance.now() - t0)} ms`);
      }
    }
    const delta = rawDelta * game.timeScale;
    // Reactions: countdown wave, cheer on a catch, head down on an escape, else idle.
    const phase = game.mode === "title" ? "title" : r.phase;
    const play = (name: string, once = false) => {
      const c = h.clips.get(name);
      if (!c || h.curName === name) return;
      const a = h.mixer.clipAction(c);
      a.reset().setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
      a.clampWhenFinished = once;
      if (h.cur) a.crossFadeFrom(h.cur, 0.3, false);
      a.play();
      h.cur = a;
      h.curName = name;
    };
    if (phase !== st.phase) {
      st.phase = phase;
      h.curName = "";
      if (phase === "countdown") play("Big_Wave_Hello", true);
      else if (phase === "caught") play("Victory_Cheer");
      else play("Idle");
    }
    if (h.curName === "Big_Wave_Hello" && h.cur && !h.cur.isRunning()) play("Idle");
    if (!h.cur && h.clips.size) play(phase === "caught" ? "Victory_Cheer" : "Idle");
    h.mixer.update(delta);
    // Head: slow look-at toward you; down on an escape.
    const head = h.cur ? h.vrm.humanoid?.getNormalizedBoneNode("head") : null;
    if (head) {
      const p = game.renderP;
      const lx = p.x - group.position.x, lz = p.z - group.position.z;
      let want = 0;
      if (game.mode === "round" && lx * lx + lz * lz < 60 * 60) {
        want = Math.atan2(lx, lz) - group.rotation.y;
        while (want > Math.PI) want -= 2 * Math.PI;
        while (want < -Math.PI) want += 2 * Math.PI;
        want = Math.max(-1, Math.min(1, want));
      }
      st.look += (want - st.look) * Math.min(1, 2 * rawDelta);
      const down = phase === "escaped" ? 0.5 : 0;
      st.nod += (down - st.nod) * Math.min(1, 3 * rawDelta);
      const vrm0 = h.vrm.meta?.metaVersion === "0";
      tmp.q.setFromAxisAngle(tmp.v.set(0, 1, 0), st.look);
      head.quaternion.premultiply(tmp.q);
      tmp.q.setFromAxisAngle(tmp.v.set(1, 0, 0), vrm0 ? -st.nod : st.nod);
      head.quaternion.multiply(tmp.q);
    }
    // Random blinks (only when the file binds "blink").
    if (h.blink && h.vrm.expressionManager) {
      st.blinkAt -= rawDelta;
      if (st.blinkAt <= 0 && st.blinkT < 0) { st.blinkT = 0; st.blinkAt = 2 + Math.random() * 3.5; }
      let w = 0;
      if (st.blinkT >= 0) {
        st.blinkT += rawDelta;
        const t = st.blinkT / 0.16;
        w = t < 0.5 ? t * 2 : Math.max(0, 2 - t * 2);
        if (t >= 1) st.blinkT = -1;
      }
      h.vrm.expressionManager.setValue("blink", w);
    }
    h.vrm.update(delta);
  }, FRAME.bones);

  return <primitive object={group} />;
}
