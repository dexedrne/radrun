// The title, laid out like the shooters' card title (RadZombies', ZombieTardio's): the key art full-bleed under soft
// shading; the two-colour wordmark and a terminal-font tagline top left; the menu as a list of big Bebas items with a
// pink focus bar (PLAY, race your best, CAMPAIGN and its stars, PRACTICE, TAG, your Radbro, CONTROLS, and back to
// vyvanse.beer when framed by it); the "[ OK ]" status line bottom left and the other games bottom right; the
// $SPIDERTAG token, the tip jar and the speaker top right (the token and the tip jar never inside someone else's
// portal, radbro.fun's included). Your Radbro's row opens the character select (the roster, the difficulty, the
// district and the mutators); CONTROLS opens the controls and the credits. The arrows move the focus down the list,
// then on through the other games and back to the top, as on the shooters; Enter picks what is highlighted (left /
// right on your Radbro's row changes him); the mouse moves the same focus, and a pad walks the same list
// (data-pad-cycle, ui/padNav.ts). Landscape phones get the list in two columns, portrait phones one narrow column;
// everything stays inside the safe area, and a screen that would scroll (a challenge or ghost line on a short
// window, a full character select on a small phone) shrinks its type and gaps until it fits.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RADBROS, charName, charTag, portraitPath, type RadbroId } from "../game/round.ts";
import { DIFFICULTIES, type Difficulty } from "../sim/tuning.ts";
import { useUi } from "./store.ts";
import { DIFF_BLURB, DIFF_LABEL, OTHER_GAMES, PERSONA, RADBRO_COLOR, S } from "./strings.ts";
import { rememberPicks, type Challenge, type StoredGhost } from "./prefs.ts";
import type { GhostChoice } from "../app/PlayPage.tsx";
import { DISTRICTS, DISTRICT_IDS } from "../world/districts.ts";
import { PAGE_DISTRICT, gotoDistrict } from "../app/district.ts";
import { DEGEN_STARS, LEVELS, TOTAL_STARS, degenUnlocked, districtUnlocked, starCount, unlockedMutators, type Progress } from "../game/campaign.ts";
import { MUTATORS } from "../game/mutators.ts";
import { HomeScreenTip } from "./iphoneFullscreen.tsx";
import { PadText } from "./pad.tsx";
import { radrunPadControls } from "./padPrompts.ts";
import { MenuNav } from "./padNav.ts";
import { backToVyvanse, vyvanseFramed } from "./vyvanse.ts";
import { isFramed } from "../radbro/bridge.ts";
import { MuteButton, Wordmark, useViewport } from "./screens.tsx";

const CREAM = "#f3eada", PINK = "#fd43ae", INK = "#05060c", GOLD = "#ffd23f", CYAN = "#9fe6ff", MINT = "#a0ffd2", SAND = "#d9cdb4";
const BEBAS = `"Bebas Neue", Impact, "Arial Narrow", sans-serif`;
const VT = `VT323, ui-monospace, monospace`;
const GLOW = "0 2px 8px #000, 0 0 14px #000";
const BAR_OFF = "rgba(243,234,216,0.35)";
const GLASS = "linear-gradient(90deg, rgba(5,7,17,0.66), rgba(5,7,17,0.16))";
const clamp = (lo: number, v: number, hi: number) => Math.min(hi, Math.max(lo, v));
const inset = (side: "top" | "right" | "bottom" | "left", px: number) => `calc(${px}px + env(safe-area-inset-${side}, 0px))`;

/** The key art behind the title (and the boot screens), under the card's shading. */
export const TITLE_ART = "url(/ui/key-art.webp)";

type Layout = {
  /** null = a desktop window; landscape = a short screen (phones, h < 520); portrait = a narrow tall one. */
  phone: "landscape" | "portrait" | null;
  mark: number; tag: number; item: number; gap: number; status: number; pill: number; padX: number; top: number; bottom: number;
};

function layoutOf(w: number, h: number): Layout {
  if (w < 560 && h >= w) return { phone: "portrait", mark: clamp(52, w * 0.2, 84), tag: 21, item: clamp(24, h * 0.035, 32), gap: 7, status: 19, pill: 16, padX: 16, top: 12, bottom: 12 };
  if (h < 520) return { phone: "landscape", mark: clamp(38, h * 0.13, 62), tag: clamp(15, h * 0.046, 22), item: clamp(17, h * 0.056, 26), gap: 5, status: clamp(16, h * 0.045, 20), pill: 17, padX: clamp(14, w * 0.025, 28), top: 10, bottom: 8 };
  return {
    phone: null, mark: clamp(56, Math.min(h * 0.16, w * 0.15), 190), tag: clamp(20, h * 0.046, 50), item: clamp(22, h * 0.043, 42), gap: clamp(5, h * 0.009, 10),
    status: clamp(18, h * 0.04, 40), pill: clamp(18, h * 0.03, 24), padX: clamp(16, w * 0.035, 64), top: clamp(14, h * 0.04, 44), bottom: clamp(14, h * 0.035, 36),
  };
}

/** True once the web fonts are in (their metrics decide what fits). */
function useFontsReady(): boolean {
  const [ok, setOk] = useState(() => document.fonts?.status === "loaded");
  useEffect(() => { void document.fonts?.ready.then(() => setOk(true)); }, []);
  return ok;
}

