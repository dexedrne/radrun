# RadRun — round 12: web-slinger tag (design)

**Date:** 2026-09-26 · **Status:** direction for the round 12 build on `feat/round12` (from main `0772cbc`): one small
contract commit, two parallel builders, one integration pass.
**Owner ask:** "for radrun we need a webzip that just goes straight and the new swinging is honestly harder we need
some like random shit inbetween buildings for better swinging or a charge jump ability / like basically turn the
radbros into spiderman chasing each other imagine like the most high skill high tech spiderman vs spiderman tag game"

**In one line:** the city gets things to web **between** the buildings (cables across every street, low sign gantries,
skybridges, rooftop water tanks and billboard frames), **E** becomes a straight zip that goes where the camera points,
**holding C** charges a big launch from roofs, walls, ledges and the rope, and a few timing moves (perfect release, zip
pop, rebound kick, kick chains, dive, web-yank, air carve) raise the skill ceiling. The thief uses the same kit, so a
chase reads as two web-slingers playing tag. Everything stays deterministic (120 Hz fixed step,
`+ - * / sqrt min max abs floor` only, seeded RNG, fixed iteration order) and every new number is a `tuning.json` key
with a `?tune` slider.

Multiplayer is not built this round (it has its own design); §12 lists what this round keeps ready for it.

Sections: 1 why swinging got harder · 2 structures between the buildings · 3 anchors on structures · 4 the straight zip ·
5 the charge jump · 6 skill tech · 7 the thief and the bots · 8 clean and readable · 9 tuning keys · 10 versions,
re-bakes, balance · 11 the builder contract · 12 order of work, multiplayer notes, open questions.

---

## 1. Why swinging got harder (causes found in the code)

| # | Cause | Where |
|---|---|---|
| H1 | **Only buildings are anchors.** An anchor must be >= `anchorMinAbove` 5 m above you, 8-42 m away, inside the 70° cone, with a clear line. Below the lower roofline of a street the only candidates are the two facades beside you. Their pivots are pushed into the street (round 10), but the arc still runs along a wall and round 11 had to add `swingAvoid` to bend it off. | `world/cityQuery.ts` findAnchor / pivotFor, `sim/player.ts` wallAhead |
| H2 | **Low districts run out of anchors.** Anchor coverage (G1) is only a warning in Market (roofs 12-39 m) and Vertigo, and the Docks' roofs are 13-23 m. A web press on those stretches plays the grey X. | `world/derive.ts` lint G1, `world/districts.ts` coverWarn |
| H3 | **There is no safety net.** With `ropeMin` 8 and `swingFloorClear` 6 an anchor has to be ~11 m up to save you. Nothing stands between the roofline and the street, so a chain that sinks under ~15 m ends on the street (`failFloor` 2 m). | `sim/tuning.ts` |
| H4 | **The zip is not straight and you can't aim it.** E pulls you to the **swing ring** (a point chosen 24 m up and 10-26 m ahead for pendulums) or to a roof ledge along the camera yaw. The velocity turns onto the line at `zipPull` 14/s, which is a curve. The ledge pop ends it at `zipLedgeSpeed` 7 m/s, so the momentum is gone, and the cooldown is 1.5 s. The sim never gets the camera pitch (`buildFrame` sets `aimY = 0`). | `sim/player.ts` zipTarget / startZip / endZip, `game/ghost.ts` buildFrame |
| H5 | **There is no big vertical move.** Jump 9 m/s (1.6 m), double jump 7.5 m/s, run-up about 9 m. Getting from a canyon back onto a roof means a zip or a string of wall kicks. | `sim/tuning.ts` |
| H6 | **Execution barely pays and is never shown.** The timed release (+11 m/s up) has no cue. A head-on facade hit is a 0.35 s bonk whatever you press. | `sim/player.ts` sweetSpot, bonk |
| H7 | **The thief reads as a zipper in the Towers.** Over the kept edges of the current bakes, swings are 64 % of his street crossings there (134 swings / 75 zips). Elsewhere: Downtown 84 %, Market 87 %, Vertigo 80 %, Docks 100 %. His kit is also a subset: no double jump, no slide, nothing charged. | `public/levels/*/bake.report.json` |

---

## 2. Structures between the buildings (WORLD)

### 2.1 What gets built

| Kind | Looks like | Collision | Web anchor | Where | Prio |
|---|---|---|---|---|---|
| **cable** | a taut steel cable across a street, facade to facade, with a slight sag | **none** (you pass through it) | any point along it; the ring glides along the cable; the pivot is the point itself (it already hangs over the open street) | one station per facing pair on a street (about every 17-24 m), heights alternating between two tiers | P0 |
| **gantry** | a steel sign truss (1.0 m wide, 1.2 m tall) across the street at 13-16 m, a pole at each curb, two traffic-light heads | the truss is a **floating solid** (you can land on it or wall-run its side); poles and lights are visual only | truss rims and underside | at most one per street run (§2.2), only where the lower roof is >= 30 m | P0 |
| **skybridge** | an enclosed glass walkway, 4 m wide and 3.5 m tall, between the two facades of a street | floating solid | rims, sides, underside | at most one per street run; chance per district | P0 |
| **tank** | a rooftop water tank on legs, 3.6 × 3.6 m, top 7-10 m above its roof | ground-rooted solid, landable top | rim, sides | roofs (chance per district), in a corner quadrant | P0 |
| **board** | a rooftop billboard frame, 0.8 m thick, 8-12 m long, top 6-8 m above its roof, along a street edge | ground-rooted solid, landable | rim | roofs that face a street (chance per district) | P1 |
| **stack** | construction scaffolding (Downtown, Towers) or a fire escape (Market, Docks): 1.5 m deep, 6-10 m wide, flush on a street facade, top 4-8 m below that roof | ground-rooted solid (drawn from 3 m up) | rim, face (its outer face is a wall-run lane, its top a ledge) | street facades (chance per district) | P1 |

