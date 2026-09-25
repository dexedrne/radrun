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
//
// Round 9 parkour (spec §7). The bought clips (game-clips/round9, all one-shots): wall run = Wall_Run (wall on
// his left) / Wall_Run_Mirror (right) once, then Run_02 rolled toward the wall; run-up = Wall_Run_Up over the
// run-up's time; ledge grab = Ledge_Grab held on its hang frame; ledge climb = Ledge_Climb up to its stand frame
// over the climb's time (the view keeps the root at the rim); vault = Vault from its takeoff; slide = Slide held
// in the slide; landing roll = Land_Roll from its roll over the roll's time. While one plays, `posed` is set
// and the view drops its procedural roll / pitch. Without a clip the procedural fallbacks stay: wall run =
// Run_02 at speed / 9 (the view rolls the root toward the wall; run-up: pitched back), wall jump / vault =
// Regular_Jump from takeoff at 1.3 / 1.6 x into the apex hold, ledge hang = Rope_Hang_Idle, ledge climb =
// Regular_Jump takeoff -> apex at 2.2 x, slide = Big_Land frozen at its deepest crouch (the view pitches the
// root back), landing roll = Big_Land cut at 0.35 s, stumble = Big_Land.

export const A_JUMP = 1;
export const A_ATTACH = 2;
export const A_RELEASE = 4;
export const A_LAND = 8;
export const A_BONK = 16;
/** Double jump: Regular_Jump again from its takeoff frame, played quicker, into the same apex hold. */
export const A_DJUMP = 32;
/** Round 9 parkour events. */
export const A_WALLRUN = 64;
export const A_WALLJUMP = 128;
export const A_LEDGE = 256;
export const A_CLIMB = 512;
export const A_VAULT = 1024;
export const A_SLIDE = 2048;
export const A_ROLL = 4096;
export const A_BIGLAND = 8192;

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
  /** Round 9: wall mode (1 wall run, 2 run-up), ledge mode (1 hang, 2+ climb), sliding. Missing = none. */
  wall?: number;
  ledge?: number;
  slide?: boolean;
  /** Round 9 wall run: 1 = the wall is on his left, -1 = on his right (picks Wall_Run / Wall_Run_Mirror). */
  wallSide?: number;
};

export type AnimCmd =
  | { kind: "base"; clip: string; fade: number; scale: number }
  | { kind: "force"; clip: string; fade: number; scale: number }
  /** One-shot; `freezeAt` pauses it on that clip time (a hold until the next command). */
  | { kind: "shot"; clip: string; fade: number; startAt: number; hold: boolean; then: string; freezeAt?: number; rate?: number };

/**
 * Clip timings (clips.meta.json): Regular_Jump's takeoff / apex / land, seconds into the clip; `at` = any
 * other measured key (duration, hangAt, slideTo, standAt, rollFrom; round 9), undefined when missing.
 */
