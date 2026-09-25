# RadRun — round 9: movement (design)

**Date:** 2026-09-25 · **Status:** direction for the round 9 build (two parallel builders + one integration pass)
**Owner ask:** "the spiderman swinging is kinda wonky would be cool to also have some parkor stuff like
wallrunning and stuff so its not just swinging and there should also be taller building and have the swining be more
pendulum based like in spiderman instead of just all the balloon web grab points everywhere i want it to be a cleaner
game"

**In one line:** webs stick to **buildings** (rims, corners, facades), a real pendulum does the work, the
balloons go, the city grows into 40-230 m canyons, and between swings you **wall-run, wall-jump, grab ledges,
vault, slide and roll**. The thief does the same. Everything stays deterministic (120 Hz fixed step,
`+ - * / sqrt min max abs floor` only, seeded RNG, fixed iteration order) and every number below is a
`tuning.json` key with a `?tune` slider, so the owner can hand-tune after the build.

Sections: 1 why the swing feels wonky · 2 the new swing · 3 parkour · 4 taller city · 5 balloon removal ·
6 the thief · 7 animations · 8 tuning keys · 9 the builder contract · 10 order of work and checks.

---

## 1. Why the current swing feels wonky (causes found in the code)

| # | Cause | Where |
|---|---|---|
| W1 | **Anchors are low and close.** Balloons hang `hookAbove` 10 m over the higher street roof, on the street midline, every 7 m (`hookSpacing`), grabbable within `aimRadius` 17 m. From a roof edge the rope is 9-17 m and the anchor only ~9 m above you. | `world/derive.ts` deriveHooks, `world/generate.ts` DEFAULT_CONFIG, `sim/tuning.ts` PLAYER |
| W2 | **The rope is shortened and reeled on attach.** `ropeTarget = 0.75 × distance` and a 6 m/s reel. A quick check of a street swing (12 m rope) dips only 1.2-1.4 m below the takeoff roof: it is a yo-yo hop, not a pendulum. | `sim/player.ts` attach(), the rope block after integration |
| W3 | **The reel tugs.** While reeling, any radial velocity above `-reel` is cancelled (`if (vr > -reel) v -= (vr + reel) n`), a constant 6 m/s pull toward the balloon: the "yank". | `sim/player.ts` rope block |
| W4 | **Going taut throws speed away.** Attaching off the tangent removes the radial part of the velocity and keeps nothing. Quick check with a 25 m rope from a 10 m/s run-off: plain projection wobbles for ~7.5 s before it gets anywhere; keeping the speed when the rope first goes taut gives one clean 2.1 s, 36 m arc. | `sim/player.ts` rope block |
| W5 | **The 20 m/s cap is applied every step, on the rope too.** The bottom of the arc can't build speed, and the release boost is capped again next step. | `sim/player.ts` speed cap after forces, `public/levels/tuning.json` speedCap 20 |
| W6 | **Anchors 1 m above you are legal** (`hookMinAbove` 1) and auto-release fires 1 m under the hook: tiny ropes that whip you round the balloon. | `sim/tuning.ts` |
| W7 | **The ring flickers.** pickTarget scores every balloon against a point 7 m ahead / 9 m up, inside the camera's 70° cone, over a 7 m lattice + intersection + sky clusters, with 3 m hysteresis. Turning the camera hops the ring between near-identical balloons. | `sim/player.ts` pickTarget, SKY_SCORE |
| W8 | **Steering fights the pendulum.** `ropeSteer` 5 m/s² pushes along the swing too, so WASD pumps or brakes the arc and the swing feels mushy. | `sim/player.ts` rope steer |
| W9 | **Grazing a facade drops you.** Bonk fires at > 10 m/s with 70 % of the speed into the wall: the rope goes and you are locked 0.35 s. | `sim/player.ts` collision, bonk |
| W10 | **The pose and camera amplify it.** The body hangs from RightHand in a two-hand `Rope_Hang_Idle`, facing follows the tangent of a short rope (fast flips), and the camera leans 25 % toward a hook 10 m away. | `app/ActorsView.tsx`, `camera/rig.ts` ropeBias |

The new swing fixes W1-W3 with high building anchors and no reel (except a floor-safety reel), W4 with
speed-keeping taut, W5 with its own cap, W6 with `anchorMinAbove` 5 m / `ropeMin` 8 m, W7 with one anchor
per building that slides along it, W8 with sideways-only steering, W9 by turning facade contact into a wall
run, and W10 with a one-arm pose and a capped camera lean.

---

## 2. The web swing

### 2.1 Anchors live on buildings (no pre-placed points)

Anchors are found **at run time** from the solids. There are no balloons and no anchor list in the model.
Every step (while not on the rope, not zipping, not ledge-hanging) the sim runs `findAnchor` (§9.3) once:

1. **Forward** `f` (horizontal unit vector) = the aim yaw blended with the velocity:
   `f = norm(aim_xz + anchorVelBias × v̂_xz × min(1, |v_xz| / runSpeed))`. The mouse steers with the camera and
   fast travel keeps anchors ahead of you. Touch already biases aim toward velocity in `buildFrame`.
2. **Ideal point** `P* = p + f × (anchorAhead + anchorAheadPerSpeed × |v_xz|) + up × anchorUp`
   (10 m + 0.5 s × speed ahead, 18 m up: at 20 m/s the ideal point is 20 m ahead and 18 m up).
3. For each solid within `ropeMax` (grid query; copy ids to a private scratch first because `segmentHit`
   reuses `index.out`), take **Q = the closest point of its box to P\***. If Q lands on the roof's top face
   *inside* the footprint, move it to the nearest point on the **rim** (top edge). If P\* is inside the box, push Q to
   the nearest side face. Result: every anchor is a **rim/corner point** (`rim = true`) or a **facade point**,
   never open sky and never the middle of a roof. At a crossing, the closest point of a corner building to a
   diagonal P\* is its corner, so turning corners needs nothing special.
4. **Filters:** `Q.y - p.y ≥ anchorMinAbove` (5 m); `ropeMin` (8) ≤ |Q - p| ≤ `ropeMax` (42); inside the aim cone
   `aimCos` (70°, touch 85°) around `f` (anchors less than 3 m out horizontally pass); a clear line p→Q
   (`segmentBlocked`, skipping that solid and the roof you stand on). Only buildings taller than you + 5 m can
   ever qualify, so on a low roof with nothing tall nearby **there is no anchor**. Run, vault, zip to a ledge
   or drop off instead.
