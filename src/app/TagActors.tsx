// Spider-tag views: every Radbro of the match as a skinned model driven from its Body (the chaser logic of
// ActorsView, one rig per slot, duplicates allowed), the web lines of the other players (FxView draws yours), the
// money bag in the holder's left hand with a red marker over him, the web tangle round a frozen holder, the red ring
// on your target when your Yoink is up, and the DOM overlays: name tags with bag clocks and the edge arrow.
import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useAssetRuntime } from "react-three-game";
import {
  ConeGeometry, DoubleSide, IcosahedronGeometry, Matrix4, Mesh, MeshBasicMaterial, Quaternion, RingGeometry, Vector3, CylinderGeometry, Euler,
} from "three";
import type { TagGame } from "../game/tagGame.ts";
import {
  EV_ATTACH, EV_BIGLAND, EV_BONK, EV_CHARGE, EV_CHARGE_START, EV_CLIMB, EV_DIVE, EV_DJUMP, EV_JUMP, EV_LAND, EV_LEDGE, EV_POP, EV_REBOUND, EV_RELEASE,
  EV_ROLL, EV_SLIDE, EV_VAULT, EV_WALLJUMP, EV_WALLRUN, EV_YANK, EV_ZIP, EV_ZIP_END, LEDGE_HANG, RING_RUNNER, EV_PERFECT, hangPoint, type Body,
} from "../sim/player.ts";
import {
  A_ATTACH, A_BIGLAND, A_BONK, A_CHARGE, A_CLIMB, A_DIVE, A_DJUMP, A_JUMP, A_LAND, A_LEAP, A_LEDGE, A_POP, A_RELEASE, A_ROLL, A_SLIDE, A_VAULT, A_WALLJUMP,
  A_WALLRUN, A_ZIP, type Beat,
} from "../anim/animMachine.ts";
import { applyCmd, makeRig, rotateBoneWorld, type ActorRig } from "./ActorsView.tsx";
import { makeBag } from "./PlayViews.tsx";
import { clipsPath, modelPath } from "./characters.ts";
import { FRAME } from "./frame.ts";
import { airBones, airInput, placeRoot, stepAirPose, type AirPoseIn } from "./airPose.ts";
import { PH_COUNTDOWN, PH_OVER } from "../game/tagMatch.ts";
import type { RadbroId } from "../game/round.ts";

const UP = new Vector3(0, 1, 0);
const POSE = { wallRoll: 0.61, runUpPitch: -1.05, slidePitch: -0.35, swingHips: 0.35, leftArmBack: 0.61, ropeFace: 6 } as const;
/** Slot colours (name tags, the HUD, the web tint of the others). */
export const SLOT_COLORS = ["#ff3d7f", "#9fe6ff", "#ffd23f", "#8dff8a", "#c79bff", "#ff9d4d", "#ffffff", "#5ad1c9"];

const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/** The rigs of the current match by slot (FxView's rope hand for your Radbro reads slot `local`). */
export const tagRigs: (ActorRig | null)[] = [];

function evBits(fe: number): number {
  let ev = 0;
  if (fe & EV_JUMP) ev |= A_JUMP;
  if (fe & EV_DJUMP) ev |= A_DJUMP;
  if (fe & (EV_ATTACH | EV_ZIP)) ev |= A_ATTACH;
  if (fe & (EV_RELEASE | EV_ZIP_END)) ev |= A_RELEASE;
  if (fe & EV_LAND) ev |= A_LAND;
  if (fe & EV_BONK) ev |= A_BONK;
  if (fe & EV_WALLRUN) ev |= A_WALLRUN;
  if (fe & EV_WALLJUMP) ev |= A_WALLJUMP;
  if (fe & EV_LEDGE) ev |= A_LEDGE;
  if (fe & EV_CLIMB) ev |= A_CLIMB;
  if (fe & EV_VAULT) ev |= A_VAULT;
  if (fe & EV_SLIDE) ev |= A_SLIDE;
  if (fe & EV_ROLL) ev |= A_ROLL;
  if (fe & EV_BIGLAND) ev |= A_BIGLAND;
  if (fe & (EV_ZIP | EV_YANK)) ev |= A_ZIP;
  if (fe & EV_CHARGE_START) ev |= A_CHARGE;
  if (fe & EV_CHARGE) ev |= A_LEAP;
  if (fe & (EV_POP | EV_REBOUND)) ev |= A_POP;
  if (fe & EV_DIVE) ev |= A_DIVE;
  return ev;
}

