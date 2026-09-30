// Plain R3F FX (priority -1), round 9: the reticle on the ringed building anchor (a ring pushed 0.3 m off
// the face, facing the camera at a constant ~28 px, yellow; green while attached; a short tick along the
// edge on a rim anchor), the web line from the RightHand (ropeFrom) to the anchor (or the web-zip target),
// a grey X for a web press with nothing ringed, and a blob shadow under the player. No balloons: anchors are the
// buildings themselves. Round 12 (docs/specs/2026-09-26-round12-spider-tag.md §8): the zip diamond (where E goes this
// frame: white, grey when out of zips or cooling down; larger on touch), the charge ring at your feet (fills, yellow
// at full) and the web flashing white on a perfect release.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, RingGeometry, Vector3 } from "three";
import type { ViewGame } from "./viewGame.ts";
import { FRAME } from "./frame.ts";
import { lowQuality } from "./quality.tsx";
import { chargeLevel, emptyZipAim, hangPoint, zipAim, EV_NOANCHOR, EV_PERFECT, EV_RELEASE, EV_AUTORELEASE, EV_SNAP } from "../sim/player.ts";
import { emptyAnchor } from "../world/cityQuery.ts";
import { useUi } from "../ui/store.ts";

/** Round 12: the zip diamond's size (px; touch x1.6), the charge ring's pieces and the perfect flash (s). */
const DIAMOND_PX = 16;
const CHARGE_SEGS = 24;
const PERFECT_FLASH = 0.18;

/** Reticle size on screen (px), the web's thickness (m) and how long the "no anchor" X shows (s). */
const RETICLE_PX = 28;
const WEB_THICK = 0.035;
/** Round 11: the web is never drawn within this many m of the lens (a white bar across the screen). */
const WEB_LENS_CLEAR = 1.2;
const NO_ANCHOR_FOR = 0.3;

