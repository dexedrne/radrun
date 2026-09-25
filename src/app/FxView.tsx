// Plain R3F FX (priority -1), round 9: the reticle on the ringed building anchor (a ring pushed 0.3 m off
// the face, facing the camera at a constant ~28 px, yellow; green while attached; a short tick along the
// edge on a rim anchor), the web line from the RightHand (ropeFrom) to the anchor (or the web-zip target),
// a grey X for a web press with nothing ringed, the web-zip ledge marker, and a blob shadow under the player.
// No balloons: anchors are the buildings themselves.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, Vector3 } from "three";
import type { ViewGame } from "./viewGame.ts";
import { FRAME } from "./frame.ts";
import { lowQuality } from "./quality.tsx";
import { emptyZipAim, zipTarget, EV_NOANCHOR } from "../sim/player.ts";

/** Reticle size on screen (px), the web's thickness (m) and how long the "no anchor" X shows (s). */
const RETICLE_PX = 28;
const WEB_THICK = 0.035;
const NO_ANCHOR_FOR = 0.3;

export function FxView({ game, hidePlayer, ropeFrom }: { game: ViewGame; hidePlayer?: () => boolean; ropeFrom?: (out: Vector3) => boolean }) {
  const ring = useRef<Mesh>(null);
  const tick = useRef<Mesh>(null);
  const rope = useRef<Mesh>(null);
  const shadow = useRef<Mesh>(null);
  const ledge = useRef<Mesh>(null);
  const nope = useRef<Mesh>(null);
  const za = useMemo(emptyZipAim, []);
  const ringMat = useMemo(() => new MeshBasicMaterial({ color: "#ffe14d", transparent: true, opacity: 0.95, depthTest: false, side: DoubleSide }), []);
  const tmp = useMemo(() => ({ a: new Vector3(), b: new Vector3(), up: new Vector3(0, 1, 0), q: new Quaternion(), m: new Matrix4(), cp: new Vector3(), cq: new Quaternion(), t: 0, nope: 0 }), []);

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
    const attached = b.ropeSolid >= 0;
    const on = !hide && (attached || b.ringId >= 0);
    if (rm) rm.visible = on;
    if (tm) tm.visible = on && !attached && b.ringRim;
    if (on && rm) {
      const a = attached ? b.ropeA : b.ringA;
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
    // Web-zip ledge marker: where ZIP goes when nothing is ringed (ready, not on a rope / zipping).
    const lm = ledge.current;
    if (lm) {
      const k = game.simTuning, f = game.frameInput;
      let show = false;
      if (!hide && k && k.webZip && f && !b.zipOn && b.ropeSolid < 0 && b.ringId < 0 && b.zipCd <= 0) {
        show = zipTarget(b, null, f.aimX, f.aimZ, k, game.world, za) === 2;
        if (show) {
          lm.position.set(za.x, za.y - k.halfHeight + 0.08, za.z);
          const s = 1 + 0.1 * Math.sin(tmp.t * 7);
          lm.scale.set(s, s, s);
        }
      }
      lm.visible = show;
    }
    // The web: from the character's RightHand (ropeFrom), else the body point, to the anchor / zip target.
    const ro = rope.current;
    if (ro) {
      ro.visible = (attached || b.zipOn) && !hide;
      if (ro.visible) {
        const h = b.zipOn ? b.zipP : b.ropeA;
        if (!ropeFrom?.(tmp.a)) tmp.a.set(p.x, p.y + 0.25, p.z);
        tmp.b.set(h.x, h.y, h.z);
        const len = tmp.a.distanceTo(tmp.b);
        ro.position.copy(tmp.a).add(tmp.b).multiplyScalar(0.5);
        ro.quaternion.setFromUnitVectors(tmp.up, tmp.b.sub(tmp.a).normalize());
        ro.scale.set(1, len, 1);
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
        <meshBasicMaterial color="#fafafa" />
      </mesh>
      <mesh ref={ledge} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10} visible={false}>
        <ringGeometry args={[0.45, 0.7, 4]} />
        <meshBasicMaterial color="#7fe7ff" transparent opacity={0.9} depthTest={false} side={DoubleSide} />
      </mesh>
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <circleGeometry args={[0.65, 20]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </>
  );
}
