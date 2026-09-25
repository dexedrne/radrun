// Airborne animation mapping (anim/animMachine.ts): every airborne moment is Regular_Jump's upright
// pose - a jump plays it from the takeoff frame and freezes on the apex, a rope release / walking off
// an edge / a bonk crossfade into that apex hold, a hard landing plays its landing crouch. The dive
// clips (Run_and_Jump, Fall_1, Leap_of_Faith) and Roll_Dodge are never commanded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { A_ATTACH, A_BONK, A_CLIMB, A_DJUMP, A_JUMP, A_LAND, A_LEDGE, A_RELEASE, A_ROLL, A_SLIDE, A_VAULT, A_WALLRUN, AnimMachine, CLIP, type AnimCmd, type AnimInput } from "../src/anim/animMachine.ts";
import CLIP_META from "../src/generated/clips.meta.json" with { type: "json" };

const ALL = ["Idle", "Casual_Walk", "Run_02", "Lean_Forward_Sprint", "Regular_Jump", "Regular_Jump_Land", "Run_and_Jump", "Fall_1",
  "Grab_Bar_and_Swing_Forward", "Rope_Hang_Idle", "Leap_of_Faith", "Roll_Dodge", "Big_Wave_Hello", "Victory_Cheer", "Falling_Down", "Fishing_Cast", "Waltz"];
const DIVES = ["Run_and_Jump", "Fall_1", "Leap_of_Faith", "Roll_Dodge"];
const T = { takeoffAt: 0.5, apexAt: 0.8, landAt: 1.117 };

const machine = () => new AnimMachine({ has: n => ALL.includes(n), takeoffAt: () => T.takeoffAt, apexAt: () => T.apexAt, landAt: () => T.landAt });
const frame = (o: Partial<AnimInput> = {}): AnimInput => ({ dt: 1 / 60, grounded: true, rope: false, speed: 8, vy: 0, events: 0, landVy: 0, panic: false, beat: "", ...o });

test("clips.meta.json: every Radbro has Regular_Jump takeoff < apex < land", () => {
  for (const [id, c] of Object.entries(CLIP_META as Record<string, { clips: Record<string, { takeoffAt?: number; apexAt?: number; landAt?: number; duration: number }> }>)) {
    const j = c.clips.Regular_Jump;
    assert.ok(j, `#${id} Regular_Jump`);
    assert.ok(j.takeoffAt! > 0 && j.takeoffAt! < j.apexAt! && j.apexAt! < j.landAt! && j.landAt! < j.duration, `#${id} ${JSON.stringify(j)}`);
  }
});