/**
 * The scale a screen's type and gaps take so that `ref` (its scroller) does not scroll: 1 = as laid out, down to `min`
 * in 5 % steps, measured before paint; it starts over at 1 whenever `key` (the size, what shows) changes.
 */
function useFit(ref: React.RefObject<HTMLElement | null>, key: string, min = 0.7): number {
  const [fit, setFit] = useState(1);
  useLayoutEffect(() => setFit(1), [key]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight > el.clientHeight + 1) setFit(f => (f > min ? Math.max(min, Math.round((f - 0.05) * 100) / 100) : f));
  });
  return fit;
}

/** A big Bebas menu item: a pale left bar, or the pink bar and fill when it has the focus. */
function itemStyle(on: boolean, off: boolean | undefined, px: number): React.CSSProperties {
  return {
    font: `400 ${px}px/1 ${BEBAS}`, letterSpacing: "0.06em", textAlign: "left", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "0.35em",
    minWidth: "6.4em", boxSizing: "border-box", padding: "0.24em 1.1em 0.16em 0.55em", cursor: off ? "default" : "pointer", border: 0,
    borderLeft: `4px solid ${on ? PINK : BAR_OFF}`, borderRadius: 2, color: on ? INK : CREAM, background: on ? PINK : GLASS,
    textShadow: on ? "none" : "0 2px 6px #000", opacity: off ? 0.6 : 1, touchAction: "manipulation",
  };
}

/** A small Bebas choice (difficulty, district, mutator): pink when picked. */
function chipStyle(sel: boolean, open: boolean, px: number): React.CSSProperties {
  return {
    font: `400 ${px}px/1 ${BEBAS}`, letterSpacing: "0.06em", padding: "0.32em 0.75em 0.22em 0.6em", borderRadius: 2, cursor: open ? "pointer" : "default", border: 0,
    borderLeft: `3px solid ${sel ? PINK : BAR_OFF}`, background: sel ? PINK : "rgba(5,7,17,0.66)", color: sel ? INK : CREAM, opacity: open ? 1 : 0.45,
    textShadow: sel ? "none" : "0 1px 4px #000", whiteSpace: "nowrap", touchAction: "manipulation",
  };
}

/** Terminal-font text inside a menu item (the stars, your Radbro's line). */
function Sub({ children, color, on, size = 0.78 }: { children: React.ReactNode; color?: string; on: boolean; size?: number }) {
  return <span style={{ font: `400 ${size}em/1 ${VT}`, letterSpacing: "0.03em", color: on ? INK : color ?? SAND, textShadow: on ? "none" : GLOW }}>{children}</span>;
}

const GHOST_STATUS: Record<string, { text: string; color: string }> = {
  checking: { text: "checking the replay…", color: "#cfd8e3" },
  verified: { text: "verified replay", color: "#3ddc84" },
  unverified: { text: "unverified", color: "#ffb347" },
};
const caughtVerb = (kind: string) => (kind === "yoink" ? "yoinked" : kind === "yank" ? "yanked" : kind === "tag" ? "tagged" : "caught");
const notice = (accent: string, px: number): React.CSSProperties => ({
  font: `400 ${px}px/1.15 ${VT}`, letterSpacing: "0.03em", color: CREAM, background: "rgba(5,7,17,0.7)", borderLeft: `3px solid ${accent}`, borderRadius: 2,
  padding: "4px 12px 4px 10px", textShadow: "0 1px 3px #000", maxWidth: "100%", boxSizing: "border-box",
});

/** The ghost link's line (who, what time, whether the replay reproduces it). */
function GhostLine({ ghost, active, busy, px }: { ghost: GhostChoice | null; active: boolean; busy: boolean; px: number }) {
  if (busy) return <div style={notice(CYAN, px)}><span style={{ color: CYAN }}>[ .. ]</span> loading the ghost…</div>;
  if (!ghost) return null;
  const { spec, info } = ghost;
  const st = GHOST_STATUS[info.status];
  return (
    <div style={notice(CYAN, px)} data-testid="ghost-banner">
      <span style={{ color: CYAN }}>[ {S.ghost} RACE ]</span> {charTag(spec.chaser)} {caughtVerb(info.kind)} {charTag(spec.runner)} in {spec.claimed.toFixed(1)} s · {DIFF_LABEL[spec.difficulty]}{" "}
      <span style={{ color: st.color }} data-testid="ghost-status">{st.text}{info.older ? (info.status === "unverified" ? " · made on an older build" : " · from an older version (replayed with its own swing)") : ""}</span>
      <div style={{ opacity: 0.85 }}>{active ? "same city, same start, same runner: PLAY races their ghost" : `pick ${charTag(spec.chaser)} and ${DIFF_LABEL[spec.difficulty]} to race the ghost`}</div>
    </div>
  );
}

/** The tip jar's coin (as on the shooters' titles). */
const Coin = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" style={{ width: "1.1em", height: "1.1em", color: "#e9c47e", flex: "none" }}>
    <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5.4 5.9h5.6l-.8.9H4.6zm0 2.6h5.6l-.8.9H4.6zm.8 2.6h5.6l-.8.9H5.4z" fill="currentColor" transform="translate(.4 -1.2)" />
  </svg>
);