5. **Score** = |Q - P\*| − `anchorRimBonus` (2 m, rims read as ledges) − `hysteresis` (4 m, the ringed building)
   + `anchorAlternate` (3 m, the building you let go of in the last 1.0 s: left-right rhythm). Lowest score wins,
   ties to the lower solid id. As with pickTarget today, check the line of sight only for a candidate that
   beats the best score so far.

The ring is **per building**: `ringId` = the solid id (or `RING_RUNNER` / `RING_NONE` as now) and the point
`ringA` is recomputed every step on that building. The reticle **glides along the facade** instead of hopping.
Yoink targeting is unchanged and still beats anchors.

### 2.2 Pivot, rope length, floor safety

On attach (web held with a ring, holdDelay rules as now):
- **Visual anchor** `ropeA = Q` (the web line is drawn to it). **Physics pivot** `ropeP = Q + n × min(swingOut,
  0.5 × horizontal distance body→face)` with `n` the face's outward horizontal normal (a corner: the normalised
  sum of its two normals). With `swingOut` 5 m the bottom of the arc sits off the wall instead of on it. On a
  25-40 m rope the web line is ~7-10° off the pivot line, which you can't see.
- `ropeLen = |ropeP - p|`. **Floor clamp:** `ropeTarget = max(ropeMin, min(ropeLen, ropeP.y - floor -
  swingFloorClear - halfHeight))` with `floor = groundBelow(ropeP)` (the street, 0). If `ropeLen > ropeTarget`
  it reels at `swingReel` (10 m/s) toward the target, the only reel there is. This is the "optional slight reel":
  it only keeps the arc 6 m above the street.
- **Speed-keeping taut:** the first time the rope goes taut after attach, remove the outward radial velocity and
  then rescale to the speed before, at most `×swingKeepSpeed` (1.6). Later taut steps: plain removal of the outward
  radial part (no inward tug; W3 gone).

### 2.3 The pendulum

On the rope, each step:
- gravity × `swingGravity` (1.35 → 33.75 m/s², a snappier arc);
- **pump:** while below the pivot and descending (`v.y < 0`), add `swingPump` (5 m/s²) along the tangential
  velocity when it is > 2 m/s. Speed builds through the bottom of the arc and stops on the way up, so you never loop;
- **steer:** only the part of the move input perpendicular to both the rope and the tangential velocity (curves
  the swing plane), at `ropeSteer` 4 m/s²; nothing along the swing (W8 gone);
- wind as now (airborne and rope);
- cap: `speedCap` 32 (one cap; ground speed is still set by runSpeed / carryDecay);
- integrate, then the rope constraint (project to the sphere when `dist > ropeLen`, outward radial velocity
  removed);
- **line check** every `losSteps` (12) steps: if body→ropeA is blocked by another solid the web snaps (`EV_SNAP`,
  release without boost);
- **auto-release** (fling) when the body is on the forward side of the pivot, past `swingReleaseCos` (0.64 ≈ 50°
  from straight down) and rising, or above `ropeP.y - autoReleaseBelow` (2.5 m).

Quick numeric check of these numbers (plain 3D pendulum, pivot 16 m ahead / 18 m up / 6 m to the side, off a
roof edge at 10 m/s): one arc of **2.1 s over 36 m**, dipping 6.6 m below the takeoff roof, **27 m/s at the
bottom**, fling 8 m/s forward + 8 m/s up. Chained (entry 22 m/s, pivot 22 m ahead): 1.9 s over 45 m, capped 32 m/s
at the bottom, fling 13 + 13 up. So a chain averages **~21 m/s** along a street (today ~16 m/s).

### 2.4 Release, chaining, no-anchor feedback

- **Let go** (web up): `v += v̂ × releaseBoost` (2) and `+ releaseUp` (3 m/s up while `v.y > -4`). `EV_RELEASE`.
- **Chaining:** holding web keeps swinging. After any release a held web re-attaches to the ringed building once
  `swingRehook` (0.18 s) has passed, so the fling always shows. Tapping web in the air attaches at once.
  `chainCount++` per attach (as now), reset on landing.
- **No anchor:** a web press with no ring does nothing in the sim; the view plays a soft "no" tick and a small
  grey X at the reticle for 0.3 s. Nothing ever attaches to open sky.
- Grounded web press with a ring = jump + attach (`zip` key, kept).

### 2.5 View

- **FxView:** delete the balloon InstancedMesh, strings, pale/popped states and the sky colours. The reticle is a
  ring at `ringA` pushed 0.3 m off the face, facing the camera, scaled with distance (constant screen size ~28 px),
  yellow; green while attached. On a rim anchor, add a short tick along the edge. The web line runs from the RightHand
  to `ropeA` (to `zipP` while zipping), 0.035 m thick. The runner's web goes to his pack anchor (§6.4).
- **Camera:** lean toward the pivot capped at `ropeBiasMax` 3 m (was an uncapped 25 %); `armRope` 9; FOV boost
  maps speed `fovSpeedLo` 10 → `fovSpeedHi` 28 m/s (was 9 → 18, hard-coded); `armWall` 6.5 while wall-running.

---

## 3. Parkour (so it's not just swinging)

All moves are in `stepBody`, deterministic, player **and** thief (except slide: the thief has no slide input).
Only **slide** is a new button. Everything else triggers from contact + speed + the move stick, and jump / web do
the obvious thing in every state.

### 3.1 States (new Body fields)

`wallMode` (0 none / 1 run / 2 run-up), `wallT`, `wallSolid`, `wallNx`, `wallNz`, `wallLo`, `wallHi` (face span),
`lastWall` + `lastWallT` (for kick alternation / grace), `ledgeMode` (0 / 1 hang / 2 climb), `ledgeT`, `ledgeSolid`,
`ledgeX/Y/Z` (grab point), `ledgeNx/Nz`, `slideT`, `rollT`, `slideBuf`, `parkour` (count, for stats). Hashed by
`hashBody` in a fixed order after the existing fields.

### 3.2 Wall run (along facades)

