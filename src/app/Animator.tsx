/**
 * Animator: a registered r3g component that adds one-shot clips, crossfades and
 * cross-file clip libraries on top of the built-in AnimatedModel.
 *
 * Why it exists: AnimatedModel creates every action with LoopRepeat/Infinity and
 * does not expose its mixer, so a jump or a vault loops forever. Animator sits on
 * the same prefab node, picks up AnimatedModel's registered handle (the
 * SkeletonUtils clone), and runs its own THREE.AnimationMixer against it.
 *
 * Prefab usage (same node as the AnimatedModel):
 *   model:    { type: "AnimatedModel", properties: { filename: "models/x.glb", animationState: "", autoUpdate: false } }
 *   animator: { type: "Animator", properties: { state: "Run_02", clipLibraries: ["models/x_fishing.clips.glb"] } }
 *
 * Set AnimatedModel animationState "" and autoUpdate false so its own mixer
 * never fights this one (Animator also calls handle.stop() on attach).
 *
 * Code usage:
 *   const animators = useSceneComponents(ANIMATOR_COMPONENT);
 *   animators.find(a => a.nodeId === "hero")?.value.play("Regular_Jump", { once: true });
 *   useGameEvent("animator:finished", e => ...); // { nodeId, clip, next }
 *
 * Clip libraries: extra GLBs whose clips are merged by name. Tracks bind by bone
 * name (PropertyBinding), so a clip-only GLB (skeleton nodes + animations, no mesh)
 * made for the SAME rig plays on the presets model. Clips do not transfer between
 * the two Radbros: their auto-rigs have different rest frames (Hips differs ~110deg).
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
  type Object3D,
} from "three";
import {
  ANIMATED_MODEL_COMPONENT,
  createNodeComponentType,
  gameEvents,
  useAssetRuntime,
  useNode,
  usePrefab,
  useRegisterNodeComponent,
  useSceneComponents,
  type Component,
  type ComponentViewProps,
} from "react-three-game";

export type AnimatorProperties = {
  /** Looping base state; one-shots return here. "" = bind pose. */
  state?: string;
  /** Extra GLB paths (relative to the prefab basePath) whose clips are merged by name. */
  clipLibraries?: string[];
  /** Default crossfade, seconds. */
  fadeDuration?: number;
  /** Pin the root bone's X/Z translation to its first key (strips root motion, keeps Y). */
  inPlace?: boolean;
  /** Bone that carries root motion. */
  rootBone?: string;
  /** Global playback rate for this node. */
  timeScale?: number;
};

export type PlayOptions = {
  /** Play once, hold the last frame, then crossfade to `then`. */
  once?: boolean;
  /** State to return to after a one-shot. Defaults to the current base state. */
  then?: string;
  /** Crossfade duration for this transition. */
  fade?: number;
  /** Per-action playback rate. */
  timeScale?: number;
};

export interface AnimatorHandle {
  readonly object: Object3D;
  readonly mixer: AnimationMixer;
  readonly clipNames: readonly string[];
  /** Clip currently in charge (the last one played). */
  readonly current: string;
  /** Looping state one-shots return to. */
  readonly base: string;
  play(name: string, options?: PlayOptions): boolean;
  setBase(name: string, fade?: number): void;
  getAction(name: string): AnimationAction | null;
}

export type AnimatorFinishedEvent = { nodeId: string; clip: string; next: string };

export const ANIMATOR_COMPONENT = createNodeComponentType<AnimatorHandle>("Animator");

const EMPTY: readonly AnimationClip[] = [];

function withBasePath(basePath: string | undefined, path: string) {
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  const base = (basePath ?? "").replace(/\/$/, "");
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/** Copy of `clip` with the root bone's X/Z position pinned to its first keyframe. */
export function stripRootMotion(clip: AnimationClip, rootBone = "Hips"): AnimationClip {
  const out = clip.clone();
  for (const track of out.tracks) {
    if (track.name !== `${rootBone}.position`) continue;
    const v = track.values;
    const x0 = v[0];
    const z0 = v[2];
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0;
      v[i + 2] = z0;
    }
  }
  return out;
}

/** Loads clip-library GLBs through r3g's shared asset runtime (cached per scene). */
function useClipLibraries(paths: readonly string[] | undefined): readonly AnimationClip[] | null {
  const assets = useAssetRuntime();
  const { basePath } = usePrefab();
  const key = (paths ?? []).join("|");
  const [clips, setClips] = useState<readonly AnimationClip[] | null>(key ? null : EMPTY);
  useEffect(() => {
    if (!key) {
      setClips(EMPTY);
      return;
    }
    let alive = true;
    setClips(null);
    const resolved = key.split("|").map(p => withBasePath(basePath, p));
    Promise.all(
      resolved.map(async p => {
        await assets.loadModel(p);
        const lib = assets.getModel(p);
        if (!lib) console.warn(`[Animator] clip library failed to load: ${p}`);
        return (lib?.animations ?? []) as AnimationClip[];
      }),
    ).then(all => {
      if (alive) setClips(all.flat());
    });
    return () => {
      alive = false;
    };
  }, [assets, basePath, key]);
  return clips;
}