type TitleProps = {
  chaser: RadbroId; setChaser: (c: RadbroId) => void; difficulty: Difficulty; setDifficulty: (d: Difficulty) => void;
  challenge: Challenge; onPlay: () => void; onPractice: () => void; ready: boolean; muted: boolean; onMute: () => void;
  ghost: GhostChoice | null; ghostBusy: boolean; ghostActive: boolean; bestGhost: StoredGhost | null; onRaceBest: () => void;
  /** Campaign progress (locks, stars), the free-play mutators and the CAMPAIGN screen. */
  progress: Progress; freeMut: number; setFreeMut: (m: number) => void; onCampaign: () => void;
};

type Entry = { key: string; testid: string; label: (on: boolean) => React.ReactNode; act: () => void; off?: boolean; desc: string };

/** Title (over the key art; the live city waits behind it). */
export function Title(props: TitleProps) {
  const { chaser, difficulty, challenge, progress, ready } = props;
  const touch = useUi(s => s.touch);
  const pad = useUi(s => s.pad);
  const { w, h, portrait } = useViewport();
  const base = layoutOf(w, h);
  /** The highlighted entry by its key (it stays put when RACE YOUR BEST comes or goes); "game-<id>" = one of the other games. */
  const [focusKey, setFocusKey] = useState("play");
  const [pick, setPick] = useState(false);
  const [controls, setControls] = useState(false);
  /** Where a pad's focus lands (PLAY; back from an overlay, the row that opened it). */
  const [home, setHome] = useState("play");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  const [pillsAbove, setPillsAbove] = useState(0);
  const framed = isFramed();
  // the token and the tip jar: on its own or on vyvanse.beer, never inside someone else's portal (radbro.fun)
  const promo = !framed || vyvanseFramed();
  const stars = starCount(progress);
  const nMut = MUTATORS.filter(m => (props.freeMut & m.bit) !== 0).length;
  const cycle = (d: number) => props.setChaser(RADBROS[(RADBROS.indexOf(chaser) + d + RADBROS.length) % RADBROS.length]);
  const keys = !touch && !pad;
  const c = RADBRO_COLOR[chaser];
  const chaserRow = (on: boolean) => (
    <>
      <span style={{ width: "1.5em", height: "1.5em", flex: "none", borderRadius: 2, overflow: "hidden", margin: "-0.06em 0 -0.04em -0.2em",
        background: `radial-gradient(circle at 50% 38%, ${c.body}99, ${c.accent}44 62%, rgba(0,0,0,0.4))`, boxShadow: `0 0 0 1px ${on ? "rgba(5,6,12,0.4)" : "rgba(243,234,216,0.3)"} inset` }}>
        <img src={portraitPath(chaser)} alt="" draggable={false} style={{ display: "block", width: "100%", height: "100%" }} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: "0.1em" }}>
        <span>{charName(chaser).toUpperCase()}</span>
        <Sub on={on} size={0.62}>{PERSONA[chaser]} · {DIFF_LABEL[difficulty].toLowerCase()} · {DISTRICTS[PAGE_DISTRICT].name.toLowerCase()}{nMut ? ` · ${nMut} mutator${nMut > 1 ? "s" : ""}` : ""}</Sub>
      </span>
      {keys && on && <Sub on={on} size={0.7}><span style={{ paddingLeft: "0.5em" }}>‹ ›</span></Sub>}
    </>
  );

  const entries: Entry[] = [
    { key: "play", testid: "play", label: () => (ready ? (props.ghostActive ? "RACE GHOST" : "PLAY") : "LOADING CITY…"), act: props.onPlay, off: !ready,
      desc: props.ghostActive ? "same city, same start, same runner: race their ghost" : S.pitch.toLowerCase() },
    ...(props.bestGhost ? [{ key: "best", testid: "race-best", label: (on: boolean) => <>RACE YOUR BEST <Sub on={on}>{props.bestGhost!.t.toFixed(1)} s</Sub></>, act: props.onRaceBest, off: !ready, desc: "race the ghost of your best run (same round)" }] : []),
    { key: "campaign", testid: "campaign", label: on => <>CAMPAIGN <Sub on={on} color={GOLD}>★ {stars}/{TOTAL_STARS}</Sub></>, act: props.onCampaign, off: !ready,
      desc: `${LEVELS.length} levels across the ${DISTRICT_IDS.length} districts, 3 stars each` },
    { key: "practice", testid: "practice", label: () => "PRACTICE", act: props.onPractice, off: !ready, desc: "free swinging in the city: no runner, no timer" },
    { key: "tag", testid: "spider-tag", label: () => "TAG", act: () => { rememberPicks(chaser, difficulty); gotoDistrict(PAGE_DISTRICT, { tag: "1" }); }, desc: "web-slinger tag: you vs 1-3 bots, or 1v1 online with a friend; whoever holds the bag chases" },
    { key: "chaser", testid: "chaser", label: on => chaserRow(on), act: () => setPick(true),
      desc: keys ? "left / right: change your Radbro · enter: the roster, the difficulty, the district" : "your Radbro or Retardio, the difficulty and the district" },
    { key: "controls", testid: "controls-toggle", label: () => "CONTROLS", act: () => setControls(true), desc: "the keys, the touch buttons or the pad, and the credits" },
    ...(vyvanseFramed() ? [{ key: "vyv", testid: "vyvanse-back", label: () => "BACK TO VYVANSE.BEER", act: backToVyvanse, desc: "close the game and go back to the vyvanse.beer menu" }] : []),
  ];
  const at = entries.findIndex(e => e.key === focusKey);
  const game = OTHER_GAMES.find(g => `game-${g.id}` === focusKey) ?? null;
  /** The highlighted entry (-1: one of the other games has the focus). */
  const cur = at >= 0 ? at : game ? -1 : 0;
  const overlay = pick || controls;

  // The keys: up / down go round the list and the other games (past the items still waiting for the city), as a pad
  // does; Enter picks the highlighted entry, whichever button holds the page's focus (a link or another button, e.g.
  // the speaker, keeps its own Enter).
  useEffect(() => {
    if (overlay) return;
    const kd = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === "ArrowDown" || e.code === "ArrowUp") {
        const ring = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-pad-cycle]") ?? [])].filter(el => !(el as HTMLButtonElement).disabled);
        const n = ring.length;
        if (!n) return;
        const d = e.code === "ArrowDown" ? 1 : -1;
        let k = ring.indexOf(document.activeElement as HTMLElement);
        if (k < 0 && cur >= 0) k = ring.indexOf(refs.current[cur] as HTMLElement);
        ring[k < 0 ? (d > 0 ? 0 : n - 1) : (k + d + n) % n].focus();
        e.preventDefault();
      } else if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && entries[cur]?.key === "chaser") {
        cycle(e.code === "ArrowRight" ? 1 : -1);
        e.preventDefault();
      } else if (e.code === "Enter" || e.code === "NumpadEnter") {
        const a = document.activeElement;
        if (a instanceof HTMLAnchorElement || a instanceof HTMLInputElement || (a instanceof HTMLButtonElement && !refs.current.includes(a))) return;
        if (cur >= 0 && !entries[cur].off) entries[cur].act();
        e.preventDefault();
      }
    };
    addEventListener("keydown", kd);
    return () => removeEventListener("keydown", kd);
  });

  // Back from an overlay: the focus returns to the row that opened it.
  const close = (key: string) => () => {
    setPick(false);
    setControls(false);
    setHome(key);
    setFocusKey(key);
    const i = entries.findIndex(e => e.key === key);
    requestAnimationFrame(() => refs.current[i]?.focus({ preventScroll: true }));
  };

  // Shrink to fit (a challenge or ghost line, the iPhone tip, a pad's legend): never a scrolling title.
  const fonts = useFontsReady();
  const fit = useFit(rootRef, [w, h, entries.length, challenge.t !== null, !!props.ghost, props.ghostBusy, props.ghost?.info.status, !!props.ghost?.info.older, pad, touch, fonts].join());
  const L: Layout = fit === 1 ? base : { ...base, mark: base.mark * fit, tag: Math.max(14, base.tag * fit), item: Math.max(16, base.item * fit), gap: base.gap * fit, top: base.top * fit, bottom: base.bottom * fit };

  // The pills top right drop below the wordmark's line when the two would meet (a narrow window, a phone).
  useLayoutEffect(() => {
    const m = markRef.current?.getBoundingClientRect(), p = pillsRef.current;
    if (!m || !p) return;
    const left = Math.min(...[...p.children].map(c => c.getBoundingClientRect().left));
    const need = m.right + 16 > left ? Math.ceil(p.getBoundingClientRect().height) + 10 : 0;
    if (need !== pillsAbove) setPillsAbove(need);
  });

  const art = `${TITLE_ART} ${L.phone === "portrait" ? "36% 50%" : "55% 32%"} / cover no-repeat`;
  const shade = L.phone === "portrait"
    ? "linear-gradient(rgba(5,7,17,0.74), rgba(5,7,17,0.42) 30%, rgba(5,7,17,0.5) 64%, rgba(5,7,17,0.86))"
    : "linear-gradient(90deg, rgba(5,7,17,0.72) 0%, rgba(5,7,17,0.4) 26%, rgba(5,7,17,0) 50%), linear-gradient(rgba(5,7,17,0.62), rgba(5,7,17,0) 27%, rgba(5,7,17,0) 80%, rgba(5,7,17,0.78))";
  const twoCol = L.phone === "landscape";
  // the other games' chips: wordmarks only on phones and narrow windows (they stay beside the status line)
  const slim = !!L.phone || w < 1000;
  const rows = Math.ceil(entries.length / 2);
  const pillH = L.phone ? 32 : Math.round(L.pill * 1.75);
  const pill = (accent: string): React.CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: L.phone ? 6 : 8, height: pillH, boxSizing: "border-box", padding: L.phone ? "0 10px 0 8px" : "0 14px 0 11px", borderRadius: 999, textDecoration: "none",
    font: `400 ${L.pill}px/1 ${VT}`, letterSpacing: "0.04em", color: "#ece6f8", background: "rgba(14,9,26,0.66)", border: `1px solid ${accent}`, pointerEvents: "auto", whiteSpace: "nowrap",
  });

  return (
    <div ref={rootRef} data-testid="title" style={{ position: "fixed", inset: 0, zIndex: 20, overflow: "hidden auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch",
      background: `${shade}, ${art} #090b16`, boxShadow: "inset 0 0 90px 20px rgba(6,7,18,0.4)" } as React.CSSProperties}>
      <div inert={overlay} style={{ visibility: overlay ? "hidden" : undefined, minHeight: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "flex-start",
        padding: `${inset("top", L.top + pillsAbove)} ${inset("right", L.padX)} ${inset("bottom", L.bottom)} ${inset("left", L.padX)}` }}>
        <div ref={markRef} style={{ maxWidth: "100%" }}><Wordmark px={L.mark} /></div>
        <div style={{ marginTop: L.phone ? 2 : "0.6vh", font: `400 ${L.tag}px/1 ${VT}`, letterSpacing: "0.06em", color: "#f2e9e1", textShadow: GLOW }}>{S.tagline}</div>
        {(touch && portrait) || props.ghost || props.ghostBusy || challenge.t !== null ? (
          <div style={{ marginTop: (L.phone ? 8 : 14) * fit, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 * fit, maxWidth: "min(760px, 100%)" }}>
            {touch && portrait && <div style={notice(GOLD, L.tag * 0.85)} data-testid="rotate-hint"><span style={{ color: GOLD }}>[ !! ]</span> rotate your phone: SPIDERTAG plays in landscape</div>}
            {(props.ghost || props.ghostBusy)
              ? <GhostLine ghost={props.ghost} active={props.ghostActive} busy={props.ghostBusy} px={L.tag * 0.82} />
              : challenge.t !== null && <div style={notice(GOLD, L.tag * 0.85)} data-testid="challenge"><span style={{ color: GOLD }}>[ CHALLENGE ]</span> beat {challenge.t.toFixed(1)} s{challenge.r ? ` vs ${charTag(challenge.r)}` : ""}</div>}
          </div>
        ) : null}
        <HomeScreenTip />
        <div role="menu" aria-label="main menu" style={twoCol
          ? { marginTop: 10 * fit, display: "grid", gridAutoFlow: "column", gridTemplateRows: `repeat(${rows}, auto)`, columnGap: 10, rowGap: L.gap, alignItems: "center" }
          : { marginTop: (L.phone ? 18 : clamp(16, h * 0.045, 48)) * fit * fit, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: L.gap }}>
          {entries.map((e, i) => {
            const on = i === cur;
            return (
              <button key={e.key} ref={el => { refs.current[i] = el; }} role="menuitem" data-testid={e.testid} data-st-item="" data-pad-cycle="" data-pad-default={e.key === home ? "" : undefined}
                disabled={e.off} onClick={e.act} onMouseEnter={() => { setFocusKey(e.key); refs.current[i]?.focus({ preventScroll: true }); }} onFocus={() => setFocusKey(e.key)} style={itemStyle(on, e.off, L.item)}>
                {e.label(on)}
              </button>
            );
          })}
        </div>
        {!L.phone && <div style={{ marginTop: clamp(10, h * 0.02, 22) * fit * fit, maxWidth: "min(52em, 100%)", boxSizing: "border-box", padding: "0.2em 1.2em 0.16em 0.5em", borderRadius: 2, background: GLASS, font: `400 ${Math.round(L.tag * 0.64)}px/1.2 ${VT}`, letterSpacing: "0.03em", color: "#f2e9e1", textShadow: `${GLOW}, 0 0 3px #000` }} data-testid="title-desc">
          &gt; {cur >= 0 ? entries[cur].desc : game ? `play ${game.mark.join("")}: ${game.short} (${game.url.replace(/^https:\/\//, "")})` : ""}
        </div>}
        <div style={{ marginTop: "auto", paddingTop: L.phone ? 12 : 24, paddingBottom: pad ? 34 : 0, width: "100%", boxSizing: "border-box", display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: L.phone ? 8 : 16 }}>
          <div style={{ font: `400 ${L.status}px/1 ${VT}`, letterSpacing: "0.04em", color: ready ? MINT : GOLD, textShadow: GLOW, whiteSpace: "nowrap" }} data-testid="status">
            {ready ? `[ OK ] ${S.host}` : "[ .. ] loading the city"}
          </div>
          <div style={{ display: "flex", gap: L.phone ? 6 : 10, flexWrap: "wrap", justifyContent: "flex-end", marginLeft: "auto" }}>
            {OTHER_GAMES.map(g => (
              <a key={g.id} href={g.url} target={framed ? "_blank" : undefined} rel="noopener" className="st-f" data-pad-item="" data-pad-cycle="" data-testid={`game-${g.id}`}
                onFocus={() => setFocusKey(`game-${g.id}`)} onMouseEnter={ev => { setFocusKey(`game-${g.id}`); ev.currentTarget.focus({ preventScroll: true }); }}
                style={{ display: "block", padding: slim ? "6px 10px 5px" : "8px 14px 7px", textDecoration: "none", borderRadius: 3, border: "1.5px solid rgba(243,234,216,0.25)", background: "rgba(5,7,17,0.62)" }}>
                <div style={{ font: `400 ${L.phone ? 19 : slim ? 22 : 26}px/0.9 ${BEBAS}`, letterSpacing: "0.03em" }}>
                  <span style={{ color: g.colors[0] }}>{g.mark[0]}</span><span style={{ color: g.colors[1] }}>{g.mark[1]}</span>
                </div>
                {!slim && <div style={{ marginTop: 4, font: `400 15px/1 ${VT}`, letterSpacing: "0.04em", color: "#c9b99a" }}>{g.short}</div>}
              </a>
            ))}
          </div>
        </div>
      </div>
      <div ref={pillsRef} inert={overlay} style={{ visibility: overlay ? "hidden" : undefined, position: "absolute", top: inset("top", L.top), right: inset("right", L.padX), left: inset("left", L.padX), display: "flex", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: L.phone ? 6 : 8, pointerEvents: "none" }}>
        {promo && (
          <a href={S.tokenUrl} target="_blank" rel="noopener" className="st-f" data-pad-item="" data-testid="token-link" title="the $SPIDERTAG coin's page" style={{ ...pill("rgba(253,67,174,0.55)"), color: PINK }}>
            <img src="/favicon.png" alt="" width={18} height={18} style={{ width: "1.1em", height: "1.1em", borderRadius: "50%" }} />$SPIDERTAG{L.phone ? "" : " ↗"}
          </a>
        )}
        {promo && <a href={S.tipUrl} target="_blank" rel="noopener" className="st-f" data-pad-item="" data-testid="tip" style={pill("rgba(233,196,126,0.45)")}><Coin />tip vyvanse.sol</a>}
        <MuteButton muted={props.muted} onMute={props.onMute} style={{ position: "relative", zIndex: 0, width: pillH, height: pillH, borderRadius: pillH / 2, background: props.muted ? "rgba(253,67,174,0.45)" : "rgba(14,9,26,0.66)", border: "1px solid rgba(243,234,216,0.4)" }} />
      </div>
      {pick && <PickScreen {...props} L={L} onClose={close("chaser")} />}
      {controls && <ControlsScreen L={L} onClose={close("controls")} />}
    </div>
  );
}

