// Sim state -> Animator commands (spec §9). Pure TS (no three.js): the view feeds it one frame of
// state (grounded / rope / speed / event bits / round beat) and applies the returned command to its
// AnimPlayer. Animation never gates gameplay: nothing here feeds back into the sim.
//
// Airborne = one upright pose: a jump plays Regular_Jump from its takeoff frame and freezes on its apex
// (arms up, knees tucked) until he lands or grabs a rope; a rope release, a bonk or walking off an edge
// crossfade straight into that apex hold. Hard landings play Regular_Jump's landing crouch
// (CLIP.land, the same clip with the hips' height kept) for a moment. The Meshy airborne clips all read
// as dives (Run_and_Jump = front flip, Fall_1 = belly-down skydive, Leap_of_Faith = swan dive), so
// they are only cut-list fallbacks now.
//
// Round 7 free fall: a long drop (falling fast, or high above the ground below while descending)
// crossfades from the apex hold into Free_Fall, an upright loop (treading air: arms sculling, legs
// kicking); a rope grab cancels it. Landing after a real free fall (or very fast) plays Big_Land, a
// feet-first superhero crouch (t = 0 is ground contact), cut short when he runs on. Without the clips
// the apex hold / landing crouch stay.

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
  /** Feet height above the ground straight below (m; round 7 free fall). Missing = unknown (vy only). */
  clearance?: number;
  /** Runner panic: sprint clip on the ground. */
  panic: boolean;
  beat: Beat;
};

export type AnimCmd =
  | { kind: "base"; clip: string; fade: number; scale: number }
  | { kind: "force"; clip: string; fade: number; scale: number }
  /** One-shot; `freezeAt` pauses it on that clip time (a hold until the next command). */
  | { kind: "shot"; clip: string; fade: number; startAt: number; hold: boolean; then: string; freezeAt?: number };

/** Clip timings (clips.meta.json): Regular_Jump's takeoff / apex / land, seconds into the clip. */
export type ClipInfo = { has(name: string): boolean; takeoffAt(name: string): number; apexAt(name: string): number; landAt(name: string): number };

export const CLIP = {
  idle: "Idle",
  walk: "Casual_Walk",
  run: "Run_02",
  sprint: "Lean_Forward_Sprint",
  jump: "Regular_Jump",
  /** Regular_Jump registered a second time with the hips' height kept (AnimPlayer policy): landing crouch. */
  land: "Regular_Jump_Land",
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
  /** Round 7: upright airborne loop for long drops, and the big feet-first landing after one. */
  freefall: "Free_Fall",
  bigLand: "Big_Land",
} as const;