test("jump: Regular_Jump from takeoff, frozen on the apex until landing; release / edge / bonk -> apex hold", () => {
  const m = machine();
  const cmds: AnimCmd[] = [];
  const step = (o: Partial<AnimInput>) => { const c = m.step(frame(o)); if (c) cmds.push(c); return c; };
  for (let i = 0; i < 10; i++) step({});
  // Jump.
  assert.deepEqual(step({ grounded: false, vy: 6, events: A_JUMP }), { kind: "shot", clip: "Regular_Jump", fade: 0.08, startAt: T.takeoffAt, hold: true, then: "", freezeAt: T.apexAt });
  for (let i = 0; i < 150; i++) assert.equal(step({ grounded: false, vy: 6 - i * 0.3, clearance: 2 }), null, `air frame ${i}`);
  // Land (soft) -> run.
  assert.deepEqual(step({ events: A_LAND, landVy: -8 }), { kind: "force", clip: "Run_02", fade: 0.12, scale: 8 / 9 });
  // Rope: grab, hang, release -> apex hold (0.1 s crossfade).
  assert.equal(step({ grounded: false, rope: true, events: A_ATTACH })?.clip, "Grab_Bar_and_Swing_Forward");
  for (let i = 0; i < 80; i++) step({ grounded: false, rope: true });
  assert.deepEqual(step({ grounded: false, vy: 3, events: A_RELEASE }), { kind: "shot", clip: "Regular_Jump", fade: 0.1, startAt: T.apexAt, hold: true, then: "", freezeAt: T.apexAt });
  for (let i = 0; i < 90; i++) assert.equal(step({ grounded: false, vy: 3 - i * 0.3, clearance: 2 }), null);
  // Hard landing -> the landing crouch for 0.3 s, then the run.
  assert.deepEqual(step({ events: A_LAND, landVy: -16, speed: 12 }), { kind: "shot", clip: "Regular_Jump_Land", fade: 0.08, startAt: T.landAt, hold: false, then: "Lean_Forward_Sprint" });
  let back: AnimCmd | null = null;
  for (let i = 0; i < 30 && !back; i++) back = step({ speed: 12 });
  assert.equal(back?.kind, "force");
  assert.equal(back?.clip, "Lean_Forward_Sprint");
  // Walk off an edge: keep the stride for 0.25 s, then the apex hold.
  for (let i = 0; i < 10; i++) step({});
  const edge: (AnimCmd | null)[] = [];
  for (let i = 0; i < 30; i++) edge.push(step({ grounded: false, vy: -i * 0.16, clearance: 2 }));
  const first = edge.findIndex(c => c !== null);
  assert.ok(first >= 14 && first <= 16, `apex hold after ~0.25 s (frame ${first})`);
  assert.equal(edge[first]?.kind, "shot");
  assert.equal((edge[first] as { freezeAt?: number }).freezeAt, T.apexAt);
  // Bonk in the air -> apex hold.
  assert.equal((step({ grounded: false, vy: -2, events: A_BONK }) as { freezeAt?: number }).freezeAt, T.apexAt);
  // Never a dive clip.
  for (const c of cmds) assert.ok(!DIVES.includes(c.clip), `${c.kind} ${c.clip}`);
});

test("runner-style phase events and beats never command a dive clip", () => {
  const m = machine();
  let seen = 0;
  for (let k = 0; k < 40; k++) {
    const ph = k % 4; // ground, air (jump), rope, air (release)
    for (let i = 0; i < 40; i++) {
      const c = m.step(frame({
        grounded: ph === 0, rope: ph === 2, vy: ph === 0 ? 0 : 4 - i * 0.4, speed: 9, clearance: 30 - i,
        events: i ? 0 : ph === 1 ? A_JUMP : ph === 2 ? A_ATTACH : ph === 3 ? A_RELEASE : A_LAND,
        beat: k === 20 && ph === 0 ? "taunt" : "",
      }));
      if (c) { seen++; assert.ok(!DIVES.includes(c.clip), `${c.kind} ${c.clip}`); }
    }
  }
  assert.ok(seen > 0);
  assert.equal(CLIP.jump, "Regular_Jump");
});

// Round 7 free fall: a long drop crossfades from the apex hold into Free_Fall (upright loop), a rope grab
// cancels it, and the landing after it is Big_Land (cut short when he runs on).
const FF = [...ALL, "Free_Fall", "Big_Land"];
const ffMachine = (has = FF) => new AnimMachine({ has: n => has.includes(n), takeoffAt: () => T.takeoffAt, apexAt: () => T.apexAt, landAt: () => T.landAt });