export type ClipInfo = {
  has(name: string): boolean; takeoffAt(name: string): number; apexAt(name: string): number; landAt(name: string): number;
  at?(name: string, key: string): number | undefined;
};

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
  /** Round 9 parkour clips (one-shots). */
  wallRunUp: "Wall_Run_Up",
  wallRunL: "Wall_Run",
  wallRunR: "Wall_Run_Mirror",
  ledgeGrab: "Ledge_Grab",
  ledgeClimb: "Ledge_Climb",
  vault: "Vault",
  slide: "Slide",
  landRoll: "Land_Roll",
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
  /** Double jump: the takeoff -> apex part of Regular_Jump at this rate (a quick upright tuck). */
  djumpRate: 1.4,
  /** Round 9 fallbacks: wall jump / vault / ledge climb rates, the slide's frozen crouch, the roll's cut. */
  wallJumpRate: 1.3,
  vaultRate: 1.6,
  climbRate: 2.2,
  slideFreeze: 0.3,
  rollFor: 0.35,
  /**
   * Round 9 clips, timed to the sim's defaults: the run-up (wallClimbTime), the ledge climb (ledgeClimbTime), the
   * roll (rollTime); the grab starts this far before its hang frame (ledgeHang); the vault's playback rate.
   */
  runUpFor: 0.6,
  climbFor: 0.35,
  rollClipFor: 0.45,
  grabLead: 0.2,
  vaultClipRate: 1.4,
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
  /** Round 9: the special pose a Big_Land / jump shot is standing in for ("slide", "roll", "climb"), and the last ledge mode. */
  special = "";
  /** Round 9: the special shot is a bought parkour clip (see `posed`). */
  private pz = false;
  /** Round 9: the current special shot's cut time (s, 0 = none). */
  private cutAt = 0;
  private ledge = 0;
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
    if (i.rope || i.ledge === 1) return [this.pick(CLIP.hang), 1];
    if (i.wall) return [this.pick(CLIP.run), clamp(i.speed / 9, 0.8, 1.6)];
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
    this.pz = false;
    this.cutAt = 0;
    return { kind: "shot", clip, fade, startAt, hold, then };
  }

  /** Round 9: a bought parkour clip owns the pose right now (the view drops its procedural roll / pitch). */
  get posed(): boolean {
    return this.pz && this.special !== "";
  }

  private at(name: string, key: string): number | undefined {
    return this.clips.at?.(name, key);
  }

  /**
   * Round 9: a bought parkour clip as a special shot (null when the pack lacks it: the caller's fallback runs).
   * rate / freezeAt / cutAt as given; `posed` is set while it plays.
   */
  private parkour(name: string, special: string, o: { then?: string; startAt?: number; fade?: number; hold?: boolean; rate?: number; freezeAt?: number; cutAt?: number }): AnimCmd | null {
    if (!this.clips.has(name)) return null;
    const cmd = this.startShot(name, o.then ?? "", o.startAt ?? 0, o.fade ?? 0.08, o.hold ?? false);
    if (!cmd || cmd.kind !== "shot") return cmd;
    this.special = special;
    this.pz = true;
    this.cutAt = o.cutAt ?? 0;
    return { ...cmd, ...(o.rate !== undefined && o.rate !== 1 ? { rate: o.rate } : {}), ...(o.freezeAt !== undefined ? { freezeAt: o.freezeAt } : {}) };
  }

  /**
   * Airborne pose: Regular_Jump frozen on its apex (from the takeoff frame on a jump, straight onto the
   * apex otherwise). Without Regular_Jump: the cut-list fallback as a plain loop.
   */
  private air(fade: number, fromTakeoff = false, rate = 1): AnimCmd | null {
    this.ff = false;
    const clip = this.pick(CLIP.jump);
    if (clip !== CLIP.jump) {
      this.shot = "";
      this.clip = this.base = clip;
      return clip ? { kind: "force", clip, fade, scale: 1 } : null;
    }
    const apex = this.clips.apexAt(clip);
    const cmd = this.startShot(clip, "", fromTakeoff ? Math.min(this.clips.takeoffAt(clip), apex) : apex, fade, true);
    return cmd && cmd.kind === "shot" ? { ...cmd, freezeAt: apex, ...(rate !== 1 ? { rate } : {}) } : cmd;
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
    this.special = "";
    this.clip = this.base = clip;
    return { kind: "force", clip, fade: RULE.ffFade, scale: 1 };
  }

  /** Back to locomotion now (a force), or the apex hold when airborne. */
  private toLoco(i: AnimInput, fade: number): AnimCmd | null {
    this.ff = false;
    this.special = "";
    if (!i.grounded && !i.rope && !i.wall && !i.ledge) return this.air(Math.min(fade, RULE.airFade));
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

  /** Slide / landing roll: the bought clip (Slide held in the slide, Land_Roll over the roll), else Big_Land. */
  private crouch(kind: "slide" | "roll", loco: string): AnimCmd | null {
    if (kind === "slide") {
      const to = this.at(CLIP.slide, "slideTo");
      const c = this.parkour(CLIP.slide, "slide", { hold: true, fade: 0.06, ...(to !== undefined ? { freezeAt: to } : {}) });
      if (c) return c;
    } else {
      const from = this.at(CLIP.landRoll, "rollFrom") ?? 0, stand = this.at(CLIP.landRoll, "standAt");
      const c = this.parkour(CLIP.landRoll, "roll", {
        then: loco, startAt: from, fade: 0.05, cutAt: RULE.rollClipFor, ...(stand !== undefined ? { rate: (stand - from) / RULE.rollClipFor } : {}),
      });
      if (c) return c;
    }
    const big = this.clips.has(CLIP.bigLand);
    const clip = big ? CLIP.bigLand : this.clips.has(CLIP.land) ? CLIP.land : "";
    if (!clip) return null;
    const start = big ? 0 : this.clips.landAt(CLIP.jump);
    const cmd = this.startShot(clip, kind === "roll" ? loco : "", start, 0.06, kind === "slide");
    this.special = kind;
    return cmd && cmd.kind === "shot" && kind === "slide" ? { ...cmd, freezeAt: start + RULE.slideFreeze } : cmd;
  }

  /** One render frame. Returns at most one command. */
  step(i: AnimInput): AnimCmd | null {
    if (this.shot) this.shotT += i.dt;
    const wall = i.wall ?? 0, ledge = i.ledge ?? 0;
    const airNow = !i.grounded && !i.rope && !wall && !ledge;
    if (airNow) { this.airT += i.dt; if (i.vy < this.minVy) this.minVy = i.vy; if (this.ff) this.ffT += i.dt; }
    else this.airT = 0;
    // What the fall was (read by the landing below), then reset for the next airborne spell.
    const wasFF = this.ff && !airNow ? this.ffT : 0, fallVy = airNow ? 0 : this.minVy;
    if (!airNow) { this.ff = false; this.ffT = 0; this.minVy = 0; }
    if (i.rope || wall || ledge) this.ff = false;
    const ledgeWas = this.ledge;
    this.ledge = ledge;

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
    const air = airNow;
    const ev = i.events;
    // Discrete events (priority: bonk > attach > ledge > climb > wall jump > wall run > release > vault >
    // stumble / roll / land > slide > jump).
    if (ev & A_BONK) return air ? this.air(RULE.airFade) : this.toLoco(i, 0.1);
    if (ev & A_ATTACH) { this.base = loco; this.special = ""; return this.startShot(CLIP.grab, this.pick(CLIP.hang), 0, 0.1); }
    if ((ev & A_LEDGE) || (ledge === 1 && ledgeWas !== 1)) {
      // Ledge_Grab from just before its hang frame, held there (clamped on its last frame).
      const hang = this.at(CLIP.ledgeGrab, "hangAt") ?? 0;
      const g = this.parkour(CLIP.ledgeGrab, "grab", { hold: true, startAt: Math.max(0, hang - RULE.grabLead) });
      if (g) return g;
      this.shot = ""; this.special = ""; const c = this.pick(CLIP.hang); this.clip = this.base = c; return c ? { kind: "force", clip: c, fade: 0.1, scale: 1 } : null;
    }
    if (ledge >= 2 && ledgeWas < 2) {
      // Ledge_Climb up to its stand frame over the climb's time (the view holds the root at the rim).
      const stand = this.at(CLIP.ledgeClimb, "standAt");
      const m = stand !== undefined ? this.parkour(CLIP.ledgeClimb, "mantle", { hold: true, fade: 0.06, rate: stand / RULE.climbFor, freezeAt: stand }) : null;
      if (m) return m;
      // Climb: the jump's takeoff -> apex, quick, while the root follows the sim path.
      const cmd = this.air(0.08, true, RULE.climbRate);
      this.special = "climb";
      return cmd;
    }
    if (ev & A_CLIMB) return i.grounded ? this.toLoco(i, 0.12) : this.air(0.06, true, RULE.wallJumpRate);
    if (ev & A_WALLJUMP) return this.air(0.06, true, RULE.wallJumpRate);
    if ((ev & A_WALLRUN) && wall) {
      // Run-up: Wall_Run_Up over the run-up's time, held on its last frame; wall run: Wall_Run (wall on his
      // left) / Wall_Run_Mirror once, then the rolled run.
      if (wall === 2) {
        const d = this.at(CLIP.wallRunUp, "duration");
        const c = this.parkour(CLIP.wallRunUp, "runup", { hold: true, ...(d !== undefined ? { rate: d / RULE.runUpFor } : {}) });
        if (c) return c;
      } else {
        const name = (i.wallSide ?? 1) < 0 ? CLIP.wallRunR : CLIP.wallRunL;
        const c = this.parkour(name, "wallrun", { then: loco, cutAt: this.at(name, "duration") ?? 0.5 });
        if (c) return c;
      }
      this.shot = ""; this.special = ""; this.clip = this.base = loco; return loco ? { kind: "force", clip: loco, fade: 0.1, scale } : null;
    }
    if ((ev & A_RELEASE) && air) return this.air(RULE.airFade);
    if (ev & A_VAULT) {
      // Vault from its takeoff frame; it runs through its own landing, then back to the run.
      const t0 = this.clips.takeoffAt(CLIP.vault), land = this.clips.landAt(CLIP.vault);
      const v = this.parkour(CLIP.vault, "vault", { then: loco, startAt: t0, fade: 0.06, rate: RULE.vaultClipRate, cutAt: Math.max(0.2, (land - t0) / RULE.vaultClipRate + 0.1) });
      if (v) return v;
      return this.air(0.06, true, RULE.vaultRate);
    }
    // The vault clip lands by itself (its landing crouch), so a landing never cuts it short.
    if ((ev & A_LAND) && i.grounded && this.special === "vault" && this.shotT < this.cutAt) return null;
    if ((ev & A_BIGLAND) && i.grounded && this.clips.has(CLIP.bigLand)) { this.base = loco; this.special = ""; return this.startShot(CLIP.bigLand, loco, 0, RULE.bigFade); }
    if ((ev & A_ROLL) && i.grounded) { this.base = loco; return this.crouch("roll", loco); }
    if ((ev & A_LAND) && i.grounded) {
      this.base = loco;
      this.special = "";
      if (i.slide) return this.crouch("slide", loco);
      const vy = i.landVy !== 0 ? i.landVy : fallVy; // the runner has no sim landVy: his fall speed
      if ((wasFF >= RULE.bigAfterFF || vy < RULE.bigVy) && this.clips.has(CLIP.bigLand)) return this.startShot(CLIP.bigLand, loco, 0, RULE.bigFade);
      if (vy < RULE.hardBelowVy && this.clips.has(CLIP.land)) return this.startShot(CLIP.land, loco, this.clips.landAt(CLIP.jump), 0.08);
      return this.toLoco(i, RULE.landFade);
    }
    if (((ev & A_SLIDE) || (i.slide && this.special !== "slide")) && i.grounded && i.slide) return this.crouch("slide", loco);
    if ((ev & A_DJUMP) && air) return this.air(0.06, true, RULE.djumpRate);
    if ((ev & A_JUMP) && air) return this.air(0.08, true);
    // Wall / ledge states own the pose while they last (the run clip / the hang); a bought clip plays out first.
    if (wall || ledge === 1) {
      const sp = this.special;
      if ((sp === "grab" && ledge === 1) || (sp === "runup" && wall === 2) || (sp === "wallrun" && wall === 1 && this.shotT < this.cutAt)) return null;
      if (this.clip !== loco || this.shot) { this.shot = ""; this.special = ""; this.clip = this.base = loco; return loco ? { kind: "force", clip: loco, fade: 0.12, scale } : null; }
      if (wall) return { kind: "base", clip: loco, fade: 0.2, scale };
      return null;
    }
    if (ledge >= 2) return null;
    // Free fall: once the drop is long, from the apex hold (or the stride) into the upright loop.
    if (air) {
      if (this.ff) return null;
      if (this.falling(i) && this.pick(CLIP.freefall)) return this.freefall();
    }

    // Shot cut-offs.
    if (this.shot) {
      const s = this.shot;
      const sp = this.special;
      const cut =
        (sp === "slide" && (!i.slide || !i.grounded)) ||
        (sp === "roll" && (!i.grounded || this.shotT > (this.cutAt || RULE.rollFor))) ||
        ((sp === "climb" || sp === "mantle") && !air && !ledge) ||
        (sp === "mantle" && air) ||
        ((sp === "runup" || sp === "wallrun" || sp === "grab") && !wall && !ledge) ||
        (sp === "vault" && this.shotT > this.cutAt) ||
        (sp === "" && s === CLIP.jump && !air) ||
        (sp === "" && s === CLIP.land && (!i.grounded || this.shotT > RULE.landFor)) ||
        (sp === "" && s === CLIP.bigLand && (!i.grounded || this.shotT > RULE.bigFor || (this.shotT > RULE.bigMove && i.speed > RULE.walkAbove))) ||
        (s === this.pick(CLIP.grab) && i.rope && this.shotT > RULE.grabFor) ||
        (s === this.pick(CLIP.grab) && !i.rope) ||
        (s === this.pick(CLIP.wave) && this.beat !== "wave" && this.beat !== "taunt" && i.speed > RULE.walkAbove);
      if (cut) return this.toLoco(i, 0.2);
      if (sp === "slide" || sp === "roll") return null;
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
