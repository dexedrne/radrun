// Round 14: gamepad glyphs and the pad-only UI bits. <Glyph> draws a PlayStation or Xbox button in SVG (no image
// files), <PadText> renders a prompt with {TOKENS} as glyphs, <PadRoot> (mounted once by main.tsx) adds the menu
// legend and the on-screen character picker for text boxes (the online room code).
import { Fragment, useEffect, useState } from "react";
import type { PadKind } from "../input/gamepad.ts";
import { useUi } from "./store.ts";
import { PAD_NAMES, TOKEN_RE, MENU_LEGEND, type PadToken } from "./padPrompts.ts";
import { setInputValue, usePadKeyboard } from "./padNav.ts";
import { padMenuActive } from "../input/padRuntime.ts";
import { audioState, isMuted } from "../audio/engine.ts";
import { safe } from "./safe.ts";

const FACE_PS: Record<string, { color: string; shape: React.ReactNode }> = {
  SOUTH: { color: "#8fb8ff", shape: <path d="M8 8l8 8M16 8l-8 8" /> },
  EAST: { color: "#ff7b7b", shape: <circle cx="12" cy="12" r="4.6" /> },
  WEST: { color: "#ff9ade", shape: <rect x="7.6" y="7.6" width="8.8" height="8.8" /> },
  NORTH: { color: "#5fe0b6", shape: <path d="M12 6.8l5.2 9H6.8z" /> },
};
const FACE_XB: Record<string, { color: string; letter: string }> = {
  SOUTH: { color: "#5dc21e", letter: "A" }, EAST: { color: "#e5483f", letter: "B" }, WEST: { color: "#3b8cf6", letter: "X" }, NORTH: { color: "#f2c10f", letter: "Y" },
};

