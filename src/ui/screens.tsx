// Plain React DOM screens over the canvas (spec §12): title, loading, in-round HUD, pause, results.
import { useEffect, useState } from "react";
import { RADBROS, type RadbroId } from "../game/round.ts";
import { DIFFICULTIES, type Difficulty } from "../sim/tuning.ts";
import { useUi } from "./store.ts";
import { DIFF_BLURB, DIFF_LABEL, MEDAL_COLOR, PERSONA, RADBRO_COLOR, S, clockText, heat, shareText } from "./strings.ts";
import { challengeUrl, ghostUrl, type Challenge, type Settings, type StoredGhost } from "./prefs.ts";
import type { GhostChoice } from "../app/PlayPage.tsx";
import { hints } from "./hints.ts";
import { DISTRICTS, DISTRICT_IDS } from "../world/districts.ts";
import { PAGE_DISTRICT, gotoDistrict } from "../app/district.ts";
import { DEGEN_STARS, LEVELS, TOTAL_STARS, degenUnlocked, districtUnlocked, starCount, unlockedMutators, type Progress } from "../game/campaign.ts";
import { MUTATORS } from "../game/mutators.ts";
import { CampaignHud, CampaignResult } from "./campaignScreen.tsx";

export const panel: React.CSSProperties = { background: "rgba(14,16,30,0.82)", borderRadius: 12, padding: "14px 18px", boxShadow: "0 6px 30px rgba(0,0,0,0.35)" };
export const btn = (primary = false): React.CSSProperties => ({
  font: "700 15px ui-monospace, monospace", padding: "10px 18px", borderRadius: 8, cursor: "pointer", letterSpacing: 1,
  border: primary ? "none" : "1px solid rgba(255,255,255,0.35)", background: primary ? "#ff3d7f" : "rgba(255,255,255,0.08)", color: "#fff",
});
export const layer: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 20 };
/** A full-screen layer that centres its child and scrolls (from the top) when the child is taller. */
export const scroller: React.CSSProperties = { ...layer, display: "flex", overflowY: "auto", WebkitOverflowScrolling: "touch" } as React.CSSProperties;

/** Viewport size, re-read on resize / rotation. compact = a short (landscape phone) screen. */
export function useViewport(): { w: number; h: number; compact: boolean; narrow: boolean; portrait: boolean } {
  const [vp, setVp] = useState(() => ({ w: innerWidth, h: innerHeight }));
  useEffect(() => {
    const f = () => setVp({ w: innerWidth, h: innerHeight });
    addEventListener("resize", f);
    addEventListener("orientationchange", f);
    return () => { removeEventListener("resize", f); removeEventListener("orientationchange", f); };
  }, []);
  return { ...vp, compact: vp.h < 520, narrow: vp.w < 560, portrait: vp.h > vp.w };
}

/** Touch in portrait: ask for landscape (non-blocking; the game still runs). */
export function RotateHint({ inline = false }: { inline?: boolean }) {
  const touch = useUi(s => s.touch);
  const { portrait } = useViewport();
  if (!touch || !portrait) return null;
  const pill: React.CSSProperties = {
    background: "#ffd23f", color: "#1a1a1a", fontWeight: 800, padding: "8px 14px", borderRadius: 10, fontSize: 13,
    boxShadow: "0 3px 12px rgba(0,0,0,0.35)", textAlign: "center",
  };
  if (inline) return <div style={{ ...pill, marginBottom: 12 }} data-testid="rotate-hint">rotate your phone: RadRun plays in landscape</div>;
  return (
    <div style={{ position: "fixed", left: "50%", top: 96, transform: "translateX(-50%)", zIndex: 40, pointerEvents: "none", width: "max-content", maxWidth: "86vw" }}>
      <div style={pill} data-testid="rotate-hint">rotate your phone: landscape plays best</div>
    </div>
  );
}

// ---- mute button (title + HUD; M key too) ----------------------------------------------------------

