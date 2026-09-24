// City look, at runtime on both backends (WebGPU and the WebGL2 fallback): world-space mapping for the
// level textures, and the sky gradient behind the fog.
//
// World-space rule: an r3g level material (a plain MeshStandardNodeMaterial / MeshBasicNodeMaterial from
// a prefab materials table) whose texture has "Repeat Texture" on is sampled in WORLD space instead of
// the box's per-face UVs, so windows, roof gravel and street markings keep their size on any box:
// walls use (along the face, height), tops use (x, z), and the material's repeatCount reads as tiles
// per metre. Everything stays in the materials table (colour, texture file, repeat) and editable in
// ?editor; turning Repeat off gives the stretched per-face UVs back. Instancing is untouched (the
// world position already includes the instance matrix).
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { RepeatWrapping, type Material, type Mesh, type Texture } from "three";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import { abs, color, mix, normalWorld, normalize, positionLocal, positionWorld, replaceDefaultUV, select, sign, smoothstep, vec2 } from "three/tsl";
import { PAGE } from "./district.ts";

/** Sky gradient stops (sRGB). The fog uses the horizon colour so distant boxes melt into it. */
/** Sky / fog of this page's district (Downtown: horizon #d3dcea, mid #98bde6, zenith #4c83d0). */
export const SKY_COLORS = { horizon: PAGE.look.skyHorizon, mid: PAGE.look.skyMid, zenith: PAGE.look.skyZenith };
export const FOG_COLOR = PAGE.look.fog;

const worldUV = () => {
  const n = normalWorld, p = positionWorld;
  const wallX = vec2(p.z.mul(sign(n.x)).negate(), p.y); // faces looking along +-x: "right" is -+z
  const wallZ = vec2(p.x.mul(sign(n.z)), p.y);
  const top = vec2(p.x, p.z);
  return select(abs(n.y).greaterThan(0.5), top, select(abs(n.x).greaterThan(abs(n.z)), wallX, wallZ));
};
const WORLD_UV = replaceDefaultUV(() => worldUV());

function isLevelMaterial(m: Material): m is MeshStandardNodeMaterial | MeshBasicNodeMaterial {
  return m.constructor === MeshStandardNodeMaterial || m.constructor === MeshBasicNodeMaterial;
}

function sync(m: Material): void {
  if (!isLevelMaterial(m)) return;
  const map = (m as { map?: Texture | null }).map;
  const want = !!map && map.wrapS === RepeatWrapping;
  const has = m.userData.rugrunWorldUV === true;
  if (want === has) return;
  m.contextNode = want ? WORLD_UV : null;
  m.userData.rugrunWorldUV = want;
  m.needsUpdate = true;
}

/** Applies the world-space rule to every level material in the scene (re-checked every few frames, so
 *  editor changes and late texture loads are picked up). */
export function CityLook() {
  const scene = useThree(s => s.scene);
  const frame = useRef(0);
  useFrame(() => {
    if (frame.current++ % 10) return;
    scene.traverse(o => {
      const mm = (o as Mesh).material;
      if (!mm) return;
      if (Array.isArray(mm)) mm.forEach(sync);
      else sync(mm);
    });
  });
  return null;
}

/** Vertical sky gradient as the scene's background node (the fallback clear colour is the horizon). */
export function SkyGradient() {
  const scene = useThree(s => s.scene);
  useEffect(() => {
    const y = normalize(positionLocal).y;
    const low = mix(color(SKY_COLORS.horizon), color(SKY_COLORS.mid), smoothstep(0.0, 0.3, y));
    const prev = scene.backgroundNode;
    scene.backgroundNode = mix(low, color(SKY_COLORS.zenith), smoothstep(0.25, 0.95, y));
    return () => { scene.backgroundNode = prev; };
  }, [scene]);
  return null;
}


/**
 * Round 4 "night" mutator (visual only): while a night round runs, a dark sky, closer fog and dimmed
 * lights; restored on the title / other rounds. Checks one flag per frame, changes only on toggles.
 */
export function NightLook({ isNight }: { isNight: () => boolean }) {
  const scene = useThree(s => s.scene);
  const st = useRef<{ on: boolean; day: unknown; dayFog: { c: number; near: number; far: number } | null; lights: Map<object, number> }>({ on: false, day: null, dayFog: null, lights: new Map() });
  useFrame(() => {
    const on = isNight();
    const cur = st.current;
    if (on === cur.on) return;
    cur.on = on;
    const fog = scene.fog as unknown as { color: { getHex(): number; setHex(v: number): void }; near: number; far: number } | null;
    if (on) {
      cur.day = scene.backgroundNode;
      const y = normalize(positionLocal).y;
      scene.backgroundNode = mix(mix(color("#2a1d44"), color("#141033"), smoothstep(0.0, 0.3, y)), color("#05040f"), smoothstep(0.25, 0.95, y));
      if (fog) { cur.dayFog = { c: fog.color.getHex(), near: fog.near, far: fog.far }; fog.color.setHex(0x1b1530); fog.near = 40; fog.far = 230; }
      scene.traverse(o => {
        const l = o as unknown as { isLight?: boolean; intensity: number };
        if (l.isLight) { cur.lights.set(o, l.intensity); l.intensity *= 0.45; }
      });
    } else {
      scene.backgroundNode = cur.day as typeof scene.backgroundNode;
      if (fog && cur.dayFog) { fog.color.setHex(cur.dayFog.c); fog.near = cur.dayFog.near; fog.far = cur.dayFog.far; }
      for (const [o, i] of cur.lights) (o as unknown as { intensity: number }).intensity = i;
      cur.lights.clear();
    }
  });
  return null;
}