/** One button glyph, sized to the text around it (1.35em). */
export function Glyph({ b, kind, size = "1.35em" }: { b: PadToken; kind: PadKind; size?: string }) {
  const label = PAD_NAMES[kind][b];
  const svg = (children: React.ReactNode, w = 24) => (
    <svg viewBox={`0 0 ${w} 24`} width={`calc(${size} * ${w / 24})`} height={size} role="img" aria-label={label}
      style={{ display: "inline-block", verticalAlign: "-0.32em", margin: "0 0.12em", flex: "none" }}>{children}</svg>
  );
  if (b === "SOUTH" || b === "EAST" || b === "WEST" || b === "NORTH") {
    if (kind === "ps") {
      const f = FACE_PS[b];
      return svg(<><circle cx="12" cy="12" r="11" fill="#15182a" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" /><g fill="none" stroke={f.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{f.shape}</g></>);
    }
    const f = FACE_XB[b];
    return svg(<><circle cx="12" cy="12" r="11" fill={f.color} stroke="rgba(0,0,0,0.35)" strokeWidth="1" /><text x="12" y="16.6" textAnchor="middle" fontSize="13" fontWeight="900" fontFamily="ui-sans-serif, system-ui, sans-serif" fill="#fff">{f.letter}</text></>);
  }
  if (b === "LS" || b === "RS" || b === "L3" || b === "R3") {
    const t = b === "LS" || b === "L3" ? "L" : "R";
    const click = b === "L3" || b === "R3";
    return svg(<><circle cx="12" cy="12" r="11" fill="#15182a" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" /><circle cx="12" cy="12" r="7.2" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" />
      <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="900" fontFamily="ui-monospace, monospace" fill="#fff">{t}{click && kind === "ps" ? "3" : ""}</text>
      {click && kind === "xbox" && <path d="M9.5 20.5l2.5 2 2.5-2" fill="none" stroke="#fff" strokeWidth="1.3" />}</>);
  }
  if (b === "DPAD") {
    return svg(<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" fill="#15182a" stroke="rgba(255,255,255,0.7)" strokeWidth="1.3" strokeLinejoin="round" />);
  }
  if (b === "START" || b === "SELECT") {
    if (kind === "xbox") {
      return svg(<><circle cx="12" cy="12" r="11" fill="#15182a" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" />
        {b === "START" ? <path d="M7.5 8.5h9M7.5 12h9M7.5 15.5h9" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
          : <><rect x="6.5" y="7" width="7.5" height="6" rx="1" fill="none" stroke="#fff" strokeWidth="1.4" /><rect x="10" y="11" width="7.5" height="6" rx="1" fill="#15182a" stroke="#fff" strokeWidth="1.4" /></>}</>);
    }
    const t = b === "START" ? "OPTIONS" : "CREATE";
    return svg(<><rect x="1" y="4" width="44" height="16" rx="8" fill="#15182a" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" /><text x="23" y="15.2" textAnchor="middle" fontSize="8.4" fontWeight="800" letterSpacing="0.4" fontFamily="ui-sans-serif, system-ui, sans-serif" fill="#fff">{t}</text></>, 46);
  }
  // Shoulders (L1 / R1, LB / RB) and triggers (L2 / R2, LT / RT).
  const trigger = b === "L2" || b === "R2";
  return svg(<>{trigger
    ? <path d="M4 21V9c0-4 3-7 7-7h6c4 0 7 3 7 7v12z" fill="#15182a" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" />
    : <rect x="1" y="6" width="26" height="13" rx="6.5" fill="#15182a" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" />}
    <text x={trigger ? 14 : 14} y={trigger ? 16.5 : 16.2} textAnchor="middle" fontSize="10" fontWeight="900" fontFamily="ui-monospace, monospace" fill="#fff">{label}</text></>, 28);
}

/** A prompt with {TOKENS} drawn as glyphs of the given (or the last used) pad kind. */
export function PadText({ text, kind }: { text: string; kind?: PadKind }) {
  const cur = useUi(s => s.pad);
  const k = kind ?? cur ?? "xbox";
  const parts = text.split(TOKEN_RE);
  // split with one capture group: even = text, odd = token
  return <>{parts.map((p, i) => (i % 2 ? <Glyph key={i} b={p as PadToken} kind={k} /> : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** The menus' legend on a pad (bottom right, clear of the centred panels), plus a note while the sound is still locked (the browser wants a click or a key first). */
function PadLegend() {
  const pad = useUi(s => s.pad);
  const [st, setSt] = useState({ on: false, back: false, sound: false });
  useEffect(() => {
    if (!pad) return;
    const f = () => {
      const on = padMenuActive();
      const back = on && !!document.querySelector('[data-pad-btn~="EAST"]');
      const sound = on && audioState() !== "running" && !isMuted();
      setSt(s => (s.on === on && s.back === back && s.sound === sound ? s : { on, back, sound }));
    };
    f();
    const iv = setInterval(f, 300);
    return () => clearInterval(iv);
  }, [pad]);
  if (!pad || !st.on) return null;
  return (
    <div style={{ position: "fixed", zIndex: 45, right: safe("right", 10), bottom: safe("bottom", 8), pointerEvents: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, maxWidth: "46vw" }} data-testid="pad-legend">
      {st.sound && <div style={{ background: "rgba(14,16,30,0.78)", borderRadius: 8, padding: "3px 10px", font: "600 11px ui-monospace, monospace", color: "#ffe9a3", textAlign: "right" }}>sound starts after one click or key press (the browser's rule)</div>}
      <div style={{ background: "rgba(14,16,30,0.78)", borderRadius: 8, padding: "4px 12px", font: "700 12px ui-monospace, monospace", color: "#fff", whiteSpace: "nowrap" }}>
        <PadText text={`${MENU_LEGEND.move} move · ${MENU_LEGEND.select} select${st.back ? ` · ${MENU_LEGEND.back} back` : ""}`} />
      </div>
    </div>
  );
}

/** The on-screen character picker for a text box with data-pad-chars (Cross types, Square deletes, Options = done). */
function PadKeyboard() {
  const el = usePadKeyboard(s => s.el);
  const [val, setVal] = useState("");
  const [orig, setOrig] = useState("");
  useEffect(() => { if (el) { setVal(el.value); setOrig(el.value); } }, [el]);
  if (!el || !el.isConnected) return null;
  const chars = [...(el.dataset.padChars || "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")];
  const max = el.maxLength > 0 ? el.maxLength : 32;
  const put = (v: string) => { setInputValue(el, v); setVal(el.value); };
  const close = () => usePadKeyboard.setState({ el: null });
  const key: React.CSSProperties = { font: "800 18px ui-monospace, monospace", width: 44, height: 40, borderRadius: 8, border: "1px solid rgba(255,255,255,0.35)", background: "rgba(255,255,255,0.08)", color: "#fff", cursor: "pointer" };
  return (
    <div data-pad-modal="" style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center", background: "rgba(8,10,20,0.6)" }} data-testid="pad-keyboard">
      <div style={{ background: "rgba(14,16,30,0.95)", borderRadius: 12, padding: 16, textAlign: "center", boxShadow: "0 6px 30px rgba(0,0,0,0.45)" }}>
        <div style={{ font: "900 30px ui-monospace, monospace", letterSpacing: 8, color: "#ffd23f", minHeight: 38 }} data-testid="pad-keyboard-value">{val || "·····".slice(0, max)}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 44px)", gap: 6, marginTop: 10 }}>
          {chars.map((c, i) => <button key={c} style={key} data-pad-default={i === 0 ? "" : undefined} onClick={() => val.length < max && put(val + c)} data-testid={`pad-key-${c}`}>{c}</button>)}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12, font: "700 13px ui-monospace, monospace" }}>
          <button style={{ ...key, width: "auto", padding: "0 14px", fontSize: 13 }} data-pad-btn="WEST" onClick={() => put(val.slice(0, -1))}><PadText text="{WEST} delete" /></button>
          <button style={{ ...key, width: "auto", padding: "0 14px", fontSize: 13 }} data-pad-btn="EAST" onClick={() => { put(orig); close(); }}><PadText text="{EAST} cancel" /></button>
          <button style={{ ...key, width: "auto", padding: "0 18px", fontSize: 13, background: "#ff3d7f", border: "none" }} data-pad-btn="START" onClick={close} data-testid="pad-keyboard-done"><PadText text="{START} done" /></button>
        </div>
      </div>
    </div>
  );
}

/** Mounted once next to the page (main.tsx). */
export function PadRoot() {
  return <><PadLegend /><PadKeyboard /></>;
}
