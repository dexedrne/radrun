// Level-only PBR maps. TextureLoader data stays linear; each repeat transform is cached and shared
// across the city's instanced material batches. LOW and touch use half-size roughness and no normals.
import { NoColorSpace, RepeatWrapping, TextureLoader, type Texture } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import { abs, cameraViewMatrix, normalWorldGeometry, select, sign, texture, uniform, vec3 } from 'three/tsl';
import { PBR_PROFILES } from '../world/pbrProfiles.ts';

const loader = new TextureLoader();
type Entry = { texture: Texture; ready: boolean };
const cache = new Map<string, Entry>();
const requested = new Set<Texture>();
export const beginPbr = () => requested.clear();
let loads = 0;
export const pbrLoads = () => loads;

function mapFor(albedo: Texture, kind: keyof typeof PBR_PROFILES, suffix: string): Texture | null {
  const key = `${kind}:${suffix}:${albedo.repeat.toArray()}:${albedo.offset.toArray()}:${albedo.rotation}:${albedo.center.toArray()}`;
  let entry = cache.get(key);
  if (!entry) {
    loads++;
    const pending: Entry = {
      texture: loader.load(`/textures/pbr/${kind}_${suffix}.png`, () => { pending.ready = true; loads--; }, undefined, () => { loads--; }),
      ready: false,
    };
    const map = pending.texture;
    map.colorSpace = NoColorSpace;
    map.wrapS = map.wrapT = RepeatWrapping;
    map.repeat.copy(albedo.repeat); map.offset.copy(albedo.offset);
    map.center.copy(albedo.center); map.rotation = albedo.rotation;
    map.anisotropy = albedo.anisotropy;
    entry = pending;
    cache.set(key, entry);
  }
  requested.add(entry.texture);
  return entry.ready ? entry.texture : null;
}

/** World-UV normals need the same basis as cityLook's projection, including top V = +z.
 * Three's default tangent frame uses geometry UVs, which point top V toward -z. Use the geometric
 * normal here (also in the UV projection) to avoid feeding the perturbed normal back into sampling. */
function worldNormal(m: MeshStandardNodeMaterial) {
  const n = normalWorldGeometry;
  const top = abs(n.y).greaterThan(0.5), wallX = abs(n.x).greaterThan(abs(n.z));
  const tangent = select(top, vec3(1, 0, 0), select(wallX, vec3(0, 0, sign(n.x).negate()), vec3(sign(n.z), 0, 0)));
  const bitangent = select(top, vec3(0, 0, 1), vec3(0, 1, 0));
  const t = texture(m.normalMap!).xyz.mul(2).sub(1);
  const xy = t.xy.mul(uniform(m.normalScale));
  return tangent.mul(xy.x).add(bitangent.mul(xy.y)).add(n.mul(t.z)).transformDirection(cameraViewMatrix);
}

const transformKey = (t: Texture) => `${t.repeat.toArray()}:${t.offset.toArray()}:${t.rotation}:${t.center.toArray()}`;

type State = { albedo: Texture; transform: string; low: boolean; world: boolean; roughness: number; normalMap: Texture | null; roughnessMap: Texture | null; normalNode: MeshStandardNodeMaterial['normalNode']; scale: [number, number] };
const states = new Map<MeshStandardNodeMaterial, State>();

/** Called only on actual level materials by CityLook, never on characters, signs or decals. */
export function syncPbr(m: MeshStandardNodeMaterial, low: boolean, world: boolean): void {
  const albedo = m.map;
  const image = albedo?.image as { src?: string } | undefined;
  const name = image?.src?.match(/\/textures\/(facade_grid|facade_brick|facade_glass|roof|street|water)\.png(?:\?|$)/)?.[1] as keyof typeof PBR_PROFILES | undefined;
  const old = states.get(m);
  if (old && (old.albedo !== albedo || !name)) {
    m.normalMap = old.normalMap; m.normalNode = old.normalNode; m.roughnessMap = old.roughnessMap;
    m.roughness = old.roughness; m.normalScale.set(...old.scale); m.needsUpdate = true;
    states.delete(m);
  }
  if (!albedo || !name) return;
  const state = states.get(m);
  const transform = transformKey(albedo);
  if (state && state.low === low && state.world === world && state.transform === transform) return;
  const roughnessMap = mapFor(albedo, name, low ? 'roughness_low' : 'roughness');
  const normalMap = low ? null : mapFor(albedo, name, 'normal');
  // Attach complete images only. Binding TextureLoader placeholders first undercounts
  // renderer.info texture bytes and can show a loading flash during shader compilation.
  if (!roughnessMap || !low && !normalMap) return;
  if (!state) states.set(m, { albedo, transform, low, world, roughness: m.roughness, normalMap: m.normalMap, roughnessMap: m.roughnessMap, normalNode: m.normalNode, scale: [m.normalScale.x, m.normalScale.y] });
  else { state.low = low; state.world = world; state.transform = transform; }
  const profile = PBR_PROFILES[name];
  m.roughness = 1; // Maps contain absolute roughness, not a multiplier of the old scalar.
  m.roughnessMap = roughnessMap;
  m.normalMap = normalMap;
  m.normalScale.setScalar(profile.normalScale);
  m.normalNode = m.normalMap && world ? worldNormal(m) : null;
  m.needsUpdate = true;
}

/** Dispose textures no longer referenced after a quality switch or an editor rebuild. Detaching
 * normals without disposing them would keep their GPU allocation alive on a High -> Low switch. */
export function prunePbr(active: Set<MeshStandardNodeMaterial>): void {
  for (const m of states.keys()) if (!active.has(m)) states.delete(m);
  const used = new Set<Texture>();
  for (const m of active) { if (m.normalMap) used.add(m.normalMap); if (m.roughnessMap) used.add(m.roughnessMap); }
  for (const [key, entry] of cache) if (!used.has(entry.texture) && !requested.has(entry.texture)) { entry.texture.dispose(); cache.delete(key); }
}

export function disposePbr(): void {
  for (const [m, s] of states) {
    m.normalMap = s.normalMap; m.normalNode = s.normalNode; m.roughnessMap = s.roughnessMap;
    m.roughness = s.roughness; m.normalScale.set(...s.scale); m.needsUpdate = true;
  }
  states.clear();
  for (const entry of cache.values()) entry.texture.dispose();
  requested.clear();
  cache.clear();
}