function AnimatorView({ properties, enabled, children }: ComponentViewProps<AnimatorProperties>) {
  const { runtimeNodeId } = useNode();
  const models = useSceneComponents(ANIMATED_MODEL_COMPONENT);
  const model = models.find(entry => entry.nodeId === runtimeNodeId)?.value ?? null;
  const libraryClips = useClipLibraries(properties.clipLibraries);

  const fadeDuration = Math.max(0, properties.fadeDuration ?? 0.2);
  const inPlace = properties.inPlace ?? false;
  const rootBone = properties.rootBone ?? "Hips";

  // Merged clip table: the model's own clips win on name collisions.
  const clips = useMemo(() => {
    if (!model || !libraryClips) return null;
    const table = new Map<string, AnimationClip>();
    for (const clip of [...model.animations, ...libraryClips]) {
      if (table.has(clip.name)) continue;
      table.set(clip.name, inPlace ? stripRootMotion(clip, rootBone) : clip);
    }
    return table;
  }, [model, libraryClips, inPlace, rootBone]);

  const mixer = useMemo(() => (model ? new AnimationMixer(model.object) : null), [model]);

  const currentRef = useRef<AnimationAction | null>(null);
  const baseRef = useRef(properties.state ?? "");
  const pendingRef = useRef<{ action: AnimationAction; then: string } | null>(null);
  const fadeRef = useRef(fadeDuration);
  fadeRef.current = fadeDuration;

  const handle = useMemo<AnimatorHandle | null>(() => {
    if (!model || !mixer || !clips) return null;

    const getAction = (name: string) => {
      const clip = clips.get(name);
      return clip ? mixer.clipAction(clip, model.object) : null;
    };

    const stopAll = (fade: number) => {
      pendingRef.current = null;
      const previous = currentRef.current;
      currentRef.current = null;
      if (!previous) return;
      if (fade > 0) previous.fadeOut(fade);
      else previous.stop();
    };

    const play = (name: string, options: PlayOptions = {}) => {
      const next = getAction(name);
      if (!next) {
        console.warn(`[Animator] ${runtimeNodeId}: no clip "${name}" (have: ${[...clips.keys()].join(", ")})`);
        return false;
      }
      const fade = Math.max(0, options.fade ?? fadeRef.current);
      const previous = currentRef.current;
      // Re-requesting the loop that is already playing is a no-op (no restart blip).
      if (!options.once && next === previous && next.isRunning() && !pendingRef.current) return true;
      next.reset();
      next.setLoop(options.once ? LoopOnce : LoopRepeat, options.once ? 1 : Infinity);
      next.clampWhenFinished = Boolean(options.once);
      next.setEffectiveTimeScale(options.timeScale ?? 1).setEffectiveWeight(1);
      if (previous && previous !== next && fade > 0) {
        previous.fadeOut(fade);
        next.fadeIn(fade);
      } else if (previous && previous !== next) {
        previous.stop();
      }
      next.play();
      currentRef.current = next;
      pendingRef.current = options.once ? { action: next, then: options.then ?? baseRef.current } : null;
      return true;
    };

    return {
      object: model.object,
      mixer,
      clipNames: [...clips.keys()],
      get current() {
        return currentRef.current?.getClip().name ?? "";
      },
      get base() {
        return baseRef.current;
      },
      play,
      setBase(name: string, fade?: number) {
        baseRef.current = name;
        if (pendingRef.current) return; // a one-shot is running; it returns to the new base
        if (name) play(name, { fade });
        else stopAll(fade ?? fadeRef.current);
      },
      getAction,
    };
  }, [clips, mixer, model, runtimeNodeId]);

  // One-shot completion -> crossfade back to the base (or `then`) state + event.
  useEffect(() => {
    if (!mixer || !handle) return;
    const onFinished = (event: { action: AnimationAction }) => {
      const pending = pendingRef.current;
      if (!pending || event.action !== pending.action) return;
      pendingRef.current = null;
      const clip = pending.action.getClip().name;
      if (pending.then) handle.play(pending.then);
      gameEvents.emit("animator:finished", { nodeId: runtimeNodeId, clip, next: pending.then } satisfies AnimatorFinishedEvent);
    };
    mixer.addEventListener("finished", onFinished as never);
    return () => mixer.removeEventListener("finished", onFinished as never);
  }, [handle, mixer, runtimeNodeId]);

  // Base state follows the prefab property.
  useEffect(() => {
    if (!handle) return;
    // Silence AnimatedModel's own (always-looping) mixer; this one owns the bones now.
    model?.stop();
    handle.setBase(properties.state ?? "", 0);
  }, [handle, model, properties.state]);

  useEffect(() => {
    if (mixer) mixer.timeScale = properties.timeScale ?? 1;
  }, [mixer, properties.timeScale]);

  useEffect(
    () => () => {
      mixer?.stopAllAction();
      currentRef.current = null;
      pendingRef.current = null;
    },
    [mixer],
  );

  useRegisterNodeComponent(ANIMATOR_COMPONENT, handle);

  // Frame order (spec §20 item 3): Animator mixers run at -4, after ActorsView (-5).
  useFrame((_, delta) => {
    if (enabled && mixer) mixer.update(delta);
  }, FRAME.animator);

  return <>{children}</>;
}

export const Animator: Component<AnimatorProperties> = {
  name: "Animator",
  View: AnimatorView,
  properties: {
    state: { type: "string", default: "" },
    clipLibraries: { type: "string[]", default: [] },
    fadeDuration: { default: 0.2, min: 0, step: 0.05 },
    inPlace: { type: "boolean", default: false },
    rootBone: { type: "string", default: "Hips" },
    timeScale: { default: 1, min: 0, step: 0.1 },
  },
};
