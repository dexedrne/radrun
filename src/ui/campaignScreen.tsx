// Round 4 campaign UI: the level picker (CAMPAIGN on the title), the live objective list in the round
// HUD, and the stars block on the results screen.
import { useMemo, useState } from "react";
import { useUi } from "./store.ts";
import { btn, panel, scroller, useViewport } from "./screens.tsx";
import { HATS, LEVELS, TOTAL_STARS, hatUnlocked, levelUnlocked, loadProgress, objectiveText, saveProgress, starCount, type Hat, type Level, type Objective, type Progress } from "../game/campaign.ts";
import { mutNames } from "../game/mutators.ts";
import { DISTRICTS, DISTRICT_IDS } from "../world/districts.ts";

const GOLD = "#ffd23f";
const stars = (s: readonly boolean[] | undefined) => [0, 1, 2].map(i => (s?.[i] ? "★" : "☆")).join("");
const DIFF_NAME: Record<string, string> = { chill: "chill", normal: "normal", degen: "DEGEN" };

export function CampaignScreen(props: { onStart: (n: number) => void; onBack: () => void; ready: boolean }) {
  const sel = useUi(s => s.campaignSel);
  const { compact } = useViewport();
  const [progress, setProgress] = useState<Progress>(() => loadProgress());
  const total = useMemo(() => starCount(progress), [progress]);
  const level = LEVELS[Math.min(LEVELS.length, Math.max(1, sel)) - 1];
  const open = levelUnlocked(progress, level.n);
  const setHat = (hat: Hat) => {
    const p = { ...progress, hat };
    saveProgress(p);
    setProgress(p);
  };
  const cell = compact ? 11 : 13;
  return (
    <div style={{ ...scroller, background: "rgba(8,10,22,0.45)" }} data-testid="campaign-screen">
      <div style={{ ...panel, margin: "auto", width: "min(860px, 96vw)", boxSizing: "border-box", padding: compact ? "8px 10px" : "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ font: `900 ${compact ? 20 : 28}px ui-monospace, monospace`, letterSpacing: 3 }}>CAMPAIGN</div>
          <div style={{ fontWeight: 800, color: GOLD }} data-testid="campaign-stars">{total}/{TOTAL_STARS} ★</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: compact ? `repeat(${DISTRICT_IDS.length}, 1fr)` : "repeat(auto-fit, minmax(150px, 1fr))", gap: compact ? 6 : 10, marginTop: compact ? 6 : 12 }}>
          {DISTRICT_IDS.map(id => (
            <div key={id}>
              <div style={{ fontSize: cell, fontWeight: 800, opacity: 0.85, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{DISTRICTS[id].name}</div>
              {LEVELS.filter(l => l.map === id).map(l => {
                const on = levelUnlocked(progress, l.n);
                const picked = l.n === level.n;
                return (
                  <button key={l.n} onClick={() => useUi.setState({ campaignSel: l.n })} data-testid={`level-${l.n}`}
                    style={{ ...btn(false), display: "flex", gap: 6, alignItems: "center", width: "100%", textAlign: "left", marginBottom: 4, padding: compact ? "4px 6px" : "7px 10px", fontSize: cell, opacity: on ? 1 : 0.5,
                      background: picked ? "rgba(255,210,63,0.22)" : "rgba(255,255,255,0.05)", borderColor: picked ? GOLD : "rgba(255,255,255,0.25)" }}>
                    <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><span style={{ opacity: 0.7 }}>{l.n}.</span> {on ? l.name : `🔒 ${l.name}`}</span>
                    <span style={{ color: GOLD, letterSpacing: 1, whiteSpace: "nowrap" }}>{stars(progress.stars[l.n])}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <LevelCard level={level} progress={progress} compact={compact} />
        <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", flexWrap: "wrap", marginTop: compact ? 6 : 12 }}>
          <button onClick={props.onBack} style={btn(false)} data-testid="campaign-back">Back</button>
          <button onClick={() => open && props.onStart(level.n)} disabled={!open || !props.ready} data-testid="campaign-start"
            style={{ ...btn(true), fontSize: compact ? 15 : 18, padding: compact ? "8px 22px" : "12px 30px", opacity: open && props.ready ? 1 : 0.5 }}>
            {open ? `START ${level.n}. ${level.name.toUpperCase()}` : `catch him in level ${level.n - 1} first`}
          </button>
          <span style={{ fontSize: 11, opacity: 0.75, marginLeft: 6 }}>George's hat:</span>
          {HATS.map(h => {
            const ok = hatUnlocked(progress, h.id);
            return (
              <button key={h.id} onClick={() => ok && setHat(h.id)} disabled={!ok} title={ok ? h.name : `${h.stars} stars`} data-testid={`hat-${h.id}`}
                style={{ ...btn(false), padding: "4px 8px", fontSize: 11, opacity: ok ? 1 : 0.45, borderColor: progress.hat === h.id ? GOLD : "rgba(255,255,255,0.25)" }}>
                {ok ? h.name : `🔒 ${h.stars}★`}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LevelCard({ level, progress, compact }: { level: Level; progress: Progress; compact: boolean }) {
  const got = progress.stars[level.n];
  const mut = mutNames(level.mutators);
  const best = progress.best[level.n];
  return (
    <div style={{ marginTop: compact ? 6 : 12, padding: compact ? "6px 10px" : "10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.06)" }} data-testid="level-card">
      <div style={{ fontWeight: 900, fontSize: compact ? 14 : 17 }}>
        {level.n}. {level.name} <span style={{ fontWeight: 600, fontSize: 12, opacity: 0.8 }}>· {DISTRICTS[level.map].name} · {DIFF_NAME[level.difficulty]}{mut.length ? ` · ${mut.join(" + ")}` : ""}{best !== undefined ? ` · best ${best.toFixed(1)} s` : ""}</span>
      </div>
      {!compact && <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>{level.blurb}</div>}
      <div style={{ display: "flex", gap: compact ? 10 : 18, flexWrap: "wrap", marginTop: 4, fontSize: compact ? 12 : 13 }}>
        {level.goals.map((o, i) => (
          <span key={i}><span style={{ color: GOLD }}>{got?.[i] ? "★" : "☆"}</span> {objectiveText(o)}</span>
        ))}
      </div>
    </div>
  );
}

/** Live objective state from the HUD numbers: met already, still open, or lost for this round. */
function live(o: Objective, h: { elapsed: number; falls: number; maxChain: number; clock: number; runnerLow: number }): "met" | "open" | "lost" {
  switch (o.kind) {
    case "catch": case "yoink": case "closeCall": return "open";
    case "under": return h.elapsed >= o.s ? "lost" : "open";
    case "noFalls": return h.falls > 0 ? "lost" : "open";
    case "chain": return h.maxChain >= o.n ? "met" : "open";
    case "above": return h.runnerLow < o.y ? "lost" : "open";
  }
}

/** The level's three objectives in the round HUD (left, under the minimap area), live. */
export function CampaignHud() {
  const camp = useUi(s => s.campaign);
  const r = useUi(s => s.round);
  const screen = useUi(s => s.screen);
  const touch = useUi(s => s.touch);
  const { compact } = useViewport();
  if (!camp || screen === "results") return null;
  const level = LEVELS[camp.n - 1];
  if (!level) return null;
  const h = { elapsed: r.elapsed, falls: r.falls, maxChain: r.maxChain, clock: r.clock, runnerLow: r.runnerLow };
  return (
    <div style={{ position: "fixed", zIndex: 10, pointerEvents: "none", left: 12, top: touch ? 112 : 58, ...panel, padding: "6px 10px", fontSize: compact ? 11 : 12 }} data-testid="campaign-hud">
      <div style={{ fontWeight: 900, marginBottom: 2 }}>{level.n}. {level.name}</div>
      {level.goals.map((o, i) => {
        const st = live(o, h);
        const extra = o.kind === "chain" ? ` (${Math.min(r.maxChain, o.n)}/${o.n})` : "";
        return (
          <div key={i} style={{ opacity: st === "lost" ? 0.45 : 1, textDecoration: st === "lost" ? "line-through" : "none" }}>
            <span style={{ color: st === "met" ? "#3ddc84" : GOLD }}>{st === "met" ? "✓" : "☆"}</span> {objectiveText(o)}{extra}
          </div>
        );
      })}
    </div>
  );
}

/** Results: the level's objectives with this run's result and which stars are new. */
export function CampaignResult() {
  const r = useUi(s => s.results);
  const c = r?.campaign;
  if (!c) return null;
  const level = LEVELS[c.n - 1];
  return (
    <div style={{ marginTop: 10, padding: "6px 10px", borderRadius: 10, background: "rgba(255,210,63,0.1)", textAlign: "left" }} data-testid="campaign-result">
      <div style={{ fontWeight: 900, textAlign: "center" }}>
        {level.n}. {level.name} <span style={{ color: GOLD, letterSpacing: 2 }} data-testid="level-stars">{stars(c.stars)}</span>
      </div>
      {level.goals.map((o, i) => (
        <div key={i} style={{ fontSize: 13, marginTop: 2 }}>
          <span style={{ color: c.got[i] ? GOLD : "rgba(255,255,255,0.4)" }}>{c.got[i] ? "★" : "☆"}</span> {objectiveText(o)}
          {c.fresh[i] && <span style={{ marginLeft: 6, fontWeight: 900, color: "#3ddc84" }}>NEW</span>}
        </div>
      ))}
      <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4, textAlign: "center" }}>campaign {c.totalStars}/{TOTAL_STARS} ★</div>
    </div>
  );
}