**Not this round:** anything in alleys (alleys stay clear for wall kicks), span wires over crossings, perching on cables,
hand-placing structures in the editor (later, as `Data {kind: "structure"}` nodes), and anything grabbable floating in
open sky.

### 2.2 Derived by rule at level time

Structures are derived by `npm run level` from the solids, the same way adjacency and wall gaps are, and written into
`city.model.json`. The hand-editable `city.json` is never touched: move a building in the editor, re-run level, and the
structures follow. New file `src/world/structures.ts`, `deriveStructures(solids, adjacency, knobs, keepOut)`. Every
random draw is `hash01(seed, x, z)` of the station's own position, never the iteration order, so an edit in one corner
of the city leaves the rest alone.

1. **Street runs.** Group the `street` adjacency pairs by axis and the street's centre line (rounded to 0.5 m) and sort
   each group along the street. A run is a sequence of pairs with <= 8 m between their spans; a crossing breaks it. A
   pair's **station** sits at the centre of its overlap span, and `L` is the lower of its two facade tops (towers
   count). Stations fall mid-building, so there is never one right at a crossing.
2. **Each station, in this order:**
   - **skybridge** if the run has none yet, `L >= 30`, the span is >= 10 m and `hash < skybridge`: bottom
     `y0 = max(12, L × U(0.35, 0.6))`, top `y0 + 3.5`, 4 m wide, centred on the station, flush with both faces;
   - else a **gantry** if `gantry` is on, the run has none yet, `L >= gantryMinL` (30) and this is the run's first or last
     station: the truss bottom at `U(gantryMin, gantryMax)` = 13-16 m, poles 1.5 m out from each face;
   - else a **cable** if `hash < cables`. Station i along its run uses tier `i mod 2`
     (`cableTier1` / `cableTier2`, one tier when `cableTier2` is 0): height
     `h = clamp(L × tier ± 0.04 L, cableMin, L − 3)`, facade to facade, sagging `cableSag` at its middle.
3. **Clearances:** no two cables of the same tier within `rigApart` (12 m) along a run; no cable within 10 m of a
   skybridge or gantry; nothing within 3 m under the lower roof's top (a roof you run on never meets a cable); a cable's
   segment and a floating box are clear of every solid but their two end solids.
4. **Rooftop fixtures** on each landable roof (not a prop, not the spawn roof):
   - a **tank** if `hash < tanks`, in the corner quadrant farthest from the roof's longest street edge, inset 2.5 m,
     >= 4 m from both centre lines, clear of props and of decor keep-outs (tools/level.ts reads the Milady's stand, the
     billboards and the AC units from `decor.json`);
   - a **board** if `hash < boards`, along the roof's street edge (inset 2.5 m, centred ± 2 m).
   At most one of each per roof.
5. **Stacks:** on each street-facing facade with `L >= 25`, if `hash < stacks`: a 1.5 m deep box on that face, 6-10 m
   wide, centred on the station ± 4 m, top `L − U(stackBelowLo, stackBelowHi)`, never within 3 m of a cable end or under
   a skybridge.

**District knobs** (tuning.json `structures.default` plus per-district overrides, §9):

| District | cables | tiers (× L) | gantry | skybridge | tanks | boards | stacks |
|---|---|---|---|---|---|---|---|
| Downtown (L 43-77) | 1.0 | 0.55 / 0.85 | on | 0.12 | 0.10 | 0.15 | 0.10 scaffolds |
| Towers (L 66-124) | 1.0 | 0.45 / 0.75 | on | 0.20 | 0.05 | 0.10 | 0.12 scaffolds |
| Market (L 12-39) | 0.7 | 0.85 | off | 0 | 0.25 | 0.15 | 0.10 fire escapes |
| Docks (L 13-23) | 0.5 | 0.85 | off | 0 | 0.25 | 0.15 | 0 |
| Vertigo (rings 22-89) | 0.6 | 0.6 | off | 0.08 | 0.10 | 0 | 0 |

**Why these numbers:**
- The upper tier is the chain and the lower tier catches you once you've sunk. In Downtown the tiers hang at 24-42 m
  and 37-65 m, so from anywhere in the canyon the next cable ahead is 5-25 m above you, close to the anchor search's
  ideal point (10 m + 0.5 s × speed ahead, 24 m up).
- A toy 2D run of the round 9-11 rope rules on stations 18-22 m apart chains for 20 s without touching the street. At
  26 m apart the chain sinks to the floor clamp, so the per-pair station (17-24 m) is about right.
- The gantry is the last net. A pivot at 13-16 m with `ropeMin` 8 and `swingFloorClear` 6 keeps the bottom of the arc
  5-7 m above the street, and the fall line is 2 m.
- Tanks and boards give the low districts anchors above their roofs (a tank top is 6-9 m above a Radbro standing next
  to it, past `anchorMinAbove` 5), while Market stays the parkour district.

Counts: Downtown has 114 street pairs, so about 100 cables. Market has 186 × 0.7 ≈ 130, Towers ≈ 150 and Vertigo ≈ 60.

### 2.3 Model changes (`src/world/cityModel.ts`, contract commit, §11)

