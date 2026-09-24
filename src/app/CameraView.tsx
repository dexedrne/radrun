// Applies the camera rig to the prefab's Camera node (priority -2, after the actors moved).
import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { usePrefab } from "react-three-game";
import { Matrix4, PerspectiveCamera, Vector3 } from "three";
import type { ViewGame } from "./viewGame.ts";
import { rigFov, rigUpdate, type SegmentHit } from "../camera/rig.ts";
import { EV_LAND } from "../sim/player.ts";
import { FRAME } from "./frame.ts";

export function CameraView({ game }: { game: ViewGame }) {
  const prefab = usePrefab();
  const tmp = useMemo(() => ({ m: new Matrix4(), eye: new Vector3(), at: new Vector3(), up: new Vector3(0, 1, 0), hook: { x: 0, y: 0, z: 0 }, se: { x: 0, y: 0, z: 0 }, sa: { x: 0, y: 0, z: 0 } }), []);
  const hit: SegmentHit = useMemo(() => {
    const idx = game.world.index;
    return (ax, ay, az, bx, by, bz) => idx.segmentHit(ax, ay, az, bx, by, bz);
  }, [game]);
  useFrame((state, delta) => {
    const b = game.body;
    let hook = null;
    if (b.ropeHook >= 0) {
      const h = game.model.hooks[b.ropeHook];
      tmp.hook.x = h.x; tmp.hook.y = h.y; tmp.hook.z = h.z;
      hook = tmp.hook;
    }
    const speed = Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z);
    rigUpdate(game.rig, Math.min(delta, 0.1), { p: game.renderP, speed, grounded: b.grounded, hook, landed: (game.frameEvents & EV_LAND) !== 0 }, game.camera, hit);
    const r = game.rig;
    const scripted = game.scriptedCamera?.(tmp.se, tmp.sa, r.pos, r.target) ?? false;
    if (scripted) {
      tmp.eye.set(tmp.se.x, tmp.se.y, tmp.se.z);
      tmp.at.set(tmp.sa.x, tmp.sa.y, tmp.sa.z);
    } else {
      tmp.eye.set(r.pos.x, r.pos.y, r.pos.z);
      tmp.at.set(r.target.x, r.target.y, r.target.z);
    }
    tmp.m.lookAt(tmp.eye, tmp.at, tmp.up);
    const node = prefab.getObject("camera");
    const cam = state.camera;
    let under = false;
    for (let o = cam.parent; o; o = o.parent) if (o === node) { under = true; break; }
    if (node && under) {
      node.position.copy(tmp.eye);
      node.quaternion.setFromRotationMatrix(tmp.m);
    } else {
      cam.position.copy(tmp.eye);
      cam.quaternion.setFromRotationMatrix(tmp.m);
    }
    if (cam instanceof PerspectiveCamera) {
      const fov = scripted ? game.camera.fov : rigFov(r);
      if (Math.abs(cam.fov - fov) > 0.01) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    }
  }, FRAME.camera);
  return null;
}