- **Start:** airborne, not on the rope / zipping / hanging; a facade within `wallRunReach` (0.6 m) of the body side
  (query `wallProbe`, §9.3), with at least `wallRunMinBelowTop` (1.5 m) of wall above your feet; horizontal speed
  along the face ≥ `wallRunMinSpeed` (5) and ≥ `wallRunRatio` (1.0) × the speed into it (≤ 45° into the wall);
  `v.y > wallRunFallMax` (−12); not the same wall within `wallRunCooldown` (0.25 s) of leaving it. Snap flush to the
  face, `v.y = max(v.y, wallRunKick)` (3), `EV_WALLRUN`, airJumps recharge.
- **While running** (≤ `wallRunTime` 1.4 s): gravity × `wallRunGravity` (0.2); along-face speed eases toward
  `wallRunSpeed` (11) at `wallRunAccel` (10 m/s²) when slower (faster is kept); into-face velocity 0; stay flush.
- **Ends:** time up (pushed off 2 m/s), past the face span (corner exit keeps velocity), stick pulls away
  (dot(move, n) > 0.5), landing on a roof, **jump** (wall jump), **web** with a ring (attach: swing off the wall).
- **Run-up** (head-on): into-speed > along-speed × 1.5, speed ≥ 6, stick into the wall (dot(move, −n) > 0.7):
  `v.y = wallClimbSpeed` (9) for `wallClimbTime` (0.6 s, ≈ 5 m), then a ledge grab if the top is in reach, else
  it ends like a wall run. Head-on without the stick → bonk (kept, but only at > `bonkMinSpeed` 14 with
  `bonkRatio` 0.85).

### 3.3 Wall jump / wall kick

Jump while wall-running, or within `wallJumpGrace` (0.15 s) of touching or leaving a facade in the air:
`v = n × wallJumpOut (7) + along-face velocity × wallJumpKeep (0.9) + up × wallJumpUp (9.5)`, `EV_WALLJUMP`.
You can't kick off the **same** solid twice in a row. Alternating between two facades climbs a 3-6 m alley,
which is also how you get out of a canyon without a web.

### 3.4 Ledge grab + climb

- **Grab:** airborne (also from a wall run-up), moving into a facade (dot(v_xz or move, −n) > 0.3) within 0.4 m,
  with that solid's top between `feet + ledgeLow` (0.4) and `feet + ledgeHigh` (2.3), `v.y ≤ ledgeMaxVy` (4), and
  the solid landable (roof or prop). The body hangs flush under the rim, velocity 0, `EV_LEDGE`, airJumps recharge.
- **Climb:** after `ledgeHang` (0.2 s) it climbs by itself (flow over stopping): a scripted two-segment path (up to
  `top + halfHeight`, then 0.6 m inward), linear per step, over `ledgeClimbTime` (0.35 s); it ends grounded on that
  roof with `ledgeExitSpeed` (6 m/s) inward, `EV_CLIMB`. **Jump** while hanging = climb-jump (`v.y = ledgeJumpUp`
  7 + 6 m/s inward). **Web** while hanging with a ring = attach. Stick away = drop.
- Reach: a standing jump (1.62 m apex) + `ledgeHigh` climbs **up to ~4 m**, a double jump ~5 m, a run-up ~9 m.

### 3.5 Vault (low obstacles, AC units)

Grounded, horizontal speed ≥ `vaultMinSpeed` (5), a solid side within `vaultLook` (0.8 m) ahead along the velocity
(`obstacleAhead`) whose top is 0.3-`vaultMax` (1.5) m above the feet: `v.y = sqrt(2 g (h + vaultClear))`
(`vaultClear` 0.35), horizontal speed kept, `EV_VAULT`. Physics carries you over (a deep box = you land on it and run
on). Taller obstacles are ledge-climb or run-up targets.

### 3.6 Slide

Button **C** (desktop) / **SLIDE** (touch, small, left of JUMP). Grounded at ≥ `slideMinSpeed` (6): `slideT =
slideTime` (0.8 s). Speed decays at `slideDecay` (3 m/s²) instead of `carryDecay`, sideways steering only at
`slideSteer` (6 m/s²), `EV_SLIDE`. **Jump out of a slide** = jump + `slideJumpFwd` (2.5 m/s) forward. Sliding off a
roof edge keeps the slide speed in the air. Pressing slide in the air buffers it for `slideBuffer` (0.25 s): landing
then goes straight into a slide (the speed-keeping landing). The collision box does not shrink (nothing to slide
under in an AABB city).

### 3.7 Landing roll / stumble

- Landing with `landVy < rollMinVy` (−15), horizontal speed ≥ 6 and the stick along the velocity (dot ≥ 0.3) or a
  buffered slide: **roll**. No carry decay for `rollTime` (0.45 s), `EV_ROLL`.
- Landing with `landVy < stumbleVy` (−24) without a roll: **stumble**, horizontal speed × `stumbleKeep` (0.4),
  locked `stumbleLock` (0.35 s) (reuses `bonkT`), `EV_BIGLAND` (the Big_Land clip). Otherwise a normal landing.

### 3.8 Inputs and how things chain

| Input | Ground | Air | Rope | Wall run | Hang |
|---|---|---|---|---|---|
| Space / JUMP | jump (slide-jump if sliding) | wall kick if a facade is in grace, else double jump | (nothing) | wall jump | climb-jump |
| LMB / WEB (hold) | ring: jump + attach | attach / keep chaining | swing, let go = fling | attach (leave the wall) | attach |
| E, Shift / ZIP | web zip | web zip | — | web zip | — |
| C / SLIDE | slide | buffer the landing slide | — | — | — |
| stick | run | air control | sideways steer | away = let go, into = run-up | away = drop |

Loops this makes possible: swing → fling → wall run on the next facade → web off the wall → swing; swing → roll on a
roof → slide → slide-jump → vault → jump the alley → ledge grab → climb → web; fall into a canyon → wall kicks /
run-up → ledge → roof.

**Kept / adapted / dropped:**
- **Double jump: kept** (`airJumps` 1). It also recharges on wall-run start and ledge grab.
- **Web zip: kept, adapted.** The target is the ringed anchor point. A rim anchor ends as a **ledge zip onto that roof**
  (the existing `zipLedgeSpeed/zipLedgeUp` launch); a facade anchor ends at the wall and starts a wall run in the aim
  direction when fast enough, otherwise the old fling. With no ring it zips to the roof ledge along the aim, as now.
  Cooldown as now.