/** Where a body's web goes this frame (rope anchor, corner post, zip / yank target), or null. */
function webEnd(b: Body, game: TagGame, slot: number, out: Vector3): Vector3 | null {
  if (hangPoint(b, out)) return out;
  if (b.zipOn) return out.set(b.zipP.x, b.zipP.y, b.zipP.z);
  if (b.yankOn) {
    const m = game.match!, t = m.target[slot];
    if (t >= 0) { const q = game.renderPs[t]; return out.set(q.x, q.y + 0.3, q.z); }
  }
  return null;
}

export function TagActors({ game, slots }: { game: TagGame; slots: RadbroId[] }) {
  const assets = useAssetRuntime();
  const key = slots.join(",");
  const rigList = useMemo(() => slots.map(id => {
    const src = assets.getModel(modelPath(id));
    return src ? makeRig(id, src, assets.getModel(clipsPath(id))) : null;
  }), [assets, key]);
  useEffect(() => {
    tagRigs.length = 0;
    rigList.forEach((r, i) => { tagRigs[i] = r; if (r) r.root.visible = false; });
    return () => {
      for (const r of rigList) { if (!r) continue; r.player.dispose(); for (const m of r.materials) m.dispose(); }
      tagRigs.length = 0;
    };
  }, [rigList]);

  const fx = useMemo(() => {
    const webMat = new MeshBasicMaterial({ color: "#f4f7ff" });
    const webs = slots.map(() => { const m = new Mesh(new CylinderGeometry(0.0175, 0.0175, 1, 6), webMat); m.visible = false; m.frustumCulled = false; return m; });
    const bag = makeBag();
    bag.visible = false;
    const marker = new Mesh(new ConeGeometry(0.28, 0.55, 4), new MeshBasicMaterial({ color: "#ff3355", transparent: true, opacity: 0.9, depthTest: false }));
    marker.rotation.x = Math.PI;
    marker.renderOrder = 10;
    marker.visible = false;
    const tangle = new Mesh(new IcosahedronGeometry(0.95, 1), new MeshBasicMaterial({ color: "#f4f7ff", wireframe: true, transparent: true, opacity: 0.8 }));
    tangle.visible = false;
    const ring = new Mesh(new RingGeometry(0.62, 0.78, 32), new MeshBasicMaterial({ color: "#ff3355", side: DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    ring.renderOrder = 11;
    ring.visible = false;
    return { webs, bag, marker, tangle, ring, webMat };
  }, [key]);
  useEffect(() => () => {
    for (const w of fx.webs) w.geometry.dispose();
    fx.webMat.dispose();
  }, [fx]);

  const tmp = useMemo(() => ({
    q: new Quaternion(), qYaw: new Quaternion(), qPose: new Quaternion(), m: new Matrix4(), eu: new Euler(),
    u: new Vector3(), f: new Vector3(), x: new Vector3(), v: new Vector3(), a: new Vector3(), b: new Vector3(), c: new Vector3(), e: new Vector3(),
    pq: new Quaternion(), wq: new Quaternion(), axis: new Vector3(), fwd: new Vector3(), pos: new Vector3(),
    ain: { dt: 0, dive: false, fall: false, hanging: false, arc: 0, perfect: false, near: false } as AirPoseIn,
  }), []);

  // -5: roots, facing, rope tilt, animMachine (as ActorsView's chaser branch, for every slot).
  useFrame((_, rawDelta) => {
    const m = game.match;
    const on = game.mode === "match" && !!m;
    for (let i = 0; i < rigList.length; i++) {
      const rig = rigList[i];
      if (!rig) continue;
      rig.root.visible = on;
      if (!on || !m || i >= m.n) { rig.root.visible = false; continue; }
      const b = m.bodies[i], p = game.renderPs[i];
      rig.p.set(p.x, p.y, p.z);
      const over = m.phase === PH_OVER;
      const anchor = !over ? hangPoint(b, tmp.a) : null;
      rig.hook = anchor ? 1 : -1;
      rig.zip = !over && (b.zipOn || b.yankOn);
      const vx = b.v.x, vy = b.v.y, vz = b.v.z;
      const speed = over || game.match!.stuck(i) ? 0 : Math.sqrt(vx * vx + vz * vz);
      const wall = over ? 0 : b.wallMode, ledge = over ? 0 : Math.min(2, b.ledgeMode), slide = !over && b.slideT > 0 && b.grounded;
      const nx = wall ? b.wallNx : b.ledgeNx, nz = wall ? b.wallNz : b.ledgeNz;
      let beat: Beat = "";
      if (m.phase === PH_COUNTDOWN) beat = "idle";
      else if (over) beat = i === game.winner ? "cheer" : i === m.holder ? "flop" : "idle";
      const wallSide = nx * -Math.cos(rig.yaw) + nz * Math.sin(rig.yaw) > 0 ? 1 : -1;
      const clear = p.y - 0.9 - game.index.groundBelow(p.x, p.z, p.y - 0.9);
      applyCmd(rig.player, rig.machine.step({
        dt: rawDelta, grounded: b.grounded || beat === "idle" || beat === "cheer" || beat === "flop", rope: anchor !== null, speed, vy, events: evBits(game.slotEvents[i] ?? 0),
        landVy: b.landVy, panic: false, beat, clearance: clear,
        wall, ledge, slide, wallSide, zip: rig.zip, charge: !over && b.chargeT > 0, dive: !over && b.diveOn,
      }));
      // The web-slinger air poses (as ActorsView's chaser).
      const free = !b.grounded && !anchor && !rig.zip && !wall && !ledge && beat === "";
      stepAirPose(rig.air, airInput(tmp.ain, rawDelta, !over && b.diveOn && beat === "", free, beat === "" ? anchor : null, p, vy, clear,
        ((game.slotEvents[i] ?? 0) & EV_PERFECT) !== 0));
      const faceTo = (x: number, z: number, rate: number) => {
        if (x * x + z * z < 1e-4) return;
        rig.yaw += wrap(Math.atan2(x, z) - rig.yaw) * Math.min(1, rate * rawDelta);
      };
      const look = i === m.holder ? m.target[i] : m.holder;
      if (m.phase === PH_COUNTDOWN || game.match!.stuck(i)) { if (look >= 0) { const q = game.renderPs[look]; faceTo(q.x - p.x, q.z - p.z, 6); } }
      else if ((wall === 2 || ledge) && (nx || nz)) faceTo(-nx, -nz, 14);
      else if (speed > 0.5) faceTo(vx, vz, 12);
      tmp.qYaw.setFromAxisAngle(UP, rig.yaw);
      let tx = 0, ty = -0.9, tz = 0;
      rig.hand.copy(rig.p);
      if (ledge === 1) rig.hand.set(p.x - nx * 0.12, p.y + LEDGE_HANG, p.z - nz * 0.12);
      if (anchor) {
        tmp.u.set(anchor.x - p.x, anchor.y - p.y, anchor.z - p.z).normalize();
        tmp.v.set(vx, vy, vz);
        tmp.f.copy(tmp.v).addScaledVector(tmp.u, -tmp.v.dot(tmp.u));
        if (tmp.f.lengthSq() < 0.5) { tmp.f.set(Math.sin(rig.yaw), 0, Math.cos(rig.yaw)); tmp.f.addScaledVector(tmp.u, -tmp.f.dot(tmp.u)); }
        tmp.f.normalize();
        tmp.x.crossVectors(tmp.u, tmp.f).normalize();
        tmp.f.crossVectors(tmp.x, tmp.u);
        tmp.m.makeBasis(tmp.x, tmp.u, tmp.f);
        tmp.q.setFromRotationMatrix(tmp.m);
        faceTo(tmp.f.x, tmp.f.z, POSE.ropeFace);
        tx = -rig.hand_ * tmp.u.x; ty = -rig.hand_ * tmp.u.y; tz = -rig.hand_ * tmp.u.z;
      } else {
        let wantRoll = 0, wantPitch = 0;
        if (rig.machine.posed) { /* the clip owns the pose */ }
        else if (wall === 1 && (nx || nz)) wantRoll = (nx * -Math.cos(rig.yaw) + nz * Math.sin(rig.yaw) > 0 ? 1 : -1) * POSE.wallRoll;
        else if (wall === 2) wantPitch = POSE.runUpPitch;
        else if (slide) wantPitch = POSE.slidePitch;
        const kk = Math.min(1, 10 * rawDelta);
        rig.roll += (wantRoll - rig.roll) * kk;
        rig.pitch += (wantPitch - rig.pitch) * kk;
        tmp.qPose.setFromEuler(tmp.eu.set(rig.pitch, 0, rig.roll, "YXZ"));
        tmp.q.multiplyQuaternions(tmp.qYaw, tmp.qPose);
      }
      if (ledge >= 2 && rig.machine.special === "mantle") { const sol = game.model.solids[b.ledgeSolid]; if (sol) ty = sol.top - p.y; }
      const hanging = anchor !== null || ledge === 1;
      rig.ropeW += ((hanging ? 1 : 0) - rig.ropeW) * Math.min(1, (hanging ? 6 : 10) * rawDelta);
      const k = Math.min(1, 14 * rawDelta);
      rig.off.x += (tx - rig.off.x) * k; rig.off.y += (ty - rig.off.y) * k; rig.off.z += (tz - rig.off.z) * k;
      placeRoot(rig, tmp.q, tmp.pos.set(p.x + rig.off.x, p.y + rig.off.y, p.z + rig.off.z), hanging, vx, vy, vz, rawDelta);
      // Your own Radbro fades when the camera is close (as in single-player).
      if (i === game.local) {
        const want = !over && game.rig.bodyDist < 2 ? 0.4 : 1;
        if (want !== rig.fade) { rig.fade = want; for (const mt of rig.materials) { mt.transparent = want < 1; mt.opacity = want; mt.needsUpdate = true; } }
      }
    }
  }, FRAME.actors);

  // -4: mixers.
  useFrame((_, delta) => {
    for (const r of rigList) if (r && r.root.visible) r.player.update(delta);
  }, FRAME.animator);

  // -3: bones (one-arm swing, hand on the rope / rim, the zip arm, the Yoink arm).
  useFrame((_, rawDelta) => {
    const m = game.match;
    if (!m) return;
    for (let i = 0; i < rigList.length && i < m.n; i++) {
      const rig = rigList[i];
      if (!rig || !rig.root.visible) continue;
      const b = m.bodies[i];
      const onRope = b.ropeSolid >= 0;
      const wantHips = onRope ? POSE.swingHips * Math.max(-1, Math.min(1, -b.v.y / 12)) : 0;
      rig.hipPitch += (wantHips - rig.hipPitch) * Math.min(1, 6 * rawDelta);
      if (rig.ropeW > 0.01 && rig.hook > 0) {
        tmp.fwd.set(Math.cos(rig.yaw), 0, -Math.sin(rig.yaw));
        rotateBoneWorld(rig.bones.leftArm, tmp.fwd, -POSE.leftArmBack * rig.ropeW, tmp);
        if (Math.abs(rig.hipPitch) > 1e-3) rotateBoneWorld(rig.bones.hips, tmp.fwd, rig.hipPitch, tmp);
      }
      airBones(rig.air, rig.pose, rig.root, rig.hook > 0);
      const rh = rig.bones.rightHand;
      if (rh && rig.ropeW > 0.01) {
        rig.root.updateMatrixWorld(true);
        rh.getWorldPosition(tmp.a);
        tmp.b.copy(rig.hand).sub(tmp.a).multiplyScalar(rig.ropeW);
        rig.root.position.add(tmp.b);
      }
      if (rig.zip) {
        tmp.fwd.set(Math.sin(rig.yaw), 0, Math.cos(rig.yaw));
        rotateBoneWorld(rig.bones.rightArm, tmp.fwd, -2.3, tmp);
      } else {
        const want = i === m.holder && b.ringId === RING_RUNNER ? 0.45 : 0;
        rig.arm += (want - rig.arm) * Math.min(1, 10 * rawDelta);
        if (rig.arm > 0.01) { tmp.fwd.set(Math.sin(rig.yaw), 0, Math.cos(rig.yaw)); rotateBoneWorld(rig.bones.rightArm, tmp.fwd, -1.9 * rig.arm, tmp); }
      }
    }
  }, FRAME.bones);

  // -1: webs of the others, the bag, the marker, the tangle, the target ring, name tags and the arrow (DOM).
  useFrame(state => {
    const m = game.match;
    const on = game.mode === "match" && !!m;
    const cam = state.camera, w = state.size.width, h = state.size.height;
    for (let i = 0; i < fx.webs.length; i++) {
      const web = fx.webs[i];
      const rig = rigList[i];
      web.visible = false;
      if (!on || !m || i >= m.n || i === game.local || !rig || m.phase === PH_OVER) continue;
      const end = webEnd(m.bodies[i], game, i, tmp.e);
      if (!end) continue;
      if (rig.bones.rightHand) rig.bones.rightHand.getWorldPosition(tmp.a); else tmp.a.copy(rig.p);
      const len = tmp.a.distanceTo(end);
      if (len < 0.05) continue;
      web.position.copy(tmp.a).add(end).multiplyScalar(0.5);
      web.quaternion.setFromUnitVectors(UP, tmp.c.copy(end).sub(tmp.a).normalize());
      web.scale.set(1, len, 1);
      web.visible = true;
    }
    const hr = on && m ? rigList[m.holder] : null;
    fx.bag.visible = !!hr;
    fx.marker.visible = !!hr && m!.holder !== game.local;
    if (hr && m) {
      const lh = hr.bones.leftHand;
      if (lh) lh.getWorldPosition(tmp.a); else tmp.a.copy(hr.p);
      fx.bag.position.set(tmp.a.x, tmp.a.y - 0.3, tmp.a.z);
      fx.bag.rotation.y += 0.02;
      const hp = game.renderPs[m.holder];
      const bob = Math.sin(performance.now() / 180) * 0.12;
      fx.marker.position.set(hp.x, hp.y + 1.75 + bob, hp.z);
      fx.marker.rotation.y += 0.04;
      const frozen = m.freeze[m.holder] > 0;
      fx.tangle.visible = frozen;
      if (frozen) {
        fx.tangle.position.set(hp.x, hp.y - 0.05, hp.z);
        fx.tangle.rotation.y += 0.05;
        const s = 0.85 + 0.15 * (m.freeze[m.holder] / m.freezeSteps);
        fx.tangle.scale.set(s, s * 1.15, s);
      }
    } else fx.tangle.visible = false;
    // The red ring: your Yoink is up on your target.
    const tgt = on && m && m.holder === game.local && m.bodies[game.local].ringId === RING_RUNNER ? m.target[game.local] : -1;
    fx.ring.visible = tgt >= 0;
    if (tgt >= 0) {
      const q = game.renderPs[tgt];
      fx.ring.position.set(q.x, q.y + 0.2, q.z);
      fx.ring.quaternion.copy(cam.quaternion);
    }
    // DOM: tags over the others (bag clock), the arrow to the holder / your target.
    for (let i = 0; i < MAX_TAGS; i++) {
      const el = document.getElementById(`rr-tag-${i}`);
      if (!el) continue;
      let show = on && !!m && i < m.n && i !== game.local;
      if (show) {
        const q = game.renderPs[i];
        tmp.c.set(q.x, q.y + 1.45, q.z).project(cam);
        const sx = (tmp.c.x * 0.5 + 0.5) * w, sy = (-tmp.c.y * 0.5 + 0.5) * h;
        show = tmp.c.z < 1 && sx > -60 && sx < w + 60 && sy > -60 && sy < h + 60;
        if (show) el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
      }
      el.style.visibility = show ? "visible" : "hidden";
    }
    const arrow = document.getElementById("rr-tag-arrow");
    if (arrow) {
      const look = on && m && m.phase !== PH_OVER ? game.lookTarget() : -1;
      let vis = false;
      if (look >= 0) {
        const q = game.renderPs[look];
        tmp.c.set(q.x, q.y + 1.0, q.z).project(cam);
        const behind = tmp.c.z > 1;
        const sx = (tmp.c.x * 0.5 + 0.5) * w, sy = (-tmp.c.y * 0.5 + 0.5) * h;
        vis = behind || sx < 0 || sx > w || sy < 0 || sy > h;
        if (vis) {
          let dx = sx - w / 2, dy = sy - h / 2;
          if (behind) { dx = -dx; dy = -dy; }
          const a = Math.atan2(dy, dx);
          const rx = w / 2 - 48, ry = h / 2 - 48;
          const k = Math.min(rx / Math.max(1e-6, Math.abs(Math.cos(a))), ry / Math.max(1e-6, Math.abs(Math.sin(a))));
          arrow.style.transform = `translate(${(w / 2 + Math.cos(a) * k).toFixed(1)}px, ${(h / 2 + Math.sin(a) * k).toFixed(1)}px) translate(-50%, -50%) rotate(${a.toFixed(3)}rad)`;
          arrow.dataset.who = String(look);
        }
      }
      arrow.style.visibility = vis ? "visible" : "hidden";
    }
  }, FRAME.fx);

  return (
    <>
      {rigList.map((r, i) => (r ? <primitive key={`rig-${i}`} object={r.root} /> : null))}
      {fx.webs.map((wm, i) => <primitive key={`web-${i}`} object={wm} />)}
      <primitive object={fx.bag} />
      <primitive object={fx.marker} />
      <primitive object={fx.tangle} />
      <primitive object={fx.ring} />
    </>
  );
}

export const MAX_TAGS = 8;