const RULE = {
  walkAbove: 0.5,
  runAbove: 5,
  sprintAbove: 11,
  /** Airborne without a jump (walked off an edge): apex hold after this long or when dropping this fast. */
  airHoldAfter: 0.25,
  airHoldVy: -5,
  /** Rope release / bonk crossfade into the apex hold. */
  airFade: 0.1,
  /** Hard landing: Regular_Jump's landing crouch below this v.y, for landFor seconds. */
  hardBelowVy: -14,
  landFor: 0.3,
  landFade: 0.12,
  grabFor: 0.85,
  /**
   * Free fall: airborne and falling faster than ffVy with at least ffNear m of air below, or descending
   * (vy < ffDescend) with more than ffFar m below; crossfade ffFade.
   */
  ffVy: -9,
  ffNear: 4,
  ffDescend: -3,
  ffFar: 6,
  ffFade: 0.25,
  /** Big landing after >= bigAfterFF s of free fall or below bigVy; cut after bigMove s when running on, else bigFor. */
  bigAfterFF: 0.35,
  bigVy: -17,
  bigFade: 0.06,
  bigMove: 0.5,
  bigFor: 1.4,
} as const;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class AnimMachine {
  readonly clips: ClipInfo;
  /** Clip last commanded (base or shot). */
  clip = "";
  shot = "";
  shotT = 0;
  airT = 0;
  /** Round 7: in the free-fall loop, for how long, and the lowest v.y of this airborne spell. */
  ff = false;
  ffT = 0;
  minVy = 0;
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
      [CLIP.wave]: [CLIP.cheer, CLIP.idle],
      [CLIP.flop]: [CLIP.fall],
      [CLIP.land]: [],
      [CLIP.grab]: [CLIP.hang],
      [CLIP.hang]: [CLIP.jump, CLIP.fall],
      [CLIP.jump]: [CLIP.fall],
      [CLIP.sprint]: [CLIP.run],
      [CLIP.fish]: [CLIP.idle],
      [CLIP.waltz]: [CLIP.idle],
      [CLIP.cheer]: [CLIP.idle],
      [CLIP.freefall]: [],
      [CLIP.bigLand]: [],
    };
    for (const s of sub[name] ?? []) if (c.has(s)) return s;
    return "";
  }

  /** Locomotion base for this frame and its playback rate (airborne: the apex hold's clip). */
  private locomotion(i: AnimInput): [string, number] {
    if (i.rope) return [this.pick(CLIP.hang), 1];
    if (!i.grounded) return [this.pick(CLIP.jump), 1];
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

  /**
   * Airborne pose: Regular_Jump frozen on its apex (from the takeoff frame on a jump, straight onto the
   * apex otherwise). Without Regular_Jump: the cut-list fallback as a plain loop.
   */
  private air(fade: number, fromTakeoff = false): AnimCmd | null {
    this.ff = false;
    const clip = this.pick(CLIP.jump);
    if (clip !== CLIP.jump) {
      this.shot = "";
      this.clip = this.base = clip;
      return clip ? { kind: "force", clip, fade, scale: 1 } : null;
    }
    const apex = this.clips.apexAt(clip);
    const cmd = this.startShot(clip, "", fromTakeoff ? Math.min(this.clips.takeoffAt(clip), apex) : apex, fade, true);
    return cmd && cmd.kind === "shot" ? { ...cmd, freezeAt: apex } : cmd;
  }

  /** Is this airborne frame a free fall (long drop ahead)? */
  private falling(i: AnimInput): boolean {
    const c = i.clearance ?? Infinity;
    return (i.vy < RULE.ffVy && c > RULE.ffNear) || (i.vy < RULE.ffDescend && c > RULE.ffFar);
  }

  /** Crossfade into the free-fall loop. */
  private freefall(): AnimCmd | null {
    const clip = this.pick(CLIP.freefall);
    if (!clip) return null;
    this.ff = true;
    this.ffT = 0;
    this.shot = "";
    this.clip = this.base = clip;
    return { kind: "force", clip, fade: RULE.ffFade, scale: 1 };
  }

  /** Back to locomotion now (a force), or the apex hold when airborne. */
  private toLoco(i: AnimInput, fade: number): AnimCmd | null {
    this.ff = false;
    if (!i.grounded && !i.rope) return this.air(Math.min(fade, RULE.airFade));
    const [loco, scale] = this.locomotion(i);
    this.shot = "";
    this.clip = loco;
    this.base = loco;
    return loco ? { kind: "force", clip: loco, fade, scale } : null;
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
    const airNow = !i.grounded && !i.rope;
    if (airNow) { this.airT += i.dt; if (i.vy < this.minVy) this.minVy = i.vy; if (this.ff) this.ffT += i.dt; }
    else this.airT = 0;
    // What the fall was (read by the landing below), then reset for the next airborne spell.
    const wasFF = this.ff && !airNow ? this.ffT : 0, fallVy = airNow ? 0 : this.minVy;
    if (!airNow) { this.ff = false; this.ffT = 0; this.minVy = 0; }
    if (i.rope) this.ff = false;

    // Beats own the character until they end ("" or a change).
    if (i.beat !== this.beat) {
      const was = this.beat;
      this.beat = i.beat;
      if (i.beat) return this.beatCmd(i.beat, i);
      // Beat over: back to locomotion right away.
      if (was) return this.toLoco(i, 0.2);
    }
    if (this.beat && this.beat !== "taunt" && this.beat !== "wave") return null;

    const [loco, scale] = this.locomotion(i);
    const air = !i.grounded && !i.rope;
    const ev = i.events;
    // Discrete events (priority: bonk > attach > release > land > jump).
    if (ev & A_BONK) return air ? this.air(RULE.airFade) : this.toLoco(i, 0.1);
    if (ev & A_ATTACH) { this.base = loco; return this.startShot(CLIP.grab, this.pick(CLIP.hang), 0, 0.1); }
    if ((ev & A_RELEASE) && air) return this.air(RULE.airFade);
    if ((ev & A_LAND) && i.grounded) {
      this.base = loco;
      const vy = i.landVy !== 0 ? i.landVy : fallVy; // the runner has no sim landVy: his fall speed
      if ((wasFF >= RULE.bigAfterFF || vy < RULE.bigVy) && this.clips.has(CLIP.bigLand)) return this.startShot(CLIP.bigLand, loco, 0, RULE.bigFade);
      if (vy < RULE.hardBelowVy && this.clips.has(CLIP.land)) return this.startShot(CLIP.land, loco, this.clips.landAt(CLIP.jump), 0.08);
      return this.toLoco(i, RULE.landFade);
    }
    if ((ev & A_JUMP) && air) return this.air(0.08, true);
    // Free fall: once the drop is long, from the apex hold (or the stride) into the upright loop.
    if (air) {
      if (this.ff) return null;
      if (this.falling(i) && this.pick(CLIP.freefall)) return this.freefall();
    }

    // Shot cut-offs.
    if (this.shot) {
      const s = this.shot;
      const cut =
        (s === CLIP.jump && !air) ||
        (s === CLIP.land && (!i.grounded || this.shotT > RULE.landFor)) ||
        (s === CLIP.bigLand && (!i.grounded || this.shotT > RULE.bigFor || (this.shotT > RULE.bigMove && i.speed > RULE.walkAbove))) ||
        (s === this.pick(CLIP.grab) && i.rope && this.shotT > RULE.grabFor) ||
        (s === this.pick(CLIP.grab) && !i.rope) ||
        (s === this.pick(CLIP.wave) && this.beat !== "wave" && this.beat !== "taunt" && i.speed > RULE.walkAbove);
      if (cut) return this.toLoco(i, 0.2);
      if (loco !== this.base && !air) { this.base = loco; return { kind: "base", clip: loco, fade: 0.2, scale }; }
      return null;
    }
    // Airborne without a shot (walked off an edge): keep the stride for a moment, then the apex hold.
    if (air) {
      if (this.clip === loco || (this.clip && this.airT <= RULE.airHoldAfter && i.vy >= RULE.airHoldVy)) return null;
      return this.air(0.2);
    }
    if (loco !== this.clip || loco !== this.base) {
      this.clip = loco;
      this.base = loco;
      return { kind: "base", clip: loco, fade: 0.2, scale };
    }
    return { kind: "base", clip: loco, fade: 0.2, scale };
  }
}