export function MuteButton({ muted, onMute, style }: { muted: boolean; onMute: () => void; style: React.CSSProperties }) {
  const label = muted ? "sound off (M)" : "sound on (M)";
  return (
    <button onClick={onMute} title={label} aria-label={label} aria-pressed={muted} data-testid="mute"
      style={{
        position: "fixed", zIndex: 14, width: 40, height: 40, borderRadius: 20, padding: 0, display: "grid", placeItems: "center", cursor: "pointer",
        background: muted ? "rgba(255,61,127,0.45)" : "rgba(14,16,30,0.55)", border: "1px solid rgba(255,255,255,0.4)", color: "#fff", pointerEvents: "auto",
        touchAction: "manipulation", ...style,
      }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
        {muted ? <path d="M16.5 9.5l5 5M21.5 9.5l-5 5" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19.3 5.7a9 9 0 0 1 0 12.6" />}
      </svg>
    </button>
  );
}

// ---- title -----------------------------------------------------------------------------------------

const GHOST_STATUS: Record<string, { text: string; color: string }> = {
  checking: { text: "checking the replay…", color: "#cfd8e3" },
  verified: { text: "verified replay", color: "#3ddc84" },
  unverified: { text: "unverified", color: "#ffb347" },
};
const caughtVerb = (kind: string) => (kind === "yoink" ? "yoinked" : kind === "tag" ? "tagged" : "caught");

/** Title: the ghost link's banner (who, what time, whether the replay reproduces it). */
function GhostBanner({ ghost, active, busy }: { ghost: GhostChoice | null; active: boolean; busy: boolean }) {
  if (busy) return <div style={{ marginTop: 10, display: "inline-block", ...panel, padding: "6px 12px", fontSize: 13 }}>loading the ghost…</div>;
  if (!ghost) return null;
  const { spec, info } = ghost;
  const st = GHOST_STATUS[info.status];
  return (
    <div style={{ marginTop: 10, display: "inline-block", background: "rgba(20,40,60,0.88)", border: "2px solid #9fe6ff", borderRadius: 8, padding: "6px 14px", fontWeight: 800 }} data-testid="ghost-banner">
      <span style={{ color: "#9fe6ff", letterSpacing: 2, marginRight: 8 }}>{S.ghost} RACE</span>
      #{spec.chaser} {caughtVerb(info.kind)} #{spec.runner} in {spec.claimed.toFixed(1)} s · {DIFF_LABEL[spec.difficulty]}
      <span style={{ color: st.color, marginLeft: 8, fontWeight: 700 }} data-testid="ghost-status">{st.text}{info.status === "unverified" && info.older ? " · made on an older build" : ""}</span>
      <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.85, marginTop: 2 }}>
        {active ? "same city, same start, same runner: PLAY races their ghost" : `pick #${spec.chaser} and ${DIFF_LABEL[spec.difficulty]} to race the ghost`}
      </div>
    </div>
  );
}

const TITLE_SHADE = "linear-gradient(180deg, rgba(10,12,30,0.15), rgba(10,12,30,0.55))";

