// Plain R3F FX (priority -1): balloon clusters as one InstancedMesh (+ strings), the reticle ring on
// snapshot.ringId (yellow, green while attached), the rope, and a blob shadow under the player.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  BoxGeometry, Color, DoubleSide, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, Quaternion, SphereGeometry, Vector3,
} from "three";
import type { ViewGame } from "./viewGame.ts";
import { FRAME } from "./frame.ts";
import { lowQuality } from "./quality.tsx";

const BALLOON_COLORS = ["#ff5a7a", "#ffd23f", "#4fc3f7", "#7cdb6a", "#b388ff", "#ff9f43"];
const CLUSTER: [number, number, number][] = [[0, 1.25, 0], [0.55, 1.05, 0.25], [-0.45, 1.0, -0.35]];
/** Round 7 sky hooks (longer grab range): bigger clusters in gold / cream / white, so they read apart. */
const SKY_COLORS = ["#ffd23f", "#fff3c4", "#ffffff"];
const SKY_SCALE = 1.6;

function useBalloons(game: ViewGame) {
  return useMemo(() => {
    const hooks = game.model.hooks;
    const balloons = new InstancedMesh(new SphereGeometry(0.42, 12, 10), new MeshStandardMaterial({ roughness: 0.35, metalness: 0 }), hooks.length * CLUSTER.length);
    const strings = new InstancedMesh(new BoxGeometry(0.03, 1, 0.03), new MeshBasicMaterial({ color: "#f5f5f5" }), hooks.length * CLUSTER.length);
    const o = new Object3D();
    const c = new Color();
    let i = 0;
    for (const h of hooks) {
      const sky = h.src === "sky", k = sky ? SKY_SCALE : 1;
      CLUSTER.forEach(([cx, cy, cz], j) => {
        const dx = cx * k, dy = 0.45 + (cy - 0.45) * k, dz = cz * k;
        o.position.set(h.x + dx, h.y + dy, h.z + dz);
        o.scale.set(k, 1.18 * k, k);
        o.rotation.set(0, 0, 0);
        o.updateMatrix();
        balloons.setMatrixAt(i, o.matrix);
        balloons.setColorAt(i, c.set(sky ? SKY_COLORS[j] : BALLOON_COLORS[(h.id * 3 + j) % BALLOON_COLORS.length]));
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
    // Round 4: rest matrices / colours to restore after a pop, and what the last frame showed.
    const baseB = balloons.instanceMatrix.array.slice();
    const baseS = strings.instanceMatrix.array.slice();
    const baseC = balloons.instanceColor ? balloons.instanceColor.array.slice() : null;
    const shown = new Uint8Array(hooks.length).fill(1);
    return { balloons, strings, baseB, baseS, baseC, shown, frag: { cur: undefined as Uint8Array | undefined } };
  }, [game]);
}

const ZERO = new Matrix4().makeScale(0, 0, 0).elements;

/**
 * Round 4 balloon states (player only): fragile balloons are drawn pale, popped ones are hidden until
 * they grow back. Updates only the instances that changed.
 */
function syncBalloons(game: ViewGame, bl: ReturnType<typeof useBalloons>): void {
  const w = game.world, down = w.hookDown, frag = w.fragile;
  const n = game.model.hooks.length, k = CLUSTER.length;
  if (frag !== bl.frag.cur && bl.baseC && bl.balloons.instanceColor) {
    bl.frag.cur = frag;
    const arr = bl.balloons.instanceColor.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const pale = frag !== undefined && frag[i] === 1;
      for (let j = 0; j < k; j++) {
        const o = (i * k + j) * 3;
        for (let c = 0; c < 3; c++) arr[o + c] = pale ? bl.baseC[o + c] * 0.45 + 0.55 : bl.baseC[o + c];
      }
    }
    bl.balloons.instanceColor.needsUpdate = true;
  }
  const step = game.body.step;
  let changed = false;
  for (let i = 0; i < n; i++) {
    const vis = down === undefined || down[i] <= step ? 1 : 0;
    if (vis === bl.shown[i]) continue;
    bl.shown[i] = vis;
    changed = true;
    for (let j = 0; j < k; j++) {
      const o = (i * k + j) * 16;
      const mb = bl.balloons.instanceMatrix.array as Float32Array, ms = bl.strings.instanceMatrix.array as Float32Array;
      for (let e = 0; e < 16; e++) { mb[o + e] = vis ? bl.baseB[o + e] : ZERO[e]; ms[o + e] = vis ? bl.baseS[o + e] : ZERO[e]; }
    }
  }
  if (changed) { bl.balloons.instanceMatrix.needsUpdate = true; bl.strings.instanceMatrix.needsUpdate = true; }
}

export function FxView({ game, hidePlayer, ropeFrom }: { game: ViewGame; hidePlayer?: () => boolean; ropeFrom?: (out: Vector3) => boolean }) {
  const bl = useBalloons(game);
  const { balloons, strings } = bl;
  const ring = useRef<Mesh>(null);
  const rope = useRef<Mesh>(null);
  const shadow = useRef<Mesh>(null);
  const ringMat = useMemo(() => new MeshBasicMaterial({ color: "#ffe14d", transparent: true, opacity: 0.95, depthTest: false, side: DoubleSide }), []);
  const tmp = useMemo(() => ({ a: new Vector3(), b: new Vector3(), up: new Vector3(0, 1, 0), q: new Quaternion(), m: new Matrix4(), t: 0 }), []);

  useFrame((state, delta) => {
    syncBalloons(game, bl);
    const b = game.body;
    const p = game.renderP;
    const hooks = game.model.hooks;
    tmp.t += delta;
    // Reticle ring on snapshot.ringId (the hook the next web press gets).
    const hide = hidePlayer?.() ?? false;
    const shadowOn = !hide && !lowQuality();
    if (shadow.current) shadow.current.visible = shadowOn;
    const rm = ring.current;
    if (rm) {
      const id = hide ? -1 : b.ringId;
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
    // Rope to the hook knot from the character's RightHand (ropeFrom), else from the body point.
    const ro = rope.current;
    if (ro) {
      ro.visible = b.ropeHook >= 0 && !hide;
      if (ro.visible) {
        const h = hooks[b.ropeHook];
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