test("free fall: long drops loop Free_Fall, short hops never do; big landing after", () => {
  const m = ffMachine();
  const step = (o: Partial<AnimInput>) => m.step(frame(o));
  for (let i = 0; i < 10; i++) step({});
  // Ordinary jump across an alley: vy 9 -> -9 with the next roof 1-2 m below: apex hold only.
  step({ grounded: false, vy: 9, events: A_JUMP, clearance: 0.5 });
  for (let i = 1; i < 86; i++) assert.equal(step({ grounded: false, vy: 9 - i * 0.21, clearance: 2 }), null, `hop frame ${i}`);
  assert.equal(step({ events: A_LAND, landVy: -9 })?.clip, "Run_02");
  // Walk off a 40 m cliff: stride, apex hold, then Free_Fall once falling fast with air below.
  const cmds: (AnimCmd | null)[] = [];
  for (let i = 0; i < 120; i++) cmds.push(step({ grounded: false, vy: Math.max(-20, -i * 0.42), clearance: 40 - i * 0.3 }));
  const ff = cmds.findIndex(c => c?.clip === "Free_Fall");
  assert.ok(ff > 0, "Free_Fall commanded");
  assert.deepEqual(cmds[ff], { kind: "force", clip: "Free_Fall", fade: 0.25, scale: 1 });
  assert.ok(cmds.slice(ff + 1).every(c => c === null), "stays in the loop");
  assert.equal(m.ff, true);
  // Landing after it: Big_Land from ground contact, cut after 0.5 s when running on.
  assert.deepEqual(step({ events: A_LAND, landVy: -20, speed: 9 }), { kind: "shot", clip: "Big_Land", fade: 0.06, startAt: 0, hold: false, then: "Run_02" });
  let back: AnimCmd | null = null, n = 0;
  for (; n < 90 && !back; n++) back = step({ speed: 9 });
  assert.equal(back?.clip, "Run_02");
  assert.ok(n >= 30 && n <= 32, `cut after ~0.5 s (frame ${n})`);
  // Standing still after the landing: the whole crouch-and-rise (1.4 s).
  for (let i = 0; i < 120; i++) step({ grounded: false, vy: -20, clearance: 30 });
  assert.equal(step({ events: A_LAND, landVy: -20, speed: 0 })?.clip, "Big_Land");
  back = null; n = 0;
  for (; n < 120 && !back; n++) back = step({ speed: 0 });
  assert.equal(back?.clip, "Idle");
  assert.ok(n >= 83 && n <= 86, `full clip ~1.4 s (frame ${n})`);
});

test("free fall: a rope grab cancels it; release over a street re-enters only when falling", () => {
  const m = ffMachine();
  const step = (o: Partial<AnimInput>) => m.step(frame(o));
  for (let i = 0; i < 5; i++) step({});
  for (let i = 0; i < 60; i++) step({ grounded: false, vy: -15, clearance: 30 });
  assert.equal(m.ff, true);
  assert.equal(step({ grounded: false, rope: true, events: A_ATTACH })?.clip, "Grab_Bar_and_Swing_Forward");
  assert.equal(m.ff, false);
  for (let i = 0; i < 60; i++) step({ grounded: false, rope: true });
  // Release going up: apex hold, no free fall while rising or barely falling.
  assert.equal((step({ grounded: false, vy: 4, events: A_RELEASE, clearance: 20 }) as { freezeAt?: number }).freezeAt, T.apexAt);
  for (let i = 0; i < 25; i++) assert.equal(step({ grounded: false, vy: 4 - i * 0.2, clearance: 20 }), null, `rising ${i}`);
  // Then dropping with 20 m of air below: Free_Fall.
  let c: AnimCmd | null = null;
  for (let i = 0; i < 20 && !c; i++) c = step({ grounded: false, vy: -1 - i * 0.4, clearance: 20 });
  assert.equal(c?.clip, "Free_Fall");
  // Bonk in the free fall: the apex hold, then back into the loop once falling again.
  assert.equal((step({ grounded: false, vy: -2, events: A_BONK, clearance: 20 }) as { freezeAt?: number }).freezeAt, T.apexAt);
  assert.equal(step({ grounded: false, vy: -10, clearance: 18 })?.clip, "Free_Fall");
});

