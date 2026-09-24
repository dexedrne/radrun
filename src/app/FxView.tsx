// Plain R3F FX (priority -1): balloon clusters as one InstancedMesh (+ strings), the reticle ring on
// snapshot.ringId (yellow, green while attached), the rope, and a blob shadow under the player.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  BoxGeometry, Color, DoubleSide, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, Quaternion, SphereGeometry, Vector3,
} from "three";
import type { Sandbox } from "../game/sandbox.ts";
import { FRAME } from "./frame.ts";

const BALLOON_COLORS = ["#ff5a7a", "#ffd23f", "#4fc3f7", "#7cdb6a", "#b388ff", "#ff9f43"];
const CLUSTER: [number, number, number][] = [[0, 1.25, 0], [0.55, 1.05, 0.25], [-0.45, 1.0, -0.35]];

function useBalloons(game: Sandbox) {
  return useMemo(() => {
    const hooks = game.model.hooks;
    const balloons = new InstancedMesh(new SphereGeometry(0.42, 12, 10), new MeshStandardMaterial({ roughness: 0.35, metalness: 0 }), hooks.length * CLUSTER.length);
    const strings = new InstancedMesh(new BoxGeometry(0.03, 1, 0.03), new MeshBasicMaterial({ color: "#f5f5f5" }), hooks.length * CLUSTER.length);
    const o = new Object3D();
    const c = new Color();
    let i = 0;
    for (const h of hooks) {
      CLUSTER.forEach(([dx, dy, dz], j) => {
        o.position.set(h.x + dx, h.y + dy, h.z + dz);
        o.scale.set(1, 1.18, 1);
        o.rotation.set(0, 0, 0);
        o.updateMatrix();
        balloons.setMatrixAt(i, o.matrix);
        balloons.setColorAt(i, c.set(BALLOON_COLORS[(h.id * 3 + j) % BALLOON_COLORS.length]));
        // string from the knot (hook point) up to the balloon
        const len = Math.sqrt(dx * dx + (dy - 0.45) * (dy - 0.45) + dz * dz);
        o.position.set(h.x + dx / 2, h.y + (dy - 0.45) / 2, h.z + dz / 2);
        o.scale.set(1, len, 1);
        o.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(dx, dy - 0.45, dz).normalize());
        o.updateMatrix();
        strings.setMatrixAt(i, o.matrix);
        i++;
      });
    }
    balloons.instanceMatrix.needsUpdate = true;
    if (balloons.instanceColor) balloons.instanceColor.needsUpdate = true;
    strings.instanceMatrix.needsUpdate = true;
    balloons.frustumCulled = false;
    strings.frustumCulled = false;
    return { balloons, strings };
  }, [game]);
}

export function FxView({ game }: { game: Sandbox }) {
  const { balloons, strings } = useBalloons(game);
  const ring = useRef<Mesh>(null);
  const rope = useRef<Mesh>(null);
  const shadow = useRef<Mesh>(null);
  const ringMat = useMemo(() => new MeshBasicMaterial({ color: "#ffe14d", transparent: true, opacity: 0.95, depthTest: false, side: DoubleSide }), []);
  const tmp = useMemo(() => ({ a: new Vector3(), b: new Vector3(), up: new Vector3(0, 1, 0), q: new Quaternion(), m: new Matrix4(), t: 0 }), []);

  useFrame((state, delta) => {
    const b = game.body;
    const p = game.renderP;
    const hooks = game.model.hooks;
    tmp.t += delta;
    // Reticle ring on snapshot.ringId (the hook the next web press gets).
    const rm = ring.current;
    if (rm) {
      const id = b.ringId;
      rm.visible = id >= 0;
      if (id >= 0) {
        const h = hooks[id];
        rm.position.set(h.x, h.y + 1.0, h.z);
        rm.quaternion.copy(state.camera.quaternion);
        const attached = b.ropeHook === id;
        ringMat.color.set(attached ? "#3ddc84" : "#ffe14d");
        const s = attached ? 1 : 1 + 0.08 * Math.sin(tmp.t * 8);
        rm.scale.set(s, s, s);
      }
    }
    // Rope from the body point (the sim's attach point) to the hook knot.
    const ro = rope.current;
    if (ro) {
      ro.visible = b.ropeHook >= 0;
      if (b.ropeHook >= 0) {
        const h = hooks[b.ropeHook];
        tmp.a.set(p.x, p.y + 0.25, p.z);
        tmp.b.set(h.x, h.y, h.z);
        const len = tmp.a.distanceTo(tmp.b);
        ro.position.copy(tmp.a).add(tmp.b).multiplyScalar(0.5);
        ro.quaternion.setFromUnitVectors(tmp.up, tmp.b.sub(tmp.a).normalize());
        ro.scale.set(1, len, 1);
      }
    }
    // Blob shadow on the ground below (pure groundBelow).
    const sh = shadow.current;
    if (sh) {
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
      <primitive object={balloons} />
      <primitive object={strings} />
      <mesh ref={ring} material={ringMat} renderOrder={10} visible={false}>
        <ringGeometry args={[0.95, 1.2, 36]} />
      </mesh>
      <mesh ref={rope} visible={false}>
        <cylinderGeometry args={[0.045, 0.045, 1, 6]} />
        <meshBasicMaterial color="#fafafa" />
      </mesh>
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <circleGeometry args={[0.65, 20]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </>
  );
}
