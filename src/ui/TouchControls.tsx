// Phone / tablet controls (spec §4 "Touch"): a floating left-thumb stick (move), right-half drag
// (camera), big WEB (hold) and JUMP buttons on the right, a ZIP (web zip) button above JUMP (dimmed while
// it recharges), a small look-at-him button and a pause button.
// Everything writes into the same InputLatch as the keyboard and mouse, so the sim sees the same
// InputFrame. Shown only in COUNTDOWN / CHASE while not paused.
import { useEffect, useRef } from "react";
import type { InputLatch } from "../input/input.ts";
import { TOUCH } from "../sim/tuning.ts";
import { useUi } from "./store.ts";
import { safe } from "./safe.ts";

const STICK_R = 56;
/** The stick's resting spot and every button sit inside the safe area (notch side, home indicator). */
const STICK_LEFT = safe("left", 88), STICK_BOTTOM = safe("bottom", 34);

type Track = { stick: number; ox: number; oy: number; look: number; lx: number; ly: number; web: number; wx: number; wy: number };

const round = (size: number, extra: React.CSSProperties = {}): React.CSSProperties => ({
  position: "absolute", width: size, height: size, borderRadius: size / 2, display: "grid", placeItems: "center",
  font: `900 ${Math.round(size / 5.2)}px ui-monospace, monospace`, letterSpacing: 1, color: "#fff", userSelect: "none",
  WebkitUserSelect: "none", touchAction: "none", border: "2px solid rgba(255,255,255,0.55)", textShadow: "0 1px 2px rgba(0,0,0,0.6)",
  boxShadow: "0 3px 14px rgba(0,0,0,0.35)", ...extra,
});