test("free fall: without the clips the apex hold / landing crouch stay; runner landings use his fall speed", () => {
  const m = ffMachine(ALL);
  const step = (o: Partial<AnimInput>) => m.step(frame(o));
  for (let i = 0; i < 5; i++) step({});
  for (let i = 0; i < 120; i++) { const c = step({ grounded: false, vy: -Math.min(20, i * 0.4), clearance: 40 }); assert.ok(!c || c.clip === "Regular_Jump", String(c?.clip)); }
  assert.equal(step({ events: A_LAND, landVy: -20, speed: 9 })?.clip, "Regular_Jump_Land");
  // Runner (landVy 0): his fall speed picks the landing.
  const r = ffMachine();
  for (let i = 0; i < 5; i++) r.step(frame({}));
  for (let i = 0; i < 30; i++) r.step(frame({ grounded: false, vy: -18, clearance: 30 - i }));
  assert.equal(r.step(frame({ events: A_LAND, landVy: 0, speed: 9 }))?.clip, "Big_Land");
});

test("double jump: Regular_Jump again from its takeoff frame at 1.4x into the apex hold (upright, never a flip)", () => {
  const m = machine();
  for (let i = 0; i < 10; i++) m.step(frame({}));
  m.step(frame({ grounded: false, vy: 6, events: A_JUMP }));
  for (let i = 0; i < 20; i++) m.step(frame({ grounded: false, vy: 6 - i * 0.3 }));
  const c = m.step(frame({ grounded: false, vy: 7.5, events: A_JUMP | A_DJUMP }));
  assert.deepEqual(c, { kind: "shot", clip: "Regular_Jump", fade: 0.06, startAt: T.takeoffAt, hold: true, then: "", freezeAt: T.apexAt, rate: 1.4 });
  // (a short hop: little air below, so no free fall)
  for (let i = 0; i < 60; i++) assert.equal(m.step(frame({ grounded: false, vy: 7 - i * 0.3, clearance: 2 })), null);
  // A web zip reads as a grab (A_ATTACH with rope on) and its end as a release into the apex hold.
  assert.equal(m.step(frame({ grounded: false, rope: true, events: A_ATTACH }))?.clip, "Grab_Bar_and_Swing_Forward");
  assert.equal(m.step(frame({ grounded: false, vy: 5, events: A_RELEASE }))?.clip, "Regular_Jump");
});

