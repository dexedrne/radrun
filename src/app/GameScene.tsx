// The one canvas: <GameCanvas flat> + PrefabRoot mounting the play prefab composed in code (camera,
// lights, PrefabRefs to city.json / decor.json, the player stand-in) with the runtime systems as
// children. Mounted once; restarts never remount it.
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Object3D } from "three";
import { GameCanvas, PrefabRoot, useScenePendingLoads, type Prefab, type GameObject } from "react-three-game";
import type { ViewGame } from "./viewGame.ts";
import type { Sandbox } from "../game/sandbox.ts";
import { useUi } from "../ui/store.ts";
import { SimDriver } from "./SimDriver.tsx";
import { PlayerView } from "./PlayerView.tsx";
import { CameraView } from "./CameraView.tsx";
import { FxView } from "./FxView.tsx";
import { StructuresView } from "./StructuresView.tsx";
import "./Sign.tsx"; // registers the decor "Sign" component before any prefab mounts
import { CityLook, FOG_COLOR, SkyGradient } from "./cityLook.tsx";
import { ANTIALIAS, HIGH_DPR, QualityView, lowQuality } from "./quality.tsx";
import { PAGE, PAGE_DISTRICT, lv } from "./district.ts";

export const SKY = FOG_COLOR;

/** Pending-loads count -> UI store; sceneReady once it drains after the PrefabRefs started. */
export function LoadBridge() {
  const pending = useScenePendingLoads();
  const seen = useRef(false);
  const t0 = useRef(performance.now());
  useEffect(() => {
    if (pending > 0) seen.current = true;
    useUi.setState({ pending });
    if (pending === 0 && (seen.current || performance.now() - t0.current > 1500)) useUi.setState({ sceneReady: true });
  }, [pending]);
  return null;
}

const node = (id: string, components: GameObject["components"], children?: GameObject[]): GameObject => ({ id, components, children });
const xf = (position: number[], extra: Record<string, unknown> = {}) => ({ type: "Transform", properties: { position, ...extra } });

export const box = (id: string, pos: number[], scale: number[], materialId: string): GameObject =>
  node(id, {
    transform: xf(pos, { scale }),
    geometry: { type: "Geometry", properties: { geometryType: "box", args: [1, 1, 1] } },
    material: { type: "Material", properties: { materialId } },
    mesh: { type: "Mesh", properties: { castShadow: false, receiveShadow: false, instanced: false } },
  });

/** The sandbox's box stand-in (node id "player"). */
export function sandboxActors(game: ViewGame): { nodes: GameObject[]; materials: Prefab["materials"] } {
  const sp = game.model.spawn;
  return {
    materials: {
      player: { color: "#e5484d", roughness: 0.7, metalness: 0 },
      nose: { color: "#ffd23f", roughness: 0.7, metalness: 0 },
    },
    nodes: [
      node("player", { transform: xf([sp.x, sp.y, sp.z]) }, [
        box("player-body", [0, 0, 0], [0.7, 1.8, 0.7], "player"),
        box("player-nose", [0, 0.45, 0.4], [0.3, 0.2, 0.2], "nose"),
      ]),
    ],
  };
}

/** Play prefab composed in code: camera, lights, PrefabRefs to city.json / decor.json, actor nodes. */
export function playPrefab(game: ViewGame, actors: { nodes: GameObject[]; materials: Prefab["materials"] }): Prefab {
  const sp = game.model.spawn;
  const b = game.model.bounds;
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  return {
    id: "play",
    name: "Rug Run play",
    materials: actors.materials,
    root: node("play-root", {}, [
      node("camera", { transform: xf([sp.x, sp.y + 3, sp.z + 8]), camera: { type: "Camera", properties: { fov: 62, near: 0.1, far: 1500 } } }),
      node("sun", {
        transform: xf([cx + 90, 220, cz + 70]),
        light: { type: "DirectionalLight", properties: { intensity: PAGE.look.sunIntensity, castShadow: false, targetOffset: [-90, -220, -70], color: PAGE.look.sun } },
      }),
      node("sky", { light: { type: "HemisphereLight", properties: { skyColor: PAGE.look.hemiSky, groundColor: PAGE.look.hemiGround, intensity: PAGE.look.hemiIntensity } } }),
      node("city", { transform: xf([0, 0, 0]), prefabRef: { type: "PrefabRef", properties: { url: lv("city.json") } } }),
      node("decor", { transform: xf([0, 0, 0]), prefabRef: { type: "PrefabRef", properties: { url: lv("decor.json") } } }),
      ...actors.nodes,
    ]),
  };
}