- **Zip-on-press (grounded web = jump + grab): kept.**
- **Bonk: kept only for head-on hits** at > 14 m/s without the stick into the wall. Everything else becomes a wall run
  or a run-up.
- **Easy grab / touch rules: kept** (touch aim cone 85°, +1 m Yoink, velocity-biased aim).

### 3.9 Falling

Remove `failBelowLowestRoof`. `EV_FALL` fires when the feet drop below **`failFloor` (2 m above the street)**.
Arcs can now dip well below roof level into the canyon, so a fall means actually hitting the street. Falls respawn as
today (last safe **roof**: only `kind: "roof"` updates `lastSafeRoof`, never a prop), −3 s, one-life rules unchanged.

---

## 4. Taller buildings (WORLD)

### 4.1 Generator shape (grid districts)

The same block lattice (2 × 2 buildings per block), bigger and taller:
- **Podium heights per block:** each block gets a base height from the smooth field in `[roofMin, roofMax]`. The
  buildings of a block are base + a seeded step from `{0, 0, 0, +1, −1, +2.5, +3.5, −7, −12}`. Alley hops within a block
  are then flat hops, climbable steps (≤ 3.5 m) or drops (≥ 6 m), never an awkward 3.5-6 m step. Neighbouring blocks
  contrast freely (the canyon walls).
- **Towers:** non-landable `kind: "tower"` spines, footprint inset 2 m, `towerMin`-`towerMax`, spread apart as now.
- **Anchor coverage fix-up (G1):** after heights, every landable roof edge that faces a street must have a solid whose top
  is ≥ that roof + 12 m within 34 m (horizontal box distance). Where one is missing, turn the best non-junction building
  across or along that street into a tower of `roof + 25..60 m`. Only landable roofs need coverage, so this converges.
- **Wall-run gaps (G4):** in `wallGapChance` of blocks the back row is one merged taller slab W (+4..+12 m) and the front
  two roofs A, B **touch W's face** (no row alley) with an 8-11 m notch between them, so W's face lines the notch. Listed
  in `model.wallGaps`.
- **Solid props (G3):** AC units, crates and vents at 0.8-1.4 m (vault) and bulkheads, water tanks and container stacks
  at 2.2-3.2 m (climb) become `kind: "prop"` solids (ground-rooted boxes inside a roof footprint, top = roof + h). Anything
  on a roof that reaches 0.5 m or more and that you can touch must be solid ("what you see is solid"). Smaller bits stay decor.
- **Streets** 16-24 m (canyons), alleys 3-6 m, the street floor at y = 0 (water at 0 in the Docks).

### 4.2 Districts

| District | Feel | Lattice (block / building / alley / street) | Roofs (podium) | Towers | Extras |
|---|---|---|---|---|---|
| **Downtown** (Midtown) | the classic, now a canyon city | 6×5 · 42 / 18.5 / 5 / 22 | 40-80 m | 8 × 140-220 m + coverage | wall gaps 0.2, ~1.5 props/roof |
| **Night Market** | **the parkour district**: dense, low, few anchors | 8×6 · 26 / 11 / 4 / 12 | 18-32 m, steps favour climbs (+2.5/+3.5) | 6 × 55-90 m at plazas (swing only near them) | wall gaps 0.3, ~2.5 props/roof; G1 coverage is a *warning* here |
| **The Docks** | low sheds, cranes, long pendulums over the water | 7×3 · 34 / 15 / 4 / 18 | 12-22 m | 6 crane masts (4×4 m, 55-80 m) on the quay + 3 offices 70-100 m | container stacks (climb), crates (vault); wind stays the default |
| **The Towers** (Financial District) | the Manhattan showcase: deepest canyons | 7×6 · 44 / 19.5 / 5 / 24 | 70-120 m | 12 × 160-230 m | wall gaps 0.25; ropes 30-42 m; default mutator none (was pops) |
| **Vertigo** | the spiral descent, as round 7 | helix as now | rings 22-86 m as now | needles 5 × 150-220 m (was 3 × 120-170) | no sky hooks / low tiers; anchors = the higher rings' cliff faces + needles |