export function TouchControls({ input, onPause, noRunner = false }: { input: InputLatch; onPause: () => void; noRunner?: boolean }) {
  const ring = useUi(s => s.round.ring);
  const zip = useUi(s => s.round.zip);
  const base = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const webBtn = useRef<HTMLDivElement>(null);
  const jumpBtn = useRef<HTMLDivElement>(null);
  const zipBtn = useRef<HTMLDivElement>(null);
  const t = useRef<Track>({ stick: -1, ox: 0, oy: 0, look: -1, lx: 0, ly: 0, web: -1, wx: 0, wy: 0 });

  // Unmount (pause, results) releases everything the thumbs were holding.
  useEffect(() => () => {
    input.setStick(0, 0);
    input.touchWebUp();
    input.touchFace = false;
  }, [input]);

  const drawStick = (on: boolean, kx = 0, ky = 0) => {
    const b = base.current, k = knob.current;
    if (!b || !k) return;
    const s = t.current;
    if (!on) {
      b.style.opacity = "0.35";
      b.style.left = STICK_LEFT; b.style.top = "auto"; b.style.bottom = STICK_BOTTOM;
      k.style.transform = "translate(0px, 0px)";
      return;
    }
    b.style.opacity = "1";
    b.style.left = `${s.ox - STICK_R}px`; b.style.top = `${s.oy - STICK_R}px`; b.style.bottom = "auto";
    k.style.transform = `translate(${kx}px, ${ky}px)`;
  };

  const press = (el: HTMLDivElement | null, on: boolean) => {
    if (el) el.style.transform = on ? "scale(0.92)" : "none";
  };

  // Field: left half = floating stick, right half = camera drag.
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const s = t.current;
    if (e.clientX < innerWidth * 0.5) {
      if (s.stick !== -1) return;
      s.stick = e.pointerId; s.ox = e.clientX; s.oy = e.clientY;
      input.setStick(0, 0);
      drawStick(true);
    } else {
      if (s.look !== -1) return;
      s.look = e.pointerId; s.lx = e.clientX; s.ly = e.clientY;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = t.current;
    if (e.pointerId === s.stick) {
      let dx = e.clientX - s.ox, dy = e.clientY - s.oy;
      const l = Math.sqrt(dx * dx + dy * dy);
      if (l > STICK_R) {
        // Floating stick: the base follows the thumb once it leaves the ring.
        s.ox += dx * (1 - STICK_R / l); s.oy += dy * (1 - STICK_R / l);
        dx = e.clientX - s.ox; dy = e.clientY - s.oy;
      }
      input.setStick(dx / STICK_R, -dy / STICK_R);
      drawStick(true, dx, dy);
    } else if (e.pointerId === s.look) {
      input.mouseDX += (e.clientX - s.lx) * TOUCH.lookScale;
      input.mouseDY += (e.clientY - s.ly) * TOUCH.lookScale;
      s.lx = e.clientX; s.ly = e.clientY;
    }
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = t.current;
    if (e.pointerId === s.stick) { s.stick = -1; input.setStick(0, 0); drawStick(false); }
    if (e.pointerId === s.look) s.look = -1;
  };

  // WEB: hold to swing; sliding the thumb while holding also turns the camera.
  const webDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault(); e.stopPropagation();
    const s = t.current;
    if (s.web !== -1) return;
    s.web = e.pointerId; s.wx = e.clientX; s.wy = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    input.touchWebDown();
    press(webBtn.current, true);
  };
  const webMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = t.current;
    if (e.pointerId !== s.web) return;
    e.stopPropagation();
    input.mouseDX += (e.clientX - s.wx) * TOUCH.lookScale;
    input.mouseDY += (e.clientY - s.wy) * TOUCH.lookScale;
    s.wx = e.clientX; s.wy = e.clientY;
  };
  const webUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = t.current;
    if (e.pointerId !== s.web) return;
    e.stopPropagation();
    s.web = -1;
    input.touchWebUp();
    press(webBtn.current, false);
  };

  const yoink = ring === "runner";
  const hooked = ring === "attached";
  const stop = (e: React.PointerEvent) => { e.preventDefault(); e.stopPropagation(); };
  return (
    <div
      data-testid="touch-controls"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onContextMenu={e => e.preventDefault()}
      style={{ position: "fixed", inset: 0, zIndex: 12, touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
    >
      {/* floating stick (resting ghost bottom-left until a thumb lands) */}
      <div ref={base} style={{
        position: "absolute", left: STICK_LEFT, bottom: STICK_BOTTOM, width: STICK_R * 2, height: STICK_R * 2, borderRadius: STICK_R, opacity: 0.35,
        background: "rgba(14,16,30,0.35)", border: "2px solid rgba(255,255,255,0.5)", pointerEvents: "none",
      }}>
        <div ref={knob} style={{
          position: "absolute", left: STICK_R - 26, top: STICK_R - 26, width: 52, height: 52, borderRadius: 26,
          background: "rgba(255,255,255,0.75)", boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        }} />
      </div>
      {/* WEB (hold) */}
      <div ref={webBtn} data-testid="touch-web"
        onPointerDown={webDown} onPointerMove={webMove} onPointerUp={webUp} onPointerCancel={webUp}
        style={round(104, { right: safe("right", 26), bottom: safe("bottom", 30), background: yoink ? "rgba(255,51,85,0.85)" : hooked ? "rgba(61,220,132,0.75)" : "rgba(255,61,127,0.62)" })}>
        {yoink ? "YOINK" : "WEB"}
      </div>
      {/* JUMP */}
      <div ref={jumpBtn} data-testid="touch-jump"
        onPointerDown={e => { stop(e); input.touchJump(); press(jumpBtn.current, true); }}
        onPointerUp={e => { e.stopPropagation(); press(jumpBtn.current, false); }}
        onPointerCancel={() => press(jumpBtn.current, false)}
        style={round(80, { right: safe("right", 146), bottom: safe("bottom", 22), background: "rgba(14,16,30,0.5)" })}>
        JUMP
      </div>
      {/* ZIP: web-zip to the ringed balloon / the roof ahead; dimmed while it recharges */}
      {zip >= 0 && <div ref={zipBtn} data-testid="touch-zip"
        onPointerDown={e => { stop(e); input.touchZip(); press(zipBtn.current, true); }}
        onPointerUp={e => { e.stopPropagation(); press(zipBtn.current, false); }}
        onPointerCancel={() => press(zipBtn.current, false)}
        style={round(64, { right: safe("right", 148), bottom: safe("bottom", 114), background: zip > 0 ? "rgba(14,16,30,0.35)" : "rgba(40,150,190,0.62)", opacity: zip > 0 ? 0.5 : 1 })}>
        ZIP
      </div>}
      {/* ease the camera toward him while held (Q / RMB on desktop); not in practice (no runner) */}
      {!noRunner && <div data-testid="touch-face"
        onPointerDown={e => { stop(e); e.currentTarget.setPointerCapture?.(e.pointerId); input.touchFace = true; }}
        onPointerUp={e => { e.stopPropagation(); input.touchFace = false; }}
        onPointerCancel={() => { input.touchFace = false; }}
        style={round(54, { right: safe("right", 52), bottom: safe("bottom", 150), background: "rgba(14,16,30,0.45)", fontSize: 11 })}>
        HIM
      </div>}
      {/* pause */}
      <div data-testid="touch-pause"
        onPointerDown={e => { stop(e); onPause(); }}
        style={round(44, { left: safe("left", 10), top: safe("top", 10), background: "rgba(14,16,30,0.55)", fontSize: 14, border: "1px solid rgba(255,255,255,0.4)" })}>
        II
      </div>
    </div>
  );
}
