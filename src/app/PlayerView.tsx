// Box stand-in for the player (until the Radbros land in M4): interpolated position, faces its
// horizontal velocity, tilts so body-up points at the web anchor while on the rope. Moves the prefab node's
// Object3D (simulation state), never the prefab document.
import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { usePrefab } from "react-three-game";
import { Quaternion, Vector3 } from "three";
import type { Sandbox } from "../game/sandbox.ts";
import { FRAME } from "./frame.ts";

export function PlayerView({ game }: { game: Sandbox }) {
  const prefab = usePrefab();
  const tmp = useMemo(() => ({
    up: new Vector3(0, 1, 0), dir: new Vector3(), q: new Quaternion(), qYaw: new Quaternion(), qTilt: new Quaternion(), yaw: game.rig.yaw,
  }), [game]);
  useFrame((_, delta) => {
    const obj = prefab.getObject("player");
    if (!obj) return;
    const p = game.renderP, b = game.body;
    obj.position.set(p.x, p.y, p.z);
    const hs = Math.sqrt(b.v.x * b.v.x + b.v.z * b.v.z);
    if (hs > 0.5) {
      const want = Math.atan2(b.v.x, b.v.z);
      let d = want - tmp.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      tmp.yaw += d * Math.min(1, 12 * delta);
    }
    tmp.qYaw.setFromAxisAngle(tmp.up, tmp.yaw);
    if (b.ropeSolid >= 0) {
      const h = b.ropeA;
      tmp.dir.set(h.x - p.x, h.y - p.y, h.z - p.z).normalize();
      tmp.qTilt.setFromUnitVectors(tmp.up, tmp.dir);
      tmp.q.multiplyQuaternions(tmp.qTilt, tmp.qYaw);
    } else {
      tmp.q.copy(tmp.qYaw);
    }
    obj.quaternion.slerp(tmp.q, Math.min(1, 14 * delta));
  }, FRAME.actors);
  return null;
}