```ts
/** round 12 fixture: a derived structure (gantry, skybridge, tank, board, stack). Landable; never in adjacency,
 *  junctions, spawn, lowestRoof or G1 coverage (like props). */
export type SolidKind = "roof" | "tower" | "prop" | "fixture";

export type Solid = {
  /* ...as now... */
  /** Round 12: bottom (m). Missing = 0 (ground-rooted). Only fixtures float (gantry, skybridge). */
  y0?: number;
  /** Round 12: what a fixture is (view + lint). Missing on city.json solids. */
  sub?: "gantry" | "skybridge" | "tank" | "board" | "stack";
};

/** Round 12: a web-only cable (no collision). a -> b at its ends, sagging `sag` m at the middle. */
export type Rig = { id: number; kind: "cable"; ax: number; ay: number; az: number; bx: number; by: number; bz: number; sag: number };

// CityModel gains: rigs: Rig[]   ([] when there are none; optional while the builders work, required at INTEGRATE)
/** Anchor / ring / rope ids >= RIG0 are rigs[id - RIG0]; below it they are solid ids. */
export const RIG0 = 1 << 20;
```

- Derived fixtures are appended **after** the city.json solids, so existing ids don't move.
- `modelHash` adds `y0`, `sub` and the rigs. Every city hash changes once, so every runner pack goes stale once (a full
  re-bake is planned anyway).
- `deriveModel`'s "main" set, the G8 overlap check and `covers()` treat `fixture` like `prop`.
- **CityIndex becomes y0-aware:** `segmentHit` slabs over `[y0, top]`, `pointBoxDist` measures from y0, and
  `groundBelow(x, z, y)` keeps "the highest top <= y" (a bridge under a pivot is the floor for the clamp).

### 2.4 Geometry rules (lint, printed by `npm run level`)

- **G9 structures.** Each cable ends on the two faces of its pair, >= 3 m under the lower top. Same-tier cables are
  >= 12 m apart along a run. Nothing sits in an alley (gap <= 6 m). Floating fixtures have `y0 >= 12` and are flush with
  both faces (± 0.01 m). A fixture never overlaps a non-fixture solid (flush contact is fine). A run has at most one
  skybridge and one gantry. Rooftop fixtures obey G3's inset / apart / centre rules with their own height bands
  (tank 7-10 m, board 6-8 m, at most one each per roof).
- **G10 clear lines.** No solid other than its two end solids blocks a cable's segment. No other solid is inside a
  floating fixture's box.
- **G11 swing coverage.** A stat, and a warning when under target. Sample every street run's centre line every 4 m at
  height 0.7 × L, in both directions, moving along the street at 20 m/s. The stat is the share of samples where the
  player's anchor search (§3, 70° cone) finds an anchor whose pivot is within 8 m of the centre line and 12-32 m ahead.
  Targets: Downtown / Towers >= 90 %, Vertigo >= 75 %, Docks >= 70 %, Market >= 60 %. Print it next to the same stat
  computed without structures (the round 11 baseline).
- **G12 budget.** At most 400 rigs and 250 fixtures per district.

### 2.5 Look, cost, quality

- **Rendering.** A new `src/app/StructuresView.tsx` draws the structures from the model, not from city.json, using
  instanced meshes only:
  - cables: 0.12 m cylinders, dark steel with a lighter upper edge so they read against the sky;
  - gantry trusses, poles and signal heads;
  - skybridges: a glass box with a frame;
  - tanks: a cylinder with a cone roof and four legs;
  - boards: a frame with a panel using the billboard art we already ship;
  - stacks: a lattice box.
- **Cost.** At most 10 extra draw calls and no new downloads (everything is procedural or already-shipped art).
  `city.model.json` grows by about 10-25 KB per district.
- **Palette.** One per district: steel grey in Downtown / Towers, neon trim in Market, rust in the Docks. No glowing
  "grab me" markers: the reticle is the only sign of where a web goes.
- **Quality.** Low quality **never hides a structure**, because they are gameplay, like the solid props. It only drops
  the signal-light glow, board lighting and cable highlights.
- **Editor.** `?editor` draws the structures too (read-only, from city.model.json), so they're visible while buildings
  are being moved.

---

## 3. Anchors on structures (MOVEMENT, `src/world/cityQuery.ts`)

- **Rigs in `findAnchor`.** After the solids loop, the search visits every rig in ascending id order, skipping any whose
  bounding box is out of `ropeMax`.
  - **Point:** `Q` is the point on the cable nearest the ideal point `P*`. The chord parameter is clamped to stay
    `rigEndInset` (2 m) from each end, and y comes from the sag: `ya + (yb − ya) t − 4 sag t (1 − t)`.
  - **Filters:** the same as for solids: `anchorMinAbove`, `ropeMin`-`ropeMax`, the cone, and a clear line from the body
    to Q.
  - **Score:** `|Q − P*| − rigBonus` (4), minus `hysteresis` when ringed, plus `anchorAlternate` when just let go.
  - Rig candidates share round 11's top list, so the arc look-ahead applies to them too.
  - A rig's pivot is Q itself (no `swingOut` push), with `rim = false` and normal (0, 0).
- **Why cables fix the old problems.** Running along an avenue, the cables cross it, so the pivot sits ahead over the
  middle of the street: a straight pendulum with nothing sideways and no wall to avoid (H1). Crossing a street, a cable
  runs along your path, so its pivot sits over the street's middle. That is exactly round 10's "crossing pendulum", and
  it no longer needs a tall building nearby (H7).
- **Ids.** A rig's ring / rope / last-rope id is `RIG0 + index`. Anything that looks up `idx.solids[id]` checks
  `id >= RIG0` first:
  - `anchorVisible` checks only `segmentBlocked` for rigs;
  - `pivotFor` is skipped;
  - the zip / ledge / wall rules never treat a rig as a face.