/** Title (round 4: over the key art until the scene is ready, then over the live city). */
export function Title(props: {
  chaser: RadbroId; setChaser: (c: RadbroId) => void; difficulty: Difficulty; setDifficulty: (d: Difficulty) => void;
  challenge: Challenge; onPlay: () => void; onPractice: () => void; ready: boolean; muted: boolean; onMute: () => void;
  ghost: GhostChoice | null; ghostBusy: boolean; ghostActive: boolean; bestGhost: StoredGhost | null; onRaceBest: () => void;
  /** Round 4: campaign progress (locks), the free-play mutators and the CAMPAIGN button. */
  progress: Progress; freeMut: number; setFreeMut: (m: number) => void; onCampaign: () => void;
}) {
  const { chaser, difficulty, challenge, progress } = props;
  const availMut = unlockedMutators(progress) | props.freeMut;
  const stars = starCount(progress);
  const touch = useUi(s => s.touch);
  const { compact, narrow } = useViewport();
  // Phones (landscape = compact, portrait = narrow): the controls strip folds into a small toggle next to
  // the credits (the touch buttons are labelled and the first-run tips teach them), blurbs hide and the
  // buttons shrink, so the whole title fits on one screen.
  const small = compact || narrow;
  const [showControls, setShowControls] = useState(false);
  const img = compact ? 60 : narrow ? 48 : 124; // narrow (portrait phone): four cards in one row
  const titlePx = compact ? 32 : narrow ? 40 : 72;
  const playBtn = (
    <button onClick={props.onPlay} disabled={!props.ready} style={{ ...btn(true), fontSize: small ? 18 : 22, padding: small ? "10px 34px" : "12px 48px", opacity: props.ready ? 1 : 0.5 }} data-testid="play">
      {props.ready ? (props.ghostActive ? "RACE GHOST" : "PLAY") : "loading city…"}
    </button>
  );
  const bestBtn = props.bestGhost && (
    <button onClick={props.onRaceBest} disabled={!props.ready} title="race the ghost of your best run (same round)"
      style={{ ...btn(false), fontSize: small ? 12 : 13, padding: small ? "10px 12px" : "13px 14px", borderColor: "#9fe6ff", opacity: props.ready ? 1 : 0.5 }} data-testid="race-best">
      race your best · {props.bestGhost.t.toFixed(1)} s
    </button>
  );
  const campaignBtn = (
    <button onClick={props.onCampaign} disabled={!props.ready} title="12 levels across the four districts, 3 stars each"
      style={{ ...btn(false), fontSize: small ? 13 : 15, padding: small ? "10px 14px" : "13px 20px", borderColor: "#ffd23f", color: "#ffe9a3", opacity: props.ready ? 1 : 0.5 }} data-testid="campaign">
      CAMPAIGN · {stars}/{TOTAL_STARS} ★
    </button>
  );
  const practiceBtn = (
    <button onClick={props.onPractice} disabled={!props.ready} title="free swinging in the city: no runner, no timer"
      style={{ ...btn(false), fontSize: small ? 13 : 15, padding: small ? "10px 14px" : "13px 20px", opacity: props.ready ? 1 : 0.5 }} data-testid="practice">
      PRACTICE
    </button>
  );
  return (
    <div style={{ ...scroller, background: props.ready ? TITLE_SHADE : `${TITLE_SHADE}, #9fc3e6 url(/ui/key-art.webp) center / cover no-repeat` }}>
      <MuteButton muted={props.muted} onMute={props.onMute} style={{ top: 10, right: 12, zIndex: 21 }} />
      <div style={{ margin: "auto", textAlign: "center", maxWidth: 760, padding: compact ? "8px 12px" : 16, boxSizing: "border-box" }}>
        <RotateHint inline />
        <div style={{ font: `900 ${titlePx}px/1 ui-monospace, monospace`, letterSpacing: compact ? 3 : 6, color: "#fff", textShadow: compact ? "3px 3px 0 #ff3d7f, 5px 5px 0 rgba(0,0,0,0.35)" : "4px 4px 0 #ff3d7f, 8px 8px 0 rgba(0,0,0,0.35)" }}>{S.title}</div>
        <div style={{ marginTop: small ? 4 : 10, fontSize: small ? 12 : 14, opacity: 0.95, textShadow: "0 1px 2px #000" }}>{S.pitch}</div>
        {(props.ghost || props.ghostBusy) ? <><br /><GhostBanner ghost={props.ghost} active={props.ghostActive} busy={props.ghostBusy} /></> : challenge.t !== null && (
          <div style={{ marginTop: 10, display: "inline-block", background: "#ffd23f", color: "#1a1a1a", fontWeight: 800, padding: "6px 12px", borderRadius: 6 }}>
            challenge: beat {challenge.t.toFixed(1)} s{challenge.r ? ` vs #${challenge.r}` : ""}
          </div>
        )}
        <div style={{ ...panel, marginTop: small ? 8 : 16, padding: small ? "8px 12px" : panel.padding }}>
          <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap", marginBottom: compact ? 6 : 10 }} data-testid="districts">
            {DISTRICT_IDS.map(id => {
              const open = id === PAGE_DISTRICT || districtUnlocked(progress, id);
              const first = LEVELS.find(l => l.map === id);
              return (
                <button key={id} onClick={() => open && id !== PAGE_DISTRICT && gotoDistrict(id)} data-testid={`map-${id}`} disabled={!open}
                  title={open ? DISTRICTS[id].blurb : `locked: catch him in campaign level ${first?.n} (${first?.name}) to open ${DISTRICTS[id].name} in free play`}
                  style={{ ...btn(false), padding: compact ? "5px 9px" : "7px 12px", fontSize: compact ? 11 : 12, opacity: open ? 1 : 0.45,
                    background: id === PAGE_DISTRICT ? "rgba(159,230,255,0.25)" : "rgba(255,255,255,0.06)",
                    borderColor: id === PAGE_DISTRICT ? "#9fe6ff" : "rgba(255,255,255,0.3)" }}>
                  {open ? "" : "🔒 "}{DISTRICTS[id].name}
                </button>
              );
            })}
          </div>
          {!small && <div style={{ fontSize: 11, opacity: 0.75, marginTop: -4, marginBottom: 10 }}>{DISTRICTS[PAGE_DISTRICT].blurb}</div>}
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: small ? 4 : 8 }}>pick your Radbro · {S.youChase}</div>
          <div style={{ display: "flex", gap: narrow ? 6 : 10, justifyContent: "center", flexWrap: "wrap" }}>
            {RADBROS.map(id => (
              <button key={id} onClick={() => props.setChaser(id)} data-testid={`card-${id}`}
                style={{
                  width: img + 26, padding: compact ? "6px 4px" : "12px 8px", borderRadius: 10, cursor: "pointer", color: "#fff", font: `700 ${compact || narrow ? 12 : 14}px ui-monospace, monospace`,
                  background: id === chaser ? "rgba(255,61,127,0.35)" : "rgba(255,255,255,0.06)",
                  border: id === chaser ? "2px solid #ff3d7f" : "2px solid rgba(255,255,255,0.2)",
                }}>
                <div style={{
                  margin: compact ? "0 auto 4px" : "0 auto 8px", width: img, height: img, borderRadius: 10, overflow: "hidden",
                  background: `radial-gradient(circle at 50% 38%, ${RADBRO_COLOR[id].body}66, ${RADBRO_COLOR[id].accent}22 62%, rgba(0,0,0,0.25))`,
                  boxShadow: id === chaser ? "0 0 0 1px rgba(255,255,255,0.25) inset" : "none",
                }}>
                  <img src={`/ui/radbro${id}.webp`} alt="" width={img} height={img} draggable={false}
                    style={{ display: "block", width: img, height: img, filter: id === chaser ? "none" : "saturate(0.8) brightness(0.9)" }} />
                </div>
                <div>{narrow ? `#${id}` : `Radbro #${id}`}</div>
                {!compact && <div style={{ fontSize: 11, opacity: 0.7, fontWeight: 400 }}>{PERSONA[id]}</div>}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", flexWrap: "wrap", marginTop: compact ? 8 : 14 }}>
            {DIFFICULTIES.map(d => {
              const open = d !== "degen" || degenUnlocked(progress) || d === difficulty;
              return (
                <button key={d} onClick={() => open && props.setDifficulty(d)} data-testid={`diff-${d}`} disabled={!open} title={open ? undefined : `locked: earn ${DEGEN_STARS} campaign stars (${stars} so far)`}
                  style={{ ...btn(false), padding: compact ? "8px 14px" : "10px 18px", opacity: open ? 1 : 0.45, background: d === difficulty ? (d === "degen" ? "rgba(255,61,127,0.32)" : "rgba(255,210,63,0.3)") : "rgba(255,255,255,0.06)", borderColor: d === difficulty ? (d === "degen" ? "#ff3d7f" : "#ffd23f") : "rgba(255,255,255,0.35)" }}>
                  {open ? "" : "🔒 "}{DIFF_LABEL[d]}
                </button>
              );
            })}
            {compact && playBtn}
            {compact && campaignBtn}
            {compact && practiceBtn}
            {compact && bestBtn}
          </div>
          {!small && <div style={{ fontSize: 11, opacity: 0.75, marginTop: 6 }}>{DIFF_BLURB[difficulty]}</div>}
          {availMut !== 0 && (
            <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap", marginTop: compact ? 6 : 10 }} data-testid="mutators">
              <span style={{ fontSize: 11, opacity: 0.75, alignSelf: "center" }}>mutators:</span>
              {MUTATORS.filter(m => (availMut & m.bit) !== 0).map(m => {
                const on = (props.freeMut & m.bit) !== 0;
                return (
                  <button key={m.id} onClick={() => props.setFreeMut(props.freeMut ^ m.bit)} title={m.blurb} data-testid={`mut-${m.id}`}
                    style={{ ...btn(false), padding: "4px 9px", fontSize: 11, background: on ? "rgba(159,230,255,0.25)" : "rgba(255,255,255,0.05)", borderColor: on ? "#9fe6ff" : "rgba(255,255,255,0.25)" }}>
                    {on ? "✓ " : ""}{m.name}
                  </button>
                );
              })}
            </div>
          )}
          {!compact && <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: small ? 8 : 10, marginTop: small ? 10 : 14, flexWrap: "wrap" }}>{playBtn}{campaignBtn}{practiceBtn}{bestBtn}</div>}
        </div>
        {(!small || showControls) && <div style={{ ...panel, marginTop: small ? 6 : 12, padding: small ? "6px 12px" : panel.padding, fontSize: small ? 11 : 12, lineHeight: small ? 1.5 : 1.7, textAlign: "left", display: "inline-block" }} data-testid="controls">
          {touch ? (
            <><b>controls</b> · left thumb = run · drag the right side = look · hold <b>WEB</b> = swing from the ringed balloon, let go = release ·
            JUMP (again in the air = double jump) · <b>ZIP</b> = web-zip to the ringed balloon / the roof ahead · red ring on him + WEB = <b>YOINK</b> · HIM = look at him</>
          ) : (
            <><b>controls</b> · mouse look/aim · WASD run · Space jump (again in the air = double jump) · LMB hold = web onto the ringed balloon, release = let go ·
            E / Shift = <b>web-zip</b> to the ringed balloon or the roof ahead · red ring on him + LMB = <b>YOINK</b> · Q/RMB look at him · R retry · M mute · Esc pause</>
          )}
        </div>}
        <div style={{ marginTop: small ? 4 : 10, fontSize: small ? 10 : 11, textShadow: "0 1px 2px #000" }}>
          {small && (
            <><button onClick={() => setShowControls(v => !v)} aria-expanded={showControls} data-testid="controls-toggle"
              style={{ ...btn(false), padding: "3px 10px", fontSize: 11, marginRight: 8, background: showControls ? "rgba(159,230,255,0.25)" : "rgba(14,16,30,0.55)" }}>
              controls {showControls ? "▴" : "▾"}
            </button></>
          )}
          <span style={{ opacity: 0.75 }}>{S.credits}</span>
        </div>
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

export function RoundHud({ reducedMotion, easyGrab, practice = false, muted, onMute }: { reducedMotion: boolean; easyGrab: boolean; practice?: boolean; muted: boolean; onMute: () => void }) {
  const r = useUi(s => s.round);
  const screen = useUi(s => s.screen);
  const feed = useUi(s => s.feed);
  const banner = useUi(s => s.banner);
  const bubble = useUi(s => s.bubble);
  const fade = useUi(s => s.fade);
  const [now, setNow] = useState(performance.now());
  const [hints, setHints] = useState(true);
  const touch = useUi(s => s.touch);
  const ghost = useUi(s => s.ghost);
  const { narrow } = useViewport();
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 100);
    const h = setTimeout(() => setHints(false), 10000);
    return () => { clearInterval(t); clearTimeout(h); };
  }, []);
  const hot = heat(r.d);
  const cd = screen === "countdown" ? Math.ceil(r.countdown) : 0;
  const ringColor = r.ring === "runner" ? "#ff3355" : r.ring === "attached" ? "#3ddc84" : r.ring === "hook" ? "#ffe14d" : "rgba(255,255,255,0.85)";
  const bannerOn = banner && now - banner.t < 1300;
  // 1.8 s, longer for long lines (~60 ms a character: the cowboy's rooftop line stays ~2.8 s).
  const bubbleOn = bubble && now - bubble.t < Math.max(1800, bubble.text.length * 60);
  const fadeA = fade && now - fade < 600 ? 1 - (now - fade) / 600 : 0;
  const speedLines = !reducedMotion && r.speed > 14 ? Math.min(1, (r.speed - 14) / 10) : 0;
  const box: React.CSSProperties = { position: "fixed", zIndex: 10, pointerEvents: "none" };
  return (
    <>
      {speedLines > 0 && (
        <div style={{ ...box, inset: 0, opacity: speedLines * 0.55, background: "radial-gradient(ellipse at center, transparent 55%, rgba(255,255,255,0.55) 100%)" }} />
      )}
      {fadeA > 0 && <div style={{ ...box, inset: 0, background: `rgba(0,0,0,${(fadeA * 0.8).toFixed(2)})` }} />}
      {!practice && <CampaignHud />}
      {/* timer (practice: the mode tag) */}
      {practice ? (
        <div style={{ ...box, top: 10, left: "50%", transform: "translateX(-50%)", font: `900 ${touch || narrow ? 16 : 22}px ui-monospace, monospace`, letterSpacing: touch || narrow ? 2 : 4, color: "#fff", textShadow: "3px 3px 0 #ff3d7f, 0 2px 4px rgba(0,0,0,0.6)" }} data-testid="practice-tag">
          {S.practice}
        </div>
      ) : (
        <div style={{ ...box, top: 10, left: "50%", transform: "translateX(-50%)", font: "800 30px ui-monospace, monospace", color: r.clock < 15 ? "#ff4d4d" : "#fff", textShadow: "0 2px 4px rgba(0,0,0,0.6)" }} data-testid="timer">
          {clockText(r.clock)}
        </div>
      )}
      {/* the raced ghost: a chip under the timer + the floating tag GhostView positions */}
      {ghost && !practice && screen !== "results" && (
        <div style={{ ...box, top: 48, left: "50%", transform: "translateX(-50%)", background: "rgba(20,40,60,0.8)", border: "1px solid #9fe6ff", borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 800, whiteSpace: "nowrap" }} data-testid="ghost-chip">
          <span style={{ color: "#9fe6ff", letterSpacing: 2 }}>{S.ghost}</span> {ghost.claimed.toFixed(1)} s{ghost.status === "unverified" ? " (unverified)" : ""}
        </div>
      )}
      <div id="rr-ghost-tag" style={{ ...box, left: 0, top: 0, visibility: "hidden" }}>
        <div style={{ color: "#dff6ff", font: "800 11px ui-monospace, monospace", letterSpacing: 2, padding: "1px 6px", borderRadius: 4, background: "rgba(20,60,90,0.55)", whiteSpace: "nowrap" }}>{S.ghost}</div>
      </div>
      {/* round 4 wind: an arrow (push direction on screen) that appears ~1 s before a gust and fills while it blows */}
      {r.wind && screen !== "results" && (
        <div style={{ ...box, top: narrow ? 110 : 80, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 8,
          background: "rgba(10,20,40,0.55)", border: "1px solid rgba(159,230,255,0.6)", borderRadius: 8, padding: "4px 10px", opacity: 0.35 + 0.65 * Math.max(r.wind.warn, r.wind.level) }} data-testid="wind">
          <span style={{ display: "inline-block", transform: `rotate(${r.wind.angle}rad)`, fontSize: 20, lineHeight: 1, color: r.wind.level > 0 ? "#9fe6ff" : "#ffe14d" }}>↑</span>
          <span style={{ font: "800 12px ui-monospace, monospace", letterSpacing: 2, color: "#dff6ff" }}>{r.wind.level > 0 ? "WIND" : "GUST"}</span>
          <span style={{ width: 46, height: 6, background: "rgba(255,255,255,0.15)", borderRadius: 3 }}>
            <span style={{ display: "block", height: 6, width: `${Math.round(r.wind.level * 100)}%`, background: "#9fe6ff", borderRadius: 3 }} />
          </span>
        </div>
      )}
      {/* practice: speed + chain panel */}
      {practice && (
        <div style={{ ...box, top: narrow ? 52 : 10, right: 12, ...panel, padding: "8px 12px", minWidth: narrow ? 130 : 180 }} data-testid="practice-stats">
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800 }}>
            <span>{r.speed.toFixed(1)} m/s</span>
            <span style={{ color: r.chain >= 3 ? "#3ddc84" : "#ffd23f" }}>chain {r.chain}</span>
          </div>
          <div style={{ height: 7, background: "rgba(255,255,255,0.15)", borderRadius: 4, marginTop: 6 }}>
            <div style={{ height: 7, width: `${Math.min(1, r.speed / 20) * 100}%`, background: r.speed > 14 ? "#3ddc84" : "#ffd23f", borderRadius: 4, transition: "width 0.2s" }} />
          </div>
          <div style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>best chain {r.maxChain} · top {r.topSpeed.toFixed(1)} m/s · falls {r.falls}</div>
        </div>
      )}
      {/* distance + heat */}
      {screen !== "results" && !practice && <div style={{ ...box, top: narrow ? 52 : 10, right: 12, ...panel, padding: "8px 12px", minWidth: narrow ? 130 : 180 }}>
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
      {/* web-zip cooldown: a thin ring around the reticle that fills back up (full and bright = ready) */}
      {screen !== "results" && r.zip >= 0 && <div data-testid="zip-ring" style={{
        ...box, left: "50%", top: "50%", width: 22, height: 22, marginLeft: -11, marginTop: -11, borderRadius: 11,
        background: `conic-gradient(${r.zip <= 0 ? "rgba(127,231,255,0.8)" : "rgba(160,170,190,0.55)"} ${Math.round(360 * (1 - r.zip))}deg, rgba(255,255,255,0.1) 0deg)`,
        WebkitMask: "radial-gradient(circle, transparent 8px, #000 8.5px)", mask: "radial-gradient(circle, transparent 8px, #000 8.5px)",
      }} />}
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
      <div style={{ ...box, left: touch ? 62 : 12, ...(touch ? { top: 12 } : { bottom: 12 }), maxWidth: touch ? "36vw" : undefined, display: "flex", flexDirection: "column", gap: 4 }}>
        {feed.filter(f => now - f.t < 5000).map(f => (
          <div key={f.id} style={{ background: "rgba(14,16,30,0.7)", padding: "3px 8px", borderRadius: 5 }}>{f.text}</div>
        ))}
        {hints && (
          <div style={{ background: "rgba(14,16,30,0.6)", padding: "3px 8px", borderRadius: 5, opacity: 0.85 }}>
            {practice
              ? (touch
                ? "left thumb run · drag right to look · hold WEB = swing · ZIP = web-zip · II = menu"
                : `WASD run · Space jump (x2 in the air) · ${easyGrab ? "hold Space" : "hold LMB"} = web · E/Shift zip · hold R = back to start · Esc = menu`)
              : touch
                ? "left thumb run · drag right to look · hold WEB = swing · ZIP = web-zip · red ring = WEB to YOINK"
                : `WASD run · Space jump (x2 in the air) · ${easyGrab ? "hold Space" : "hold LMB"} = web · E/Shift zip · red ring = ${easyGrab ? "Space" : "LMB"} to YOINK · Q look at him · hold R retry`}
          </div>
        )}
      </div>
      {r.holdR > 0 && (
        <div style={{ ...box, left: "50%", bottom: 40, transform: "translateX(-50%)", ...panel, padding: "4px 10px" }}>{practice ? "back to start…" : "retry…"} {Math.round(r.holdR * 100)}%</div>
      )}
      <HintPill />
      {/* mute: top left on desktop (M key while the mouse is captured), under the II button on touch */}
      <MuteButton muted={muted} onMute={onMute} style={touch ? { left: 12, top: 62 } : { left: 12, top: 10 }} />
      <div style={{ ...box, ...(touch ? { left: "50%", transform: "translateX(-50%)" } : { right: 12 }), bottom: touch ? 4 : 8, fontSize: 11, opacity: 0.6 }}>{r.fps.toFixed(0)} fps</div>
      <RotateHint />
    </>
  );
}

