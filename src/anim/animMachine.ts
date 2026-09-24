// Sim state -> Animator commands (spec §9). Pure TS (no three.js): the view feeds it one frame of
// state (grounded / rope / speed / event bits / round beat) and applies the returned command to its
// AnimPlayer. Animation never gates gameplay: nothing here feeds back into the sim.

export const A_JUMP = 1;
export const A_ATTACH = 2;
export const A_RELEASE = 4;
export const A_LAND = 8;
export const A_BONK = 16;

/** Scripted beats that override locomotion (countdown wave, taunt, catch, escape, results). */
export type Beat = "" | "wave" | "taunt" | "cheer" | "flop" | "waltz" | "fish" | "rug" | "idle";

export type AnimInput = {
  dt: number;
  grounded: boolean;
  rope: boolean;
  /** Horizontal speed, m/s. */
  speed: number;
  vy: number;
  /** A_* bits seen this frame. */
  events: number;
  /** v.y at the last landing (roll on hard landings). */
  landVy: number;
  /** Runner panic: sprint clip on the ground. */
  panic: boolean;
  beat: Beat;
};

export type AnimCmd =
  | { kind: "base"; clip: string; fade: number; scale: number }
  | { kind: "force"; clip: string; fade: number; scale: number }
  | { kind: "shot"; clip: string; fade: number; startAt: number; hold: boolean; then: string };

export type ClipInfo = { has(name: string): boolean; takeoffAt(name: string): number };

export const CLIP = {
  idle: "Idle",
  walk: "Casual_Walk",
  run: "Run_02",
  sprint: "Lean_Forward_Sprint",
  jump: "Run_and_Jump",
  fall: "Fall_1",
  grab: "Grab_Bar_and_Swing_Forward",
  hang: "Rope_Hang_Idle",
  leap: "Leap_of_Faith",
  roll: "Roll_Dodge",
  wave: "Big_Wave_Hello",
  cheer: "Victory_Cheer",
  flop: "Falling_Down",
  fish: "Fishing_Cast",
  waltz: "Waltz",
} as const;

