// The one canvas: <GameCanvas flat> + PrefabRoot mounting the play prefab composed in code (camera,
// lights, PrefabRefs to city.json / decor.json, the player stand-in) with the runtime systems as
// children. Mounted once; restarts never remount it.
import { useEffect, useMemo, useRef } from "react";
import { GameCanvas, PrefabRoot, useScenePendingLoads, type Prefab, type GameObject } from "react-three-game";
import type { ViewGame } from "./viewGame.ts";
import type { Sandbox } from "../game/sandbox.ts";
import { useUi } from "../ui/store.ts";
import { SimDriver } from "./SimDriver.tsx";
import { PlayerView } from "./PlayerView.tsx";
import { CameraView } from "./CameraView.tsx";
import { FxView } from "./FxView.tsx";
import "./Sign.tsx"; // registers the decor "Sign" component before any prefab mounts

export const SKY = "#9fc3e6";

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
        light: { type: "DirectionalLight", properties: { intensity: 1.5, castShadow: false, targetOffset: [-90, -220, -70], color: "#fff4e0" } },
      }),
      node("sky", { light: { type: "HemisphereLight", properties: { skyColor: "#e3eeff", groundColor: "#6b5d7a", intensity: 1.25 } } }),
      node("city", { transform: xf([0, 0, 0]), prefabRef: { type: "PrefabRef", properties: { url: "/levels/city.json" } } }),
      node("decor", { transform: xf([0, 0, 0]), prefabRef: { type: "PrefabRef", properties: { url: "/levels/decor.json" } } }),
      ...actors.nodes,
    ]),
  };
}

/** Sandbox scene (the free-roam page): box stand-in + the M1 systems. */
export function GameScene({ game, children }: { game: Sandbox; children?: React.ReactNode }) {
  const prefab = useMemo(() => playPrefab(game, sandboxActors(game)), [game]);
  return (
    <SceneCanvas prefab={prefab}>
      <SimDriver game={game} />
      <PlayerView game={game} />
      <CameraView game={game} />
      <FxView game={game} />
      {children}
    </SceneCanvas>
  );
}

/** The one canvas + PrefabRoot. Mounted once per page; children are the runtime systems. */
const FORCE_WEBGL = new URLSearchParams(location.search).has("webgl2");

export function SceneCanvas({ prefab, children }: { prefab: Prefab; children?: React.ReactNode }) {
  return (
    <GameCanvas
      flat
      glConfig={FORCE_WEBGL ? { forceWebGL: true } : undefined}
      onCreated={s => {
        const be = (s.gl as unknown as { backend?: { isWebGPUBackend?: boolean; isWebGLBackend?: boolean } }).backend;
        const name = be?.isWebGPUBackend ? "WebGPU" : be?.isWebGLBackend ? "WebGL2" : "unknown";
        useUi.setState({ backend: name });
        console.info("[rug-run] renderer:", name);
      }}
    >
      <color attach="background" args={[SKY]} />
      <fog attach="fog" args={[SKY, 120, 380]} />
      <PrefabRoot data={prefab}>
        <LoadBridge />
        {children}
      </PrefabRoot>
    </GameCanvas>
  );
}
