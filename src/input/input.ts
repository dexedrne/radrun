// Keyboard / mouse / pointer lock / touch -> a latched InputFrame consumed once per 120 Hz step (spec §4).
// Press edges stay latched until a step consumes them (so a frame with zero steps never loses a
// press); a press is also reported as held on the step that consumes it (a quick click still grabs).
// Window blur clears every held key. The DOM part (attachDom) is separate from the pure latch so the
// latch can be driven by scripts, bots and tests.
import type { InputFrame } from "../sim/player.ts";
import { recFromInput, type InputRec } from "../game/ghost.ts";

export type Scheme = { easyGrab: boolean };

export class InputLatch {
  readonly keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  lmb = false;
  rmb = false;
  jumpEdge = false;
  webEdge = false;
  /** Web zip press (E / Shift, touch ZIP). */
  zipEdge = false;
  /** Touch: the left-thumb stick (x right, y forward, dead zone applied, |stick| <= 1). */
  stickX = 0;
  stickY = 0;
  /** Touch: WEB button held / look-at-him button held. */
  touchWeb = false;
  touchFace = false;
  /** Easy grab: Space press also counts as a web press (Yoink), Space held = web held. */
  easyGrab = false;
  /** Optional per-step recording (replays / tests). */
  record: InputFrame[] | null = null;
  /** Scripted override (autoplay / bots): when set, replaces DOM input for each consumed step. */
  script: ((frame: InputFrame, stepIndex: number) => void) | null = null;
  private steps = 0;

  press(code: string): void {
    if (this.keys.has(code)) return;
    this.keys.add(code);
    if (code === "Space") {
      this.jumpEdge = true;
      if (this.easyGrab) this.webEdge = true;
    }
    if (code === "KeyE" || code === "ShiftLeft" || code === "ShiftRight") this.zipEdge = true;
  }
  release(code: string): void {
    this.keys.delete(code);
  }
  mouseDown(button: number): void {
    if (button === 0) { this.lmb = true; this.webEdge = true; }
    if (button === 2) this.rmb = true;
  }
  mouseUp(button: number): void {
    if (button === 0) this.lmb = false;
    if (button === 2) this.rmb = false;
  }
  /** Touch stick in unit-radius coordinates: dead zone 0.15, full speed at 0.8. */
  setStick(x: number, y: number): void {
    const l = Math.sqrt(x * x + y * y);
    if (l < 0.15) { this.stickX = this.stickY = 0; return; }
    const k = Math.min(1, (l - 0.15) / 0.65) / l;
    this.stickX = x * k;
    this.stickY = y * k;
  }
  touchWebDown(): void {
    if (!this.touchWeb) { this.touchWeb = true; this.webEdge = true; }
  }
  touchWebUp(): void {
    this.touchWeb = false;
  }
  touchJump(): void {
    this.jumpEdge = true;
  }
  touchZip(): void {
    this.zipEdge = true;
  }
  clear(): void {
    this.keys.clear();
    this.stickX = this.stickY = 0;
    this.touchWeb = this.touchFace = false;
    this.lmb = this.rmb = false;
    this.jumpEdge = this.webEdge = this.zipEdge = false;
    this.mouseDX = this.mouseDY = 0;
  }
  /** Mouse deltas since the last call (applied to the camera once per frame). */
  takeLook(): [number, number] {
    const d: [number, number] = [this.mouseDX, this.mouseDY];
    this.mouseDX = this.mouseDY = 0;
    return d;
  }
  get towardRunner(): boolean {
    return this.keys.has("KeyQ") || this.rmb || this.touchFace;
  }

  private get fwd(): number {
    return (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0) - (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0) + this.stickY;
  }
  private get right(): number {
    return (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0) - (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0) + this.stickX;
  }

  /**
   * The play page's path (ghost-exact): one step as a quantised record (camera yaw, camera-space move,
   * buttons); PlayGame rebuilds the InputFrame from it (game/ghost.ts buildFrame) so a recorded run
   * replays bit-exactly. Consumes the press edges like consume().
   */
  sample(rec: InputRec, yaw: number): InputRec {
    const webHeldNow = this.lmb || this.touchWeb || (this.easyGrab && this.keys.has("Space"));
    recFromInput(rec, yaw, this.fwd, this.right, this.jumpEdge, this.webEdge, webHeldNow || this.webEdge, this.zipEdge);
    this.jumpEdge = false;
    this.webEdge = false;
    this.zipEdge = false;
    this.steps++;
    return rec;
  }

  /**
   * Fill `f` for one fixed step. Move is camera-relative: forward = (-sin yaw, -cos yaw) on xz.
   * `aim` is the camera forward vector.
   */
  consume(f: InputFrame, yawSin: number, yawCos: number, aimX: number, aimY: number, aimZ: number): InputFrame {
    const fwd = this.fwd;
    const right = this.right;
    let mx = -yawSin * fwd + yawCos * right;
    let mz = -yawCos * fwd - yawSin * right;
    const ml = Math.sqrt(mx * mx + mz * mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    f.moveX = mx;
    f.moveZ = mz;
    f.aimX = aimX;
    f.aimY = aimY;
    f.aimZ = aimZ;
    const webHeldNow = this.lmb || this.touchWeb || (this.easyGrab && this.keys.has("Space"));
    f.jumpPressed = this.jumpEdge;
    f.webPressed = this.webEdge;
    f.webHeld = webHeldNow || this.webEdge;
    f.zipPressed = this.zipEdge;
    this.jumpEdge = false;
    this.webEdge = false;
    this.zipEdge = false;
    if (this.script) this.script(f, this.steps);
    this.steps++;
    if (this.record) this.record.push({ ...f });
    return f;
  }
}

/** Wire DOM events into a latch. Returns a detach function. */
export function attachDom(latch: InputLatch, el: HTMLElement, onLockChange?: (locked: boolean) => void): () => void {
  const kd = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    latch.press(e.code);
  };
  const ku = (e: KeyboardEvent) => latch.release(e.code);
  const md = (e: MouseEvent) => {
    if (document.pointerLockElement !== el) return;
    latch.mouseDown(e.button);
  };
  const mu = (e: MouseEvent) => latch.mouseUp(e.button);
  const mm = (e: MouseEvent) => {
    if (document.pointerLockElement !== el) return;
    latch.mouseDX += e.movementX;
    latch.mouseDY += e.movementY;
  };
  const blur = () => latch.clear();
  const lock = () => {
    const locked = document.pointerLockElement === el;
    if (!locked) latch.clear();
    onLockChange?.(locked);
  };
  const ctx = (e: Event) => e.preventDefault();
  addEventListener("keydown", kd);
  addEventListener("keyup", ku);
  addEventListener("mousedown", md);
  addEventListener("mouseup", mu);
  addEventListener("mousemove", mm);
  addEventListener("blur", blur);
  addEventListener("contextmenu", ctx);
  document.addEventListener("pointerlockchange", lock);
  return () => {
    removeEventListener("keydown", kd);
    removeEventListener("keyup", ku);
    removeEventListener("mousedown", md);
    removeEventListener("mouseup", mu);
    removeEventListener("mousemove", mm);
    removeEventListener("blur", blur);
    removeEventListener("contextmenu", ctx);
    document.removeEventListener("pointerlockchange", lock);
  };
}
