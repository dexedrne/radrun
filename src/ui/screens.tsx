// Plain React DOM screens over the canvas (spec §12): title, loading, in-round HUD, pause, results.
import { useEffect, useState } from "react";
import { RADBROS, type RadbroId } from "../game/round.ts";
import type { Difficulty } from "../sim/tuning.ts";
import { useUi } from "./store.ts";
import { MEDAL_COLOR, PERSONA, RADBRO_COLOR, S, clockText, heat, shareText } from "./strings.ts";
import { challengeUrl, type Challenge, type Settings } from "./prefs.ts";

const panel: React.CSSProperties = { background: "rgba(14,16,30,0.82)", borderRadius: 12, padding: "14px 18px", boxShadow: "0 6px 30px rgba(0,0,0,0.35)" };
const btn = (primary = false): React.CSSProperties => ({
  font: "700 15px ui-monospace, monospace", padding: "10px 18px", borderRadius: 8, cursor: "pointer", letterSpacing: 1,
  border: primary ? "none" : "1px solid rgba(255,255,255,0.35)", background: primary ? "#ff3d7f" : "rgba(255,255,255,0.08)", color: "#fff",
});
const layer: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 20 };

// ---- title -----------------------------------------------------------------------------------------

export function Title(props: {
  chaser: RadbroId; setChaser: (c: RadbroId) => void; difficulty: Difficulty; setDifficulty: (d: Difficulty) => void;
  challenge: Challenge; onPlay: () => void; ready: boolean;
}) {
  const { chaser, difficulty, challenge } = props;
  return (
    <div style={{ ...layer, display: "grid", placeItems: "center", background: "linear-gradient(180deg, rgba(10,12,30,0.15), rgba(10,12,30,0.55))" }}>
      <div style={{ textAlign: "center", maxWidth: 760, padding: 16 }}>
        <div style={{ font: "900 72px/1 ui-monospace, monospace", letterSpacing: 6, color: "#fff", textShadow: "4px 4px 0 #ff3d7f, 8px 8px 0 rgba(0,0,0,0.35)" }}>{S.title}</div>
        <div style={{ marginTop: 10, fontSize: 14, opacity: 0.95, textShadow: "0 1px 2px #000" }}>{S.pitch}</div>
        {challenge.t !== null && (
          <div style={{ marginTop: 10, display: "inline-block", background: "#ffd23f", color: "#1a1a1a", fontWeight: 800, padding: "6px 12px", borderRadius: 6 }}>
            challenge: beat {challenge.t.toFixed(1)} s{challenge.r ? ` vs #${challenge.r}` : ""}
          </div>
        )}
        <div style={{ ...panel, marginTop: 16 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>pick your Radbro · {S.youChase}</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            {RADBROS.map(id => (
              <button key={id} onClick={() => props.setChaser(id)} data-testid={`card-${id}`}
                style={{
                  width: 150, padding: "12px 8px", borderRadius: 10, cursor: "pointer", color: "#fff", font: "700 14px ui-monospace, monospace",
                  background: id === chaser ? "rgba(255,61,127,0.35)" : "rgba(255,255,255,0.06)",
                  border: id === chaser ? "2px solid #ff3d7f" : "2px solid rgba(255,255,255,0.2)",
                }}>
                <div style={{ margin: "0 auto 8px", width: 44, height: 64, borderRadius: 6, background: RADBRO_COLOR[id].body, boxShadow: `inset 0 -8px 0 ${RADBRO_COLOR[id].accent}` }} />
                <div>Radbro #{id}</div>
                <div style={{ fontSize: 11, opacity: 0.7, fontWeight: 400 }}>{PERSONA[id]}</div>
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
            {(["chill", "normal"] as const).map(d => (
              <button key={d} onClick={() => props.setDifficulty(d)} style={{ ...btn(false), background: d === difficulty ? "rgba(255,210,63,0.3)" : "rgba(255,255,255,0.06)", borderColor: d === difficulty ? "#ffd23f" : "rgba(255,255,255,0.35)" }}>
                {d === "chill" ? "Chill" : "Normal"}
              </button>
            ))}
          </div>
          <button onClick={props.onPlay} disabled={!props.ready} style={{ ...btn(true), marginTop: 14, fontSize: 22, padding: "12px 48px", opacity: props.ready ? 1 : 0.5 }} data-testid="play">
            {props.ready ? "PLAY" : "loading city…"}
          </button>
        </div>
        <div style={{ ...panel, marginTop: 12, fontSize: 12, lineHeight: 1.7, textAlign: "left", display: "inline-block" }}>
          <b>controls</b> · mouse look/aim · WASD run · Space jump · LMB hold = web onto the ringed balloon, release = let go ·
          red ring on him + LMB = <b>YOINK</b> · Q/RMB look at him · R retry · Esc pause
        </div>
        <div style={{ marginTop: 10, fontSize: 11, opacity: 0.75, textShadow: "0 1px 2px #000" }}>{S.credits}</div>
      </div>
    </div>
  );
}

export function Loading({ onRetry, onMenu }: { onRetry: () => void; onMenu: () => void }) {
  const load = useUi(s => s.load);
  return (
    <div style={{ ...layer, display: "grid", placeItems: "center", background: "rgba(10,12,30,0.5)" }}>
      <div style={{ ...panel, minWidth: 260, textAlign: "center" }} data-testid="loading">
        <div style={{ fontWeight: 800, letterSpacing: 3 }}>{S.loading}</div>
        <div style={{ height: 8, background: "rgba(255,255,255,0.15)", borderRadius: 4, marginTop: 10 }}>
          <div style={{ height: 8, width: `${Math.round(load.progress * 100)}%`, background: "#ff3d7f", borderRadius: 4, transition: "width 0.2s" }} />
        </div>
        {load.error && (
          <div style={{ marginTop: 10, fontSize: 12 }}>
            <div style={{ color: "#ff8a8a", wordBreak: "break-all" }}>failed to load {load.error}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 8 }}>
              <button style={btn(true)} onClick={onRetry}>Retry</button>
              <button style={btn()} onClick={onMenu}>Menu</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- in-round HUD --------------------------------------------------------------------------------

export function RoundHud({ reducedMotion, easyGrab }: { reducedMotion: boolean; easyGrab: boolean }) {
  const r = useUi(s => s.round);
  const screen = useUi(s => s.screen);
  const feed = useUi(s => s.feed);
  const banner = useUi(s => s.banner);
  const bubble = useUi(s => s.bubble);
  const fade = useUi(s => s.fade);
  const [now, setNow] = useState(performance.now());
  const [hints, setHints] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 100);
    const h = setTimeout(() => setHints(false), 10000);
    return () => { clearInterval(t); clearTimeout(h); };
  }, []);
  const hot = heat(r.d);
  const cd = screen === "countdown" ? Math.ceil(r.countdown) : 0;
  const ringColor = r.ring === "runner" ? "#ff3355" : r.ring === "attached" ? "#3ddc84" : r.ring === "hook" ? "#ffe14d" : "rgba(255,255,255,0.85)";
  const bannerOn = banner && now - banner.t < 1300;
  const bubbleOn = bubble && now - bubble.t < 1800;
  const fadeA = fade && now - fade < 600 ? 1 - (now - fade) / 600 : 0;
  const speedLines = !reducedMotion && r.speed > 14 ? Math.min(1, (r.speed - 14) / 10) : 0;
  const box: React.CSSProperties = { position: "fixed", zIndex: 10, pointerEvents: "none" };
  return (
    <>
      {speedLines > 0 && (
        <div style={{ ...box, inset: 0, opacity: speedLines * 0.55, background: "radial-gradient(ellipse at center, transparent 55%, rgba(255,255,255,0.55) 100%)" }} />
      )}
      {fadeA > 0 && <div style={{ ...box, inset: 0, background: `rgba(0,0,0,${(fadeA * 0.8).toFixed(2)})` }} />}
      {/* timer */}
      <div style={{ ...box, top: 10, left: "50%", transform: "translateX(-50%)", font: "800 30px ui-monospace, monospace", color: r.clock < 15 ? "#ff4d4d" : "#fff", textShadow: "0 2px 4px rgba(0,0,0,0.6)" }} data-testid="timer">
        {clockText(r.clock)}
      </div>
      {/* distance + heat */}
      {screen !== "results" && <div style={{ ...box, top: 10, right: 12, ...panel, padding: "8px 12px", minWidth: 180 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800 }}>
          <span>{r.d.toFixed(0)} m</span>
          <span style={{ color: hot.color }}>{hot.label}</span>
        </div>
        <div style={{ height: 7, background: "rgba(255,255,255,0.15)", borderRadius: 4, marginTop: 6 }}>
          <div style={{ height: 7, width: `${hot.fill * 100}%`, background: hot.color, borderRadius: 4, transition: "width 0.2s" }} />
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6, minHeight: 20 }}>
          {r.panic && !r.gassed && <span style={{ background: "#ff3355", padding: "1px 6px", borderRadius: 4, fontWeight: 800 }}>{S.panicTag}</span>}
          {r.gassed && <span style={{ background: "#7cdb6a", color: "#111", padding: "1px 6px", borderRadius: 4, fontWeight: 800 }}>{S.gassedBadge}</span>}
        </div>
      </div>}
      {/* reticle */}
      {screen !== "results" && <div style={{ ...box, left: "50%", top: "50%", width: 8, height: 8, marginLeft: -4, marginTop: -4, borderRadius: 4, background: ringColor, boxShadow: "0 0 0 1.5px rgba(0,0,0,0.5)" }} />}
      {r.ring === "runner" && screen === "chase" && (
        <div style={{ ...box, left: "50%", top: "50%", transform: "translate(-50%, 14px)", color: "#ff3355", font: "900 18px ui-monospace, monospace", textShadow: "0 1px 3px #000", letterSpacing: 2 }}>{S.yoink}</div>
      )}
      {/* countdown / banners */}
      {cd > 0 && (
        <div style={{ ...box, left: "50%", top: "38%", transform: "translate(-50%, -50%)", font: "900 96px ui-monospace, monospace", color: "#fff", textShadow: "5px 5px 0 #ff3d7f" }}>{cd}</div>
      )}
      {bannerOn && (
        <div style={{ ...box, left: "50%", top: "30%", transform: "translate(-50%, -50%)", font: "900 54px ui-monospace, monospace", color: "#fff", textShadow: "4px 4px 0 #ff3d7f" }}>{banner!.text}</div>
      )}
      {/* speech bubble + edge arrow (positioned by ScreenTracker) */}
      <div id="rr-bubble" style={{ ...box, left: 0, top: 0, visibility: "hidden" }}>
        {bubbleOn && (
          <div style={{ background: "#fff", color: "#111", fontWeight: 800, padding: "5px 10px", borderRadius: 10, whiteSpace: "nowrap", boxShadow: "0 2px 6px rgba(0,0,0,0.35)" }}>{bubble!.text}</div>
        )}
      </div>
      <div id="rr-arrow" style={{ ...box, left: 0, top: 0, visibility: "hidden" }}>
        <div style={{ width: 0, height: 0, borderTop: "14px solid transparent", borderBottom: "14px solid transparent", borderLeft: "26px solid #ff3355", filter: "drop-shadow(0 1px 2px #000)" }} />
      </div>
      {/* feed */}
      <div style={{ ...box, left: 12, bottom: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        {feed.filter(f => now - f.t < 5000).map(f => (
          <div key={f.id} style={{ background: "rgba(14,16,30,0.7)", padding: "3px 8px", borderRadius: 5 }}>{f.text}</div>
        ))}
        {hints && (
          <div style={{ background: "rgba(14,16,30,0.6)", padding: "3px 8px", borderRadius: 5, opacity: 0.85 }}>
            WASD run · Space jump · {easyGrab ? "hold Space" : "hold LMB"} = web · red ring = {easyGrab ? "Space" : "LMB"} to YOINK · Q look at him · hold R retry
          </div>
        )}
      </div>
      {r.holdR > 0 && (
        <div style={{ ...box, left: "50%", bottom: 40, transform: "translateX(-50%)", ...panel, padding: "4px 10px" }}>retry… {Math.round(r.holdR * 100)}%</div>
      )}
      <div style={{ ...box, right: 12, bottom: 8, fontSize: 11, opacity: 0.6 }}>{r.fps.toFixed(0)} fps</div>
    </>
  );
}

// ---- pause ---------------------------------------------------------------------------------------

export function Pause(props: { onResume: () => void; onRestart: () => void; onQuit: () => void; settings: Settings; setSettings: (s: Settings) => void }) {
  const [open, setOpen] = useState(false);
  const s = props.settings;
  const set = (patch: Partial<Settings>) => props.setSettings({ ...s, ...patch });
  return (
    <div style={{ ...layer, zIndex: 30, display: "grid", placeItems: "center", background: "rgba(8,10,20,0.55)" }}>
      <div style={{ ...panel, minWidth: 300, textAlign: "center" }}>
        <div style={{ font: "900 28px ui-monospace, monospace", letterSpacing: 4 }}>{S.paused}</div>
        <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
          <button style={btn(true)} onClick={props.onResume}>Resume</button>
          <button style={btn()} onClick={props.onRestart}>Restart</button>
          <button style={btn()} onClick={() => setOpen(!open)}>Settings</button>
          <button style={btn()} onClick={props.onQuit}>Quit</button>
        </div>
        {open && (
          <div style={{ marginTop: 12, textAlign: "left", display: "grid", gap: 6, fontSize: 12 }}>
            <label>sensitivity {s.sensitivity.toFixed(4)}<input type="range" min={0.0005} max={0.006} step={0.0001} value={s.sensitivity} onChange={e => set({ sensitivity: Number(e.target.value) })} style={{ width: "100%" }} /></label>
            <label>volume {Math.round(s.volume * 100)}%<input type="range" min={0} max={1} step={0.05} value={s.volume} onChange={e => set({ volume: Number(e.target.value) })} style={{ width: "100%" }} /></label>
            <label>FOV {s.fov}°<input type="range" min={55} max={75} step={1} value={s.fov} onChange={e => set({ fov: Number(e.target.value) })} style={{ width: "100%" }} /></label>
            <label><input type="checkbox" checked={s.invertY} onChange={e => set({ invertY: e.target.checked })} /> invert Y</label>
            <label><input type="checkbox" checked={s.reducedMotion} onChange={e => set({ reducedMotion: e.target.checked })} /> reduced motion</label>
            <label><input type="checkbox" checked={s.easyGrab} onChange={e => set({ easyGrab: e.target.checked })} /> easy grab (tap Space = jump, hold Space = swing)</label>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- results -------------------------------------------------------------------------------------

export function ResultsScreen(props: { onRetry: () => void; onMenu: () => void }) {
  const r = useUi(s => s.results);
  const [copied, setCopied] = useState("");
  if (!r) return null;
  const share = async () => {
    const text = `${shareText(r.kind, r.runner, r.time)} ${challengeUrl(r.chaser, r.runner, r.difficulty, r.time)}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied to clipboard");
    } catch {
      setCopied(text);
    }
  };
  const delta = r.caught && r.best !== null ? r.time - r.best : null;
  return (
    <div style={{ ...layer, display: "grid", placeItems: "end center", paddingBottom: "8vh", pointerEvents: "none" }}>
      <div style={{ ...panel, minWidth: 360, textAlign: "center", pointerEvents: "auto" }} data-testid="results">
        {r.caught ? (
          <>
            <div style={{ font: "900 34px ui-monospace, monospace", letterSpacing: 2 }}>{r.kind === "yoink" ? "YOINKED" : "TAGGED"} in {r.time.toFixed(1)} s</div>
            <div style={{ marginTop: 8, display: "inline-block", padding: "4px 14px", borderRadius: 20, fontWeight: 900, color: "#111", background: MEDAL_COLOR[r.medal] }}>{r.medal}</div>
            <div style={{ marginTop: 6, fontSize: 13, opacity: 0.9 }}>
              {r.newBest ? (r.best === null ? "first catch - personal best" : `new best (${(delta ?? 0).toFixed(1)} s)`) : r.best !== null ? `best ${r.best.toFixed(1)} s (+${(delta ?? 0).toFixed(1)})` : ""}
            </div>
          </>
        ) : (
          <>
            <div style={{ font: "900 34px ui-monospace, monospace" }}>{S.escape}</div>
            <div style={{ marginTop: 6, opacity: 0.9 }}>closest {r.closest.toFixed(1)} m · {S.goneFishing}</div>
          </>
        )}
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
          longest swing chain {r.maxChain} · top speed {r.topSpeed.toFixed(1)} m/s · falls {r.falls} · #{r.chaser} vs #{r.runner} · {r.difficulty}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
          {r.caught && <button style={btn()} onClick={share}>Share</button>}
          <button style={btn(true)} onClick={props.onRetry} data-testid="retry">Retry (R)</button>
          <button style={btn()} onClick={props.onMenu}>Menu</button>
        </div>
        {copied && <div style={{ marginTop: 8, fontSize: 11, opacity: 0.85, wordBreak: "break-all", userSelect: "text" }}>{copied}</div>}
      </div>
    </div>
  );
}

export function ResumeOverlay({ onResume }: { onResume: () => void }) {
  return (
    <div onClick={onResume} style={{ ...layer, zIndex: 25, display: "grid", placeItems: "center", cursor: "pointer" }}>
      <div style={{ ...panel }}>click to resume</div>
    </div>
  );
}