/** An overlay over the title, laid out like it (data-pad-modal: a pad stays inside; the arrow keys move the same way). */
function useOverlayKeys(onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const nav = new MenuNav();
    const kd = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === "Escape") { e.preventDefault(); closeRef.current(); return; }
      const dir = e.code === "ArrowUp" ? "up" : e.code === "ArrowDown" ? "down" : e.code === "ArrowLeft" ? "left" : e.code === "ArrowRight" ? "right" : null;
      if (!dir) return;
      e.preventDefault();
      if (!nav.cur && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) nav.cur = document.activeElement;
      nav.move(dir);
    };
    addEventListener("keydown", kd);
    return () => { removeEventListener("keydown", kd); nav.release(); };
  }, []);
}

/** An overlay's layer: more shade over the art where it carries lines of text (dark). */
function overlayRoot(L: Layout, dark = false): React.CSSProperties {
  const a = dark ? 0.8 : 0.6, b = dark ? 0.62 : 0.3, c = dark ? 0.45 : 0.15;
  return {
    position: "fixed", inset: 0, zIndex: 22, overflow: "hidden auto", overscrollBehavior: "contain",
    background: L.phone === "portrait" ? `rgba(5,7,17,${dark ? 0.72 : 0.5})` : `linear-gradient(90deg, rgba(5,7,17,${a}), rgba(5,7,17,${b}) 55%, rgba(5,7,17,${c}))`,
  };
}
const overlayCol = (L: Layout, fit = 1): React.CSSProperties => ({
  minHeight: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: L.phone ? 8 * fit : `clamp(${10 * fit}px, ${2.2 * fit}vh, ${22 * fit}px)`,
  padding: `${inset("top", L.top)} ${inset("right", L.padX)} ${inset("bottom", L.bottom)} ${inset("left", L.padX)}`,
});
function Heading({ a, b, sub, L, fit = 1 }: { a: string; b: string; sub?: string; L: Layout; fit?: number }) {
  const px = (L.phone === "landscape" ? clamp(28, L.mark * 0.62, 40) : L.phone ? 44 : clamp(44, L.mark * 0.5, 84)) * fit;
  return (
    <div>
      <div role="heading" aria-level={2} style={{ font: `400 ${px}px/0.9 ${BEBAS}`, letterSpacing: "0.03em", textShadow: "0 3px 10px #000" }}>
        <span style={{ color: CREAM }}>{a}</span><span style={{ color: PINK }}>{b}</span>
      </div>
      {sub && <div style={{ marginTop: 2, font: `400 ${L.phone ? 17 : Math.round(L.tag * 0.72)}px/1 ${VT}`, letterSpacing: "0.05em", color: SAND, textShadow: GLOW }}>{sub}</div>}
    </div>
  );
}

