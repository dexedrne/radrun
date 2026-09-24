// AnimPlayer: the Animator core (spec §9) as a plain class, shared by the r3g Animator component and
// the in-game characters. Own AnimationMixer on a SkeletonUtils clone, crossfades, one-shots that
// return to the base loop, clip libraries merged by name, plus the §9 additions:
//  - startAt(seconds) on play (e.g. Regular_Jump starts at its takeoff frame), freezeAt(seconds) to
//    pause a one-shot on one pose (Regular_Jump's apex is the airborne hold),
//  - a per-clip root policy {xz: keep | pin, y: keep | pin} applied once to the root bone's
//    position track (pin = hold the clip's first key; a first key far from the standing reference,
//    like Leap_of_Faith's 14 m start, pins to the reference instead); `alias` registers a clip a second
//    time under another name (its own policy, e.g. Regular_Jump's landing crouch with the hips' height kept),
//  - no own frame loop: the owner calls update(dt) at the Animator priority (FRAME.animator).
import {
  AnimationMixer, LoopOnce, LoopRepeat, VectorKeyframeTrack,
  type AnimationAction, type AnimationClip, type Object3D,
} from "three";

export type RootPolicy = { xz: "keep" | "pin"; y: "keep" | "pin" };

export type PlayOptions = {
  /** Play once, hold the last frame, then crossfade to `then` (default: the base loop). */
  once?: boolean;
  then?: string;
  fade?: number;
  timeScale?: number;
  /** Start this many seconds into the clip. */
  startAt?: number;
  /** One-shot that holds its last frame forever (no return). */
  hold?: boolean;
  /** Pause the action once it reaches this clip time (stays on that pose until the next play). */
  freezeAt?: number;
};

export type AnimPlayerOptions = {
  rootBone?: string;
  fade?: number;
  policy?: (clip: string) => RootPolicy | undefined;
  /** Standing root position (parent space) used when a pinned first key is far off. */
  reference?: [number, number, number];
  /** Extra names for clips: { alias: source clip }. */
  alias?: Record<string, string>;
  onFinished?: (clip: string, next: string) => void;
};

/** Copy of `clip` with the root bone's position pinned on the policy's axes. */
export function applyRootPolicy(clip: AnimationClip, policy: RootPolicy, rootBone = "Hips", ref?: [number, number, number]): AnimationClip {
  if (policy.xz === "keep" && policy.y === "keep") return clip;
  const out = clip.clone();
  for (const track of out.tracks) {
    if (track.name !== `${rootBone}.position` || !(track instanceof VectorKeyframeTrack)) continue;
    const v = track.values;
    const first = [v[0], v[1], v[2]];
    const pin = first.map((f, k) => (ref && Math.abs(f - ref[k]) > 0.5 ? ref[k] : f));
    for (let i = 0; i < v.length; i += 3) {
      if (policy.xz === "pin") { v[i] = pin[0]; v[i + 2] = pin[2]; }
      if (policy.y === "pin") v[i + 1] = pin[1];
    }
  }
  return out;
}

export class AnimPlayer {
  readonly root: Object3D;
  readonly mixer: AnimationMixer;
  readonly clips = new Map<string, AnimationClip>();
  private readonly opts: AnimPlayerOptions;
  private cur: AnimationAction | null = null;
  private pending: { action: AnimationAction; then: string } | null = null;
  private held = false;
  private freeze: { action: AnimationAction; at: number } | null = null;
  base = "";

  constructor(root: Object3D, clipSets: readonly (readonly AnimationClip[])[], opts: AnimPlayerOptions = {}) {
    this.root = root;
    this.opts = opts;
    this.mixer = new AnimationMixer(root);
    const bone = opts.rootBone ?? "Hips";
    // The first set wins on name collisions (the model's own clips, then libraries).
    for (const set of clipSets) for (const c of set) {
      if (this.clips.has(c.name)) continue;
      const pol = opts.policy?.(c.name);
      this.clips.set(c.name, pol ? applyRootPolicy(c, pol, bone, opts.reference) : c);
    }
    for (const [name, from] of Object.entries(opts.alias ?? {})) {
      const src = clipSets.flat().find(c => c.name === from);
      if (!src || this.clips.has(name)) continue;
      const c = src.clone();
      c.name = name;
      const pol = opts.policy?.(name);
      this.clips.set(name, pol ? applyRootPolicy(c, pol, bone, opts.reference) : c);
    }
    this.mixer.addEventListener("finished", e => {
      const p = this.pending;
      if (!p || (e as unknown as { action: AnimationAction }).action !== p.action) return;
      this.pending = null;
      const clip = p.action.getClip().name;
      if (p.then) this.play(p.then);
      this.opts.onFinished?.(clip, p.then);
    });
  }

  has(name: string): boolean {
    return this.clips.has(name);
  }

  get current(): string {
    return this.cur?.getClip().name ?? "";
  }

  /** A one-shot is still running (it will return to the base when it ends). */
  get busy(): boolean {
    return this.pending !== null || this.held;
  }

  action(name: string): AnimationAction | null {
    const c = this.clips.get(name);
    return c ? this.mixer.clipAction(c) : null;
  }

  play(name: string, o: PlayOptions = {}): boolean {
    const next = this.action(name);
    if (!next) return false;
    const fade = Math.max(0, o.fade ?? this.opts.fade ?? 0.2);
    const prev = this.cur;
    const once = Boolean(o.once || o.hold);
    if (!once && next === prev && next.isRunning() && !this.pending && !this.held) {
      if (o.timeScale !== undefined) next.setEffectiveTimeScale(o.timeScale);
      return true;
    }
    next.reset();
    next.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    next.setEffectiveTimeScale(o.timeScale ?? 1).setEffectiveWeight(1);
    if (o.startAt) next.time = Math.min(o.startAt, next.getClip().duration - 1e-3);
    if (prev && prev !== next) {
      if (fade > 0) { prev.fadeOut(fade); next.fadeIn(fade); } else prev.stop();
    }
    this.freeze = o.freezeAt !== undefined ? { action: next, at: Math.min(o.freezeAt, next.getClip().duration - 1e-3) } : null;
    if (this.freeze && next.time >= this.freeze.at) { next.time = this.freeze.at; next.paused = true; }
    next.play();
    this.cur = next;
    this.held = Boolean(o.hold);
    this.pending = o.once && !o.hold ? { action: next, then: o.then ?? this.base } : null;
    return true;
  }

  /** Looping base state; a running one-shot returns to it when it ends. */
  setBase(name: string, fade?: number, timeScale?: number): void {
    this.base = name;
    if (this.pending || this.held) return;
    this.play(name, { fade, timeScale });
  }

  /** Cancel any one-shot / hold and go straight to `name` as the new base. */
  force(name: string, fade?: number, timeScale?: number): void {
    this.pending = null;
    this.held = false;
    this.base = name;
    this.play(name, { fade, timeScale });
  }

  setTimeScale(s: number): void {
    if (this.cur && !this.pending && !this.held) this.cur.setEffectiveTimeScale(s);
  }

  update(dt: number): void {
    // Freeze exactly on the pose (no overshoot frame): clamp before the mixer advances past it.
    const f = this.freeze;
    if (f && !f.action.paused && f.action.time + dt * f.action.getEffectiveTimeScale() >= f.at) {
      f.action.time = f.at;
      f.action.paused = true;
    }
    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.cur = null;
    this.pending = null;
    this.freeze = null;
  }
}
