// Airborne animation mapping (anim/animMachine.ts): every airborne moment is Regular_Jump's upright
// pose - a jump plays it from the takeoff frame and freezes on the apex, a rope release / walking off
// an edge / a bonk crossfade into that apex hold, a hard landing plays its landing crouch. The dive
// clips (Run_and_Jump, Fall_1, Leap_of_Faith) and Roll_Dodge are never commanded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { A_ATTACH, A_BONK, A_JUMP, A_LAND, A_RELEASE, AnimMachine, CLIP, type AnimCmd, type AnimInput } from "../src/anim/animMachine.ts";
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
  for (let i = 0; i < 150; i++) assert.equal(step({ grounded: false, vy: 6 - i * 0.3 }), null, `air frame ${i}`);
  // Land (soft) -> run.
  assert.deepEqual(step({ events: A_LAND, landVy: -8 }), { kind: "force", clip: "Run_02", fade: 0.12, scale: 8 / 9 });
  // Rope: grab, hang, release -> apex hold (0.1 s crossfade).
  assert.equal(step({ grounded: false, rope: true, events: A_ATTACH })?.clip, "Grab_Bar_and_Swing_Forward");
  for (let i = 0; i < 80; i++) step({ grounded: false, rope: true });
  assert.deepEqual(step({ grounded: false, vy: 3, events: A_RELEASE }), { kind: "shot", clip: "Regular_Jump", fade: 0.1, startAt: T.apexAt, hold: true, then: "", freezeAt: T.apexAt });
  for (let i = 0; i < 90; i++) assert.equal(step({ grounded: false, vy: 3 - i * 0.3 }), null);
  // Hard landing -> the landing crouch for 0.3 s, then the run.
  assert.deepEqual(step({ events: A_LAND, landVy: -16, speed: 12 }), { kind: "shot", clip: "Regular_Jump_Land", fade: 0.08, startAt: T.landAt, hold: false, then: "Lean_Forward_Sprint" });
  let back: AnimCmd | null = null;
  for (let i = 0; i < 30 && !back; i++) back = step({ speed: 12 });
  assert.equal(back?.kind, "force");
  assert.equal(back?.clip, "Lean_Forward_Sprint");
  // Walk off an edge: keep the stride for 0.25 s, then the apex hold.
  for (let i = 0; i < 10; i++) step({});
  const edge: (AnimCmd | null)[] = [];
  for (let i = 0; i < 30; i++) edge.push(step({ grounded: false, vy: -i * 0.16 }));
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
        grounded: ph === 0, rope: ph === 2, vy: ph === 0 ? 0 : 4 - i * 0.4, speed: 9,
        events: i ? 0 : ph === 1 ? A_JUMP : ph === 2 ? A_ATTACH : ph === 3 ? A_RELEASE : A_LAND,
        beat: k === 20 && ph === 0 ? "taunt" : "",
      }));
      if (c) { seen++; assert.ok(!DIVES.includes(c.clip), `${c.kind} ${c.clip}`); }
    }
  }
  assert.ok(seen > 0);
  assert.equal(CLIP.jump, "Regular_Jump");
});