Looks: fog far ≥ 700 m (Towers 900), skyline ring boxes 80-300 m at 420-650 m, camera far stays 1500, the sun
keeps its direction. Blurbs lose the balloons (Downtown: "Canyons of glass and brick. Swing the avenues.";
Market: "Low, dense rooftops. Vault, climb, wall-kick. Few places to web."; Towers: "The deepest canyons in town.
Long ropes, big swings."; Vertigo: "… drop, dive, web the needles on the way down.").

### 4.3 WORLD guarantees (checked by `lintModel`, `npm run level`)

- **G1 anchor coverage** as in 4.1 (error; a warning in Market and Vertigo).
- **G2 runnable roofs:** landable roofs ≥ 12 × 12 m (Market 10 × 10); alley neighbours differ by ≤ 1.2 (hop), 1.2-3.5
  (climb) or ≥ 6 m (drop).
- **G3 props:** `kind: "prop"`, `landable: true`, ≥ 2.5 m inside the roof edges, ≥ 3 m from the roof centre (junction
  point), ≥ 3 m apart, ≤ 3 per roof, clear of decor footprints (billboards, the Milady's stand). Props are **excluded**
  from adjacency / facingPairs, junction candidates, spawn, `lowestRoof` and the coverage rule. Low quality
  (`quality.tsx`) never hides a solid prop (it may still hide decor-only AC units / antennas).
- **G4 wall gaps:** `a`, `b` landable with |Δh| ≤ 1; `wall.top ≥ max(a, b).top + 3`; `a` and `b` flush with the wall
  face (±0.01 m); the face spans the whole notch + 1 m each side; notch 8-11 m.
- **G5 no balloons:** `model.hooks` is `[]` in every district; `"hook"` nodes in city.json are ignored with a warning.
- **G6 heights:** landable 10-140 m, towers ≤ 230 m, street / water at y = 0.
- **G7** ≥ 14 junction candidates per district; `spawn`, `bounds`, `adjacency` and `junctionCandidates` keep their meaning.
- **G8** every solid is an unrotated ground-rooted box (y0 = 0), as today.

---

## 5. Balloons: removed everywhere

| What used them | Where | Replacement |
|---|---|---|
| Street balloons, intersection balloons, lower street tiers, balloon-free gaps, manual hooks | `derive.ts` deriveHooks, `CityConfig` hookSpacing / hookAbove / hookClearance / autoHooks / hookGapChance / lowTierDh, `fromPrefab.ts` "hook" nodes | Building anchors (§2.1). `hooks: []` this round; the `Hook` type and field are deleted at integration. Market's "no balloon" stretches become low-rise stretches with no anchors (G1 warning) |
| Sky balloon clusters (Towers, Vertigo) | `derive.ts` skyHooks, `CityConfig.sky`, `Hook.reach`, `player.ts` SKY_SCORE | Towers / needles / crane masts as anchors |
| Aiming and attaching | `player.ts` pickTarget, attach, `SimWorld.hooks`, `forceHook`, `Body.ropeHook` | `findAnchor`, `Body.ropeSolid / ropeA / ropeP / ringA`, `SimWorld.forceAnchor` |
| Web zip to a balloon | `player.ts` zipTarget kind 1 | Zip to the ringed anchor point (rim = ledge launch) |
| Pops mutator: fragile balloons, `hookDown`, `EV_POP`, pale/popped FX, pop SFX, `MECH.popShare/popRespawn` | `round.ts`, `player.ts`, `FxView.tsx`, `sfx.ts`, `catalog.ts`, `mutators.ts` | **Snapping webs** (same bit 1, id `snap`): every web snaps after `MECH.snapTime` 1.6 s on the rope (`EV_SNAP`, the pop samples reused as the snap sound). Blurb: "Your web snaps after 1.6 s. Chain fast." |
| Free-play mutator defaults | `mutators.ts` DISTRICT_MUTATORS towers: pops | Towers 0, Docks wind (kept) |
| Campaign | `campaign.ts` L3 Pop Quiz, L10, L11, L12, L15 (M_POPS); L4 / L14 blurbs | M_SNAP; new blurbs (L3 "Snap Quiz": "Webs snap after 1.6 s. Keep them short."; L4 "Neon Alleys": "Low roofs, few anchors. Vault, climb and wall-kick."; L14: "Dive after him and web the needles on the way down.") |
| Runner swings on street balloons | `graph.ts` Link.hooks / streetHookInset / swingHookAbove, `bot.ts` forceHook, pack rope `ref` = hook id | Links carry a baked anchor; pack v2 anchor table (§6) |
| Balance swing bot | `bots.ts` SwingBot (lane balloons, rescue grab, sky checks) | Holds web along lanes and lets the sim's auto-release fling; rescue = web to any ring / run-up |
| Views reading `model.hooks[ropeHook]` | ActorsView, GhostView, PlayerView, CameraView, autoplay, BotDriver, RouteView, PlayViews, SimDriver, probe-canyon, shot | `b.ropeA` / `b.ropeP` |
| Tips, controls text, touch labels | `hints.ts`, `screens.tsx`, `SandboxPage.tsx`, `TouchControls.tsx` | "hold LMB/WEB to web the building ahead", "let go at the bottom to fling", "chain swings down the avenues", "run along a wall to wall-run, Space to kick off", "C to slide" |
| Night mutator blurb "glowing balloons" | `mutators.ts` | "glowing windows" |
| Decor balloons | Milady's balloon stand (`gen-city.ts` defaultDecor), favicon | **Kept.** A shop prop and the brand icon, not grab points |

---

## 6. The thief (runner)

### 6.1 How he moves

Same sim, `runnerFrom(player)`: no air control, no steer, no Yoink, no double jump / web zip, **no slide** (added to
`MOVES_OFF`, and slide keys to `MOVE_KEYS`). Wall run, wall jump, ledge grab / climb, vault and roll are automatic, so
they are part of his baked tracks.

**Hop kinds** (`route/graph.ts`, from adjacency + `model.wallGaps`, props excluded):

| Kind | When | Bot inputs (swept param) |
|---|---|---|
| `alley` | alley gap, Δh ∈ [−6, +1.2] | jump step (as now) |
| `climb` | alley gap, Δh ∈ (+1.2, +3.5] | jump step; the sim's ledge grab + climb finish it |
| `drop` | alley gap, Δh ≤ −6 | walk-off pace (as now) |
| `swing` | street gap, Δh ∈ [−40, +4], with a baked anchor | jump at the edge, web held with `forceAnchor`, release step |
| `wallrun` | a `wallGaps` entry, either direction | jump step with the lateral held 0.2 m off the wall face and a small push into it; optional kick step |

- **Baked anchor:** at graph time, `findAnchor` from the takeoff point (edge, lateral centre of the span, standing) with
  `f` = the hop direction and speed = runSpeed. No anchor → no link. The link stores the whole `AnchorHit` (solid,
  visual point, pivot). Deterministic.
- Vaults happen by themselves on roof legs (props are ≥ 2.5 m from edges and 3 m from junction points, G3), so a roof leg
  that crosses a prop shows him vaulting.
- The bake (`route/bake.ts`) keeps its windows. The swing window uses the release sweep as now (360 steps; arcs ~2 s).
  For wallrun / climb the jump sweep uses `alleyWindow`. EV_WALL / EV_BONK stop failing a hop while `wallMode` or
  `ledgeMode` is on (planned contact); any other wall contact still fails it.
- Graph: `GRAPH.junctions` 12 (Vertigo 14) as now, `maxHops` 7 → 8 (bigger blocks), `minHops` 3. `alleyClimbMax`
  1.2 → 3.5 (climb), `streetClimbMax` 4.5 → 4.

### 6.2 Pack format v2 (`route/trackPack.ts`)

- `PackHeader.version: 2` + `anchors: number[]` (flat x, y, z in cm, visual anchor points). On the rope, `ref` = an index
  into it (was a hook id).
- New phases: `PHASE_WALL = 3` (ref = wall solid) and `PHASE_LEDGE = 4` (ref = solid). New events `EVT_VAULT = 5`,
  `EVT_ROLL = 6`, so the runner's animations can play the same clips as the player's.
- The pack decoder rejects version-1 packs (the city hash changes anyway).

### 6.3 Balance (keep the existing bands)

`npm run balance -- --all` per district after the bake, the same targets as `tools/balance.ts`:
- normal follow k = 1.0: ≤ 5 % caught · k = 1.2: median 35-70 s · chill follow k = 1.0: ≥ 90 % caught, median 60-75 s ·
  normal camper: < 25 % caught;
- swing bot: chill forgiving (~95-98 %, ~10 s median), **normal median 25-40 s**, **degen 50-95 % caught, median 40-70 s**.

Swings are ~30 % faster for both of them, so expect to retune the per-district `chase` tweaks (spawn 22 + 4 m will
likely want 30 + 6 m) and `gStar` / `mMax`. The runner's speed is baked; the rubber band does the rest. The **SwingBot**
plays the new moves: it holds web along street lanes (its lane planner stays), lets the auto-release fling, re-holds after
`cooldown` steps, and near him drops the rope and Yoinks as now. With `moves` on it also wall-runs by steering along facades
and slides after landings.

### 6.4 Campaign, links, ghosts

- **Stars:** redo every "under N s" star with the swing bot per level (district tweak + mutators), using the round 6 rule:
  the bot gets it in ~60-85 % of rounds, ~30 % on the Degen finale (L12) and L15. Chain objectives stay (chains are easier
  now: consider n + 1). **New objective** `{ kind: "parkour"; n }` = n parkour moves (wall runs + wall jumps + ledge
  climbs + vaults + slides) in the round (`RoundStats.parkour`). Use it on L4 Neon Alleys (n = 6, replacing "under 25 s")
  and L9 Last Call (n = 4, replacing closeCall).
- **Links:** `LINK_VERSION` 3 → **4** (one bump for the new city + sim). Older links open with the existing "made on an
  older build" note; their ghosts are not raced.
- **Ghost record FORMAT 3:** bits + `B_SLIDE` (16). Formats 1-2 still decode (moves off / no slide) but only v < 4 links
  carry them. Stored PB ghosts from before v4 are dropped on load (kept bests stay listed as "old city").

---

## 7. Animations

Clips bind by bone name across the four Radbros. A clip bought on one rig is retargeted by bone name onto the other three,
the way the #652 remake got #723's clips. Preset keys and ids are from the preset library's `anim_library.json` (outside
the repo). **Build the procedural fallbacks first** so the round ships without purchases; clips swap in afterwards.

| Move | Clip (preset key, id) | Procedural fallback (existing clips) |
|---|---|---|
| Web swing (one arm) | keep `Grab_Bar_and_Swing_Forward` (first 0.35 s) → `Rope_Hang_Idle`, plus a **bone pass**: RightArm + RightForeArm aimed along the web at `ropeA`, LeftArm swept back 35°, hips pitched with the swing phase (±20°: lean forward on the downswing, tuck on the upswing), facing = the swing tangent smoothed at 6 rad/s | this is the plan (no purchase) |
| Wall run | `diagonal_wall_run` (445), loop | `Run_02` at speed / 9, root rolled 35° toward the wall |
| Wall run-up | `climbing_up_wall` (444) | `Run_02` pitched back 60° (feet on the wall) |
| Wall jump | — | `Regular_Jump` from takeoff at rate 1.3 + a yaw snap to the jump direction |
| Ledge grab / hang | `Jump_and_Grab_Wall` (448), frozen on its hang frame | `Rope_Hang_Idle`, root flush with the wall, both hands on the rim (hand correction) |
| Ledge climb | `Ladder_Climb_Finish` (435) or the end of `climbing_up_wall` (444): look at the preview GIFs first | `Regular_Jump` takeoff → apex at rate 2.2 while the root follows the sim path |
| Vault | `Parkour_Vault` (429) (alt `Unarmed_Vault` 428) | `Regular_Jump` from takeoff at rate 1.6 (tuck) |
| Slide | `slide_light` (516) (alt `sliding_rool` 518) | `Big_Land` frozen at its deepest crouch (`freezeAt`) + root pitched back 20° |
| Landing roll | `Roll_Dodge` (158), **already owned** in #2564's pack: retarget by bone name onto #652 / #4764 / #723 (no purchase) | `Big_Land` cut at 0.35 s |
| Stumble | `Big_Land` (owned) | — |

Purchase priority (3 credits a preset): 445 wall run, 429 vault, 516 slide, 448 ledge grab, then 444 / 435. `animMachine` gets
bits `A_WALLRUN`, `A_WALLJUMP`, `A_LEDGE`, `A_CLIMB`, `A_VAULT`, `A_SLIDE`, `A_ROLL`, `A_BIGLAND` and the locomotion rule "wall
state → wall clip, ledge state → hang clip"; the runner gets them from pack phases / events. `npm run assets --
--packs-only` then `--meta-only` after any clip change.

---

## 8. Tuning keys (all in `tuning.json` → `player` / `camera` / `mechanics`, all with `?tune` sliders)

**Changed:** `speedCap` 20 → 32 (15-45) · `carryDecay` 12 → 8 · `releaseBoost` 3 → 2 · `autoReleaseBelow` 1 → 2.5 ·
`ropeSteer` 5 → 4 (sideways only) · `hysteresis` 3 → 4 · `bonkMinSpeed` 10 → 14 · `bonkRatio` 0.7 → 0.85 ·
camera `armRope` 8 → 9.

**Removed:** `aimRadius`, `hookMinAbove`, `scoreAhead`, `scoreUp`, `ropeScale`, `reelSpeed`, `failBelowLowestRoof`;
mechanics `popShare`, `popRespawn` (tuning.json loading already warns and skips unknown keys).

**New, with starting values and slider ranges:**

| Group | Key = start (min-max) |
|---|---|
| Anchor search | `ropeMin` = 8 (4-15) · `ropeMax` = 42 (20-60) · `anchorMinAbove` = 5 (2-12) · `anchorAhead` = 10 (0-25) · `anchorAheadPerSpeed` = 0.5 (0-1.5) · `anchorUp` = 18 (6-35) · `anchorVelBias` = 0.6 (0-1.5) · `anchorRimBonus` = 2 (0-8) · `anchorAlternate` = 3 (0-8) |
| Pendulum | `swingOut` = 5 (0-10) · `swingFloorClear` = 6 (2-15) · `swingReel` = 10 (0-25) · `swingGravity` = 1.35 (1-2.5) · `swingPump` = 5 (0-15) · `swingKeepSpeed` = 1.6 (1-2.5) · `swingReleaseCos` = 0.64 (0.2-1) · `swingRehook` = 0.18 (0-0.5) · `releaseUp` = 3 (0-8) · `losSteps` = 12 (1-60) |
| Wall | `wallRun` = true · `wallRunReach` = 0.6 (0.2-1.5) · `wallRunMinSpeed` = 5 (2-12) · `wallRunRatio` = 1 (0.3-3) · `wallRunMinBelowTop` = 1.5 (0-4) · `wallRunFallMax` = −12 (−25-0) · `wallRunTime` = 1.4 (0.3-3) · `wallRunSpeed` = 11 (6-20) · `wallRunAccel` = 10 (0-30) · `wallRunGravity` = 0.2 (0-1) · `wallRunKick` = 3 (0-8) · `wallRunCooldown` = 0.25 (0-1) · `wallClimbSpeed` = 9 (4-15) · `wallClimbTime` = 0.6 (0.2-1.5) · `wallJumpOut` = 7 (2-14) · `wallJumpUp` = 9.5 (4-15) · `wallJumpKeep` = 0.9 (0-1.2) · `wallJumpGrace` = 0.15 (0-0.4) |
| Ledge | `ledgeGrab` = true · `ledgeLow` = 0.4 (0-1.5) · `ledgeHigh` = 2.3 (1-3.5) · `ledgeMaxVy` = 4 (−5-12) · `ledgeHang` = 0.2 (0-1) · `ledgeClimbTime` = 0.35 (0.1-1) · `ledgeExitSpeed` = 6 (0-12) · `ledgeJumpUp` = 7 (3-12) |
| Vault | `vault` = true · `vaultMax` = 1.5 (0.5-2.5) · `vaultLook` = 0.8 (0.2-2) · `vaultMinSpeed` = 5 (1-12) · `vaultClear` = 0.35 (0-1) |
| Slide | `slide` = true · `slideMinSpeed` = 6 (2-12) · `slideTime` = 0.8 (0.2-2) · `slideDecay` = 3 (0-15) · `slideSteer` = 6 (0-15) · `slideJumpFwd` = 2.5 (0-8) · `slideBuffer` = 0.25 (0-0.6) |
| Landing | `rollMinVy` = −15 (−30 to −5) · `rollTime` = 0.45 (0-1.2) · `stumbleVy` = −24 (−40 to −10) · `stumbleKeep` = 0.4 (0-1) · `stumbleLock` = 0.35 (0-1) |
| Fall | `failFloor` = 2 (0-10) |
| Camera | `ropeBiasMax` = 3 (0-8) · `armWall` = 6.5 (3-12) · `fovSpeedLo` = 10 (0-20) · `fovSpeedHi` = 28 (10-45) |
| Mechanics | `snapTime` = 1.6 (0.5-4) |

Angles are stored as cosines (`swingReleaseCos`, `aimCos`), so the sim never calls trig and replays match across
browsers. Any change to a key the thief uses means re-bake (`npm run level -- --all`) + `npm run balance`, as today.

---

## 9. The contract between the two builders

Two builders work in parallel on separate branches off `main` (this spec's commit): **MOVEMENT** and **WORLD**. Each edits
**only its own files** below. A file on neither list is off limits until INTEGRATE (§10). Each branch must typecheck and
pass its own tests on its own, without the other branch.

### 9.1 MOVEMENT owns

- Sim: `src/sim/player.ts`, `src/sim/tuning.ts`, `public/levels/tuning.json` (player / camera / mechanics sections).
- **New file `src/world/cityQuery.ts`** (the anchor / wall / ledge / obstacle queries, §9.3).
- Input + ghosts: `src/input/input.ts`, `src/ui/TouchControls.tsx`, `src/game/ghost.ts`, `src/ui/prefs.ts`.
- Game: `src/game/{round,play,sandbox,bots,campaign,mutators}.ts`.
- Runner: `src/route/{graph,bot,bake,trackPack}.ts`, `src/runner/runner.ts`.
- Views: `src/anim/animMachine.ts`, `src/app/{ActorsView,GhostView,PlayerView,FxView,CameraView,PlayViews,SimDriver,
  SandboxPage}.tsx`, `src/app/autoplay.ts`, `src/camera/rig.ts`, `src/app/dev/{BotDriver.ts,RouteView.tsx,TunePanel.tsx}`.
- UI text + audio: `src/ui/{hints,strings,store}.ts`, `src/ui/screens.tsx`, `src/audio/{sfx,catalog}.ts`.
- Clips: `tools/assets.ts`, `public/models/*.clips.glb`, `src/generated/clips.meta.json`.
- Tools: `tools/{balance,probe-canyon,botshot,shot}.ts`.
- Tests: `test/{sim,moves,proto,round,ghost,anim,bots,mechanics,campaign,route,determinism,input,hints,audio}.test.ts`,
  `test/helpers.ts`, `test/fixtures/proto/*`.

### 9.2 WORLD owns

- `src/world/{cityModel,generate,derive,districts,fromPrefab,toPrefab,level,billboards}.ts`, `src/app/district.ts`.
- `tools/{gen-city,level,gen-props,restyle-city,gen-textures,billboards,icons}.ts`.
- Level data: `public/levels/**/city.json`, `decor.json`, `city.model.json` (**not** `runner.pack.bin` /
  `bake.report.json`: INTEGRATE bakes). Sky art `public/sky/*`, facade textures.
- Look: `src/app/{cityLook,GameScene,quality,Milady,Sign,FlatLook}.tsx`, `src/app/dev/EditorPage.tsx`.
- Tests: `test/{city,districts,vertigo}.test.ts`.
- `districts.ts` `chase` tweak **numbers** are set at INTEGRATE (WORLD leaves them as they are).

### 9.3 Queries MOVEMENT adds (`src/world/cityQuery.ts`, over the existing CityIndex API)

```ts
import { CityIndex, slab } from "./cityModel.ts";
import type { Tuning } from "../sim/tuning.ts";

/** A web anchor on a building: visual point (a*), physics pivot (p*), face normal, rim/corner flag. */
export type AnchorHit = {
  solid: number; ax: number; ay: number; az: number; px: number; py: number; pz: number;
  nx: number; nz: number; rim: boolean; score: number;
};
export const emptyAnchor = (): AnchorHit => ({ solid: -1, ax: 0, ay: 0, az: 0, px: 0, py: 0, pz: 0, nx: 0, nz: 0, rim: false, score: 0 });

/** §2.1 search. (x, y, z) body centre; (fx, fz) unit forward; speed = |v_xz|; ringSolid = hysteresis;
 *  lastSolid (-1 = none) = the building let go of in the last 1.0 s; skipRoof = the roof stood on (-1 airborne).
 *  Fills out (pivot included, §2.2), returns false when nothing qualifies. Allocation-free. */
export function findAnchor(idx: CityIndex, x: number, y: number, z: number, fx: number, fz: number, speed: number,
  k: Tuning, ringSolid: number, lastSolid: number, skipRoof: number, out: AnchorHit): boolean;

/** A vertical side face of a solid near the body. */
export type FaceHit = { solid: number; nx: number; nz: number; dist: number; top: number; lo: number; hi: number };
export const emptyFace = (): FaceHit => ({ solid: -1, nx: 0, nz: 0, dist: 0, top: 0, lo: 0, hi: 0 });

/** Nearest side face within `reach` of the body's side (half width hw) that spans feet..feet+1.8; lo/hi = its
 *  extent along the face tangent. Ties -> lower solid id. */
export function wallProbe(idx: CityIndex, x: number, feet: number, z: number, hw: number, reach: number, out: FaceHit): boolean;

/** First side face hit moving from (x, z) along unit (dx, dz) within `look` at feet+0.1..feet+1.6 (vault / climb check). */
export function obstacleAhead(idx: CityIndex, x: number, feet: number, z: number, dx: number, dz: number, look: number,
  hw: number, out: FaceHit): boolean;

/** A grabbable ledge: the face the body presses into (unit -n = into it) whose landable top is in [feet+lo, feet+hi]. */
export function ledgeAt(idx: CityIndex, x: number, feet: number, z: number, hw: number, nx: number, nz: number,
  lo: number, hi: number, out: FaceHit): boolean;
```

Rules for these functions: sqrt-only maths, fixed ascending-id iteration, no allocation in the hot path (module
scratch arrays). They **copy `idx.out` into a private scratch** before calling `segmentHit` / `segmentBlocked`, because
those overwrite `idx.out`. They treat any `kind` the same way (they read `landable` and `top`), so WORLD's new `"prop"` kind
needs no change on this side.

**Existing CityIndex API that WORLD must not change this round:** `solids`, `nearbySolids(x0, z0, x1, z1) → count
in out`, `out`, `segmentHit`, `segmentBlocked`, `ledgeAlong` + `ledgeT`, `groundBelow`, `roofAt`, `slab()`,
`pointBoxDist()`, `GRID`; `Solid {id, kind, landable, x0, z0, x1, z1, top, node?}`; `CityModel {version, config,
bounds, lowestRoof, solids, hooks, adjacency, junctionCandidates, spawn, hash}`; `Adjacency`.

### 9.4 Model changes WORLD makes (`src/world/cityModel.ts`)

```ts
export type SolidKind = "roof" | "tower" | "prop";   // prop: rooftop obstacle (G3), landable, never in adjacency

/** A notch between two roofs lined by a taller wall (the thief's wall-run hop; G4). Listed once, both directions usable. */
export type WallGap = {
  a: number; b: number;     // landable roofs; a -> b along +dir on `axis`
  wall: number;             // the taller solid whose face lines the notch
  axis: "x" | "z";          // travel axis
  dir: 1 | -1;
  edge: number;             // a's takeoff edge on the axis
  far: number;              // b's near edge on the axis
  face: number;             // the wall face coordinate on the other axis
  side: 1 | -1;             // that face's outward normal sign on the other axis (points into the notch)
};

// CityModel gains:  wallGaps?: WallGap[];   (optional this round; INTEGRATE makes it required)
// CityModel.hooks stays (always []) and Hook stays as a deprecated type until INTEGRATE deletes both.
```

MOVEMENT must compile without WORLD's branch: in `graph.ts` it reads
`(m as { wallGaps?: WallGapLike[] }).wallGaps ?? []` with a local `WallGapLike` that has exactly the fields above
(structurally identical). INTEGRATE swaps it for the imported type. MOVEMENT never reads `model.hooks`.

### 9.5 What each side may assume

- **MOVEMENT assumes** only the geometry rules G1-G8 (§4.3). It tests on synthetic tall cities built in `test/helpers.ts`
  (`deriveModel` from main plus hand-placed solids: a 22 m canyon between 50 m roofs with an 80 m tower, a wall-gap
  notch, a roof with a 1.2 m and a 2.8 m prop) and, in the browser, on the current `?map=towers` (roofs 38-52, towers
  90-130). Anchors come from the solids, so the swing works on any city, including main's.
- **WORLD assumes** nothing from MOVEMENT. It runs `npm run level -- --all --no-bake` (a new flag WORLD adds to
  `tools/level.ts`: derive + lint + write `city.model.json`, skip the bake) and never commits packs. Its lint uses only
  geometry, not `findAnchor`.

---

## 10. Order of work and checks (owner: "build, one quick check, commit")

1. **MOVEMENT** and **WORLD** in parallel (worktrees off this commit). Each finishes with `npm run typecheck` + its own
   tests + **one** quick check, then commits on its branch. MOVEMENT: `npm run probe:canyon` reworked to print the
   chained speed along a Towers avenue (target ~20-24 m/s) + one sandbox swing in the browser. WORLD: `gen-city --force`
   per district, lint clean (G1 warnings only in Market / Vertigo), one editor screenshot per district.
2. **INTEGRATE** (one pass, any file): merge WORLD, then MOVEMENT; delete `Hook` / `hooks` / `forceHook`; make
   `wallGaps` required; `npm run level -- --all` (re-bake every district; bake checks strongly connected, no forced
   U-turns, swing / alley / drop windows); `npm run balance -- --all` → set `districts.ts` chase tweaks and campaign
   stars (§6.3-6.4); `LINK_VERSION` 4; PLAY.md controls; `npm test`, `npm run build`; **one** real-time bot round in the
   test build per district = the Node-predicted catch step, 0 console errors. Commit. No push / deploy (the owner's call).
3. The owner hand-tunes in `?tune` (§8) and the editor; any change to a thief-facing key → `npm run level -- --all` +
   `npm run balance`.

**Open for the owner:** whether the thief should also slide (needs a bake input, not planned); whether Market should keep a
little swinging (G1 as a warning) or none; the new "parkour n" objective on L4 / L9.