/** Sandbox scene (the free-roam page): box stand-in + the M1 systems. */
export function GameScene({ game, children }: { game: Sandbox; children?: React.ReactNode }) {
  const prefab = useMemo(() => playPrefab(game, sandboxActors(game)), [game]);
  return (
    <SceneCanvas prefab={prefab}>
      <StructuresView model={game.model} district={PAGE_DISTRICT} source={game} />
      <SimDriver game={game} />
      <PlayerView game={game} />
      <CameraView game={game} />
      <FxView game={game} />
      {children}
    </SceneCanvas>
  );
}

const freeze = (o: Object3D) => {
  if (!o.matrixAutoUpdate) return;
  o.updateMatrix(); // compose it once (this also marks its world matrix for the next update)
  o.matrixAutoUpdate = false;
};

/**
 * The city and decor prefabs never move on a game page (no editor here), yet three recomposes every object's matrix
 * and world matrix every frame (~700 nodes, a tenth of a low-end frame). Freeze them: each composed once, then
 * matrixAutoUpdate off. Their ancestors up to the scene are static too and are frozen as well, or they would push
 * the whole tree through every frame anyway. Everything that moves (camera, actors, bones, FX, the Milady) keeps
 * auto-update and still updates its own subtree. Re-checked every 60 frames: decor loads late, and a node r3g
 * rebuilds starts unfrozen (correct, just not skipped). Visibility (quality.tsx) is unaffected.
 */
function FreezeStatic() {
  const scene = useThree(s => s.scene);
  const frame = useRef(0);
  useFrame(() => {
    if (frame.current++ % 60 !== 0) return;
    const roots: Object3D[] = [];
    scene.traverse(o => {
      const id = o.userData.prefabNodeId;
      if (id === "city" || id === "decor") roots.push(o);
    });
    for (const r of roots) {
      r.traverse(freeze);
      for (let p = r.parent; p; p = p.parent) freeze(p);
    }
  });
  return null;
}

/** The one canvas + PrefabRoot. Mounted once per page; children are the runtime systems. */
const FORCE_WEBGL = new URLSearchParams(location.search).has("webgl2");
/** Renderer options fixed at creation: the WebGL2 switch and anti-aliasing (off on Low). */
const GL_CONFIG = { antialias: ANTIALIAS, ...(FORCE_WEBGL ? { forceWebGL: true } : {}) };

export function SceneCanvas({ prefab, frameloop = "always", children }: { prefab: Prefab; frameloop?: "always" | "never"; children?: React.ReactNode }) {
  return (
    <GameCanvas
      flat
      frameloop={frameloop}
      dpr={lowQuality() ? 1 : HIGH_DPR}
      glConfig={GL_CONFIG}
      onCreated={s => {
        const be = (s.gl as unknown as { backend?: { isWebGPUBackend?: boolean; isWebGLBackend?: boolean } }).backend;
        const name = be?.isWebGPUBackend ? "WebGPU" : be?.isWebGLBackend ? "WebGL2" : "unknown";
        useUi.setState({ backend: name });
        console.info("[rug-run] renderer:", name);
      }}
    >
      <color attach="background" args={[SKY]} />
      <fog attach="fog" args={[FOG_COLOR, PAGE.look.fogNear, PAGE.look.fogFar]} />
      <SkyGradient />
      <CityLook />
      <QualityView />
      <FreezeStatic />
      <PrefabRoot data={prefab}>
        <LoadBridge />
        {children}
      </PrefabRoot>
    </GameCanvas>
  );
}