test("round 9 parkour clips: side-picked wall run then the run, run-up, held grab, mantle, vault, slide, roll; fallbacks without them", () => {
  const PK = ["Wall_Run_Up", "Wall_Run", "Wall_Run_Mirror", "Ledge_Grab", "Ledge_Climb", "Vault", "Slide", "Land_Roll"];
  const meta = (CLIP_META as unknown as Record<string, { clips: Record<string, Record<string, number>> }>)["652"].clips;
  for (const n of PK) assert.ok(meta[n], `#652 ${n} in clips.meta.json`);
  const at = (n: string, k: string) => (typeof meta[n]?.[k] === "number" ? meta[n][k] : undefined);
  const mk = (has: string[]) => new AnimMachine({ has: n => has.includes(n), takeoffAt: n => at(n, "takeoffAt") ?? T.takeoffAt, apexAt: () => T.apexAt, landAt: n => at(n, "landAt") ?? T.landAt, at });
  const m = mk([...ALL, ...PK]);
  for (let i = 0; i < 5; i++) m.step(frame({}));
  // Wall run, wall on his right: the mirrored clip once (posed), then the run once it is over.
  const w = m.step(frame({ grounded: false, wall: 1, wallSide: -1, events: A_WALLRUN, speed: 11 }));
  assert.equal(w?.clip, "Wall_Run_Mirror");
  assert.ok(m.posed);
  let back: AnimCmd | null = null;
  for (let i = 0; i < 60 && !back; i++) back = m.step(frame({ grounded: false, wall: 1, wallSide: -1, speed: 11 }));
  assert.equal(back?.clip, "Run_02");
  assert.equal(m.posed, false);
  assert.equal(mk([...ALL, ...PK]).step(frame({ grounded: false, wall: 1, wallSide: 1, events: A_WALLRUN, speed: 11 }))?.clip, "Wall_Run");
  // Run-up: Wall_Run_Up over 0.6 s, held while it lasts; then the ledge grab from just before its hang frame, held.
  const u = m.step(frame({ grounded: false, wall: 2, events: A_WALLRUN, speed: 0, vy: 9 })) as { clip: string; rate?: number; hold: boolean };
  assert.equal(u.clip, "Wall_Run_Up");
  assert.ok(u.hold && Math.abs(u.rate! - at("Wall_Run_Up", "duration")! / 0.6) < 1e-9);
  for (let i = 0; i < 20; i++) assert.equal(m.step(frame({ grounded: false, wall: 2, speed: 0, vy: 9 })), null);
  const g = m.step(frame({ grounded: false, ledge: 1, events: A_LEDGE, speed: 0 })) as { clip: string; startAt: number; hold: boolean };
  assert.equal(g.clip, "Ledge_Grab");
  assert.ok(g.hold && Math.abs(g.startAt - (at("Ledge_Grab", "hangAt")! - 0.2)) < 1e-9);
  for (let i = 0; i < 12; i++) assert.equal(m.step(frame({ grounded: false, ledge: 1, speed: 0 })), null);
  // Mantle: Ledge_Climb up to its stand frame in 0.35 s; the climb's end -> the run.
  const c = m.step(frame({ grounded: false, ledge: 2, speed: 0 })) as { clip: string; rate?: number; freezeAt?: number };
  assert.equal(c.clip, "Ledge_Climb");
  assert.equal(m.special, "mantle");
  assert.ok(Math.abs(c.rate! - at("Ledge_Climb", "standAt")! / 0.35) < 1e-9 && c.freezeAt === at("Ledge_Climb", "standAt"));
  for (let i = 0; i < 20; i++) m.step(frame({ grounded: false, ledge: 2, speed: 0 }));
  assert.equal(m.step(frame({ events: A_CLIMB | A_LAND, speed: 6 }))?.clip, "Run_02");
  assert.equal(m.posed, false);
  // Vault from its takeoff frame; its own landing is never cut by the landing event.
  for (let i = 0; i < 5; i++) m.step(frame({}));
  const v = m.step(frame({ grounded: false, vy: 8, events: A_VAULT })) as { clip: string; startAt: number };
  assert.equal(v.clip, "Vault");
  assert.equal(v.startAt, at("Vault", "takeoffAt"));
  for (let i = 0; i < 20; i++) m.step(frame({ grounded: false, vy: 8 - i }));
  assert.equal(m.step(frame({ events: A_LAND, landVy: -5 })), null, "the vault lands by itself");
  let run: AnimCmd | null = null;
  for (let i = 0; i < 90 && !run; i++) run = m.step(frame({}));
  assert.equal(run?.clip, "Run_02");
  // Slide: held at slideTo while sliding; landing roll from rollFrom over 0.45 s.
  const sl = m.step(frame({ slide: true, events: A_SLIDE, speed: 10 })) as { clip: string; freezeAt?: number };
  assert.equal(sl.clip, "Slide");
  assert.equal(sl.freezeAt, at("Slide", "slideTo"));
  assert.equal(m.step(frame({ speed: 9 }))?.clip, "Run_02");
  const r = m.step(frame({ events: A_LAND | A_ROLL, landVy: -18, speed: 10 })) as { clip: string; startAt: number };
  assert.equal(r.clip, "Land_Roll");
  assert.equal(r.startAt, at("Land_Roll", "rollFrom"));
  // Without the clips: the procedural fallbacks (the run for the wall run, the hang for the grab, Big_Land-free crouch).
  const f = mk(ALL);
  for (let i = 0; i < 5; i++) f.step(frame({}));
  assert.equal(f.step(frame({ grounded: false, wall: 1, wallSide: -1, events: A_WALLRUN, speed: 11 }))?.clip, "Run_02");
  assert.equal(f.posed, false);
  assert.equal(f.step(frame({ grounded: false, ledge: 1, events: A_LEDGE, speed: 0 }))?.clip, "Rope_Hang_Idle");
  assert.equal(f.step(frame({ grounded: false, vy: 8, events: A_VAULT }))?.clip, "Regular_Jump");
});
