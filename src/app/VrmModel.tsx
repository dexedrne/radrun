/**
 * VrmModel: a registered r3g component that loads a .vrm through three-vrm
 * (MToonNodeMaterial for WebGPURenderer), mounts vrm.scene under its node,
 * drives it with retargeted humanoid clips and exposes expressions.
 *
 * Prefab usage:
 *   vrm: { type: "VrmModel", properties: {
 *     url: "https://raw.githubusercontent.com/prnthh/Pockit/main/web/1.vrm",
 *     clipLibrary: "models/radbro652.clips.glb", rig: "meshy", clip: "Casual_Walk",
 *     expression: "joy", look: "shipped" } }
 *
 * Code usage:
 *   const vrms = useSceneComponents(VRM_MODEL_COMPONENT);
 *   const h = vrms.find(v => v.nodeId === "milady")?.value;
 *   h?.play("Regular_Jump", { once: true });   // returns to `clip` afterwards
 *   h?.setExpression("blink", 1);              // VRM0 ("joy", "a") or VRM1 ("happy", "aa") names
 */
import { useFrame } from "@react-three/fiber";
import { FRAME } from "./frame.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  type AnimationAction,
  type AnimationClip,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
} from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { VRM } from "@pixiv/three-vrm";
import { MToonNodeMaterial } from "@pixiv/three-vrm/nodes";
import {
  createNodeComponentType,
  useAssetRuntime,
  useNode,
  usePrefab,
  useRegisterNodeComponent,
  type Component,
  type ComponentViewProps,
} from "react-three-game";
import { loadVrm } from "../vrm/loadVrm.ts";
import { MESHY_RIG, MIXAMO_RIG, retargetClip } from "../vrm/retarget.ts";

export type VrmModelProperties = {
  url?: string;
  /** Expression held on this node ("" = none). VRM0 preset names are accepted. */
  expression?: string;
  expressionWeight?: number;
  /** GLB whose clips (authored on a Meshy or Mixamo rig) are retargeted onto this VRM. */
  clipLibrary?: string;
  rig?: "meshy" | "mixamo";
  /** Looping base clip ("" = rest pose). */
  clip?: string;
  inPlace?: boolean;
  /** Re-aim limb rest directions onto the VRM's T-pose (needed for A-pose sources such as Meshy). */
  alignRestPose?: boolean;
  /** shipped = materials as loaded; mtoon = force MToonNodeMaterial; unlit = MeshBasicNodeMaterial. */
  look?: "shipped" | "mtoon" | "unlit";
};

export type VrmInfo = {
  url: string;
  bytes: number;
  ms: number;
  metaVersion: string;
  expressions: Array<{ name: string; binds: number }>;
  materials: string[];
};

export interface VrmHandle {
  readonly vrm: VRM;
  readonly mixer: AnimationMixer;
  readonly clips: ReadonlyMap<string, AnimationClip>;
  readonly info: VrmInfo;
  play(name: string, options?: { once?: boolean; fade?: number }): boolean;
  /** Freeze on `name` at time t (for deterministic captures). */
  pose(name: string, t: number): boolean;
  resume(): void;
  /** Resets all expressions, then sets one. Returns the resolved VRM1 name, or null if unknown. */
  setExpression(name: string, weight?: number): string | null;
}

export const VRM_MODEL_COMPONENT = createNodeComponentType<VrmHandle>("VrmModel");

/** three-vrm maps VRM0 preset names to VRM1 ones on load; accept both. */
const V0_TO_V1: Record<string, string> = {
  a: "aa", i: "ih", u: "ou", e: "ee", o: "oh", joy: "happy", sorrow: "sad", fun: "relaxed",
  blink_l: "blinkLeft", blink_r: "blinkRight", lookup: "lookUp", lookdown: "lookDown", lookleft: "lookLeft", lookright: "lookRight",
};