export function FxView({ game, hidePlayer, ropeFrom, webColor }: { game: ViewGame; hidePlayer?: () => boolean; ropeFrom?: (out: Vector3) => boolean; webColor?: string | null }) {
  const ring = useRef<Mesh>(null);
  const tick = useRef<Mesh>(null);
  const rope = useRef<Mesh>(null);
  const rope2 = useRef<Mesh>(null);
  const shadow = useRef<Mesh>(null);
  const ledge = useRef<Mesh>(null);
  const nope = useRef<Mesh>(null);
  const za = useMemo(emptyZipAim, []);
  const ah = useMemo(emptyAnchor, []);
  const charge = useRef<Mesh>(null);
  const flash = useRef<Mesh>(null);
  const chargeGeo = useMemo(() => Array.from({ length: CHARGE_SEGS + 1 }, (_, i) => new RingGeometry(0.55, 0.8, 40, 1, Math.PI / 2, (2 * Math.PI * i) / CHARGE_SEGS)), []);
  const chargeMat = useMemo(() => new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.9, depthTest: false, side: DoubleSide }), []);
  const flashMat = useMemo(() => new MeshBasicMaterial({ color: "#ffffff", toneMapped: false }), []);
  const diamondMat = useMemo(() => new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.95, depthTest: false, side: DoubleSide }), []);
  const fl = useMemo(() => ({ t: 0, a: new Vector3(), b: new Vector3() }), []);
  const ringMat = useMemo(() => new MeshBasicMaterial({ color: "#ffe14d", transparent: true, opacity: 0.95, depthTest: false, side: DoubleSide }), []);
  const tmp = useMemo(() => ({ a: new Vector3(), b: new Vector3(), c: new Vector3(), d: new Vector3(), up: new Vector3(0, 1, 0), q: new Quaternion(), m: new Matrix4(), cp: new Vector3(), cq: new Quaternion(), t: 0, nope: 0, hang: { x: 0, y: 0, z: 0 } }), []);
  /** Stretch a unit web cylinder from a to b. */
  const place = (m: Mesh, a: Vector3, b: Vector3) => {
    const len = a.distanceTo(b);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(tmp.up, tmp.d.copy(b).sub(a).normalize());
    m.scale.set(1, len, 1);
  };

  useFrame((state, delta) => {
    const b = game.body;
    const p = game.renderP;
    tmp.t += delta;
    const hide = hidePlayer?.() ?? false;
    const shadowOn = !hide && !lowQuality();
    if (shadow.current) shadow.current.visible = shadowOn;
    const cam = state.camera;
    // World pose: the engine's camera sits in a group under the prefab 'camera' node (CameraView moves the
    // node, not the camera), so cam.position / cam.quaternion are local and stay near the origin.
    const camP = cam.getWorldPosition(tmp.cp), camQ = cam.getWorldQuaternion(tmp.cq);
    // Constant screen size: world size per pixel at distance d = 2 d tan(fov / 2) / viewport height.
    const pxWorld = (d: number) => {
      const fov = cam instanceof PerspectiveCamera ? cam.fov : 60;
      return (2 * d * Math.tan((fov * Math.PI) / 360)) / Math.max(1, state.size.height);
    };
    // Reticle on the ringed building (the anchor the next web press gets; while attached, the rope's).
    const rm = ring.current, tm = tick.current;
    // (a corner swing's web on the corner post counts as attached)
    const hang = hangPoint(b, tmp.hang);
    const attached = hang !== null;
    const on = !hide && (attached || b.ringId >= 0);
    if (rm) rm.visible = on;
    if (tm) tm.visible = on && !attached && b.ringRim;
    if (on && rm) {
      const a = hang ?? b.ringA;
      const nx = attached ? 0 : b.ringNx, nz = attached ? 0 : b.ringNz;
      rm.position.set(a.x + nx * 0.3, a.y + (b.ringRim && !attached ? 0.3 : 0), a.z + nz * 0.3);
      rm.quaternion.copy(camQ);
      ringMat.color.set(attached ? "#3ddc84" : "#ffe14d");
      const d = camP.distanceTo(rm.position);
      const pulse = attached ? 1 : 1 + 0.08 * Math.sin(tmp.t * 8);
      const k = (pxWorld(d) * RETICLE_PX) / 2.4 * pulse; // the ring geometry is 2.4 m across
      rm.scale.set(k, k, k);
      if (tm && tm.visible) {
        // A short tick along the rim edge (tangent = (-nz, nx)).
        tm.position.set(a.x + nx * 0.05, a.y + 0.05, a.z + nz * 0.05);
        tm.rotation.set(0, Math.atan2(-nx, -nz), 0);
        const w = pxWorld(d) * RETICLE_PX * 1.6;
        tm.scale.set(w, Math.max(0.05, w * 0.08), Math.max(0.05, w * 0.08));
      }
    }
    // A web press with nothing ringed: a small grey X at the aim point for a moment.
    if (game.frameEvents & EV_NOANCHOR) tmp.nope = NO_ANCHOR_FOR;
    tmp.nope = Math.max(0, tmp.nope - delta);
    const nm = nope.current;
    if (nm) {
      nm.visible = tmp.nope > 0 && !hide;
      if (nm.visible) {
        cam.getWorldDirection(tmp.a);
        nm.position.copy(camP).addScaledVector(tmp.a, 12);
        nm.quaternion.copy(camQ);
        const k = (pxWorld(12) * 20) / 1.2;
        nm.scale.set(k, k, k);
      }
    }
    // Round 12 zip diamond: where E goes this frame (the sim's own zipAim; the ringed anchor for the aim assist).
    // White when a zip is ready, grey when out of zips or cooling down; hidden while zipping, yanking or when E yanks.
    const lm = ledge.current;
    if (lm) {
      const k = game.simTuning, f = game.frameInput;
      let show = false;
      if (!hide && k && k.webZip && f && !b.zipOn && !b.yankOn && !b.yankOk && b.ledgeMode === 0) {
        let a = null;
        if (b.ringId >= 0) {
          ah.solid = b.ringId; ah.ax = b.ringA.x; ah.ay = b.ringA.y; ah.az = b.ringA.z; ah.px = b.ringP.x; ah.py = b.ringP.y; ah.pz = b.ringP.z;
          ah.nx = b.ringNx; ah.nz = b.ringNz; ah.rim = b.ringRim; a = ah;
        }
        show = zipAim(b, a, f.aimX, f.aimY, f.aimZ, k, game.world, za) > 0;
        if (show) {
          lm.position.set(za.hx + za.nx * 0.2, za.hy, za.hz + za.nz * 0.2);
          lm.quaternion.copy(camQ);
          const ready = b.zipCd <= 0 && Math.min(b.zipLeft, k.zipCharges) > 0;
          diamondMat.color.set(ready ? "#ffffff" : "#8a8f99");
          const d = camP.distanceTo(lm.position);
          const kk = (pxWorld(d) * DIAMOND_PX * (useUi.getState().touch ? 1.6 : 1)) / 0.7;
          lm.scale.set(kk, kk, kk);
        }
      }
      lm.visible = show;
    }
    // Round 12 charge ring: fills at your feet while C charges, yellow at full.
    const cm = charge.current;
    if (cm) {
      const k = game.simTuning;
      const on = !hide && !!k && b.chargeT > 0;
      cm.visible = on;
      if (on && k) {
        const c = chargeLevel(b.chargeT, k);
        const seg = Math.max(1, Math.round(c * CHARGE_SEGS));
        if (cm.geometry !== chargeGeo[seg]) cm.geometry = chargeGeo[seg];
        chargeMat.color.set(c >= 1 ? "#ffe14d" : "#ffffff");
        chargeMat.opacity = c > 0 ? 0.9 : 0.35;
        const g = b.grounded ? p.y - 0.9 + 0.05 : p.y - 0.9;
        cm.position.set(p.x, g, p.z);
      }
    }
    // Round 12 perfect release: the web just let go of flashes white (a thicker line) for a moment.
    if (hang) { if (!ropeFrom?.(fl.a)) fl.a.set(p.x, p.y + 0.25, p.z); fl.b.set(hang.x, hang.y, hang.z); }
    if (game.frameEvents & EV_SNAP) { fl.t = PERFECT_FLASH; flashMat.color.set("#ff695c"); }
    else if ((game.frameEvents & EV_PERFECT) && (game.frameEvents & (EV_RELEASE | EV_AUTORELEASE))) { fl.t = PERFECT_FLASH; flashMat.color.set("#ffffff"); }
    fl.t = Math.max(0, fl.t - delta);
    const fm = flash.current;
    if (fm) {
      fm.visible = fl.t > 0 && !hide;
      if (fm.visible) { place(fm, fl.a, fl.b); fm.scale.x = fm.scale.z = 1 + 2 * (fl.t / PERFECT_FLASH); }
    }
    // The web: from the character's RightHand (ropeFrom), else the body point, to the anchor / zip target.
    // Round 11: the part of the line within WEB_LENS_CLEAR of the lens is left out (up to two pieces).
    const ro = rope.current, r2 = rope2.current;
    if (r2) r2.visible = false;
    if (ro) {
      ro.visible = (attached || b.zipOn) && !hide;
      if (ro.visible) {
        const h = b.zipOn ? b.zipP : hang ?? b.ropeA;
        if (!ropeFrom?.(tmp.a)) tmp.a.set(p.x, p.y + 0.25, p.z);
        tmp.b.set(h.x, h.y, h.z);
        // |a + t (b - a) - cam|^2 = R^2 -> the t range inside the sphere.
        const dx = tmp.b.x - tmp.a.x, dy = tmp.b.y - tmp.a.y, dz = tmp.b.z - tmp.a.z;
        const fx = tmp.a.x - camP.x, fy = tmp.a.y - camP.y, fz = tmp.a.z - camP.z;
        const A = dx * dx + dy * dy + dz * dz, B = 2 * (fx * dx + fy * dy + fz * dz), C = fx * fx + fy * fy + fz * fz - WEB_LENS_CLEAR * WEB_LENS_CLEAR;
        const disc = B * B - 4 * A * C;
        let t0 = 2, t1 = 2;
        if (A > 1e-9 && disc > 0) { const q = Math.sqrt(disc); t0 = (-B - q) / (2 * A); t1 = (-B + q) / (2 * A); }
        if (t1 <= 0 || t0 >= 1) place(ro, tmp.a, tmp.b); // clear of the lens
        else {
          const lo = Math.max(0, t0), hi = Math.min(1, t1);
          let used = false;
          if (lo > 0.01) { tmp.c.copy(tmp.a).lerp(tmp.b, lo); place(ro, tmp.a, tmp.c); used = true; }
          if (hi < 0.99) {
            tmp.c.copy(tmp.a).lerp(tmp.b, hi);
            const m = used ? r2 : ro;
            if (m) { place(m, tmp.c, tmp.b); m.visible = true; used = true; }
          }
          if (!used) ro.visible = false;
        }
      }
    }
    // Blob shadow on the ground below (pure groundBelow).
    const sh = shadow.current;
    if (sh && shadowOn) {
      const g = game.world.index.groundBelow(p.x, p.z, p.y - 0.9 + 0.05);
      const hgt = p.y - 0.9 - g;
      sh.position.set(p.x, g + 0.03, p.z);
      const s = 1 / (1 + Math.max(0, hgt) * 0.06);
      sh.scale.set(s, s, s);
      (sh.material as MeshBasicMaterial).opacity = 0.38 * s;
    }
  }, FRAME.fx);

  return (
    <>
      <mesh ref={ring} material={ringMat} renderOrder={10} visible={false}>
        <ringGeometry args={[0.95, 1.2, 36]} />
      </mesh>
      <mesh ref={tick} renderOrder={10} visible={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#ffe14d" transparent opacity={0.9} depthTest={false} />
      </mesh>
      <mesh ref={nope} renderOrder={11} visible={false}>
        <planeGeometry args={[1.2, 0.18]} />
        <meshBasicMaterial color="#b8bcc6" transparent opacity={0.85} depthTest={false} side={DoubleSide} />
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <planeGeometry args={[1.2, 0.18]} />
          <meshBasicMaterial color="#b8bcc6" transparent opacity={0.85} depthTest={false} side={DoubleSide} />
        </mesh>
      </mesh>
      <mesh ref={rope} visible={false}>
        <cylinderGeometry args={[WEB_THICK / 2, WEB_THICK / 2, 1, 6]} />
        <meshBasicMaterial color={webColor ?? "#fafafa"} />
      </mesh>
      <mesh ref={rope2} visible={false}>
        <cylinderGeometry args={[WEB_THICK / 2, WEB_THICK / 2, 1, 6]} />
        <meshBasicMaterial color={webColor ?? "#fafafa"} />
      </mesh>
      <mesh ref={ledge} material={diamondMat} renderOrder={10} visible={false}>
        <ringGeometry args={[0.22, 0.35, 4]} />
      </mesh>
      <mesh ref={charge} material={chargeMat} geometry={chargeGeo[1]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10} visible={false} />
      <mesh ref={flash} visible={false}>
        <cylinderGeometry args={[WEB_THICK, WEB_THICK, 1, 6]} />
        <primitive object={flashMat} attach="material" />
      </mesh>
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <circleGeometry args={[0.65, 20]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </>
  );
}