/** The first-run tip (ui/hints.ts), under the reticle. */
export function HintPill() {
  const hint = useUi(s => s.hint);
  const touch = useUi(s => s.touch);
  const { compact } = useViewport();
  if (!hint) return null;
  // Touch: above the character (the stick and the WEB / JUMP buttons own the bottom of the screen).
  return (
    <div style={{ position: "fixed", zIndex: 12, pointerEvents: "none", left: "50%", top: touch ? "24%" : compact ? "70%" : "74%", transform: "translateX(-50%)", maxWidth: touch ? "min(620px, 64vw)" : "min(620px, 86vw)", width: "max-content" }}>
      <div key={hint.id} data-testid={`hint-${hint.id}`}
        style={{ background: "rgba(14,16,30,0.86)", borderLeft: `4px solid ${hint.id === "yoink" ? "#ff3355" : "#ffd23f"}`, padding: compact ? "6px 12px" : "9px 16px", borderRadius: 8, font: `700 ${compact ? 13 : 15}px ui-monospace, monospace`, boxShadow: "0 4px 18px rgba(0,0,0,0.4)", textAlign: "center" }}>
        <span style={{ color: hint.id === "yoink" ? "#ff3355" : "#ffd23f", marginRight: 8, letterSpacing: 2 }}>TIP</span>{hint.text}
      </div>
    </div>
  );
}