function withBasePath(basePath: string | undefined, path: string) {
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  const base = (basePath ?? "").replace(/\/$/, "");
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

function swapMaterials(vrm: VRM, look: "mtoon" | "unlit") {
  const restore: Array<[Mesh, Material | Material[]]> = [];
  vrm.scene.traverse(object => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const convert = (source: Material) => {
      const src = source as MeshStandardMaterial;
      if ((src as unknown as { isMToonNodeMaterial?: boolean }).isMToonNodeMaterial) return source;
      const common = { transparent: src.transparent, opacity: src.opacity, side: src.side, alphaTest: src.alphaTest, depthWrite: src.depthWrite };
      if (look === "unlit") return Object.assign(new MeshBasicNodeMaterial({ map: src.map, color: src.color }), common);
      const m = new MToonNodeMaterial();
      Object.assign(m, common);
      m.color.copy(src.color);
      m.map = src.map;
      m.shadeMultiplyTexture = src.map;
      m.shadeColorFactor.setRGB(0.72, 0.66, 0.74);
      if (!src.map) m.shadeColorFactor.multiply(src.color);
      m.shadingToonyFactor = 0.9;
      m.shadingShiftFactor = -0.05;
      m.parametricRimColorFactor.setRGB(0.25, 0.25, 0.25);
      m.parametricRimFresnelPowerFactor = 4;
      m.name = `${src.name}-mtoon`;
      return m;
    };
    restore.push([mesh, mesh.material]);
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });
  return () => {
    for (const [mesh, original] of restore) {
      const current = mesh.material;
      for (const m of Array.isArray(current) ? current : [current]) if (!(Array.isArray(original) ? original : [original]).includes(m)) m.dispose();
      mesh.material = original;
    }
  };
}

