// Graphics quality (pause -> Settings -> Quality, stored with the other settings).
//  High: r3g's pixel ratio range (touch devices capped per input/touch.ts: 1.25 on phones, 1.5 on
//        tablets), anti-aliasing, blob shadows, the runner trail, every rooftop prop.
//  Low:  pixel ratio 1, anti-aliasing off (the renderer is created once, so that part applies after a
//        reload), no blob shadows or runner trail, and of the rooftop props only the water towers
//        (decor.json's AC units and antennas are hidden).
// The views read lowQuality() every frame, so a switch takes effect immediately.
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Object3D } from "three";
import { useUi } from "../ui/store.ts";
import { canvasDpr, detectTouch } from "../input/touch.ts";

export const lowQuality = (): boolean => useUi.getState().quality === "low";

/** Pixel-ratio range for High (the touch-step default). */
export const HIGH_DPR = canvasDpr(detectTouch());

/** Anti-aliasing for the renderer this page creates (fixed once the canvas exists). */
export const ANTIALIAS = !lowQuality();

const DEV = import.meta.env.MODE !== "production";
const PROPS_GROUP = /(^|\/)rooftop-props$/;
/** AC units and antennas (the rooftop-props group's ac-b-* / ant-b-* and decor's own ac-N / antenna-N). */
const THINNED = /(^|\/)(ac|ant|antenna)-/;

/** Mounted inside the canvas: applies the pixel ratio and thins the rooftop props. */
export function QualityView() {
  const setDpr = useThree(s => s.setDpr);
  const scene = useThree(s => s.scene);
  const quality = useUi(s => s.quality);
  const st = useRef<{ group: Object3D | null; frame: number }>({ group: null, frame: 0 });

  useEffect(() => {
    setDpr(quality === "low" ? 1 : HIGH_DPR);
  }, [quality, setDpr]);

  // decor.json loads late and r3g may rebuild nodes, so re-check every 30 frames (cheap: the props
  // group is found once, then only the decor prefab's ~300 nodes are walked).
  useFrame(() => {
    const s = st.current;
    if (s.frame++ % 30 !== 0) return;
    if (!s.group || !s.group.parent) {
      s.group = null;
      scene.traverse(o => {
        const id = o.userData.prefabNodeId;
        if (!s.group && typeof id === "string" && PROPS_GROUP.test(id)) s.group = o;
      });
    }
    // Walk the whole decor prefab (the props group's parent): AC units and antennas live in both.
    const g = s.group?.parent ?? s.group;
    if (!g) return;
    const show = !lowQuality();
    let thinned = 0, hidden = 0;
    g.traverse(o => {
      const id = o.userData.prefabNodeId;
      if (o === g || typeof id !== "string" || !THINNED.test(id)) return;
      thinned++;
      if (o.visible !== show) o.visible = show;
      if (!o.visible) hidden++;
    });
    if (DEV) (window as unknown as { __quality?: unknown }).__quality = { quality: useUi.getState().quality, thinned, hidden };
  });
  return null;
}
