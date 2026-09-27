// Dev-only ?bench (multiplayer design §7 gates 3 and 4): open it on a phone (vite --host, or a build:test preview) to measure
// the online step cost there, and in each browser to compare the determinism self-test hash.
//   - self-test: the bundled 600-step fixture must hash to SELFTEST_HASH (same value in every engine);
//   - step cost: a recorded Spider-tag match (tag bots, this page's district) replayed through TagMatch.stepWords,
//     microseconds per body per step, for 2 and 8 Radbros;
//   - rollback cost: a snapshot load + a 12-step re-sim (the p99 depth at 150 ms RTT), milliseconds per rollback.
import { useEffect, useState } from "react";
import { applyTuningJson, type TuningJson } from "../../sim/tuning.ts";
import type { CityModel } from "../../world/cityModel.ts";
import { CityIndex } from "../../world/cityModel.ts";
import { TUNING_URL } from "../../world/districts.ts";
import { lv, PAGE } from "../district.ts";
import { TagMatch, type TagSlot } from "../../game/tagMatch.ts";
import { TagBot } from "../../game/tagBot.ts";
import { SELFTEST_HASH, selfTestHash } from "../../net/selftest.ts";

type Row = { label: string; value: string };

declare global {
  interface Window { __bench?: { selfTest: string; ok: boolean; rows: Row[] } }
}

const ROSTER = ["652", "4764", "2564", "723", "3171"] as const;
const hex = (h: number) => `0x${(h >>> 0).toString(16).padStart(8, "0")}`;

async function run(log: (r: Row) => void): Promise<void> {
  const st0 = performance.now();
  const h = selfTestHash();
  const ok = h === SELFTEST_HASH;
  log({ label: "self-test hash", value: `${hex(h)} ${ok ? "✓ matches" : `✗ expected ${hex(SELFTEST_HASH)}`} (${(performance.now() - st0).toFixed(1)} ms)` });
  window.__bench = { selfTest: hex(h), ok, rows: [] };
  const [model, tj] = await Promise.all([
    fetch(lv("city.model.json")).then(r => r.json() as Promise<CityModel>),
    fetch(TUNING_URL).then(r => r.json() as Promise<TuningJson>),
  ]);
  const tuning = applyTuningJson(tj).player;
  const index = new CityIndex(model);
  for (const n of [2, 8]) {
    await new Promise(r => setTimeout(r, 30));
    const slots: TagSlot[] = Array.from({ length: n }, (_, i) => ({ radbro: ROSTER[i % ROSTER.length] }));
    const steps = 1200;
    // Record a bot match, then time the replay (the sim alone, as a rollback re-sim pays it).
    const rec = new TagMatch({ model, index, tuning, slots, seed: 3, seconds: 60, countdown: false });
    const bots = slots.map((_, i) => new TagBot(rec, i, 100 + i, "sharp"));
    const words: number[][] = [];
    for (let s = 0; s < steps; s++) { const w = bots.map(b => b.next(rec)); words.push(w); rec.stepWords(w); for (const b of bots) b.after(); }
    // (A first replay warms the JIT; the second is timed.)
    for (let s = 0, w = new TagMatch({ model, index, tuning, slots, seed: 3, seconds: 60, countdown: false }); s < steps; s++) w.stepWords(words[s]);
    const m = new TagMatch({ model, index, tuning, slots, seed: 3, seconds: 60, countdown: false });
    const snap = m.newSnap();
    let t = performance.now();
    for (let s = 0; s < steps; s++) m.stepWords(words[s]);
    const us = ((performance.now() - t) * 1000) / (steps * n);
    if (m.hash() !== rec.hash()) log({ label: `${n} Radbros`, value: "✗ replay hash differs from the recorded run" });
    log({ label: `step, ${n} Radbros`, value: `${us.toFixed(1)} µs per body-step · ${(us * n / 1000).toFixed(3)} ms per step · match hash ${hex(m.hash())} (compare across browsers)` });
    // Rollback: load the snapshot 12 steps back and re-sim, repeated.
    const m2 = new TagMatch({ model, index, tuning, slots, seed: 3, seconds: 60, countdown: false });
    for (let s = 0; s < 600; s++) m2.stepWords(words[s]);
    m2.save(snap);
    const reps = 60;
    t = performance.now();
    for (let k = 0; k < reps; k++) { m2.load(snap); for (let s = 600; s < 612; s++) m2.stepWords(words[s]); }
    log({ label: `rollback 12 steps, ${n} Radbros`, value: `${((performance.now() - t) / reps).toFixed(2)} ms` });
  }
  log({ label: "district", value: PAGE.name });
  log({ label: "browser", value: navigator.userAgent });
}

export default function BenchPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const out: Row[] = [];
    void run(r => { out.push(r); setRows([...out]); if (window.__bench) window.__bench.rows = out; }).then(() => setDone(true), e => { out.push({ label: "error", value: String(e) }); setRows([...out]); });
  }, []);
  return (
    <div style={{ padding: 16, font: "14px ui-monospace, monospace", color: "#eee", background: "#12142a", minHeight: "100%", boxSizing: "border-box" }} data-testid="bench">
      <h2 style={{ marginTop: 0 }}>RadRun online bench</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}><td style={{ padding: "4px 16px 4px 0", opacity: 0.75, verticalAlign: "top" }}>{r.label}</td><td style={{ padding: "4px 0", wordBreak: "break-word" }}>{r.value}</td></tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 12, opacity: 0.7 }}>{done ? "done" : "running…"}</div>
    </div>
  );
}
