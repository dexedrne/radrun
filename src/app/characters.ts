// Character assets: paths, the LOADING manifest (spec §20 item 4: chaser, runner, their clip packs,
// George) and a bridge to r3g's asset runtime so the page can preload outside the canvas tree.
import { useAssetRuntime, type AssetRuntime } from "react-three-game";
import type { RadbroId } from "../game/round.ts";
import type { RootPolicy } from "./animPlayer.ts";
import CLIP_META_JSON from "../generated/clips.meta.json";
import { GEORGE_GLB } from "./george.config.ts";

export type Vec3T = [number, number, number];
export type ClipMeta = {
  duration: number;
  loop: boolean;
  hips: { start: Vec3T; min: Vec3T; max: Vec3T };
  rootPolicy: RootPolicy;
  takeoffAt?: number;
  landAt?: number;
  handHeight?: number;
};
export type CharacterMeta = { clipPack: boolean; clips: Record<string, ClipMeta> };

export const CLIP_META = CLIP_META_JSON as unknown as Record<RadbroId, CharacterMeta>;

export const modelPath = (id: RadbroId) => `/models/radbro${id}.glb`;
export const clipsPath = (id: RadbroId) => `/models/radbro${id}.clips.glb`;

/** The LOADING manifest for a round pair (the third Radbro is never fetched). */
export function manifestFor(chaser: RadbroId, runner: RadbroId): string[] {
  const out: string[] = [];
  for (const id of [chaser, runner]) {
    out.push(modelPath(id));
    if (CLIP_META[id]?.clipPack) out.push(clipsPath(id));
  }
  if (GEORGE_GLB) out.push(GEORGE_GLB);
  return out;
}

/** Filled by <AssetsBridge/> inside PrefabRoot. */
export const assetsRef: { current: AssetRuntime | null } = { current: null };

export function AssetsBridge() {
  assetsRef.current = useAssetRuntime();
  return null;
}

/**
 * Preload a manifest; progress = resolved / total, an entry is resolved when getModel(path) is non-null.
 * Resolves to null when everything loaded, else the first failed path.
 */
export async function loadManifest(paths: string[], onProgress: (f: number) => void): Promise<string | null> {
  const assets = assetsRef.current;
  if (!assets) return "asset runtime not ready";
  let done = 0;
  onProgress(0);
  const results = await Promise.all(
    paths.map(p =>
      assets.loadModel(p).then(() => {
        const ok = assets.getModel(p) !== null;
        if (ok) onProgress(++done / paths.length);
        return ok ? null : p;
      }, () => p),
    ),
  );
  return results.find(r => r !== null) ?? null;
}

/** Rope-hang hand height above the feet (errata 1), measured into clips.meta.json. */
export function handHeight(id: RadbroId): number {
  return CLIP_META[id]?.clips.Rope_Hang_Idle?.handHeight ?? 1.3;
}