function VrmModelView({ properties, enabled, children }: ComponentViewProps<VrmModelProperties>) {
  const { runtimeNodeId } = useNode();
  const { basePath } = usePrefab();
  const assets = useAssetRuntime();
  const url = properties.url ? withBasePath(basePath, properties.url) : "";
  const [vrm, setVrm] = useState<VRM | null>(null);
  const [library, setLibrary] = useState<{ root: import("three").Object3D; clips: AnimationClip[] } | null>(null);

  // Load through r3g's asset runtime (so PrefabRoot's pending-load count sees it). One VRM per node:
  // a VRM's humanoid/expressions cannot be shared between two mounted copies.
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const key = `vrm:${runtimeNodeId}:${url}`;
    void assets
      .loadModel(key, async () => {
        const loaded = await loadVrm(url);
        loaded.vrm.scene.userData.loadInfo = { url, bytes: loaded.bytes, ms: loaded.ms };
        return loaded.vrm.scene;
      })
      .then(() => {
        const scene = assets.getModel(key);
        if (alive) setVrm((scene?.userData.vrm as VRM | undefined) ?? null);
      });
    return () => {
      alive = false;
    };
  }, [assets, runtimeNodeId, url]);

  const libraryPath = properties.clipLibrary ? withBasePath(basePath, properties.clipLibrary) : "";
  useEffect(() => {
    if (!libraryPath) return;
    let alive = true;
    void assets.loadModel(libraryPath).then(() => {
      const root = assets.getModel(libraryPath);
      if (alive && root) setLibrary({ root, clips: (root.animations ?? []) as AnimationClip[] });
    });
    return () => {
      alive = false;
    };
  }, [assets, libraryPath]);

  const inPlace = properties.inPlace ?? true;
  const alignRestPose = properties.alignRestPose ?? true;
  const rig = properties.rig === "mixamo" ? MIXAMO_RIG : MESHY_RIG;
  const clips = useMemo(() => {
    const table = new Map<string, AnimationClip>();
    if (!vrm || !library) return table;
    const t0 = performance.now();
    for (const clip of library.clips) table.set(clip.name, retargetClip(clip, library.root, vrm, rig, { inPlace, alignRestPose }));
    console.info(`[VrmModel] ${runtimeNodeId}: retargeted ${table.size} clips in ${Math.round(performance.now() - t0)}ms`);
    return table;
  }, [vrm, library, rig, inPlace, alignRestPose, runtimeNodeId]);

  const mixer = useMemo(() => (vrm ? new AnimationMixer(vrm.scene) : null), [vrm]);
  const current = useRef<AnimationAction | null>(null);
  const paused = useRef(false);
  const baseClip = useRef(properties.clip ?? "");
  baseClip.current = properties.clip ?? "";

  const handle = useMemo<VrmHandle | null>(() => {
    if (!vrm || !mixer) return null;
    const loadInfo = vrm.scene.userData.loadInfo as { url: string; bytes: number; ms: number };
    const materials = new Set<string>();
    vrm.scene.traverse(o => {
      const m = (o as Mesh).material;
      if (m) for (const x of Array.isArray(m) ? m : [m]) materials.add(x.type);
    });
    const em = vrm.expressionManager;
    const info: VrmInfo = {
      ...loadInfo,
      metaVersion: vrm.meta?.metaVersion ?? "?",
      expressions: (em?.expressions ?? []).map(e => ({ name: e.expressionName, binds: e.binds.length })),
      materials: [...materials],
    };
    const play: VrmHandle["play"] = (name, options = {}) => {
      const clip = clips.get(name);
      if (!clip) return false;
      paused.current = false;
      const next = mixer.clipAction(clip);
      const prev = current.current;
      next.reset();
      next.setLoop(options.once ? LoopOnce : LoopRepeat, options.once ? 1 : Infinity);
      next.clampWhenFinished = Boolean(options.once);
      const fade = options.fade ?? 0.2;
      if (prev && prev !== next && fade > 0) next.crossFadeFrom(prev, fade, false);
      else if (prev && prev !== next) prev.stop();
      next.play();
      current.current = next;
      return true;
    };
    return {
      vrm,
      mixer,
      clips,
      info,
      play,
      pose(name, t) {
        const clip = clips.get(name);
        if (!clip) return false;
        mixer.stopAllAction();
        const action = mixer.clipAction(clip);
        action.reset().setLoop(LoopRepeat, Infinity).play();
        current.current = action;
        mixer.setTime(t);
        paused.current = true;
        return true;
      },
      resume() {
        paused.current = false;
      },
      setExpression(name, weight = 1) {
        if (!em) return null;
        const resolved = em.getExpression(name) ? name : V0_TO_V1[name] && em.getExpression(V0_TO_V1[name]) ? V0_TO_V1[name] : null;
        em.resetValues();
        if (resolved) em.setValue(resolved, weight);
        return resolved;
      },
    };
  }, [vrm, mixer, clips]);

  // Base clip + one-shot return.
  useEffect(() => {
    if (!handle || !mixer) return;
    if (baseClip.current) handle.play(baseClip.current, { fade: 0 });
    const onFinished = () => {
      if (baseClip.current) handle.play(baseClip.current);
    };
    mixer.addEventListener("finished", onFinished);
    return () => {
      mixer.removeEventListener("finished", onFinished);
      mixer.stopAllAction();
    };
  }, [handle, mixer, properties.clip]);

  useEffect(() => {
    handle?.setExpression(properties.expression ?? "", properties.expressionWeight ?? 1);
  }, [handle, properties.expression, properties.expressionWeight]);

  const look = properties.look ?? "shipped";
  useEffect(() => {
    if (!vrm || look === "shipped") return;
    return swapMaterials(vrm, look);
  }, [vrm, look]);

  useRegisterNodeComponent(VRM_MODEL_COMPONENT, handle);

  useFrame((_, delta) => {
    if (!vrm || !enabled) return;
    if (mixer && !paused.current) mixer.update(delta);
    vrm.update(delta); // normalized -> raw bones, expressions, look-at, spring bones, MToon UV anim
  }, FRAME.bones);

  return (
    <>
      {vrm ? <primitive object={vrm.scene} /> : null}
      {children}
    </>
  );
}

export const VrmModel: Component<VrmModelProperties> = {
  name: "VrmModel",
  View: VrmModelView,
  properties: {
    url: { type: "string", default: "" },
    expression: { type: "string", default: "" },
    expressionWeight: { default: 1, min: 0, max: 1, step: 0.05 },
    clipLibrary: { type: "string", default: "" },
    rig: { type: "select", default: "meshy", options: [{ value: "meshy", label: "Meshy (Radbro)" }, { value: "mixamo", label: "Mixamo" }] },
    clip: { type: "string", default: "" },
    inPlace: { type: "boolean", default: true },
    alignRestPose: { type: "boolean", default: true },
    look: {
      type: "select",
      default: "shipped",
      options: [
        { value: "shipped", label: "As loaded (MToon or glTF PBR)" },
        { value: "mtoon", label: "Force MToonNodeMaterial" },
        { value: "unlit", label: "Unlit (MeshBasicNodeMaterial)" },
      ],
    },
  },
};
