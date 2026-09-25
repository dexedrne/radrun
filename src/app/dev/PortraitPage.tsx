// ?portrait=<id> (dev/test builds only): renders one Radbro from the game's own GLB + clip pack in its
// Idle pose as a 3/4 bust on a transparent background, the way the title cards show it.
// `npm run portraits` (tools/portraits.ts) screenshots this page into public/ui/radbro<id>.webp.
// Knobs: &yaw=deg (camera around the head, default 28), &t=s (Idle time), &size=px (default 384),
// &bust=f (frame bottom = Head bone - f x (hair top - Head bone), default 0.6). Round 7 pose checks:
// &clip=<name> (instead of Idle, e.g. Free_Fall / Big_Land) and &full (frame the whole body).
import { useEffect, useRef, useState } from "react";
import { AnimationMixer, Box3, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type AnimationClip, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { RADBROS, type RadbroId } from "../../game/round.ts";
import { clipsPath, modelPath } from "../characters.ts";

declare global {
  interface Window { __portrait?: { done: boolean; dataUrl?: string; error?: string } }
}

const q = new URLSearchParams(location.search);
const ID = (RADBROS as readonly string[]).includes(q.get("portrait") ?? "") ? (q.get("portrait") as RadbroId) : RADBROS[0];
const YAW = (Number(q.get("yaw") ?? 28) * Math.PI) / 180;
const T = Number(q.get("t") ?? 0.6);
const SIZE = Number(q.get("size") ?? 384);
const BUST = Number(q.get("bust") ?? 0.6); // how far below the Head bone the frame ends, in head heights
const CLIP = q.get("clip") ?? "Idle";
const FULL = q.has("full");

async function render(canvas: HTMLCanvasElement): Promise<string> {
  const draco = new DRACOLoader().setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const [char, pack] = await Promise.all([loader.loadAsync(modelPath(ID)), loader.loadAsync(clipsPath(ID)).catch(() => null)]);
  const model: Object3D = char.scene;
  const clips: AnimationClip[] = [...char.animations, ...(pack?.animations ?? [])];
  const idle = clips.find(c => c.name === CLIP) ?? clips.find(c => c.name === "Idle") ?? clips[0];
  const scene = new Scene();
  scene.add(model);
  if (idle) {
    const mixer = new AnimationMixer(model);
    mixer.clipAction(idle).play();
    mixer.setTime(T);
  }
  model.updateMatrixWorld(true);

  // Frame the bust: from the top of the hair down past the shoulders.
  const box = new Box3().setFromObject(model, true);
  const head = new Vector3();
  let found = false;
  model.traverse(o => { if (!found && o.name === "Head") { o.getWorldPosition(head); found = true; } });
  if (!found) head.set((box.min.x + box.max.x) / 2, box.max.y - 0.35, (box.min.z + box.max.z) / 2);
  const top = box.max.y + 0.03;
  const bottom = FULL ? box.min.y - 0.05 : head.y - (top - head.y) * BUST;
  console.info(`[portrait] #${ID} ${idle?.name} box y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)} head ${head.y.toFixed(2)} (bone ${found})`);
  const midY = (top + bottom) / 2;
  const fov = 24;
  const half = (top - bottom) / 2;
  const dist = half / Math.tan(((fov / 2) * Math.PI) / 180);
  const cam = new PerspectiveCamera(fov, 1, 0.05, 50);
  const cx = FULL ? (box.min.x + box.max.x) / 2 : head.x, cz = FULL ? (box.min.z + box.max.z) / 2 : head.z;
  cam.position.set(cx + Math.sin(YAW) * dist * (FULL ? 1.15 : 1), midY + 0.08, cz + Math.cos(YAW) * dist * (FULL ? 1.15 : 1));
  cam.lookAt(cx, midY, cz);

  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(2);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, cam);

  // Downsample 2x for clean edges, then encode.
  const out = document.createElement("canvas");
  out.width = out.height = SIZE;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, SIZE, SIZE);
  renderer.dispose();
  draco.dispose();
  return out.toDataURL("image/webp", 0.9);
}

export default function PortraitPage() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    window.__portrait = { done: false };
    render(ref.current!).then(
      dataUrl => { window.__portrait = { done: true, dataUrl }; setUrl(dataUrl); },
      e => { window.__portrait = { done: true, error: String(e) }; console.error("[portrait]", e); },
    );
  }, []);
  return (
    <div style={{ padding: 16, display: "flex", gap: 16, background: "#1b1d2e", minHeight: "100vh" }}>
      <canvas ref={ref} style={{ width: SIZE, height: SIZE, display: url ? "none" : "block" }} />
      {url && <img src={url} width={SIZE} height={SIZE} alt={`Radbro #${ID}`} style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12 }} />}
    </div>
  );
}
