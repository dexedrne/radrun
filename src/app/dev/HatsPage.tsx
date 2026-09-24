// ?hats (dev/test builds only): George's campaign hats on his head across his clips, one row per hat,
// one column per pose, each cell a 3/4 close-up of the head. For tuning HAT_LIFT / HAT_FWD (app/hats.ts):
// the hat should sit on the crown of the head and turn / tilt with it in every clip.
// Knobs: &yaw=deg (camera around the head, default 35), &cell=px (default 200), &lift=m / &fwd=m (try
// other hat offsets without editing hats.ts).
import { useEffect, useRef, useState } from "react";
import {
  AnimationMixer, Color, DirectionalLight, HemisphereLight, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type AnimationClip, type Object3D,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GEORGE_GLB, GEORGE_RENDER } from "../george.config.ts";
import { headRestInverse, makeHats, placeHats } from "../hats.ts";

declare global {
  interface Window { __hats?: { done: boolean; dataUrl?: string; error?: string } }
}

const q = new URLSearchParams(location.search);
const YAW = (Number(q.get("yaw") ?? 35) * Math.PI) / 180;
const CELL = Number(q.get("cell") ?? 200);
const LIFT = q.has("lift") ? Number(q.get("lift")) : undefined;
const FWD = q.has("fwd") ? Number(q.get("fwd")) : undefined;
const POSES: [string, number][] = [["Idle", 0.4], ["Idle", 2.2], ["Walk", 0.3], ["Run", 0.25], ["Sit_Idle", 0.8], ["Loaf", 0.6], ["Happy", 0.35], ["Sulk", 0.6]];
const HATS = ["party", "crown", "foil"];

async function render(canvas: HTMLCanvasElement): Promise<string> {
  const draco = new DRACOLoader().setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
  const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(GEORGE_GLB);
  const model: Object3D = gltf.scene;
  model.scale.setScalar(GEORGE_RENDER.scale);
  const clips: AnimationClip[] = gltf.animations;
  const head = model.getObjectByName("head");
  if (!head) throw new Error("no head bone");
  const rest = headRestInverse(model, head);
  const scene = new Scene();
  scene.background = new Color("#2b2f45");
  scene.add(model, new HemisphereLight("#e3eeff", "#6b5d7a", 1.6));
  const sun = new DirectionalLight("#fff4e0", 1.6);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const hats = makeHats();
  scene.add(hats);
  const poses = POSES.filter(([n]) => clips.some(c => c.name === n));
  const W = CELL * poses.length, H = CELL * HATS.length;
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setScissorTest(true);
  const cam = new PerspectiveCamera(30, 1, 0.02, 20);
  const mixer = new AnimationMixer(model);
  const hp = new Vector3();
  HATS.forEach((hat, row) => {
    for (const h of hats.children) h.visible = h.name === hat;
    hats.visible = true;
    poses.forEach(([name, t], col) => {
      mixer.stopAllAction();
      mixer.clipAction(clips.find(c => c.name === name)!).reset().play();
      mixer.setTime(t);
      model.updateMatrixWorld(true);
      placeHats(hats, head, rest, GEORGE_RENDER.scale, LIFT, FWD);
      head.getWorldPosition(hp);
      const dist = 0.6;
      cam.position.set(hp.x + Math.sin(YAW) * dist, hp.y + 0.2, hp.z + Math.cos(YAW) * dist);
      cam.lookAt(hp.x, hp.y + 0.03, hp.z);
      const x = col * CELL, y = (HATS.length - 1 - row) * CELL;
      renderer.setViewport(x, y, CELL, CELL);
      renderer.setScissor(x, y, CELL, CELL);
      renderer.render(scene, cam);
    });
  });
  console.info(`[hats] ${poses.map(p => p[0]).join(" ")}`);
  draco.dispose();
  const url = canvas.toDataURL("image/png");
  renderer.dispose();
  return url;
}

export default function HatsPage() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    window.__hats = { done: false };
    render(ref.current!).then(
      dataUrl => { window.__hats = { done: true, dataUrl }; setUrl(dataUrl); },
      e => { window.__hats = { done: true, error: String(e) }; console.error("[hats]", e); },
    );
  }, []);
  return (
    <div style={{ padding: 16, background: "#1b1d2e", minHeight: "100vh" }}>
      <canvas ref={ref} style={{ display: url ? "none" : "block" }} />
      {url && <img src={url} alt="George's hats" />}
    </div>
  );
}