- **Floating solids (y0 > 0) in every query.**
  - slab tests run over `[y0, top]`;
  - findAnchor clamps Q's y to `[y0, top]` (a point on the underside has normal (0, 0), so its pivot is Q);
  - `wallProbe`, `obstacleAhead` and `ledgeAt` ignore a solid whose `y0` is above feet + 0.2 (it's overhead);
  - `segmentFace` gets `out.ny` (+1 top, −1 underside, 0 side). Round 11's `swingClear` counts a top hit as clear
    (as now) and an underside hit as blocked (a swing up into a bridge).
- **Collision (`stepBody`).**
  - A solid is skipped while the body is entirely below its `y0`.
  - Hitting it from below (the head was under `y0` last step and `v.y > 0`) is a **head bump**: `p.y = y0 − halfHeight`,
    `v.y = 0`, no side push, and EV_WALL is set.
  - Landing on top works as on any roof (a perch). `lastSafeRoof` still only takes `kind: "roof"`, so you never respawn
    on a gantry.

---

## 4. The straight web zip (E / Shift / touch ZIP)

What changes: the zip stops using the swing ring. It goes **where the camera points, in a straight line, fast, and
keeps its speed.**

### 4.1 Aim

The direction is `d` = the camera forward, pitched up by `zipLift` (stored as a sine: 0.14 ≈ 8°, because the
third-person camera looks down at you). The pitch is clamped to `zipAimMin` −0.34 (−20°) … `zipAimMax` 0.77 (+50°).
The sim gets the pitch through a new ghost-record column (§10). It is quantised and read back from a table built with
`+ - * /`, like the yaw, so the sim still never calls trig. Touch aims the same way (the look drag sets the pitch; the
velocity bias applies to the yaw as now).

### 4.2 Target

The target is the first thing on the ray from the chest (`p.y + 0.3`) within `zipReach` (45 m):
- a solid's face or top (`segmentFace`, floating solids included), or
- a rig that passes within `zipRigAssist` (1.2 m) of the ray.

If nothing is hit, the zip takes the ringed swing anchor when it lies within `zipAssistCos` (0.966 ≈ 15°) of `d`.
Failing that there is **no zip**: the grey X and the soft "no" play, and no cooldown or charge is spent. Nothing ever
attaches to open sky.

The HUD shows the target every frame as a small white diamond (a pure preview, like `zipTarget` today).

### 4.3 The pull

- **Straight:** `v = d' × zipSpeed` (30 m/s), where `d'` points at the target's approach point. With `zipPull` 60/s the
  velocity is on the line within ~4 steps; there is no gravity and no wind, and it stays under `speedCap` (32).
- **Ends:** at the target (`zipStop`, 1.0 m short), after `zipMaxTime` (1.6 s), or early on a second ZIP or a web
  press. An early end keeps `zipKeep` × the speed.

### 4.4 Arrival, by what the ray hit

| Hit | What happens |
|---|---|
| a facade | With Jump pressed in the last `zipPopWindow` (0.25 s) or on arrival: a **zip pop** (§6.2). Otherwise a wall run along the aim's side when \|along\| > 0.3 and you're fast enough (as now); else a **run-up** when there is >= 1.5 m of wall above your feet (up to ~9 m, then ledge grab and climb); else a push off (`wallPushOff`). |
| a rim (the hit is within `zipRimReach` 2.5 m under a landable top) | A ledge pop onto the roof at `zipLedgeSpeed` 7 → **12** m/s inward and `zipLedgeUp` 4. A zip pop instead vaults you over the rim and on. |
| a cable | With web held you attach to that cable at once, and the swing keeps the zip's speed (`swingKeepSpeed`): zip-to-swing. Otherwise a fling: `v = d × zipSpeed × zipKeep (0.85)` + `zipFlingUp` (3) up. |
| a top face (zipping down onto a roof) | You land (a roll if you're fast, as for any landing). |

### 4.5 Cooldown and charges

`zipCooldown` 1.5 → **0.35 s**. `zipCharges` **2** per airtime, refilled on landing, rope attach, wall-run start and
ledge grab. So zip → swing → zip → swing chains without end, two zips in a row work, and zips alone can't keep you in
the air.

### 4.6 The runner

In the bake and playback, `w.forceAnchor` is set and the zip goes to that anchor, as now (his rim zips). He gets the same
straight pull and the new ledge-pop speed.

**Quick numbers:** across a 22 m street, 0.75 s. Up 20 m to a rim across a street, 1.0 s. Today the same zip runs at
26 m/s on a curve toward a point chosen for swinging, and it ends at 7 m/s.

---

## 5. The charge jump (hold C / SLIDE)

C becomes the crouch button: **tap = slide** (as now), **hold = charge**, **release = launch**. Pressing Jump while
charging also launches, at the current charge.

- **Charge level:** `c = clamp((held − chargeMin) / chargeTime, 0, 1)`, with `chargeMin` 0.15 s and `chargeTime`
  0.55 s, so it is full after 0.7 s.
- **While charging on the ground,** a running slide carries on; otherwise you crouch-walk at `chargeWalk` (4 m/s).
- **Feedback:** a ring fills at your feet and turns yellow at full, and a rising whine peaks.

| Charging from | The launch |
|---|---|
| a roof (or the ground), including coyote time (0.1 s) after walking off | `v.y = jumpSpeed + c × chargeUp` (13, so up to 22 m/s), and the horizontal speed gains `c × chargeFwd` (8) along the stick (along the aim yaw when the stick is neutral). |
| a wall run or run-up | A wall jump plus `c × chargeWallOut` (6) outward and `c × chargeWallUp` (8) up. |
| a ledge hang (the automatic climb waits while C is held, up to `chargeHangMax` 1.5 s) | Straight up: `v.y = ledgeJumpUp + c × chargeUp`, 3 m/s inward. |
| the rope | A **slingshot:** you let go with `c × chargeFling` (8) added along the velocity and `c × chargeFlingUp` (4) up. The timed and perfect release bonuses stack on top. |
| the air | No charge (C in the air is the dive, §6.5). A charge carried off the ground lasts `chargeAir` (0.3 s), then it's lost. |

**Numbers.**
- A full leap from a run goes 9.7 m up and 30 m to the same height, or 26 m onto a roof 4 m higher in 1.55 s. That is a
  22 m street to a slightly higher roof.
- A half charge covers 16 m on the flat.
- Launch speed is 27.8 m/s, under the cap.
- Charging costs time and speed (the crouch-walk), so it's a real choice: chain swings for speed, or charge for height
  or for a street you can't swing.

**Other rules.**
- `airJumps` and zip charges refill on launch, so leap → double jump → zip works.
- The charge needs the held state of C: new input field `slideHeld`, ghost bit `B_SLIDE_HELD` (§10).
- `charge` is its own toggle, separate from `slide`: the runner charges but never slides.

---

## 6. Skill tech

Every move here is deterministic and is available to the player and the bots. The runner gets only what his bake needs
(§7).

### 6.1 Perfect release

- **Window:** let go of web (or release a C slingshot) on the upswing between `swingPerfectCos` 0.82 (35° from straight
  down) and the auto-release (50°).
- **Reward:** `releasePerfect` (3 m/s) along the velocity, on top of round 11's timed lift (+11 m/s up past 15°).
- **Cue:** the web line flashes white and a short ding plays (`EV_PERFECT`).
- The window is about 0.15-0.25 s. Holding on until the auto-release gets neither bonus.

### 6.2 Zip pop (the point launch)

At a zip's end (§4.4): `v.y = zipPopUp` (14 m/s, ~3.9 m up), plus `zipPopFwd` (6) along the aim's horizontal (anything
pointing into a face is removed). At a rim it vaults you over and forward.

### 6.3 Rebound kick

- **Trigger:** a head-on facade hit that would bonk (> 14 m/s, >= 85 % into the face), with Jump pressed in the jump
  buffer (0.1 s before the hit) or within `reboundWindow` (0.12 s) after it.
- **Result:** no bonk. Instead `v = n × vin × reboundKeep (0.6)` + up × `wallJumpUp` (`EV_REBOUND`).
- The mistake that used to stop you dead becomes a move.

### 6.4 Kick chains

Each wall kick made without touching the ground or the rope adds `kickChainUp` (0.8 m/s) to the next kick's up speed,
at most 3 times (+2.4). Alleys climb faster when you keep the rhythm.

### 6.5 Dive

- **Trigger:** a fresh C press in the air, with at least `diveMinDrop` (6 m) under your feet, while not on the rope or
  zipping.
- **Effect:** `v.y = min(v.y, −diveSpeed)` (12). While C stays held: gravity × `diveGravity` (1.5) and no air
  acceleration.
- **Ends:** when C is released, or on landing, rope attach, a zip, or a wall.
- **Combos.**
  - Webbing out of a dive keeps the speed on the first taut step (×1.6): the biggest swings in the game.
  - Landing with C still held rolls into a slide (the buffered slide, as now). Keep holding and it charges, then leap.

### 6.6 Web-yank

- **Ring:** when he is within `yankRange` (per difficulty: Chill 14, Normal 12, Degen 9 m), inside the aim cone and in
  sight, the ring on him turns into a **red dashed ring**. The solid red Yoink ring still means <= 5 m.
- **The yank:** ZIP on him is a homing zip at `yankSpeed` (32 m/s), re-aimed at him every step, for at most `yankTime`
  (0.7 s).
- **Outcome:** reaching him is the normal tag (catch kind "yank" for stats and voice). Running out of time, or losing
  sight of him, ends the yank with its momentum and starts `yankCooldown` (2.5 s).
- A miss costs you, so it's a read: yank when he commits to a leap, a climb or a swing toward you.

### 6.7 Air carve

In the air and off the rope, the horizontal velocity turns toward the stick at `airTurn` (1.6 rad/s), speed kept, when
the stick is within ~100° of your direction of travel. The existing `airAccel` still adds speed up to `runSpeed`. You
can bend a fling round a corner.

### 6.8 Flow (P2: build last, drop first)

- **Pips:** a perfect release, a zip pop, a rebound, the 3rd chained kick or a full-charge launch each add a flow pip,
  up to 3.
- **Reward:** each pip raises the speed cap by `flowCap` (2 m/s).
- **Loss:** one pip drains every `flowDecay` (2.5 s) without a new one. All pips go on a bonk, a stumble, a fall, or
  near-stopping on the ground (< 4 m/s).
- **HUD:** three small pips under the reticle, nothing more.

---

## 7. The thief and the bots use the same kit

### 7.1 The thief (baked tracks)

- **`runnerFrom`:** the straight zip on (forced targets only), charge on, slide off. All player-only tech is off or 0:
  perfect release, rebound, kick chains, dive, yank, air carve, flow.
- **Rig swings:** the graph's street-swing options now include rig anchors (they come out of `findAnchor`). A cable
  across his street is a clean crossing pendulum, so most crossings bake a swing without a tall building nearby.
- **New hop kind `leap`:** a charged jump across a street or alley, with gap <= `leapGapMax` (24 m) and
  Δh in [−20, +6] m.
  - Bot inputs: hold C from `release − fullCharge` steps, and release at the edge. The swept parameter is the release
    step.
  - Route preference is swing > leap > zip. The bake keeps the edges with the fewest zips, then the fewest leaps.
- **Zip hops** stay (the straight pull to the forced rim, then the ledge pop).
- **Pack v3:** `PHASE_ZIP = 5` (its ref is the zip target in the anchor table, so the view draws his zip web and pose),
  `EVT_CHARGE = 7` and `EVT_LEAP = 8`. v2 packs are rejected (the city hash changes anyway).
- **Target mix** of street crossings over the kept edges, in every district: swings >= 55 %, leaps 10-25 %,
  zips <= 20 %.
- **His view:** the same zip pose and web line, the charge ring in his colour, the leap clip, and webs to cables.

### 7.2 The bots

The SwingBot with `moves` (the balance tool and `?bot=chase&moves`):
- The rigs come for free (it uses the anchor search).
- It zips when nothing is ringed and it is falling, or when he is across from it or above it.
- It leaps (charged) instead of `climbZip` when he is on a roof <= 24 m across and <= 6 m up.
- It yanks when he is in yank range and moving toward or across it.
- It releases at the auto-release, like a Normal human.

A new info row, the **tech bot**, also releases in the perfect window and yanks.

### 7.3 Animations

- New bits `A_ZIP`, `A_CHARGE`, `A_LEAP`, `A_POP` and `A_DIVE`. The player and the runner play the same poses.
- **Poses (no new clips needed):**

| Move | Pose |
|---|---|
| zip | the right arm aimed along the web and the body stretched (a bone pass over `Lean_Forward_Sprint`) |
| charge | `Big_Land` frozen at its deepest crouch (the slide's fallback pose), feet planted |
| leap | `Regular_Jump` at rate 0.8, with a tuck |
| pop | `Regular_Jump` from takeoff at rate 1.4 |
| dive | `Leap_of_Faith` (swan dive) into `Fall_1` (belly-down): clips already bought, cut as air poses because they read as dives, which is right here |

- Run `npm run assets -- --meta-only` only if a clip changes.

---

## 8. Clean and readable (the owner wants a clean game)

**One job per button:**

| Button | Does |
|---|---|
| LMB / WEB | swing |
| E / Shift / ZIP | straight zip; yank when he's ringed |
| Space / JUMP | jump, wall kick, zip pop, rebound |
| C / SLIDE | tap: slide · hold: charge · in the air: dive |

**HUD marks**, and only these:
- the swing ring (yellow, green while on the rope);
- the zip diamond (white, grey when out of charges or cooling down);
- the yank ring (red dashed) and the Yoink ring (red);
- the charge ring at your feet;
- the flow pips (P2).

No text pop-ups mid-chase, no combo counters.

**Sound:** one short cue per event: zip thwip, pop, charge whine and launch thump, perfect ding, yank snap, rebound
clang, dive wind. They use the existing SFX bus and sit under the music.

**Camera:**

| Move | Camera |
|---|---|
| zip | FOV +`zipFov` (6°) for the zip, arm `armZip` (6.5 m) |
| charge | arm pulled in by `chargeArm` (0.5 m), FOV −`chargeFov` (3°) |
| leap | the existing speed FOV |
| dive | arm `armDive` (8 m), look point 1 m lower |

**Structures:** density follows §2.2. Nothing in alleys, and nothing at rooftop run height except at most one tank and
one board per roof.

**First-round hints:**
- "E: zip where you look"
- "hold C: charge a leap"
- "let go near the top of the swing: faster"

The controls screen, PLAY.md and README list the new moves.

**Touch:** ZIP aims with the look drag (pitch included). Holding SLIDE charges, and the button shows the ring. The zip
diamond is drawn larger.

---

## 9. Tuning keys (`tuning.json`, each with a `?tune` slider)

**Changed:** `zipSpeed` 26 → 30 · `zipPull` 14 → 60 · `zipCooldown` 1.5 → 0.35 · `zipLedgeSpeed` 7 → 12 ·
`zipFlingUp` 6 → 3 (now only the cable fling).

**Removed:** `zipRange`, `zipRise`, `zipDrop` (the old ledge search), `zipRelease` (→ `zipStop`), `zipFlingFwd`
(→ `zipKeep`). tuning.json loading already warns about unknown keys and skips them.

**New keys, `Key = start (min-max)`:**

| Group | Key = start (min-max) |
|---|---|
| Rig anchors | `rigBonus` = 4 (0-10) · `rigEndInset` = 2 (0-6) |
| Straight zip | `zipReach` = 45 (15-70) · `zipLift` = 0.14 (0-0.5) · `zipAimMin` = −0.34 (−0.9-0) · `zipAimMax` = 0.77 (0-0.95) · `zipRigAssist` = 1.2 (0-3) · `zipAssistCos` = 0.966 (0.8-1) · `zipStop` = 1 (0.3-3) · `zipKeep` = 0.85 (0-1.2) · `zipCharges` = 2 (1-5) · `zipRimReach` = 2.5 (0-5) · `zipPopWindow` = 0.25 (0-0.6) · `zipPopUp` = 14 (0-22) · `zipPopFwd` = 6 (0-14) |
| Charge | `charge` = true · `chargeMin` = 0.15 (0-0.4) · `chargeTime` = 0.55 (0.2-1.5) · `chargeWalk` = 4 (0-9) · `chargeUp` = 13 (0-25) · `chargeFwd` = 8 (0-16) · `chargeWallOut` = 6 (0-14) · `chargeWallUp` = 8 (0-16) · `chargeHangMax` = 1.5 (0-4) · `chargeFling` = 8 (0-16) · `chargeFlingUp` = 4 (0-10) · `chargeAir` = 0.3 (0-1) |
| Tech | `swingPerfectCos` = 0.82 (0.64-0.97) · `releasePerfect` = 3 (0-8) · `reboundWindow` = 0.12 (0-0.3) · `reboundKeep` = 0.6 (0-1.2) · `kickChainUp` = 0.8 (0-3) · `dive` = true · `diveMinDrop` = 6 (0-20) · `diveSpeed` = 12 (0-25) · `diveGravity` = 1.5 (1-3) · `yankSpeed` = 32 (15-45) · `yankTime` = 0.7 (0.2-1.5) · `yankCooldown` = 2.5 (0-6) · `airTurn` = 1.6 (0-5) · `flowCap` = 2 (0-5) · `flowDecay` = 2.5 (0.5-6) |
| Difficulty | `yankRange` = Chill 14 / Normal 12 / Degen 9 (0-25) |
| Camera | `zipFov` = 6 (0-15) · `armZip` = 6.5 (3-12) · `armDive` = 8 (3-14) · `chargeArm` = 0.5 (0-2) · `chargeFov` = 3 (0-8) |
| Structures (`structures.default` / `structures.<district>`) | `cables` = 1 (0-1) · `cableTier1` = 0.55 (0.3-0.95) · `cableTier2` = 0.85 (0-0.95; 0 = one tier) · `cableMin` = 12 (8-30) · `cableSag` = 0.25 (0-1.5) · `rigApart` = 12 (6-30) · `gantry` = true · `gantryMin` = 13 (10-20) · `gantryMax` = 16 (10-24) · `gantryMinL` = 30 (15-60) · `skybridge` = 0.12 (0-0.5) · `skybridgeLo` = 0.35 (0.2-0.7) · `skybridgeHi` = 0.6 (0.3-0.8) · `tanks` = 0.1 (0-0.6) · `tankLo` = 7 (5-12) · `tankHi` = 10 (6-14) · `boards` = 0.15 (0-0.6) · `boardLo` = 6 (4-10) · `boardHi` = 8 (5-12) · `stacks` = 0.1 (0-0.5) · `stackBelowLo` = 4 (2-10) · `stackBelowHi` = 8 (3-15) |

Per-district structure starts are in the §2.2 table.

**How the structure sliders work:** in `?tune` they re-derive the structures in the page for the sandbox and the editor
preview. A chase keeps the baked model. **Save** writes the `structures` section of tuning.json, and
`npm run level -- --all` bakes it in.

**Runner-unused keys:** tuning these never stales a pack, so they are added to `RUNNER_UNUSED_KEYS`:
- all of the Tech group;
- `zipPop*`, `zipLift`, `zipAim*`, `zipRigAssist`, `zipAssistCos` (he zips only to forced targets);
- the camera keys.

Every other new player key, and every structure key, is used by the runner. Changing one means `npm run level -- --all`
and then `npm run balance`.

---

## 10. Versions, re-bakes, balance

**Versions.**
- **`LINK_VERSION` 5 → 6.**
- **Ghost `FORMAT` 3 → 4:** a pitch column (quantised; the table is built like the yaw table) and the bit
  `B_SLIDE_HELD = 32`.
  - Formats 1-3 still decode, with charge and dive off and pitch 0. As now, only older links carry them, and those
    aren't raced.
  - Stored v5 bests and ghosts show as "old city" (the existing `bestsV` path).
- **Pack v3** (§7.1).

**Re-bake.**
- Every district: `npm run level -- --all`. Structures change every city hash, and the zip and charge keys change the
  runner's tuning hash.
- Then `npm run balance -- --all`, which sets:
  - the `districts.ts` chase tweaks;
  - the difficulty table, including `yankRange`;
  - the campaign stars (round 6 rule: the bot earns the time star in ~60-85 % of rounds, ~30 % on L12 / L15).
- Optionally, INTEGRATE gives one mid-campaign level a `{ kind: "tech"; n: 5 }` objective (perfect releases + zip
  pops + rebounds + full-charge launches).

**Targets:**

| Check | Target | Where |
|---|---|---|
| Chained avenue swing speed, Downtown / Towers | 23-27 m/s (round 9-11: ~22-23.5) | `npm run probe:canyon` |
| G11 swing coverage | >= 90 % Downtown / Towers, >= 75 % Vertigo, >= 70 % Docks, >= 60 % Market | `npm run level` |
| SwingBot web presses with nothing ringed | <= 1 / min Downtown / Towers, <= 3 / min Market / Docks | balance (new stat) |
| Swings that slam a wall | <= 1 in 60 (round 10) | probe / balance |
| SwingBot street falls per round | at most half of round 11's | balance |
| Zip across 22 m | <= 0.8 s | test |
| Full charge leap | 28-32 m flat, apex 9-10.5 m | test |
| Thief street crossings: swings / leaps / zips | >= 55 % / 10-25 % / <= 20 % | bake.report.json |
| Chase bands (unchanged) | Normal follow k = 1.0: <= 5 % caught · k = 1.2: median 35-70 s · Chill follow: >= 90 %, median 60-75 s · Normal camper: < 25 % · swing bot Chill ~95-98 %, ~10 s · Normal median 25-40 s · Degen 50-95 % caught, median 40-70 s | `npm run balance -- --all` |
| Tech bot (info) | Degen >= 80 % caught, median 30-50 s (skill pays, but still takes work) | balance |
| Bake | strongly connected, no forced U-turns, windows as now | `npm run level` |
| Determinism | replay hashes match; a format-4 ghost round-trips bit-exactly | tests |

**When the owner tunes:**

| Key tuned | Then run |
|---|---|
| `structures.*`, or a player key the runner uses | `npm run level -- --all`, then balance |
| a runner-unused key (§9) | balance only |
| a camera key | nothing |

---

## 11. The builder contract

### 11.1 Step 0: one contract commit on `feat/round12`, before the fork

- **`cityModel.ts`:** `SolidKind` "fixture", `Solid.y0?` / `sub?`, `Rig`, `CityModel.rigs?` and `RIG0`. CityIndex
  becomes y0-aware (`segmentHit`, `pointBoxDist`); models without `y0` give byte-identical results.
- **`tuning.ts`:** every §9 key with its start value, plus `TUNABLE_KEYS`, `RUNNER_UNUSED_KEYS`, `runnerFrom` and the
  `structures` / difficulty `yankRange` sections of `TuningJson` / `applyTuningJson`. Regenerate `tuning.json`.
- **A test:** a floating box in `segmentHit` / `pointBoxDist`, and the existing suites pass unchanged.

### 11.2 WORLD owns

- `src/world/{structures.ts (new), derive.ts, level.ts, districts.ts}`
- `tools/level.ts` (decor keep-outs, the G9-G12 lint, the G11 stat, `--no-bake` as in round 9)
- `src/app/{StructuresView.tsx (new), quality.tsx, GameScene.tsx}` (mounting the view)
- `src/app/dev/EditorPage.tsx`
- `public/levels/**/city.model.json` (**not** the packs or bake reports: INTEGRATE bakes)
- `test/{structures,city,districts}.test.ts`

### 11.3 MOVEMENT owns

- sim: `src/sim/player.ts` (after step 0) and `src/world/cityQuery.ts`
- input and ghosts: `src/input/input.ts`, `src/game/{ghost,round,play,sandbox,bots,campaign}.ts`
- runner: `src/route/{graph,bot,bake,trackPack}.ts`, `src/runner/runner.ts`, `src/anim/animMachine.ts`
- views: `src/app/{ActorsView,GhostView,PlayerView,FxView,CameraView,PlayViews,SimDriver,SandboxPage}.tsx`,
  `src/camera/rig.ts`
- dev pages: `src/app/dev/{TunePanel.tsx,BotDriver.ts,RouteView.tsx}`
- UI: `src/ui/{hints,strings,store,prefs}.ts`, `src/ui/{screens,TouchControls}.tsx`
- audio: `src/audio/{sfx,catalog}.ts`
- tools: `tools/{balance,probe-canyon,botshot,shot}.ts`
- tests: the sim / moves / route / ghost / determinism / input suites, plus `test/round12.test.ts` and
  `test/helpers.ts`, which gets a synthetic canyon with hand-placed cables, a gantry and a skybridge.

### 11.4 What each side may assume

- **MOVEMENT** assumes only the model types from step 0 and the geometry rules G9-G12. It never runs WORLD's deriver:
  it tests on synthetic cities and, in the browser, on any district (rig-free until INTEGRATE, where zips and charges
  still work).
- **WORLD** assumes nothing from MOVEMENT. It never bakes; its G11 stat uses the step-0 `findAnchor` over solids plus a
  local rig scan that follows §3's rules. INTEGRATE swaps that for MOVEMENT's real one.

### 11.5 Tests to write

| Area | Tests |
|---|---|
| Floating solids | land on a gantry; head bump from below; wall run along a skybridge side; the floor clamp over a bridge |
| Rig anchors | a cable is found mid-street and the ring glides along it; a rig rope snaps when a skybridge blocks it |
| Straight zip | on the line within 4 steps (< 1° off); open sky gives no zip and costs nothing; rim ledge pop at 12 m/s; zip-to-swing attach on a cable; charges refill |
| Charge | full leap 28-32 m; wall launch; hang launch; slingshot release |
| Tech | perfect-release window; rebound instead of bonk; kick-chain up speed; dive speed; yank catch and whiff cooldown |
| Versions | ghost format 4 round trip with pitch and C held; pack v3 zip / leap phases; determinism across everything |
| WORLD | G9-G12 on every district; stable ids when a far building moves |

---

## 12. Order of work, multiplayer notes, open questions

**Order of work.**
1. **Step 0** contract commit (§11.1).
2. **WORLD and MOVEMENT in parallel** (worktrees off step 0). Each ends with `npm run typecheck`, its own tests and
   **one** quick check, then commits on its branch.
   - WORLD: `npm run level -- --all --no-bake`, lint clean, G11 printed per district, one editor screenshot per district.
   - MOVEMENT: the probe on the synthetic canyon with cables, then one sandbox run in the browser (a zip, a charge
     leap, a cable swing).
3. **INTEGRATE** (one pass, any file):
   - merge WORLD, then MOVEMENT;
   - make `rigs` required and wire the structure sliders;
   - `npm run level -- --all`, then `npm run balance -- --all` → chase tweaks, `yankRange`, campaign stars;
   - `LINK_VERSION` 6, controls in PLAY.md and README;
   - `npm test`, `npm run build`, `npm run build:test`;
   - **one** real-time bot round per district in the test build: the catch step must equal Node's prediction, with 0
     console errors;
   - commit. No push, no deploy (the owner's call).
4. **The owner play-tests and hand-tunes** in `?tune` (§9).

**If time runs short,** drop in this order: flow (P2) → stacks and boards (P1) → air carve.
**Keep:** cables, gantries, skybridges, tanks, floating solids, the straight zip, charge (ground, wall, rope, ledge),
the thief's cable swings and leaps, perfect release, rebound, yank, dive, and the versions / re-bake / balance pass.

**Multiplayer readiness** (no netcode, servers, databases or realtime channels this round):
- Every new move reads only the `InputFrame`, the world and "the other body" (today `w.runner`). The yank targets a
  body, so a remote player later is the same call.
- The input record now carries the pitch, so a lockstep or input-relay design can reuse the ghost codec as its wire
  format.
- Tag rules are unchanged (`tagRadius`, Yoink, yank).

**Open for the owner:**
- **Charge button.** Is C the right one? Charging on Jump would delay every ordinary jump until release, which hurts
  alley hops, so it isn't recommended.
- **Yank range per difficulty**, and whether Chill gets the yank at all.
- **Market's structure density.** It stays the parkour district at ~60 % coverage; more cables would make it another
  swing district.
- **Flow.** Should the cap rise +2 m/s per pip (up to 38), or should flow stay out entirely?
