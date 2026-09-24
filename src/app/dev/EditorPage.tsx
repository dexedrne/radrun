// ?editor (dev/test builds only): prnth's PrefabEditor on public/levels/city.json or decor.json
// (?editor=decor). Save writes the file back through the dev server; saving city.json re-runs
// `npm run level`, so moved/resized buildings change gameplay (city.model.json) immediately.
// Data {kind} tags drive the sim: "roof" (landable), "tower" (solid), "hook" (manual balloon).
import { useEffect, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import { PrefabEditor, type PrefabEditorRef } from "react-three-game/editor";
import { PrefabRoot, type Prefab } from "react-three-game";
import { saveLevelFile } from "./save.ts";
import { SKY } from "../GameScene.tsx";
import { CityLook, SkyGradient } from "../cityLook.tsx";

type FileName = "city.json" | "decor.json";

function centreOf(p: Prefab | null): [number, number, number] {
  // Frame the district: the "ground" node of city.json, or the average of decor node positions.
  const nodes = p?.root.children ?? [];
  const ground = nodes.find(n => n.id === "ground");
  const pos = ground?.components?.transform?.properties?.position as number[] | undefined;
  if (pos) return [pos[0], 0, pos[2]];
  const ps = nodes.map(n => n.components?.transform?.properties?.position as number[] | undefined).filter(Boolean) as number[][];
  if (!ps.length) return [0, 0, 0];
  return [ps.reduce((s, q) => s + q[0], 0) / ps.length, ps.reduce((s, q) => s + q[1], 0) / ps.length, ps.reduce((s, q) => s + q[2], 0) / ps.length];
}

/** Point the editor's OrbitControls at the level once. */
function FrameLevel({ at }: { at: [number, number, number] }) {
  const controls = useThree(s => s.controls) as unknown as { target?: { set: (x: number, y: number, z: number) => void }; update?: () => void } | null;
  const camera = useThree(s => s.camera);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !controls?.target) return;
    done.current = true;
    controls.target.set(at[0], at[1], at[2]);
    camera.position.set(at[0] + 60, at[1] + 90, at[2] + 140);
    camera.far = 3000;
    camera.updateProjectionMatrix();
    controls.update?.();
  }, [controls, camera, at]);
  return null;
}

/** When editing decor, show the city (read-only) for context. */
function CityContext() {
  const [city, setCity] = useState<Prefab | null>(null);
  useEffect(() => {
    fetch(`/levels/city.json?v=${Date.now()}`).then(r => r.json()).then(setCity, () => setCity(null));
  }, []);
  return city ? <PrefabRoot data={city} /> : null;
}

export default function EditorPage() {
  const initial: FileName = new URLSearchParams(location.search).get("editor") === "decor" ? "decor.json" : "city.json";
  const [file, setFile] = useState<FileName>(initial);
  const [prefab, setPrefab] = useState<Prefab | null>(null);
  const [status, setStatus] = useState("");
  const ref = useRef<PrefabEditorRef>(null);
  useEffect(() => {
    setPrefab(null);
    fetch(`/levels/${file}?v=${Date.now()}`).then(r => r.json()).then(setPrefab, e => setStatus(`load failed: ${String(e)}`));
  }, [file]);
  const save = async () => {
    const data = ref.current?.save();
    if (!data) return;
    setStatus("saving…");
    setStatus(await saveLevelFile(file, data));
  };
  const bar: React.CSSProperties = { position: "fixed", left: "50%", bottom: 10, transform: "translateX(-50%)", zIndex: 50, display: "flex", gap: 8, alignItems: "center", background: "rgba(12,16,28,0.9)", color: "#fff", padding: "6px 10px", borderRadius: 8, font: "12px ui-monospace, monospace", maxWidth: "92vw" };
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      {prefab && (
        <PrefabEditor ref={ref} key={file} prefab={prefab} canvasProps={{ flat: true, camera: { position: [180, 120, 300], far: 3000 } }}>
          <color attach="background" args={[SKY]} />
          <SkyGradient />
          <CityLook />
          {/* Same lights as the play prefab (the level files carry none). */}
          <hemisphereLight args={["#e3eeff", "#6b5d7a", 1.25]} />
          <directionalLight position={[216, 220, 175]} intensity={1.5} color="#fff4e0" />
          <FrameLevel at={centreOf(prefab)} />
          {file === "decor.json" && <CityContext />}
        </PrefabEditor>
      )}
      <div style={bar}>
        <b>editor</b>
        <select value={file} onChange={e => setFile(e.target.value as FileName)}>
          <option value="city.json">city.json (gameplay)</option>
          <option value="decor.json">decor.json (decor)</option>
        </select>
        <button onClick={save}>save {file}</button>
        <a href="/?sandbox" style={{ color: "#93c5fd" }}>play</a>
        <span style={{ opacity: 0.85, whiteSpace: "pre-wrap", maxWidth: 520 }}>{status || "Data kind: roof / tower / hook drive the sim; unit boxes, no rotation"}</span>
      </div>
    </div>
  );
}
