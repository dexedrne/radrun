// Round 14: menus on a gamepad. Every screen is plain DOM buttons, so one spatial navigator covers them all: the
// d-pad / left stick moves a visible focus ring to the nearest control in that direction, Cross / A presses it,
// left / right on a slider changes it, a text box with data-pad-chars opens the on-screen picker (PadKeyboard), and
// a control with data-pad-btn="EAST START ..." is pressed by those buttons wherever the focus is (Circle / B = back,
// Options / Start = resume, Triangle / Y = retry). While a [data-pad-modal] element is up (pause, the picker) only
// its controls take part; [data-pad-default] marks where the focus lands first; [data-pad-skip] opts out.
import { create } from "zustand";
import type { NavDir, PadButton } from "../input/gamepad.ts";

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * The control to go to from `from` in direction `dir` (index into `rects`, -1 = none that way). Candidates must lie
 * that way from the centre. Cost = the gap ahead (edge to edge) + 2x the sideways gap (edge to edge, 0 when they
 * overlap), so the nearest row / column wins over a far one straight ahead; ties go to the most centred.
 */
export function pickNext(from: Rect, rects: readonly Rect[], dir: NavDir): number {
  const fx = from.x + from.w / 2, fy = from.y + from.h / 2;
  const horiz = dir === "left" || dir === "right";
  const sgn = dir === "right" || dir === "down" ? 1 : -1;
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const ahead = (horiz ? cx - fx : cy - fy) * sgn;
    if (ahead <= 2) continue;
    // Ahead by the near edge (a wide control next to a narrow one), never less than 1 px.
    const edge = horiz ? (sgn > 0 ? r.x - (from.x + from.w) : from.x - (r.x + r.w)) : (sgn > 0 ? r.y - (from.y + from.h) : from.y - (r.y + r.h));
    const dist = Math.max(1, edge, 0.35 * ahead);
    const overlap = horiz ? Math.min(r.y + r.h, from.y + from.h) - Math.max(r.y, from.y) : Math.min(r.x + r.w, from.x + from.w) - Math.max(r.x, from.x);
    const side = overlap > 0 ? 0 : -overlap;
    const score = dist + side * 2 + 0.1 * Math.abs(horiz ? cy - fy : cx - fx);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** The on-screen character picker's target (PadKeyboard renders it). */
export const usePadKeyboard = create<{ el: HTMLInputElement | null }>(() => ({ el: null }));

const SEL = "button:not(:disabled), input:not(:disabled), select:not(:disabled), [data-pad-item]";

/** Set an input's value the way typing would (React's onChange sees it). */
export function setInputValue(el: HTMLInputElement, v: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (set) set.call(el, v); else el.value = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function scope(): ParentNode {
  const m = document.querySelectorAll("[data-pad-modal]");
  return m.length ? m[m.length - 1] : document;
}
function shown(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest("[data-pad-skip]")) return false;
  if (el.getClientRects().length === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.pointerEvents !== "none";
}
const rectOf = (el: Element): Rect => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

let cssDone = false;
/** The focus ring (only on the element the pad focused). */
export function installPadCss(): void {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const st = document.createElement("style");
  st.textContent = `[data-pad-focus]{outline:3px solid #ffd23f !important;outline-offset:3px !important;box-shadow:0 0 0 6px rgba(255,210,63,0.25),0 0 22px rgba(255,210,63,0.55) !important;position:relative;z-index:1}
input[type=range][data-pad-focus]{accent-color:#ffd23f}`;
  document.head.appendChild(st);
}

export class MenuNav {
  cur: HTMLElement | null = null;
  /** The focus was placed by ensure(), not moved by the player: it follows the default when that shows up later. */
  private auto = false;

  /** The controls taking part right now (the top modal's, else the page's). */
  items(): HTMLElement[] {
    return [...scope().querySelectorAll<HTMLElement>(SEL)].filter(shown);
  }

  private valid(el: HTMLElement | null): el is HTMLElement {
    if (!el || !shown(el) || (el as HTMLButtonElement).disabled) return false;
    const s = scope();
    return s === document || (s as Element).contains(el);
  }

  /** Keep a focus on screen: after a screen change (the old control gone, a modal up) land on the default. */
  ensure(): void {
    const ok = this.valid(this.cur);
    if (ok && !this.auto) return;
    const items = this.items();
    const def = items.find(e => e.hasAttribute("data-pad-default")) ?? null;
    if (ok && (!def || def === this.cur)) return;
    this.focus(def ?? items[0] ?? null);
    this.auto = true;
  }

  focus(el: HTMLElement | null): void {
    if (this.cur === el) return;
    this.cur?.removeAttribute("data-pad-focus");
    this.cur = el;
    if (!el) return;
    el.setAttribute("data-pad-focus", "");
    try { el.focus({ preventScroll: true }); } catch { /* fine */ }
    try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch { /* fine */ }
  }

  /** The ring off (the pad went back to play, or another device took over). */
  release(): void {
    const el = this.cur;
    this.cur = null;
    if (!el) return;
    el.removeAttribute("data-pad-focus");
    if (document.activeElement === el) el.blur();
  }

  move(dir: NavDir): void {
    this.ensure();
    const cur = this.cur;
    if (!cur) return;
    if (cur instanceof HTMLInputElement && cur.type === "range" && (dir === "left" || dir === "right")) { this.nudge(cur, dir === "right" ? 1 : -1); this.auto = false; return; }
    const items = this.items().filter(e => e !== cur);
    const i = pickNext(rectOf(cur), items.map(rectOf), dir);
    if (i >= 0) this.focus(items[i]);
    this.auto = false;
  }

  /** A slider: one twentieth of its range per press, on its step. */
  private nudge(el: HTMLInputElement, sgn: number): void {
    const min = Number(el.min || 0), max = Number(el.max || 100), step = Number(el.step) || (max - min) / 100;
    const inc = Math.max(step, Math.round((max - min) / 20 / step) * step);
    const v = Math.min(max, Math.max(min, Number(el.value) + sgn * inc));
    setInputValue(el, String(Number((min + Math.round((v - min) / step) * step).toFixed(6))));
  }

  /** Cross / A on the focused control. */
  activate(): void {
    this.ensure();
    const el = this.cur;
    if (!el) return;
    this.auto = false;
    if (el instanceof HTMLInputElement) {
      if (el.type === "range") return;
      if (el.type === "checkbox" || el.type === "radio") { el.click(); return; }
      if (el.dataset.padChars !== undefined) { usePadKeyboard.setState({ el }); return; }
      el.focus();
      return;
    }
    el.click();
  }

  /** A control bound to this pad button (data-pad-btn), in the current scope, if one is on screen. */
  bound(b: PadButton): HTMLElement | null {
    for (const el of scope().querySelectorAll<HTMLElement>("[data-pad-btn]")) {
      if ((el.dataset.padBtn ?? "").split(/\s+/).includes(b) && shown(el) && !(el as HTMLButtonElement).disabled) return el;
    }
    return null;
  }

  /** A pad button in the menus: Cross / A presses the focus, others press the control bound to them. True = used. */
  press(b: PadButton): boolean {
    if (b === "SOUTH") { this.activate(); return true; }
    const el = this.bound(b);
    if (!el) return false;
    el.click();
    return true;
  }
}
