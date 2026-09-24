/**
 * One GLTFLoader with the three-vrm plugins, set up for WebGPURenderer:
 * VRMC_materials_mtoon (and VRM0 MToon, via the v0compat plugin) become
 * MToonNodeMaterial instead of the WebGL-only ShaderMaterial MToonMaterial.
 */
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MToonMaterialLoaderPlugin, VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { MToonNodeMaterial } from "@pixiv/three-vrm/nodes";

let loader: GLTFLoader | null = null;

function vrmLoader(): GLTFLoader {
  if (loader) return loader;
  loader = new GLTFLoader();
  loader.setCrossOrigin("anonymous");
  loader.register(parser => {
    const mtoonMaterialPlugin = new MToonMaterialLoaderPlugin(parser, { materialType: MToonNodeMaterial });
    return new VRMLoaderPlugin(parser, { mtoonMaterialPlugin });
  });
  return loader;
}

export type LoadedVrm = { vrm: VRM; bytes: number; ms: number };

/** Load a .vrm (any URL; the file extension does not matter to GLTFLoader.parse). */
export async function loadVrm(url: string): Promise<LoadedVrm> {
  const t0 = performance.now();
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error(`VRM fetch ${response.status} for ${url}`);
  const buffer = await response.arrayBuffer();
  const out = await parseVrm(buffer, url);
  out.ms = Math.round(performance.now() - t0);
  return out;
}

/** Parse an already-fetched .vrm (the Milady cameo fetches first, parses only outside the chase). */
export async function parseVrm(buffer: ArrayBuffer, url: string): Promise<LoadedVrm> {
  const t0 = performance.now();
  const base = url.slice(0, url.lastIndexOf("/") + 1);
  const gltf = await vrmLoader().parseAsync(buffer, base);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error(`Not a VRM (no VRM/VRMC_vrm extension): ${url}`);
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm); // VRM0 faces -Z; turn it to +Z like every other glTF
  vrm.scene.traverse(o => {
    o.frustumCulled = false;
    if ((o as { isMesh?: boolean }).isMesh) o.castShadow = true;
  });
  vrm.scene.userData.vrm = vrm;
  return { vrm, bytes: buffer.byteLength, ms: Math.round(performance.now() - t0) };
}
