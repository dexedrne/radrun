// The raced ghost (game/ghost.ts): a translucent copy of the challenger's Radbro replaying the recorded run
// from its own render-only Round (PlayGame.ghost). Never solid, never part of your round. Hidden in the
// countdown (it starts where you start), shown from GO; after its catch it cheers for a moment and fades;
// it also fades once your own round is over. A small "GHOST" tag floats over it (#rr-ghost-tag, RoundHud).
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useAssetRuntime } from "react-three-game";
import { Color, Matrix4, MeshBasicMaterial, Quaternion, Vector3, type Mesh, type MeshStandardMaterial } from "three";
import type { PlayGame } from "../game/play.ts";
import { EV_ATTACH, EV_BONK, EV_JUMP, EV_LAND, EV_RELEASE } from "../sim/player.ts";
import { A_ATTACH, A_BONK, A_JUMP, A_LAND, A_RELEASE, type Beat } from "../anim/animMachine.ts";
import { applyCmd, makeRig } from "./ActorsView.tsx";
import { clipsPath, modelPath } from "./characters.ts";
import { useUi } from "../ui/store.ts";
import { FRAME } from "./frame.ts";

const TINT = new Color("#9fe6ff");
const GLOW = new Color("#1f5f80");
const OPACITY = 0.55;
/** Seconds the ghost stays (cheering) after its own catch. */
const LINGER = 1.5;

const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