const RULE = {
  walkAbove: 0.5,
  runAbove: 5,
  sprintAbove: 11,
  airFallAfter: 0.6,
  airFallVy: -8,
  rollBelowVy: -14,
  landFade: 0.12,
  grabFor: 0.85,
  leapFor: 1.4,
  jumpFor: 0.6,
} as const;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class AnimMachine {
  readonly clips: ClipInfo;
  /** Clip last commanded (base or shot). */
  clip = "";
  shot = "";
  shotT = 0;
  airT = 0;
  beat: Beat = "";
  private base = "";

  constructor(clips: ClipInfo) {
    this.clips = clips;
  }

  /** Pick an available clip (cut-list substitutes when a clip is missing). */
  private pick(name: string): string {
    const c = this.clips;
    if (c.has(name)) return name;
    const sub: Record<string, string[]> = {
      [CLIP.idle]: [CLIP.run],
      [CLIP.leap]: [CLIP.fall],
      [CLIP.wave]: [CLIP.cheer, CLIP.idle],
      [CLIP.flop]: [CLIP.fall],
      [CLIP.roll]: [],
      [CLIP.grab]: [CLIP.hang],
      [CLIP.hang]: [CLIP.fall],
      [CLIP.jump]: ["Regular_Jump", CLIP.fall],
      [CLIP.sprint]: [CLIP.run],
      [CLIP.fish]: [CLIP.idle],
      [CLIP.waltz]: [CLIP.idle],
      [CLIP.cheer]: [CLIP.idle],
    };
    for (const s of sub[name] ?? []) if (c.has(s)) return s;
    return "";
  }

  /** Locomotion base for this frame and its playback rate. */
  private locomotion(i: AnimInput): [string, number] {
    if (i.rope) return [this.pick(CLIP.hang), 1];
    if (!i.grounded) return [this.pick(CLIP.fall), 1];
    const s = i.speed;
    if (s < RULE.walkAbove) return [this.pick(CLIP.idle), 1];
    if (i.panic || s > RULE.sprintAbove) return [this.pick(CLIP.sprint), clamp(s / 10, 0.85, 1.3)];
    if (s < RULE.runAbove) return [this.pick(CLIP.walk), clamp(s / 1.6, 0.7, 1.6)];
    return [this.pick(CLIP.run), clamp(s / 9, 0.8, 1.4)];
  }

  private startShot(name: string, then: string, startAt = 0, fade = 0.15, hold = false): AnimCmd | null {
    const clip = this.pick(name);
    if (!clip) return null;
    this.shot = clip;
    this.shotT = 0;
    this.clip = clip;
    return { kind: "shot", clip, fade, startAt, hold, then };
  }

  private beatCmd(b: Beat, i: AnimInput): AnimCmd | null {
    const [loco] = this.locomotion(i);
    switch (b) {
      case "wave": return this.startShot(CLIP.wave, this.pick(CLIP.idle), 0, 0.2);
      case "taunt": return this.startShot(CLIP.wave, loco, 0, 0.15);
      case "cheer": { this.shot = ""; const c = this.pick(CLIP.cheer); this.clip = c; return { kind: "force", clip: c, fade: 0.25, scale: 1 }; }
      case "flop": return this.startShot(CLIP.flop, "", 0, 0.15, true);
      case "waltz": return this.startShot(CLIP.waltz, "", 0, 0.4, true);
      case "fish": return this.startShot(CLIP.fish, "", 0, 0.3, true);
      case "rug": { this.shot = ""; const c = this.pick(CLIP.cheer); this.clip = c; return { kind: "force", clip: c, fade: 0.3, scale: 1 }; }
      case "idle": { this.shot = ""; const c = this.pick(CLIP.idle); this.clip = c; return { kind: "force", clip: c, fade: 0.3, scale: 1 }; }
      default: return null;
    }
  }

  /** One render frame. Returns at most one command. */
  step(i: AnimInput): AnimCmd | null {
    if (this.shot) this.shotT += i.dt;
    if (!i.grounded && !i.rope) this.airT += i.dt;
    else this.airT = 0;

    // Beats own the character until they end ("" or a change).
    if (i.beat !== this.beat) {
      const was = this.beat;
      this.beat = i.beat;
      if (i.beat) return this.beatCmd(i.beat, i);
      // Beat over: back to locomotion right away.
      if (was) {
        this.shot = "";
        const [loco, scale] = this.locomotion(i);
        this.base = loco;
        this.clip = loco;
        return loco ? { kind: "force", clip: loco, fade: 0.2, scale } : null;
      }
    }
    if (this.beat && this.beat !== "taunt" && this.beat !== "wave") return null;

    const [loco, scale] = this.locomotion(i);
    const ev = i.events;
    // Discrete events (priority: bonk > attach > release > land > jump).
    if (ev & A_BONK) {
      this.shot = "";
      this.clip = loco;
      this.base = loco;
      return { kind: "force", clip: this.pick(CLIP.fall), fade: 0.1, scale: 1 };
    }
    if (ev & A_ATTACH) { this.base = loco; return this.startShot(CLIP.grab, this.pick(CLIP.hang), 0, 0.1); }
    if (ev & A_RELEASE) { this.base = loco; return this.startShot(CLIP.leap, this.pick(CLIP.fall), 0, 0.12); }
    if (ev & A_LAND) {
      this.base = loco;
      if (i.landVy < RULE.rollBelowVy && this.clips.has(CLIP.roll)) return this.startShot(CLIP.roll, loco, 0, 0.08);
      this.shot = "";
      this.clip = loco;
      return { kind: "force", clip: loco, fade: RULE.landFade, scale };
    }
    if (ev & A_JUMP) { this.base = loco; return this.startShot(CLIP.jump, this.pick(CLIP.fall), this.clips.takeoffAt(CLIP.jump), 0.08); }

    // Shot cut-offs.
    if (this.shot) {
      const s = this.shot;
      const air = !i.grounded && !i.rope;
      const cut =
        (s === this.pick(CLIP.jump) && air && (this.airT > RULE.jumpFor || i.vy < RULE.airFallVy)) ||
        (s === this.pick(CLIP.leap) && air && this.shotT > RULE.leapFor) ||
        (s === this.pick(CLIP.grab) && i.rope && this.shotT > RULE.grabFor) ||
        (s === this.pick(CLIP.grab) && !i.rope) ||
        ((s === this.pick(CLIP.jump) || s === this.pick(CLIP.leap)) && (i.grounded || i.rope)) ||
        (s === this.pick(CLIP.wave) && this.beat !== "wave" && this.beat !== "taunt" && i.speed > RULE.walkAbove);
      if (cut) {
        this.shot = "";
        this.clip = loco;
        this.base = loco;
        return { kind: "force", clip: loco, fade: 0.2, scale };
      }
      if (loco !== this.base) { this.base = loco; return { kind: "base", clip: loco, fade: 0.2, scale }; }
      return null;
    }
    // Airborne without a shot: Fall 1 only after 0.6 s or when dropping fast.
    if (!i.grounded && !i.rope && this.airT <= RULE.airFallAfter && i.vy >= RULE.airFallVy && this.clip) {
      return null;
    }
    if (loco !== this.clip || loco !== this.base) {
      this.clip = loco;
      this.base = loco;
      return { kind: "base", clip: loco, fade: 0.2, scale };
    }
    return { kind: "base", clip: loco, fade: 0.2, scale };
  }
}