/** The character select: the roster as cards, then the round's difficulty, district and mutators. */
function PickScreen(p: TitleProps & { L: Layout; onClose: () => void }) {
  const { L, chaser, difficulty, progress } = p;
  const { w, h } = useViewport();
  useOverlayKeys(p.onClose);
  // a small phone with the districts and mutators unlocked: smaller cards, chips and gaps until DONE is on screen
  const rootRef = useRef<HTMLDivElement>(null);
  const fonts = useFontsReady();
  const fit = useFit(rootRef, [w, h, unlockedMutators(progress) | p.freeMut, DISTRICT_IDS.filter(id => districtUnlocked(progress, id)).length, degenUnlocked(progress), fonts].join(), 0.6);
  // the picked card takes the focus (keys: the arrows go on from it)
  useEffect(() => { document.querySelector<HTMLElement>(`[data-testid="card-${chaser}"]`)?.focus({ preventScroll: true }); }, []);
  const stars = starCount(progress);
  const availMut = unlockedMutators(progress) | p.freeMut;
  const cols = L.phone === "portrait" ? 4 : RADBROS.length;
  const gap = (L.phone ? 6 : 10) * Math.min(1, fit + 0.2);
  // the cards' largest size; the grid shrinks them to the width there is (safe areas included)
  const card = Math.round((L.phone === "landscape" ? h * 0.21 : L.phone ? 120 : clamp(96, h * 0.2, 230)) * fit);
  const cardPx = Math.min(card, (w - 2 * L.padX - (cols - 1) * gap) / cols);
  const namePx = L.phone ? clamp(12, cardPx * 0.3, 18) : clamp(18, cardPx * 0.14, 30);
  const chip = Math.max(13, (L.phone ? 17 : clamp(18, h * 0.027, 28)) * Math.min(1, fit + 0.15));
  const label = (t: string) => <span style={{ width: L.phone ? "auto" : "6.2em", flex: "none", font: `400 ${L.phone ? Math.round(chip * 0.94) : Math.round(chip * 0.82)}px/1 ${VT}`, letterSpacing: "0.05em", color: SAND, textShadow: GLOW }}>&gt; {t}</span>;
  // the difficulty's and the district's line, on glass (they sit over the busiest part of the art)
  const blurb = (t: string) => !L.phone && <span style={{ marginLeft: 6, padding: "0.2em 1em 0.14em 0.45em", borderRadius: 2, background: GLASS, font: `400 ${Math.round(chip * 0.86)}px/1.1 ${VT}`, color: "#f2e9e1", textShadow: GLOW }}>{t}</span>;
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 * Math.min(1, fit + 0.2), flexWrap: "wrap", maxWidth: "100%" };
  return (
    <div ref={rootRef} data-pad-modal="" data-testid="pick" role="dialog" aria-label="pick your Radbro" style={overlayRoot(L)}>
      <div style={overlayCol(L, fit)}>
        <Heading a="PICK YOUR " b="RADBRO" sub={`or Retardio · ${S.youChase.toLowerCase()}`} L={L} fit={Math.min(1, fit + 0.15)} />
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, ${card}px))`, gap, width: "100%" }} data-testid="roster">
          {RADBROS.map(id => {
            const sel = id === chaser;
            const c = RADBRO_COLOR[id];
            return (
              <button key={id} onClick={() => p.setChaser(id)} className="st-f" data-testid={`card-${id}`} data-pad-default={sel ? "" : undefined} aria-pressed={sel} title={`${charName(id)} · ${PERSONA[id]}`}
                style={{ minWidth: 0, padding: 0, border: 0, borderRadius: 3, overflow: "hidden", cursor: "pointer", textAlign: "left", color: CREAM, touchAction: "manipulation",
                  background: "rgba(5,7,17,0.7)", boxShadow: sel ? `0 0 0 2px ${PINK}, 0 0 22px rgba(253,67,174,0.45)` : "0 0 0 1px rgba(243,234,216,0.2)" }}>
                <div style={{ aspectRatio: "1", background: `radial-gradient(circle at 50% 40%, ${c.body}88, ${c.accent}33 62%, rgba(0,0,0,0.35))` }}>
                  <img src={portraitPath(id)} alt="" draggable={false} style={{ display: "block", width: "100%", height: "100%", filter: sel ? "none" : "saturate(0.85) brightness(0.9)" }} />
                </div>
                <div style={{ borderLeft: `4px solid ${sel ? PINK : BAR_OFF}`, background: sel ? PINK : GLASS, color: sel ? INK : CREAM, padding: L.phone ? "4px 6px 3px" : "6px 8px 5px" }}>
                  <div style={{ font: `400 ${namePx}px/1 ${BEBAS}`, letterSpacing: "0.05em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{L.phone || cardPx < 120 ? charTag(id) : charName(id).toUpperCase()}</div>
                  {!L.phone && <div style={{ marginTop: 2, font: `400 ${Math.round(namePx * 0.8)}px/1 ${VT}`, letterSpacing: "0.03em", opacity: 0.9 }}>{PERSONA[id]}</div>}
                </div>
              </button>
            );
          })}
        </div>
        <div style={row}>
          {label("difficulty")}
          {DIFFICULTIES.map(d => {
            const open = d !== "degen" || degenUnlocked(progress) || d === difficulty;
            return (
              <button key={d} onClick={() => open && p.setDifficulty(d)} disabled={!open} className="st-f" data-testid={`diff-${d}`} aria-pressed={d === difficulty}
                title={open ? DIFF_BLURB[d] : `locked: earn ${DEGEN_STARS} campaign stars (${stars} so far)`} style={chipStyle(d === difficulty, open, chip)}>
                {open ? "" : "🔒 "}{DIFF_LABEL[d].toUpperCase()}
              </button>
            );
          })}
          {blurb(DIFF_BLURB[difficulty])}
        </div>
        <div style={row} data-testid="districts">
          {label("district")}
          {DISTRICT_IDS.map(id => {
            const open = id === PAGE_DISTRICT || districtUnlocked(progress, id);
            const first = LEVELS.find(l => l.map === id);
            return (
              <button key={id} onClick={() => { if (open && id !== PAGE_DISTRICT) { rememberPicks(chaser, difficulty); gotoDistrict(id); } }} disabled={!open} className="st-f" data-testid={`map-${id}`} aria-pressed={id === PAGE_DISTRICT}
                title={open ? DISTRICTS[id].blurb : `locked: catch him in campaign level ${first?.n} (${first?.name}) to open ${DISTRICTS[id].name} in free play`} style={chipStyle(id === PAGE_DISTRICT, open, chip)}>
                {open ? "" : "🔒 "}{DISTRICTS[id].name.toUpperCase()}
              </button>
            );
          })}
          {blurb(DISTRICTS[PAGE_DISTRICT].blurb.toLowerCase())}
        </div>
        {availMut !== 0 && (
          <div style={row} data-testid="mutators">
            {label("mutators")}
            {MUTATORS.filter(m => (availMut & m.bit) !== 0).map(m => {
              const on = (p.freeMut & m.bit) !== 0;
              return (
                <button key={m.id} onClick={() => p.setFreeMut(p.freeMut ^ m.bit)} title={m.blurb} className="st-f" data-testid={`mut-${m.id}`} aria-pressed={on} style={chipStyle(on, true, Math.round(chip * 0.85))}>
                  {on ? "✓ " : ""}{m.name.toUpperCase()}
                </button>
              );
            })}
          </div>
        )}
        <button onClick={p.onClose} data-st-item="" data-testid="pick-done" data-pad-btn="EAST START" style={{ ...itemStyle(true, false, (L.phone ? 24 : clamp(24, h * 0.043, 40)) * Math.min(1, fit + 0.2)), marginTop: (L.phone ? 2 : 6) * fit }}>DONE</button>
      </div>
    </div>
  );
}

const KEY_ROWS: [string, string][] = [
  ["mouse", "look / aim"],
  ["W A S D", "run"],
  ["hold LMB", "swing (let go near the top = perfect · steer into a cross street = corner swing)"],
  ["E / Shift", "zip where you look (red dashed ring on him = yank)"],
  ["Space", "jump (again in the air = double jump; on a wall = wall kick; end of a zip = pop)"],
  ["hold G", "wingsuit glide in the air (look down for speed, pull up for height)"],
  ["C", "tap = slide · hold = charge a leap · in the air = head-first dive (web out of it = fast swing)"],
  ["", "ledges and low walls are climbed / vaulted by themselves"],
  ["red ring + LMB", "YOINK"],
  ["Q / RMB", "look at him"],
  ["R · M · Esc", "retry (hold 1 s mid-round) · mute · pause"],
];
const TOUCH_ROWS: [string, string][] = [
  ["left thumb", "run"],
  ["drag right", "look"],
  ["hold WEB", "swing (let go near the top = perfect · steer into a cross street = corner swing)"],
  ["ZIP", "zip where you look (red dashed ring on him = yank)"],
  ["JUMP", "again in the air = double jump; on a wall = wall kick; end of a zip = pop"],
  ["hold GLIDE", "wingsuit in the air; pitch down for speed, up for height"],
  ["SLIDE", "tap = slide · hold = charge a leap · in the air = head-first dive (web out of it = fast swing)"],
  ["red ring + WEB", "YOINK"],
  ["HIM", "look at him"],
];

/** The controls for the device in use (keys and mouse, touch, or the pad's glyphs), then the credits. */
function ControlsScreen({ L, onClose }: { L: Layout; onClose: () => void }) {
  const touch = useUi(s => s.touch);
  const pad = useUi(s => s.pad);
  const { h } = useViewport();
  useOverlayKeys(onClose);
  const rows: [React.ReactNode, string][] = pad ? radrunPadControls().map(([k, d]) => [<PadText text={k} />, d]) : touch ? TOUCH_ROWS : KEY_ROWS;
  const px = L.phone === "landscape" ? 16 : L.phone ? 18 : clamp(18, h * 0.029, 28);
  return (
    <div data-pad-modal="" data-testid="controls" role="dialog" aria-label="controls" style={overlayRoot(L, true)}>
      <div style={overlayCol(L)}>
        <Heading a="CONT" b="ROLS" sub={pad ? "controller" : touch ? "touch" : "keyboard and mouse"} L={L} />
        <div style={{ display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", columnGap: L.phone ? 10 : 18, rowGap: L.phone ? 3 : 6, maxWidth: "min(1000px, 100%)", alignItems: "baseline" }}>
          {rows.map(([k, d], i) => (
            <div key={i} style={{ display: "contents" }}>
              <div style={{ font: `400 ${Math.round(px * 1.05)}px/1.1 ${BEBAS}`, letterSpacing: "0.05em", color: PINK, textShadow: "0 1px 4px #000", whiteSpace: "nowrap" }}>{k}</div>
              <div style={{ font: `400 ${px}px/1.15 ${VT}`, letterSpacing: "0.02em", color: CREAM, textShadow: "0 1px 4px #000" }}>{d}</div>
            </div>
          ))}
        </div>
        <div style={{ maxWidth: "min(1000px, 100%)", font: `400 ${Math.round(px * 0.85)}px/1.2 ${VT}`, color: SAND, opacity: 0.8 }} data-testid="credits">{S.credits}</div>
        <button onClick={onClose} data-st-item="" data-testid="controls-back" data-pad-default="" data-pad-btn="EAST" style={{ ...itemStyle(true, false, L.phone ? 24 : clamp(24, h * 0.043, 40)), marginTop: 4 }}>BACK</button>
      </div>
    </div>
  );
}
