// ?routeview (dev/test builds): top-down junction graph coloured by bake margin, plus a live runner that
// flees from your mouse (the mouse is the player). Click an edge's junction to list its branches.
import { useEffect, useRef, useState } from "react";
import type { CityModel } from "../../world/cityModel.ts";
import { decodePack, type Pack } from "../../route/trackPack.ts";
import type { BakeReport } from "../../route/bake.ts";
import { applyTuningJson, DT, type Difficulty, type DifficultyTable, type TuningJson } from "../../sim/tuning.ts";
import { Runner, RM_EDGE, RM_LOOK, RM_TAUNT, RM_TURN } from "../../runner/runner.ts";
import { Rand } from "../../sim/math.ts";
import { chaseDist } from "../../sim/player.ts";
import { FixedStepper } from "../../sim/stepper.ts";
import { lv } from "../district.ts";
import { TUNING_URL } from "../../world/districts.ts";

type Data = { model: CityModel; pack: Pack; report: BakeReport | null; table: DifficultyTable };

const MODE = ["edge", "look-back", "taunt", "head turn"];

export default function RouteView() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [diff, setDiff] = useState<Difficulty>("normal");
  const [info, setInfo] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: 0, z: 0, set: false });

  useEffect(() => {
    (async () => {
      const [m, p, r, t] = await Promise.all([
        fetch(lv("city.model.json")).then(x => x.json()),
        fetch(lv("runner.pack.bin")).then(x => x.arrayBuffer()),
        fetch(lv("bake.report.json")).then(x => (x.ok ? x.json() : null), () => null),
        fetch(TUNING_URL).then(x => (x.ok ? x.json() : null), () => null),
      ]);
      setData({ model: m, pack: decodePack(p), report: r, table: applyTuningJson(t as TuningJson).difficulty });
    })().catch(e => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!data) return;
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    const { model, pack } = data;
    const b = model.bounds;
    const pad = 20;
    const fit = () => {
      cv.width = innerWidth; cv.height = innerHeight;
      return Math.min((cv.width - 2 * pad) / (b.x1 - b.x0), (cv.height - 2 * pad - 60) / (b.z1 - b.z0));
    };
    let s = fit();
    const X = (x: number) => pad + (x - b.x0) * s;
    const Z = (z: number) => pad + 60 + (z - b.z0) * s;
    const onResize = () => { s = fit(); };
    addEventListener("resize", onResize);
    const onMove = (e: MouseEvent) => { mouse.current = { x: (e.clientX - pad) / s + b.x0, z: (e.clientY - pad - 60) / s + b.z0, set: true }; };
    cv.addEventListener("mousemove", onMove);

    const scores = pack.edges.map(e => e.score);
    const lo = Math.min(...scores), hi = Math.max(...scores);
    const colour = (v: number) => {
      const t = hi > lo ? (v - lo) / (hi - lo) : 1;
      return `hsl(${Math.round(t * 120)}, 85%, 50%)`;
    };
    const rng = new Rand(12345);
    const runner = new Runner(pack, { ...data.table[diff] }, rng, 0, pack.out[0][0]);
    const stepper = new FixedStepper();
    const player = { x: 0, y: 0, z: 0 };
    let last = performance.now(), raf = 0, lastInfo = 0;
    const trail: [number, number][] = [];
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (mouse.current.set) {
        player.x = mouse.current.x; player.z = mouse.current.z;
        player.y = runner.p.y;
      } else { player.x = runner.p.x - 30; player.z = runner.p.z; player.y = runner.p.y; }
      const n = stepper.frame(dt);
      for (let i = 0; i < n; i++) {
        runner.step(player, chaseDist(player, runner.p));
        if (i % 6 === 0) { trail.push([runner.p.x, runner.p.z]); if (trail.length > 400) trail.shift(); }
      }
      // draw
      ctx.fillStyle = "#0e1222"; ctx.fillRect(0, 0, cv.width, cv.height);
      for (const so of model.solids) {
        ctx.fillStyle = so.landable ? `hsl(220, 12%, ${22 + (so.top - 24) * 2}%)` : "#39406a";
        ctx.fillRect(X(so.x0), Z(so.z0), (so.x1 - so.x0) * s, (so.z1 - so.z0) * s);
      }
      // His baked web anchors (pack v2).
      ctx.fillStyle = "rgba(255,210,63,0.7)";
      for (let i = 0; i + 2 < pack.anchors.length; i += 3) ctx.fillRect(X(pack.anchors[i]) - 1.5, Z(pack.anchors[i + 2]) - 1.5, 3, 3);
      ctx.lineWidth = 2;
      for (const e of pack.edges) {
        ctx.strokeStyle = colour(e.score);
        ctx.globalAlpha = runner.mode === RM_EDGE && runner.edge === e.index ? 1 : 0.45;
        ctx.beginPath();
        for (let i = 0; i < e.count; i += 3) {
          const x = e.origin.x + e.samples[i * 5] / 100, z = e.origin.z + e.samples[i * 5 + 2] / 100;
          if (i === 0) ctx.moveTo(X(x), Z(z)); else ctx.lineTo(X(x), Z(z));
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.font = "11px ui-monospace, monospace";
      pack.junctions.forEach((j, i) => {
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(X(j.x), Z(j.z), 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#000"; ctx.fillText(String(i), X(j.x) - (i > 9 ? 7 : 3), Z(j.z) + 4);
      });
      ctx.strokeStyle = "rgba(255,80,160,0.6)"; ctx.beginPath();
      trail.forEach(([x, z], i) => (i ? ctx.lineTo(X(x), Z(z)) : ctx.moveTo(X(x), Z(z)))); ctx.stroke();
      ctx.fillStyle = "#ff3d7f"; ctx.beginPath(); ctx.arc(X(runner.p.x), Z(runner.p.z), 6, 0, Math.PI * 2); ctx.fill();
      if (runner.headX || runner.headZ) {
        ctx.strokeStyle = "#ffd23f"; ctx.beginPath(); ctx.moveTo(X(runner.p.x), Z(runner.p.z));
        ctx.lineTo(X(runner.p.x + runner.headX * 12), Z(runner.p.z + runner.headZ * 12)); ctx.stroke();
      }
      ctx.fillStyle = "#6ec6ff"; ctx.beginPath(); ctx.arc(X(player.x), Z(player.z), 5, 0, Math.PI * 2); ctx.fill();
      if (now - lastInfo > 100) {
        lastInfo = now;
        const d = chaseDist(player, runner.p);
        setInfo(`${MODE[runner.mode]} · edge ${runner.edge} t ${runner.t.toFixed(2)} s · junction ${runner.junction} · d ${d.toFixed(1)} m · m ${runner.band.m.toFixed(3)} (target ${runner.band.mTarget.toFixed(2)}) · rate ${runner.rate.toFixed(2)} · budget ${runner.band.budget.toFixed(1)} s${runner.band.gassed ? " · GASSED" : ""}${runner.band.panic ? " · PANIC" : ""}${runner.mode === RM_LOOK || runner.mode === RM_TAUNT || runner.mode === RM_TURN ? ` · last branch score ${runner.lastScore.toFixed(2)}` : ""}`);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    void DT;
    return () => { cancelAnimationFrame(raf); removeEventListener("resize", onResize); cv.removeEventListener("mousemove", onMove); };
  }, [data, diff]);

  if (err) return <div style={{ padding: 20 }}>routeview failed: {err}</div>;
  const rep = data?.report;
  return (
    <div style={{ position: "fixed", inset: 0, background: "#0e1222" }}>
      <canvas ref={canvas} style={{ position: "absolute", inset: 0 }} />
      <div style={{ position: "absolute", left: 20, top: 8, right: 20, font: "12px ui-monospace, monospace", color: "#fff" }}>
        <b>?routeview</b> · {data ? `${data.pack.junctions.length} junctions · ${data.pack.edges.length} edges · pack ${data.pack.hash} · ${(data.pack.bytes / 1024).toFixed(0)} KB` : "loading…"}
        {rep && ` · min swing window ${rep.checks.minSwingWindowMs} ms · min alley ${rep.checks.minAlleyWindowMs} ms · min landing margin ${rep.checks.minLandMargin} m`}
        {" · "}edge colour = bake margin (red low, green high) · the mouse is the player ·{" "}
        <select value={diff} onChange={e => setDiff(e.target.value as Difficulty)}>
          <option value="normal">normal</option>
          <option value="chill">chill</option>
          <option value="degen">degen</option>
        </select>
        <div style={{ marginTop: 4, opacity: 0.9 }}>{info}</div>
      </div>
    </div>
  );
}