// ---- pause ---------------------------------------------------------------------------------------

export function Pause(props: { onResume: () => void; onRestart: () => void; onQuit: () => void; settings: Settings; setSettings: (s: Settings) => void; practice?: boolean }) {
  const [open, setOpen] = useState(false);
  const [tipsReset, setTipsReset] = useState(false);
  const touch = useUi(s => s.touch);
  const s = props.settings;
  const set = (patch: Partial<Settings>) => props.setSettings({ ...s, ...patch });
  return (
    <div style={{ ...scroller, zIndex: 30, background: "rgba(8,10,20,0.55)" }}>
      <div style={{ ...panel, margin: "auto", minWidth: "min(300px, 86vw)", textAlign: "center", boxSizing: "border-box" }} data-testid="pause">
        <div style={{ font: "900 28px ui-monospace, monospace", letterSpacing: 4 }}>{props.practice ? S.practice : S.paused}</div>
        <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
          <button style={btn(true)} onClick={props.onResume}>Resume</button>
          <button style={btn()} onClick={props.onRestart}>{props.practice ? "Back to start" : "Restart"}</button>
          <button style={btn()} onClick={() => setOpen(!open)}>Settings</button>
          <button style={btn()} onClick={props.onQuit} data-testid="quit">{props.practice ? "Back to title" : "Quit"}</button>
        </div>
        {open && (
          <div style={{ marginTop: 12, textAlign: "left", display: "grid", gap: 6, fontSize: 12 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }} data-testid="quality">
              <span style={{ flex: 1 }}>quality</span>
              {(["low", "high"] as const).map(q => (
                <button key={q} onClick={() => set({ quality: q, qualityChosen: true })} data-testid={`quality-${q}`}
                  style={{ ...btn(false), padding: "5px 12px", fontSize: 12, background: s.quality === q ? "rgba(255,210,63,0.3)" : "rgba(255,255,255,0.06)", borderColor: s.quality === q ? "#ffd23f" : "rgba(255,255,255,0.35)" }}>
                  {q === "low" ? "Low" : "High"}
                </button>
              ))}
            </div>
            {s.quality === "low" && <div style={{ opacity: 0.7, fontSize: 11 }}>Low: sharpness 1x, no shadows or trail, fewer rooftop props (anti-aliasing off after a reload){s.qualityAuto && !s.qualityChosen ? ". Switched automatically (the game ran below ~40 fps); pick High to keep High." : ""}</div>}
            <label>sensitivity {s.sensitivity.toFixed(4)}<input type="range" min={0.0005} max={0.006} step={0.0001} value={s.sensitivity} onChange={e => set({ sensitivity: Number(e.target.value) })} style={{ width: "100%" }} /></label>
            <label>music {Math.round(s.music * 100)}%<input type="range" min={0} max={1} step={0.05} value={s.music} onChange={e => set({ music: Number(e.target.value) })} style={{ width: "100%" }} data-testid="vol-music" /></label>
            <label>sound effects {Math.round(s.sfx * 100)}%<input type="range" min={0} max={1} step={0.05} value={s.sfx} onChange={e => set({ sfx: Number(e.target.value) })} style={{ width: "100%" }} data-testid="vol-sfx" /></label>
            <label>voices {Math.round(s.voice * 100)}%<input type="range" min={0} max={1} step={0.05} value={s.voice} onChange={e => set({ voice: Number(e.target.value) })} style={{ width: "100%" }} data-testid="vol-voice" /></label>
            <label><input type="checkbox" checked={s.muted} onChange={e => set({ muted: e.target.checked })} data-testid="mute-check" /> mute all (M)</label>
            <label>FOV {s.fov}°<input type="range" min={55} max={75} step={1} value={s.fov} onChange={e => set({ fov: Number(e.target.value) })} style={{ width: "100%" }} /></label>
            <label><input type="checkbox" checked={s.invertY} onChange={e => set({ invertY: e.target.checked })} /> invert Y</label>
            <label><input type="checkbox" checked={s.reducedMotion} onChange={e => set({ reducedMotion: e.target.checked })} /> reduced motion</label>
            {!touch && <label><input type="checkbox" checked={s.easyGrab} onChange={e => set({ easyGrab: e.target.checked })} /> easy grab (tap Space = jump, hold Space = swing)</label>}
            <button style={{ ...btn(false), padding: "5px 12px", fontSize: 12 }} data-testid="tips-reset" onClick={() => { hints.reset(); setTipsReset(true); }}>
              {tipsReset ? "tips will show again" : "show tips again"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- results -------------------------------------------------------------------------------------

export function ResultsScreen(props: { onRetry: () => void; onMenu: () => void; onNext?: (n: number) => void; onLevels?: () => void }) {
  const r = useUi(s => s.results);
  const touch = useUi(s => s.touch);
  const { compact } = useViewport();
  const [copied, setCopied] = useState("");
  if (!r) return null;
  const share = async () => {
    // With the packed run: a ghost link (the exact round + your inputs); else the plain time claim.
    const url = r.ghostCode ? ghostUrl(r.chaser, r.runner, r.difficulty, r.time, r.seed, r.ghostCode, r.mutators) : challengeUrl(r.chaser, r.runner, r.difficulty, r.time, r.mutators);
    const text = `${shareText(r.kind, r.runner, r.time)}${r.ghostCode ? " - race my ghost:" : ""} ${url}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied to clipboard");
    } catch {
      setCopied(text);
    }
  };
  const delta = r.caught && r.best !== null ? r.time - r.best : null;
  const vg = r.vsGhost;
  let ghostLine = "";
  if (vg) {
    const d = vg.time !== null && r.caught ? r.time - vg.time : 0;
    ghostLine = r.caught
      ? vg.time === null ? "you beat the ghost (it never caught him)" : d < -0.05 ? `you beat the ghost by ${(-d).toFixed(1)} s` : d > 0.05 ? `the ghost was ${d.toFixed(1)} s faster` : "dead heat with the ghost"
      : vg.time !== null ? `the ghost caught him in ${vg.time.toFixed(1)} s` : "the ghost never caught him either";
    if (!vg.verified) ghostLine += " (unverified ghost)";
  }
  const big = compact ? 26 : 34;
  return (
    <div style={{ ...layer, display: "grid", placeItems: "end center", paddingBottom: compact ? "3vh" : "8vh", pointerEvents: "none" }}>
      <div style={{ ...panel, minWidth: "min(360px, 90vw)", maxWidth: "94vw", boxSizing: "border-box", padding: compact ? "10px 14px" : panel.padding, textAlign: "center", pointerEvents: "auto" }} data-testid="results">
        {r.caught ? (
          <>
            <div style={{ font: `900 ${big}px ui-monospace, monospace`, letterSpacing: 2 }}>{r.kind === "yoink" ? "YOINKED" : "TAGGED"} in {r.time.toFixed(1)} s</div>
            <div style={{ marginTop: 8, display: "inline-block", padding: "4px 14px", borderRadius: 20, fontWeight: 900, color: "#111", background: MEDAL_COLOR[r.medal] }}>{r.medal}</div>
            <div style={{ marginTop: 6, fontSize: 13, opacity: 0.9 }}>
              {r.newBest ? (r.best === null ? "first catch - personal best" : `new best (${(delta ?? 0).toFixed(1)} s)`) : r.best !== null ? `best ${r.best.toFixed(1)} s (+${(delta ?? 0).toFixed(1)})` : ""}
            </div>
          </>
        ) : (
          <>
            <div style={{ font: `900 ${big}px ui-monospace, monospace` }}>{S.escape}</div>
            <div style={{ marginTop: 6, opacity: 0.9 }}>closest {r.closest.toFixed(1)} m · {S.goneFishing}</div>
          </>
        )}
        {ghostLine && <div style={{ marginTop: 6, fontSize: 13, fontWeight: 800, color: "#9fe6ff" }} data-testid="ghost-result">{ghostLine}</div>}
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
          longest swing chain {r.maxChain} · top speed {r.topSpeed.toFixed(1)} m/s · falls {r.falls} · #{r.chaser} vs #{r.runner} · {r.difficulty}
        </div>
        <CampaignResult />
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 14 }}>
          {r.campaign && r.campaign.stars[0] && r.campaign.n < LEVELS.length && props.onNext && (
            <button style={{ ...btn(true), background: "#ffd23f", color: "#111" }} onClick={() => props.onNext?.(r.campaign!.n + 1)} data-testid="next-level">Next level</button>
          )}
          {r.campaign && props.onLevels && <button style={btn()} onClick={props.onLevels} data-testid="levels">Levels</button>}
          {r.caught && <button style={btn()} onClick={share} data-testid="share" title={r.ghostCode ? "copy a ghost link: friends race your run" : "copy a challenge link"}>{r.ghostCode ? "Share ghost" : "Share"}</button>}
          <button style={btn(true)} onClick={props.onRetry} data-testid="retry">{touch ? "Retry" : "Retry (R)"}</button>
          <button style={btn()} onClick={props.onMenu} data-testid="menu">Menu</button>
        </div>
        {copied && <div style={{ marginTop: 8, fontSize: 11, opacity: 0.85, wordBreak: "break-all", userSelect: "text", maxHeight: 84, overflowY: "auto" }} data-testid="share-text">{copied}</div>}
      </div>
    </div>
  );
}

/** A short notice (auto quality) near the top, gone after 6 s. */
export function Toast() {
  const toast = useUi(s => s.toast);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => useUi.setState({ toast: null }), 6000);
    return () => clearTimeout(id);
  }, [toast]);
  if (!toast) return null;
  return (
    <div style={{ position: "fixed", zIndex: 35, left: "50%", top: "16%", transform: "translateX(-50%)", pointerEvents: "none", width: "max-content", maxWidth: "88vw" }}>
      <div style={{ ...panel, padding: "8px 14px", fontSize: 13, fontWeight: 700, borderLeft: "4px solid #ffd23f", textAlign: "center" }} data-testid="toast">{toast.text}</div>
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