export function GhostView({ game }: { game: PlayGame }) {
  const id = useUi(s => s.ghost?.chaser ?? null);
  const pair = useUi(s => s.pair);
  const assets = useAssetRuntime();
  const rig = useMemo(() => {
    if (!id || !pair) return null;
    const src = assets.getModel(modelPath(id));
    if (!src) return null;
    const r = makeRig(id, src, assets.getModel(clipsPath(id)));
    r.root.name = "ghost";
    r.root.visible = false;
    for (const m of r.materials) {
      m.transparent = true;
      m.opacity = 0;
      m.depthWrite = false;
      const sm = m as MeshStandardMaterial;
      if (sm.color) sm.color.lerp(TINT, 0.6);
      if (sm.emissive) { sm.emissive.copy(GLOW); sm.emissiveIntensity = 1; }
      m.needsUpdate = true;
    }
    return r;
  }, [assets, id, pair]);
  useEffect(() => () => {
    if (!rig) return;
    rig.player.dispose();
    for (const m of rig.materials) m.dispose();
  }, [rig]);
  const rope = useRef<Mesh>(null);
  const ropeMat = useMemo(() => new MeshBasicMaterial({ color: "#c8f3ff", transparent: true, opacity: 0, depthWrite: false }), []);
  const st = useMemo(() => ({
    alpha: 0, doneT: 0, runId: -1, visible: false,
    q: new Quaternion(), m: new Matrix4(), u: new Vector3(), f: new Vector3(), x: new Vector3(), v: new Vector3(),
    a: new Vector3(), b: new Vector3(), c: new Vector3(), up: new Vector3(0, 1, 0), qYaw: new Quaternion(),
  }), []);

  // -5: fade, root, facing, rope tilt, animMachine.
  useFrame((_, rawDelta) => {
    if (!rig) return;
    const g = game.ghost;
    if (game.runId !== st.runId) { st.runId = game.runId; st.alpha = 0; st.doneT = 0; }
    if (!g || game.mode !== "round" || game.practice) { rig.root.visible = st.visible = false; return; }
    const gr = g.round, b = gr.player, live = game.round;
    if (g.done) st.doneT += rawDelta;
    const want = live.phase === "countdown" || live.over || st.doneT > LINGER ? 0 : 1;
    st.alpha += (want - st.alpha) * Math.min(1, (want > st.alpha ? 4 : 3) * rawDelta);
    st.visible = st.alpha > 0.02;
    rig.root.visible = st.visible;
    if (!st.visible) return;
    for (const m of rig.materials) m.opacity = OPACITY * st.alpha;

    const p = game.ghostP;
    const hook = !g.done && b.ropeHook >= 0 ? b.ropeHook : -1;
    rig.hook = hook;
    rig.p.set(p.x, p.y, p.z);
    const fe = game.ghostEvents;
    let ev = 0;
    if (fe & EV_JUMP) ev |= A_JUMP;
    if (fe & EV_ATTACH) ev |= A_ATTACH;
    if (fe & EV_RELEASE) ev |= A_RELEASE;
    if (fe & EV_LAND) ev |= A_LAND;
    if (fe & EV_BONK) ev |= A_BONK;
    const vx = b.v.x, vy = b.v.y, vz = b.v.z;
    const speed = g.done ? 0 : Math.sqrt(vx * vx + vz * vz);
    const beat: Beat = gr.phase === "caught" ? "cheer" : "";
    applyCmd(rig.player, rig.machine.step({
      dt: rawDelta * game.timeScale, grounded: b.grounded || g.done, rope: hook >= 0, speed, vy, events: ev, landVy: b.landVy, panic: false, beat,
      clearance: p.y - 0.9 - game.index.groundBelow(p.x, p.z, p.y - 0.9),
    }));

    const faceTo = (x: number, z: number, rate: number) => {
      if (x * x + z * z < 1e-4) return;
      rig.yaw += wrap(Math.atan2(x, z) - rig.yaw) * Math.min(1, rate * rawDelta);
    };
    if (gr.phase === "caught") faceTo(gr.runner.p.x - p.x, gr.runner.p.z - p.z, 5);
    else if (speed > 0.5) faceTo(vx, vz, 12);

    // Root: feet at p - 0.9; on the rope the body hangs from RightHand at p (as ActorsView's chaser).
    st.qYaw.setFromAxisAngle(st.up, rig.yaw);
    let tx = 0, ty = -0.9, tz = 0;
    if (hook >= 0) {
      const h = game.model.hooks[hook];
      st.u.set(h.x - p.x, h.y - p.y, h.z - p.z).normalize();
      st.v.set(vx, vy, vz);
      st.f.copy(st.v).addScaledVector(st.u, -st.v.dot(st.u));
      if (st.f.lengthSq() < 0.5) {
        st.f.set(Math.sin(rig.yaw), 0, Math.cos(rig.yaw));
        st.f.addScaledVector(st.u, -st.f.dot(st.u));
      }
      st.f.normalize();
      st.x.crossVectors(st.u, st.f).normalize();
      st.f.crossVectors(st.x, st.u);
      st.m.makeBasis(st.x, st.u, st.f);
      st.q.setFromRotationMatrix(st.m);
      faceTo(st.f.x, st.f.z, 12);
      tx = -rig.hand * st.u.x; ty = -rig.hand * st.u.y; tz = -rig.hand * st.u.z;
    } else st.q.copy(st.qYaw);
    rig.ropeW += ((hook >= 0 ? 1 : 0) - rig.ropeW) * Math.min(1, (hook >= 0 ? 6 : 10) * rawDelta);
    const k = Math.min(1, 14 * rawDelta);
    rig.off.x += (tx - rig.off.x) * k; rig.off.y += (ty - rig.off.y) * k; rig.off.z += (tz - rig.off.z) * k;
    rig.root.position.set(p.x + rig.off.x, p.y + rig.off.y, p.z + rig.off.z);
    rig.root.quaternion.slerp(st.q, Math.min(1, 14 * rawDelta));
  }, FRAME.actors);

  // -4: mixer.
  useFrame((_, delta) => {
    if (rig && st.visible) rig.player.update(delta * game.timeScale);
  }, FRAME.animator);

  // -3: rope-hand correction (RightHand lands on p while hanging).
  useFrame(() => {
    if (!rig || !st.visible) return;
    const rh = rig.bones.rightHand;
    if (rh && rig.ropeW > 0.01) {
      rig.root.updateMatrixWorld(true);
      rh.getWorldPosition(st.a);
      st.b.copy(rig.p).sub(st.a).multiplyScalar(rig.ropeW);
      rig.root.position.add(st.b);
    }
  }, FRAME.bones);

  // -1: the ghost's rope and the floating tag.
  useFrame(state => {
    const ro = rope.current;
    const tag = document.getElementById("rr-ghost-tag");
    const on = !!rig && st.visible;
    if (ro) {
      ro.visible = on && rig!.hook >= 0;
      if (ro.visible) {
        const h = game.model.hooks[rig!.hook];
        if (rig!.bones.rightHand) rig!.bones.rightHand.getWorldPosition(st.a); else st.a.copy(rig!.p);
        st.b.set(h.x, h.y, h.z);
        const len = st.a.distanceTo(st.b);
        ro.position.copy(st.a).add(st.b).multiplyScalar(0.5);
        ro.quaternion.setFromUnitVectors(st.up, st.c.copy(st.b).sub(st.a).normalize());
        ro.scale.set(1, len, 1);
        ropeMat.opacity = 0.55 * st.alpha;
      }
    }
    if (tag) {
      let show = on;
      if (show) {
        const p = game.ghostP;
        st.c.set(p.x, p.y + 1.35, p.z).project(state.camera);
        const w = state.size.width, hgt = state.size.height;
        const sx = (st.c.x * 0.5 + 0.5) * w, sy = (-st.c.y * 0.5 + 0.5) * hgt;
        show = st.c.z < 1 && sx > -40 && sx < w + 40 && sy > -40 && sy < hgt + 40;
        if (show) tag.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
        tag.style.opacity = st.alpha.toFixed(2);
      }
      tag.style.visibility = show ? "visible" : "hidden";
    }
  }, FRAME.fx);

  return (
    <>
      {rig && <primitive object={rig.root} />}
      <mesh ref={rope} material={ropeMat} visible={false}>
        <cylinderGeometry args={[0.035, 0.035, 1, 6]} />
      </mesh>
    </>
  );
}
