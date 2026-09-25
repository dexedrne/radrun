// First-run tips (round 3): short prompts shown at the moment they matter, once each (remembered in
// localStorage via prefs; pause -> Settings -> "show tips again" resets them). PlayDriver ticks the
// engine at 10 Hz with the player's state; the pill is <HintPill/> in screens.tsx.
//   swing  - a balloon is ringed and you are not on a rope  -> done when you web on
//   fling  - you are on the rope                            -> done when you let go
//   chain  - airborne after a let-go                        -> done at a 3-swing chain
//   yoink  - the red ring is on him (real rounds only)      -> done after it has been read
//   djump  - airborne off the rope (after the fling tip)     -> done at a double jump
//   zip    - on a roof with a ringed balloon (after fling)   -> done at a web zip
import { hintsSeen, markHintSeen, resetHintsSeen } from "./prefs.ts";
import { useUi } from "./store.ts";

export type HintId = "swing" | "fling" | "chain" | "yoink" | "djump" | "zip";

export type HintInput = {
  /** Chase or practice, not paused, not a bot page. */
  active: boolean;
  grounded: boolean;
  rope: boolean;
  ring: "none" | "hook" | "attached" | "runner";
  chain: number;
  touch: boolean;
  easyGrab: boolean;
  /** A double jump / web zip happened since the last tick; moves = the double jump + zip are on. */
  djumped?: boolean;
  zipped?: boolean;
  moves?: boolean;
};

export function hintText(id: HintId, touch: boolean, easyGrab: boolean): string {
  const web = touch ? "WEB" : easyGrab ? "Space" : "LMB";
  switch (id) {
    case "swing": return `hold ${web} while a balloon has the yellow ring to web on and swing`;
    case "fling": return `let go of ${web} at the bottom of the arc to fling forward`;
    case "chain": return "chain swings down the streets to go fast: grab the next balloon before you land";
    case "yoink": return touch ? "red ring on him = tap WEB to YOINK" : `red ring on him = ${easyGrab ? "tap Space" : "click"} to YOINK`;
    case "djump": return touch ? "tap JUMP again in the air to double jump" : easyGrab ? "tap Space in the air (no balloon ringed) to double jump" : "press Space again in the air to double jump";
    case "zip": return touch
      ? "tap ZIP to web-zip straight to the ringed balloon (or the roof ledge ahead)"
      : "press E or Shift to web-zip straight to the ringed balloon (or the roof ledge ahead)";
  }
}

/** Seconds a tip stays up at most (it goes as soon as you have done the thing). */
const MAX_SHOW: Record<HintId, number> = { swing: 9, fling: 6, chain: 7, yoink: 4, djump: 5, zip: 7 };

export class Hints {
  private seen: Record<string, boolean> = {};
  private loaded = false;
  cur: HintId | null = null;
  private shown = 0;
  private wasRope = false;
  private released = false;
  /** Seconds active this round/practice (no tips in the first second after GO). */
  private activeT = 0;

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.seen = hintsSeen();
  }

  /** New round / practice: forget per-round state (not the seen flags). */
  newRun(): void {
    this.hide();
    this.wasRope = false;
    this.released = false;
    this.activeT = 0;
  }

  /** Settings -> "show tips again". */
  reset(): void {
    resetHintsSeen();
    this.seen = {};
    this.loaded = true;
    this.newRun();
  }

  private hide(): void {
    this.cur = null;
    this.shown = 0;
    if (useUi.getState().hint) useUi.setState({ hint: null });
  }

  private show(id: HintId, s: HintInput): void {
    this.cur = id;
    this.shown = 0;
    useUi.setState({ hint: { id, text: hintText(id, s.touch, s.easyGrab) } });
  }

  private finish(): void {
    if (this.cur) { this.seen[this.cur] = true; markHintSeen(this.cur); }
    this.hide();
  }

  tick(dt: number, s: HintInput): void {
    this.load();
    if (!s.active) { if (this.cur) this.hide(); return; }
    this.activeT += dt;
    const rope = s.rope;
    if (this.wasRope && !rope && !s.grounded) this.released = true;
    if (s.grounded) this.released = false;
    const justReleased = this.wasRope && !rope;
    this.wasRope = rope;

    // The red ring beats any other tip.
    if (s.ring === "runner" && !this.seen.yoink && this.cur !== "yoink") this.show("yoink", s);

    if (this.cur) {
      this.shown += dt;
      const c = this.cur;
      const done = (c === "swing" && rope) || (c === "fling" && justReleased) || (c === "chain" && s.chain >= 3) || (c === "yoink" && this.shown >= 1.5) ||
        (c === "djump" && !!s.djumped) || (c === "zip" && !!s.zipped);
      // A finished tip hands straight over to the next one below (swing -> fling -> chain).
      if (done || this.shown >= MAX_SHOW[c]) this.finish();
      else return;
    }
    if (this.activeT < 1) return;
    if (rope && !this.seen.fling) this.show("fling", s);
    else if (!rope && s.ring === "hook" && !this.seen.swing) this.show("swing", s);
    else if (!rope && !s.grounded && this.released && s.chain < 3 && this.seen.fling && !this.seen.chain) this.show("chain", s);
    else if (s.moves && !rope && !s.grounded && this.seen.fling && !this.seen.djump) this.show("djump", s);
    else if (s.moves && s.grounded && s.ring === "hook" && this.seen.fling && !this.seen.zip) this.show("zip", s);
  }
}

export const hints = new Hints();
