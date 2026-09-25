Working title at the time: Rug Run (now RadRun).

# Rug Run — design spec (v2)

**Status:** approved design, revised after review · **Date:** 2026-09-24
**Engine:** [react-three-game](https://prnth.com/react-three-game/) by prnth, pinned to exactly `0.0.113`
**Home:** `github.com/dexedrne/rug-run` (public, pseudonymous — see §15)

## 0. Inputs

Everything a developer needs before M0. Source locations on the owner's machine are listed in the
private (untracked) implementation plan, never in this public repo. M0 copies them in so the repo is
self-contained.

| Input | What | Lands in (M0) |
|---|---|---|
| 2D rope-sim prototype | `kinematic.ts` (fixed-step rope sim), `level.ts` (level, tuning, `pickAnchor`, body half-extents), the tuned scripted input run | `test/fixtures/proto/` (verbatim, read-only) |
| Expected trace | per-step state of the prototype's tuned scripted run (1,316 steps, 10.97 s), dumped by running the prototype once in M0 | `test/fixtures/proto/trace.json` |
| Animator + FlatLook | prototype r3g components (mixer on AnimatedModel's clone, crossfades, one-shots, clip libraries; unlit look) | `src/app/Animator.tsx`, `src/app/FlatLook.tsx` |
| Radbro #652, #4764, #2564 | owner's rigged GLBs, `delivery/radbro{652,4764,2564}_animations.glb` (**never** the `final/` set) | processed by `tools/assets` → `public/models/` |
| Owned clips | `radbro{652,4764}_fishing.glb`, `radbro{652,4764}_waltz.glb` (delivery set) | folded into per-character clip packs |
| George | owner's cat asset: `george_animations.glb` + `george_clips.json` | processed by `tools/assets` → `public/models/` |
| Milady prototype | `VrmModel.tsx`, `loadVrm.ts`, `retarget.ts` (Radbro→VRM humanoid retarget with A→T rest alignment) | `src/app/VrmModel.tsx`, `src/vrm/` |
| Bag, rug, balloons | procedural geometry — no asset files | — |

## 1. Pitch

The runner has swiped your bag. You pick your Radbro (#652, #4764 or #2564) and get **90 seconds**
to chase one of the other two across a rooftop city in free third-person 3D — running, hopping alleys
and **swinging from balloons** — with **George**, your black cat, bounding after you. Tag him or
**YOINK** him before a flying rug swoops in and he escapes. *"He rugged you."*

- Desktop-first (mouse + keyboard). Touch is a post-v1 stretch.
- Short rounds, instant retry, shareable challenge links.
- A static site on Vercel. No backend: nothing leaves the client.

Tone: Radbro and crypto humour only — no borrowed references from other games (items, lines, UI
styling).

## 2. Cast

| Character | Source | Role |
|---|---|---|
| Radbro #652 | owner's rigged GLB (24-bone auto-rig, bone names `Hips > Spine02 > Spine01 > Spine > neck`, A-pose) | playable / runner |
| Radbro #4764 | same rig layout, different bind pose (Hips ≈ 110°, RightHand ≈ 40°) | playable / runner |
| Radbro #2564 (GHOST) | same pipeline: tin-foil hat + kufi, aviators, ghost-white, "RAD RESPONSE" vest | playable / runner |
| George | owner's black cat: quadruped, Blender cat skeleton, scripted clips | player's sidekick (§10) |
| A Pockit Milady | prnth's Pockit VRM collection, fetched at runtime | balloon-stand host cameo (§11) |

You pick your chaser on the title screen; the runner is chosen at random from the other two each
round (a challenge link can fix both, §3). All runners use the same route pack, so the choice is
cosmetic and never affects balance. prnth's low-poly Radbro (Rigify metarig, no clips) is out of the
MVP; it could become a guest skin later.

Personalities (bubble lines, §12): **#652** showboat, **#4764** smug, **#2564** paranoid ghost
("they're watching", "can't catch a ghost").

## 3. Round flow

TITLE → LOADING → COUNTDOWN 3 s (both frozen) → CHASE 90 s → CAUGHT | ESCAPED → RESULTS.

- **Countdown.** The camera opens on the runner on his start roof, holding the bag and doing Big
  Wave Hello with a "finders keepers" bubble; George sits beside you. The camera dollies back to
  your shoulder: 3-2-1-GO. Start junction and player spawn come from the round seed (§7): you start
  on an adjacent roof on the far side from his first edge, about 22-26 m behind.
- **Chase.** Every 5-9 s he reaches a junction roof, looks back at you, and commits to the branch
  leading away from you; his head turns toward the chosen exit 0.3 s before he runs (the tell). If
  you are more than 35 m back (d, §5.3) he stops for a taunt (1.4 s; Chill 1.8 s) — your window.
- **How you gain ground:** chain-swinging down street canyons (15-17 m/s vs his ~9.5 m/s run),
  cutting diagonals he can't take (his hops are axis-aligned), and reading his branch early.
- **Panic arc.** Closing in raises his playback rate (§7). Panic (m > 1.05) switches him to the
  sprint clip and drains a panic budget; empty budget = GASSED, capped at base speed until it
  refills. UI for both is defined once in §12.
- **Falls.** Feet below the lowest roof − 8 m: "rekt." (§12), 0.6 s fade, respawn on the last roof
  you landed on at the point nearest him (3D Euclidean), 1 m in from the edge, camera yaw snapped to
  face him, **−3 s** off the clock. He keeps going. No lives; the clock is the only resource.
- **Catch** (checked every 120 Hz step, so it can't be skipped):
  - **Tag:** horizontal distance ≤ 1.5 m **and** |dy| ≤ 1.8 m.
  - **YOINK:** when the sim's ring target is the runner (§5.2) the reticle is red; an LMB press on
    that step (easy grab: a Space press) lassoes him — no jump, no hold delay. Otherwise LMB behaves
    normally.
  - On catch: 1.2 s of 0.35× slow-mo with a camera orbit; he flops (Falling Down), the bag pops into
    your LeftHand, you do Victory Cheer, George does Happy. Results play over chaser and runner
    waltzing (Waltz clip) with George sitting beside them.
- **Escape** (clock hits 0): a flying rug swoops in and he rides off (Victory Cheer). "He rugged
  you." Your Radbro plays Fishing_Cast ("gone fishing"); George sulks. Results show closest distance.
- **Retry:** R (tap on results, hold 1 s mid-round) creates a fresh Round with a new seed.
  **Restart < 100 ms; nothing reloads or remounts** (§13).

**Targets.** Chill (first-run default): following his line catches him in about 60-75 s.
Normal: following his line never catches him; moving ~20% faster along his line catches him in
35-70 s; strong swingers in 20-30 s. **Authority:** the CI balance bots (§16 test 9) gate the
pre-playtest defaults; after each human playtest the humans' constants are committed and test 9's
thresholds are re-pinned to the bot results under those constants.

**Scoring.** Catch time = 90 s − clock remaining at the catch step (fall penalties included).
Medals (provisional until the M3 playtest):

| Difficulty | Rad | Gold | Silver | Bronze |
|---|---|---|---|---|
| Normal | ≤ 25 s | ≤ 40 s | ≤ 60 s | any catch |
| Chill | ≤ 35 s | ≤ 55 s | ≤ 75 s | any catch |

Stats: longest swing chain (consecutive rope attaches with no grounded step between), top speed
(max |v|), falls, yoink vs tag. Personal bests per chaser × difficulty in `localStorage` (try/catch).

**Challenge link:** `?c=<chaser>&r=<runner>&d=<chill|normal>&t=<seconds>`. Opening it preselects
chaser, runner and difficulty on the title screen and shows a "beat 41.7 s" banner (claimed, not
verified). Share text: "I yoinked|tagged #<runner> in <t> s in Rug Run". Share is hidden on ESCAPED.

## 4. Controls

**Desktop (default; two-button, no hold delay).**

| Input | Action |
|---|---|
| Click PLAY | request pointer lock |
| Mouse | look + aim (camera forward = aim). Sensitivity 0.0022 rad/px, invert-Y option |
| WASD | run relative to camera; weak air control; on the rope: pump/steer (§5) |
| Space | jump; coyote time and input buffer (§5) |
| LMB | press/hold: web onto the ringed balloon; release lets go. Held LMB retries the attach every step, so a hook that comes into range mid-jump still grabs. LMB while grounded with a ringed hook = jump + grab ("zip"). Red reticle (runner ringed) = YOINK on press |
| Q or RMB (hold) | ease the camera toward the runner at 8/s |
| Esc / pointer-lock lost | pause, click-to-resume overlay |
| R | retry |

The camera never steers itself, except: yaw snaps to face the runner on respawn, and the scripted
shots in §8.

Settings: sensitivity, invert Y, FOV (55-75°, default 62°), volume, reduced motion (no speed FOV
widening, landing kick or speed lines), **easy grab** (the verified one-button scheme: tap Space =
jump, hold Space ≥ 0.12 s = swing, Space press on a red reticle = YOINK).

**Input model.** DOM events latch into an `InputFrame {move xz, aim xyz, jumpPressed, webHeld,
webPressed}`, consumed once per 120 Hz step; edge flags are consumed on the first step of a frame;
window blur clears held keys. Deterministic and replayable.

**Touch (post-v1):** floating left stick, right-half drag for camera, JUMP and WEB buttons, aim
half-angle 70° → 85° (`AIM_COS_TOUCH = 0.08715574274765817`) with velocity bias, Yoink range +1 m,
fullscreen on first tap. Produces the same `InputFrame`.

## 5. Player movement — 3D kinematic sim

`sim/player.ts` → `stepBody()`: a pure-TS 3D generalisation of the verified 2D prototype rope sim.
The player, the runner bake and the prototype-equivalence test share it through presets (§5.6).

### 5.1 State, timing, determinism

- **Body point.** `p` = **centre** of a 0.7 × 1.8 × 0.7 box (half-extents 0.35 / 0.9), exactly as in
  the prototype. Feet = `p.y − 0.9`; chest = `p + (0, 0.3, 0)`. The rope attaches at `p`; all reach
  distances are measured from `p`.
- **State:** `p, v` (vec3), grounded, roofId, `rope {hookId, len, target} | null`, heldFor, coyote,
  jumpBuffer, bonkT, lastSafe (roof + point), **`ringId`** (hook id, `RUNNER`, or none), chainCount.
  `ringId` is updated only inside `stepBody` from that step's latched aim, and is part of the FNV-1a
  state hash. The reticle draws `snapshot.ringId` — it never calls `pickTarget` itself — so the ring
  you see is the hook you get.
- **Timing.** Fixed 1/120 s step from an accumulator; frame delta capped at 0.25 s, max 30 steps
  per frame. Render interpolates prev/curr snapshots at `alpha = acc/dt`.
- **Determinism rule** (covers `sim/`, `game/round.ts`, `runner/` and `sidekick/`): only
  `+ − × ÷`, `Math.sqrt`, `min/max/abs/floor`. No `Math.hypot`, trig, `pow`, `exp` or `log` (they
  differ across JS engines). Every derived constant is a literal in `sim/tuning.ts`. Fixed iteration
  order; `mulberry32` is the only randomness.

### 5.2 Targeting (`pickTarget`) and Yoink

Hooks are placed by rule (§6), never raycast. Each step, with the latched aim:
- **Hook candidates:** 3D distance from `p` ≤ `aimRadius`; `hook.y ≥ p.y + 1.0`; inside the aim
  cone; clear segment from `p` to the hook (slab test vs nearby solid AABBs). Score =
  `|hook − (p + aim_xz·7 + up·9)|`, minus 3 m for the currently ringed hook (hysteresis).
- **Aim cone:** the angle between the horizontal aim and the horizontal direction to the candidate
  is ≤ 70° (half-angle; 140° total), tested as `dot ≥ AIM_COS` with
  `AIM_COS = 0.3420201433256687`.
- **Runner candidate (Yoink):** d (§5.3) ≤ Yoink range (difficulty table, §7); inside the aim cone;
  no minimum-height rule; line of sight = segment from player chest to runner chest, tested against
  solids (towers **and** roof buildings), excluding the roof each endpoint stands on. A valid runner
  candidate beats every hook (`ringId = RUNNER`).

### 5.3 Distance metrics

| Metric | Formula | Used for |
|---|---|---|
| **d** (chase distance) | `√(dx² + dz² + (0.5·dy)²)` between body points | rubber band, flinch, taunt, panic regen, cornered, look-back range, HUD distance + heat bar, Yoink range |
| Tag | horizontal ≤ 1.5 m **and** \|dy\| ≤ 1.8 m | tag catch |
| 3D Euclidean | `√(dx² + dy² + dz²)` | hook reach, branch term `\|edgeEnd − player\|`, respawn nearest point |

### 5.4 Movement rules

1. **Ground.** Horizontal velocity → `move × runSpeed` at `groundAccel` (brake `groundBrake`).
   Momentum carry: landing faster than `runSpeed` is kept and the excess decays at `carryDecay`.
   Jump sets `vy = jumpSpeed`. Running off an edge starts coyote time.
2. **Rope.** Attach: `len = |hook − p|`, `target = ropeScale·len`, reel in at `reelSpeed`. After
   integration, if `|p − a| > len`, project `p` onto the sphere and remove outward radial velocity
   beyond the reel rate; tangential velocity kept; slack allowed. Rope steer applies `ropeSteer` of
   the move vector projected onto the plane ⟂ rope. Auto-release when `p.y > hook.y − 1`. Release
   adds `releaseBoost` along v̂. Landing cuts the rope.
3. **Free air.** Gravity 25. Air control `airAccel`, unable to push horizontal speed above
   `max(current, runSpeed)`. Speed capped at 28 m/s → ≤ 0.233 m per step < 0.35 m half-width, so no
   tunnelling without swept tests.
4. **Collision** (box vs AABBs in a 16 m grid). Landing: feet at or above the roof top on the
   previous step and `vy ≤ 0`. Otherwise push out through the face the previous position was outside
   of and zero that velocity component (tie-break x, then z). Every solid is a ground-rooted,
   unrotated box (linted); decor is never solid. **Bonk** only on head-on hits: airborne, normal
   speed > `bonkMinSpeed` and > `bonkRatio` × horizontal speed → rope drops, controls lock
   `bonkLock`, Fall 1 plays. Glancing hits slide. The rope never wraps around buildings (accepted).
5. **Fall.** Feet below lowest roof − 8 m → fall (§3).

### 5.5 Tuning (`sim/tuning.ts`, the single source of truth)

| Constant | Value | Constant | Value |
|---|---|---|---|
| dt | 1/120 | maxFrameDelta / maxSteps | 0.25 s / 30 |
| gravity | 25 | speedCap | 28 |
| runSpeed | 9 | groundAccel / groundBrake | 60 / 40 |
| carryDecay | 12 | airAccel | 6 |
| jumpSpeed | 9 | coyoteTime / jumpBuffer | 0.1 / 0.1 |
| aimRadius (from `p`) | 17 | AIM_COS | 0.3420201433256687 |
| hookMinAbove | 1.0 | score ahead / up | 7 / 9 |
| hysteresis bonus | 3 | ropeScale | 0.75 |
| reelSpeed | 6 | ropeSteer | 5 |
| releaseBoost | 3 | autoRelease below hook | 1.0 |
| bonkMinSpeed / bonkRatio | 10 / 0.7 | bonkLock | 0.35 s |
| halfWidth / halfHeight | 0.35 / 0.9 | holdDelay (easy grab) | 0.12 |
| tag radius / tag dy | 1.5 / 1.8 | respawn penalty / inset | 3 s / 1 m |
| failBelowLowestRoof | 8 | M_SMOOTH (§7) | 1/48 |

`aimRadius` 17: in this city the nearest hook from a standing takeoff at a street edge is 15.4 m
(14 m street, Δh ≤ 4) or 15.9 m (16 m street) from `p`, so 17 leaves ≥ 1.1 m; test 4 lints it.

### 5.6 Presets and the verified reduction

- **PLAYER:** everything above.
- **RUNNER:** `airAccel = 0`, `ropeSteer = 0`, no Yoink. Each runner hop's *airborne* part is a
  planar copy of the verified 2D problem; the real RUNNER preset is validated by the bake (test 5).
- **PROTOTYPE** (test only): instant ground velocity (`v.x = runSpeed` every grounded step; no
  accel, brake or carry), one-button grab with `holdDelay 0.12`, `aimRadius 14`, prototype
  targeting (nearest anchor with `a.x ≥ x − 0.5` and `a.y ≥ y + 1`), no bonk, no auto-release, no
  speed cap, no hysteresis, `airAccel = ropeSteer = 0`, `jumpBuffer 0`.
- **Test 1:** `stepBody` with PROTOTYPE, `move = aim = +x`, on the fixture level with the fixture
  script, matches `trace.json` within 1e-9 m and lands on the same steps (`sqrt` vs the prototype's
  `hypot` differ by ~1e-14).

## 6. City

**Hybrid:** a generator-owned gameplay layer plus an editor-owned decor layer. One frozen district
for the MVP.

**Gameplay layer.** `world/generate.ts` (pure, seeded): `npm run gen-city -- --seed 7` → `CityModel`
(roofs, towers, hooks, roof adjacency, junction candidates, spawns). Writes `public/levels/
city.model.json` (the sim's source of truth) and, via `world/toPrefab.ts`, `public/levels/city.json`
(rendered: buildings, trims, water, **skyline**). Changing layout = change seed/config, re-run gen +
bake; CI checks both.

**Layout.**
- 6 × 5 blocks. Pitch = 28 m block + street width (street chosen by the M1 canyon probe; default
  14 m → 42 m pitch, ≈ 252 × 210 m). Small enough that nothing streams.
- Each block is 2 × 2 roof buildings of 12 × 12 m separated by 4 m alleys; ~10% of blocks merge a
  pair into a 28 × 12 m slab.
- Streets are swing-only (a flat jump tops out at 7.8 m).
- Roof tops 24-34 m from a smooth seeded field, quantised to 0.5 m. Clamp + lint: alley neighbours
  differ ≤ 1.0 m (≥ 305 ms press window), street neighbours ≤ 4 m.
- 6 landmark towers of 50-70 m in building slots: obstacles and line-of-sight blockers, never landing
  targets or runner-graph nodes.
- A water plane at y = 0 rings the district. Fail line = lowest roof − 8 m.
- Skyline: a seeded ring of 40 unlit boxes at 250-400 m, emitted into `city.json`; fog 120-380 m.

**Balloons (hooks).** Clusters every 7 m along street centrelines at `max(two facing landable
roofs) + 10 m`, plus one per intersection at `max(the four corner roofs) + 10 m` (~220 total); any
within 2 m of a box are dropped. Not prefab nodes: `FxView` draws them as one `InstancedMesh` from
`CityModel.hooks`. The Milady's stand explains them (§11).

**Decor layer.** `public/levels/decor.json`, a separate prefab mounted by `PrefabRef` and edited in
prnth's PrefabEditor (`?editor`, dev-only): billboards with Radbro/crypto jokes (WAGMI, "gm", "ngmi",
"buying the dip"), AC units, antennas, banners, the Milady's balloon stand. Never read by the sim or
bake. Budget: ≤ 40 nodes and ≤ 6 batch keys.

**As r3g prefab JSON (0.0.113 format).** Every building, trim and skyline box is a **unit box scaled
by its Transform**, so all share one geometry signature (`box:[1,1,1]`). r3g batches by
`${type}:${JSON.stringify(args)}|material uuid|castShadow|receiveShadow`, so per-size `args` would
explode the draw calls. Example node:

```json
{ "id": "b-3-2-1", "components": {
  "transform": { "type": "Transform", "properties": { "position": [0, 14, 0], "scale": [12, 28, 12] } },
  "geometry":  { "type": "Geometry",  "properties": { "geometryType": "box", "args": [1, 1, 1] } },
  "material":  { "type": "Material",  "properties": { "materialId": "facadeB" } },
  "mesh":      { "type": "Mesh",      "properties": { "castShadow": false, "receiveShadow": false } },
  "data":      { "type": "Data",      "properties": { "data": { "kind": "roof", "id": 37 } } }
} }
```

~400 nodes, ~7 materialIds, shadow maps off (blob shadows instead). No crashcat anywhere.

## 7. The runner

Variable-speed **playback of pre-baked route edges** on a small **junction graph**. No pathfinding
and no live physics at runtime: every frame he shows was simulated with `stepBody` (RUNNER) and
validated in Node at build time. He cannot fall or get stuck. **He never collides with the player;
touching him (tag) is the catch.**

**Graph (build time, `route/graph.ts`).**
- Hop kinds from roof adjacency: alley hops (same-block neighbours, overlapping span ≥ 6 m) and
  street swings (facing roofs, takeoff points aligned to balloons every 7 m along the span).
- ~12 non-boundary junction roofs by seeded farthest-point sampling; junction point = roof centre.
- Candidate edges: from each junction, BFS paths (seeded tie-breaks) to its 4 nearest junctions,
  3-7 hops each, at least one street swing. Waypoints: landing, optional approach, takeoff.
- Bake every candidate; discard failures; keep each junction's best 2-3 outgoing edges by margin →
  ~30 edges of 5-9 s (~200 s of unique running).

**Bake (`route/bot.ts` + `route/bake.ts`).**
- Every edge starts and ends in a canonical **rest state** at a junction (junction point, v = 0,
  grounded, no rope), so any incoming edge composes bit-exactly with any outgoing edge. Residual
  snap < 5 cm (asserted).
- Roof legs are straight: run to an approach point 3 m behind the takeoff, then along the hop axis.
- Alley hop: sweep the jump step, keep the middle of the press window; window ≥ 250 ms.
- Street swing: hold web from jump + 1 step with that balloon forced, sweep the release step.
  Release = earliest valid step + max(24 steps, 25% of window); window ≥ 400 ms.
- Every landing on the target roof, ≥ 1.5 m from its edges, no wall contact.
- Parameters are stored as **integer step indices**.

**Ship the tracks, don't re-simulate them.** `public/levels/runner.pack.bin` (~100 KB): 60 Hz
samples (int16 cm relative to the edge origin, phase, hook id), events (takeoff, attach, release,
land) with exact steps, each edge's exit vector (position at +2 s minus start) and its along-path
speed. The browser never runs his physics. CI re-bakes and compares the pack hash.

**Runtime (`runner/runner.ts`, `runner/rubberBand.ts`).** Each step `track += dt · rate · base`;
pose interpolated from the pack.
- Rubber band: `m_target = clamp(1 + 0.025·(g* − d), m_min, m_max)`;
  `m += (m_target − m) · M_SMOOTH` per step (`M_SMOOTH = 1/48`, i.e. dt/0.4 s);
  `rate = m` on the ground, `clamp(m, 0.9, 1.1)` in the air.
- **Flinch:** if his next 1 s of track heads at you (`dot(dir, toPlayer) > 0.3`) and d < 30 m,
  `m_target ≤ 0.9`.
- **Panic budget:** time at m > 1.05 drains it; it regenerates at 0.3 s/s while m ≤ 1 and d > 20 m.
  Empty → `m_max = 1.0` (GASSED) until it refills to 30%.
- **Junction dwell** (sim time, not scaled by rate): arrive → **look-back** 0.15 s (neck look-at the
  player when d < 20 m) — or, when d > 35 m, a **taunt** instead (difficulty table) → the branch is
  scored with the player position at that step → **head turn** to the chosen exit for exactly 0.3 s
  (36 steps) → depart. Normal dwell = 0.45 s.
- **Branch score** = `dot(exitVeĉ, awayFromPlayer̂) + 0.6·min(|edgeEnd − player|, 60)/60 −
  0.8·[used in last 2 picks] − 2·[returns to previous junction] + σ·noise`, where
  `noise = u1 + … + u12 − 6` from 12 mulberry32 uniforms (Irwin–Hall ≈ N(0,1)); take the argmax.
- **Cornered** (best score < −0.5 and d < 10 m): "pls no" bubble, take the best edge anyway.

**Round randomness.** `createRound({city, pack, difficulty, chaser, runner, seed})`; the start
junction, player spawn and branch noise all derive from `mulberry32(seed)`. The UI passes
`seed = crypto.getRandomValues(new Uint32Array(1))[0]` per round; tests pass fixed seeds.

**Difficulty.**

| Difficulty | Base | g* | m range | Panic budget | Branch σ | Yoink range | Taunt |
|---|---|---|---|---|---|---|---|
| Chill (first-run default) | 0.9 | 20 m | 0.7-1.1 | 8 s | 0.6 | 6.5 m | 1.8 s |
| Normal | 1.0 | 24 m | 0.8-1.2 | 15 s | 0.15 | 5 m | 1.4 s |

Final constants come from the balance bots using the pack's **measured** along-path speeds, then
from human playtests (authority rule in §3).

## 8. Camera

Pure spring-arm maths in `camera/rig.ts`; `CameraView` applies it (priority, §13).
- Yaw/pitch from the mouse; pitch clamped −30…+55°.
- Arm 6 m grounded / 7 m airborne / 8 m on the rope, blended at 4/s; 0.6 m right-shoulder offset.
- Target = chest; on the rope it shifts 25% toward the hook so the arc reads.
- Collision: `CityIndex.segmentHit(target, camera)` (parametric t of the first solid hit); the camera
  sits 0.3 m in front of a hit, min arm 1.5 m; below 2 m the local Radbro fades to 40% opacity.
  George and decor are ignored.
- FOV = `fovSetting + 16° × clamp((speed − 9)/9, 0, 1)`, easing 3/s; −3° landing kick for 0.1 s.
  Reduced motion disables the widening and the kick.
- Runner aids: hold Q/RMB to ease toward him; edge-of-screen arrow with d; blob shadows under all
  characters (pure `groundBelow()`); a faint trail of his last 2 s. No automatic steering.
- Scripted shots: countdown dolly (3 s), catch orbit (1.2 s at 0.35× sim time), rug escape tracking
  shot (2.5 s).
- The camera affects the sim only through the aim vector recorded in the `InputFrame`.

## 9. Radbro animation and assets

**Setup.** Each Radbro is an r3g `AnimatedModel {animationState: "", autoUpdate: false}` driven by
the ported **`Animator`** (own `AnimationMixer` on the model clone, crossfades, one-shots with an
`animator:finished` event, clip libraries from clip-only GLBs) plus an unlit **`FlatLook`**.
Additions (~30 LOC): `startAt(seconds)`, a per-clip root policy `{xz: pin, y: keep | pin}`
(airborne/leap clips pin Hips Y), and an explicit `useFrame` priority (§13). Sim-state → clip mapping
lives in pure `anim/animMachine.ts`; the view only calls `play()` / `setBase()`. **Animation never
gates gameplay.**

| Player state | Clip |
|---|---|
| Countdown, or grounded < 0.5 m/s | Idle |
| Grounded 0.5-5 m/s | Casual_Walk (owned) |
| Grounded running | Run_02 (owned), timeScale = speed/9 clamped 0.8-1.4 |
| Grounded > 11 m/s (momentum carry) | Lean_Forward_Sprint (owned, in place) |
| Jump | Run and Jump, once (startAt = takeoffAt, Y pinned) |
| Airborne > 0.6 s, or vy < −8 | Fall 1 |
| Rope attach | Grab Bar and Swing Forward once → Rope Hang Idle base loop |
| Release | Leap of Faith once → Fall 1 |
| Landing with vy < −14 | Roll Dodge, once |
| Other landings | 0.12 s fade to the ground state |
| Bonk | Fall 1 |
| Yoink | base + procedural arm raise; the lasso is FX |
| Win | Victory Cheer |
| Timeout | Fishing_Cast ("gone fishing") |
| Results after a catch | Waltz, chaser and runner face to face |

**On the rope:** root rotated so body-up points from `p` toward the hook and the character faces the
swing tangent; model shifted 0.7 m along that direction so the `RightHand` bone sits at the rope
end; the rope is drawn from `RightHand`'s world position (`getWorldPosition`) to the balloon.

**Runner:** same machine fed from the edge's track events with lookahead, plus panic →
Lean_Forward_Sprint; junction look-back → Idle + neck look-at (d < 20 m); head turn to the exit;
taunt → Big Wave Hello; caught → Falling Down → Waltz; escape → Victory Cheer on the rug. Characters
face their velocity (slerp 12 rad/s).

**The bag:** procedural low-poly money bag (~60 tris), parented to the runner's **LeftHand** (right
hand holds the rope; #4764's katana is baked across his back); re-parented to the chaser's LeftHand
on a catch.

**Clips to buy: 10 preset clips × 3 Radbros = 90 credits** (3 credits each), each retargeted
onto **every** rig in the rigging service — the bind poses differ, so sharing clips across characters twists
joints. Check each preview for forward root motion before buying.

| # | Clip | preset id |
|---|---|---|
| 1 | Rope Hang Idle | 477 |
| 2 | Grab Bar and Swing Forward | 495 |
| 3 | Run and Jump | 463 |
| 4 | Leap of Faith | 501 |
| 5 | Fall 1 | 502 |
| 6 | Roll Dodge | 158 |
| 7 | Idle (0), or Idle 3 (243) if its preview is livelier | 0 / 243 |
| 8 | Big Wave Hello | 28 |
| 9 | Victory Cheer | 59 |
| 10 | Falling Down | 366 |

Owned on all three: Casual_Walk, Run_02, Lean_Forward_Sprint (Regular_Jump kept as a fallback pose).
Fishing_Cast and Waltz are owned for #652/#4764; for #2564 they are made with text-to-motion
(~10 credits each, reusing the prompts that produced the originals). Optional wave 2 (+27 credits for
all three): Catching Breath (31, gassed dwell), Sliding Stumble (519, bonk), Wave for Help (291,
cornered). **Cut fallback** (15 credits for all three): Rope Hang Idle, Grab Bar and Swing Forward,
Run and Jump, Fall 1, Victory Cheer, with substitutes: Idle → Run_02 frame 0 at timeScale 0; Leap of
Faith → Fall 1; Roll Dodge → 0.12 s fade; Big Wave Hello → Victory Cheer; Falling Down → Fall 1;
Milady wave → skipped (idle only).

**Asset pipeline (`tools/assets`).**
- Source: the owner's `delivery/` GLBs only (metre-scale bones). Never the `final/` set (centimetre
  bones under a 0.01 armature, different clip names — mixing breaks the Hips position).
- Character GLB, exact commands: `gltf-transform unlit` → drop the sit/lie clips → `resize --width
  1024 --height 1024` → `webp --quality 90` → `resample` → `draco` (**draco last**; `unlit` after it
  silently drops the compression). ≈ 0.7 / 0.85 MB for #652 / #4764 after dropping sit/lie (0.9 /
  1.06 MB with all 7 clips); #2564 measured in M0.
- Clip pack: **one clip-only GLB per character** (skeleton + animation only) holding the 10 bought
  clips plus Fishing_Cast and Waltz — ≈ 0.6-0.9 MB each.
- `clips.meta.json`: per clip hips range, takeoff time and root-motion data (measured after buying).
- Render with `<GameCanvas flat>` — R3F forces ACES tone mapping and `rendererConfig.toneMapping`
  is overwritten; only `flat` disables it.
- r3g's Draco decoder is fetched from gstatic at runtime; three's bundled decoder files are never
  requested, so a post-build step deletes `dist/assets/draco_*` (and CI asserts nothing 404s).
- **Only the two Radbros in the round are loaded** (plus George); the third is not fetched.
- Performance fallback: the ~30k-triangle simplified Radbros (already produced in prototyping).

## 10. George (sidekick)

George is purely visual: not solid, not in the sim state or its hash, never affects balance. His
behaviour is a pure, deterministic function of the player's snapshot history.

**Asset.** `george_animations.glb` + `george_clips.json` (built outside this repo; cat skeleton,
scripted clips): Idle, Walk, Trot, Run, Jump (one-shot, with takeoff/land times), Leap_Air (loop),
Land, Sit + Sit_Idle, Loaf, Happy (one-shot), Sulk. `george_clips.json` gives each locomotion clip's
ground speed. Processed by `tools/assets` (unlit, 1024 webp, resample, draco; target ≤ 15k tris,
≤ 0.6 MB). Rendered with the same `Animator` pattern (an `AnimatedModel` + `Animator`), scaled for
readability next to 1.7-unit Radbros (tuned in M4; start at shoulder height ≈ 0.36 units).

**Follow model (`sidekick/george.ts`, pure).**
- A ring buffer of the player's snapshots (`p`, grounded, phase) at 120 Hz, capacity 2 s.
- **Grounded delayed sample:** George's target = the player's position `D = 0.5 s` ago, offset
  0.9 m to the trailing side (perpendicular to the path tangent), clamped onto the roof under that
  sample via `CityIndex.groundBelow` so he never stands off an edge.
- **Airborne delayed sample** (the player jumped or swung): George follows the delayed sample's
  exact path (no lateral offset) — a big cartoon leap along your arc. Clips: Jump (startAt takeoff) →
  Leap_Air → Land.
- **Speed-matched clips on roofs:** from George's own speed — Idle < 0.2 m/s, Walk < 1.2, Trot < 3.5,
  Run above; playback rate = speed / clip ground speed, clamped 0.7-1.6.
- **Falls:** when the player falls, George stops at the last grounded delayed sample and sits; on
  respawn the buffer is cleared and he is placed beside the player.
- **Beats:** countdown → Sit_Idle beside you; catch → Happy, then Sit_Idle at the results; escape →
  Sulk.
- Tests: trailing-side offset, airborne samples followed exactly, grounded target never off a roof,
  fall/respawn behaviour, clip choice by speed — all fixture-driven, no browser.

## 11. Pockit Milady cameo (requested by prnth)

A Pockit Milady runs the **balloon stand** on a central rooftop (placed in `decor.json`), which is
why there are balloons all over the city. She is decoration: not solid, not in the sim, bake or
runner graph, and **the game never waits for her**.

**Facts (verified in prototyping).** Pockit files are VRM 0.0 with 21 humanoid bones. Their
materials are `VRM_USE_GLTFSHADER` (plain glTF PBR, loaded as `MeshStandardMaterial`, not MToon). Of
the expression groups, **only `blink` has any shape data**; joy/sorrow/a-i-u-e-o are empty. The
collection is `web/1.vrm … web/3333.vrm` (contiguous), 0.7-3.8 MB (median 1.2 MB), ~39k tris,
8 materials. VRM metadata: OnlyAuthor, Redistribution_Prohibited, commercial Disallow, violent
Disallow.

**Loading.**
- URL: `https://cdn.jsdelivr.net/gh/prnthh/Pockit@<pinned commit SHA>/web/${N}.vrm`, falling back to
  `https://raw.githubusercontent.com/prnthh/Pockit/<same SHA>/web/${N}.vrm` (both verified to allow
  cross-origin fetches; the github.com `/raw/` redirect does not). `N = 1 + floor(Math.random() ×
  3333)` — cosmetic, outside the sim.
- Fetched by `VrmModel` itself (`fetch` → `GLTFLoader` with `VRMLoaderPlugin` → `parseAsync`) after
  PLAY, **outside** the loading gate, with a 10 s timeout. r3g's asset runtime is not used: its
  loader rejects the `.vrm` extension and would take the canvas down. On 404, timeout or parse error:
  log at info level and show the stand without a host.
- Never committed to this repo.

**Look and motion.**
- Materials swapped to unlit at load (`MeshBasicNodeMaterial` with the same maps) to match the flat
  scene; VRM0 models face −Z, so rotate π about Y.
- Expressions: random blinks only. Any other expression is used only if the loaded file has bound
  data for it (checked at runtime).
- Reactions are body clips: countdown → Big Wave Hello; idle → Idle with slow bone look-at at the
  player; catch → Victory Cheer; escape → Idle with head down. Clips are retargeted at runtime
  (~50-100 ms) from #652's clip pack onto her normalized humanoid bones using the Radbro→VRM bone map
  with A-pose → T-pose rest alignment, spine folding (3 source spine bones → 2) and a hips-height
  scale (the prototype's `retarget.ts`).

**Verification gate (M5, before wiring her in):** unlit Milady next to FlatLook Radbros on WebGPU and
WebGL2; bound-expression count per file; retargeted idle/wave/cheer read correctly; jsDelivr and raw
fallbacks; a 404 leaves the game fully working. If the gate fails, cut the cameo (cut order, §17).

**Cost:** ~8 draw calls; 0.7-3.8 MB fetched from jsDelivr, outside the dist budget; three-vrm adds
~146 KB minified (34 KB gzip) to the bundle.

## 12. HUD, menus and strings

Plain React DOM over the canvas; `SimDriver` pushes a small zustand UI store at 10 Hz so HUD updates
never re-render the canvas tree. No 3D text.

- **Title:** "RUG RUN" logo over a slow orbit of the district; three character cards (#652, #4764,
  #2564) to pick your chaser; "You chase one of the other two"; difficulty Chill (preselected on first
  visit) / Normal; PLAY requests pointer lock; a controls card. Challenge links preselect.
- **Loading:** `useScenePendingLoads()` (exported by react-three-game; throws outside `PrefabRoot`)
  is bridged by a small `<LoadBridge/>` inside `PrefabRoot` into the UI store. Progress =
  resolved/total over a known manifest (city.json, decor.json, the two Radbros, their clip packs,
  George); the manifest is preloaded with `useAssetRuntime().loadModel()` before the characters
  mount, and LOADED means every manifest entry resolved. The Milady is not in the manifest.
- **In-round:** timer top centre (mm:ss.t, red under 15 s); d + heat bar top right; GASSED badge /
  PANIC tag; edge-of-screen arrow; centre dot + in-world ring on `snapshot.ringId` (yellow, green
  while attached, red "YOINK" on the runner); speech bubbles above characters and a small line feed
  bottom-left; control hints fade after 10 s; speed lines above 14 m/s unless reduced motion.
- **Pause:** Resume, Restart, Settings, Quit.
- **Results:** CAUGHT — "YOINKED in 41.7 s" / "TAGGED in 41.7 s", medal, delta to best, stats,
  chaser and runner waltzing with George beside them. ESCAPED — "He rugged you.", closest d, your
  Radbro fishing, George sulking. Share (§3) or Retry (R) or Menu.
- **Credits:** "Radbro #652, #4764 and #2564", the public handle **dexedrne** only, "George the
  cat", "built on react-three-game by prnth", "Pockit Milady by prnth".

**Events and strings (single definition).**

| Event | Presentation |
|---|---|
| Countdown | runner bubble "finders keepers" |
| Heat bar | d > 40 m COLD · 20-40 WARM · 8-20 HOT · < 8 ON HIS HEELS |
| Panic (m > 1.05) | Lean_Forward_Sprint; "wtf" bubble on entry; PANIC tag next to the heat bar |
| Gassed | GASSED badge; feed line "He's gassed!" |
| Taunt | Big Wave Hello + a per-character bubble (#652 showboat, #4764 smug, #2564 paranoid ghost) |
| Cornered | bubble "pls no" |
| Fall | centre banner "rekt." + the same feed line |
| Escape | "He rugged you." |

**Dev pages.** `?sandbox` (free-roam, no runner), `?tune` (sliders), `?routeview` (junction graph
coloured by bake margin, plus live runner state), `?editor` (PrefabEditor on `decor.json`). Stripped
from the production build. The **test build** (`vite build --mode test`) additionally keeps `?bot`
and `window.__probe` (§16); it is size-checked separately from production.

## 13. Architecture

~70% pure TypeScript (testable in Node, engine-agnostic). The engine layer is 10 runtime files plus
`toPrefab` (format only) and 4 dev pages; if the r3g licence or API ever blocks us, porting it to
plain R3F is estimated at ~2.5 days.

| Module | Purpose | Engine |
|---|---|---|
| `sim/math.ts` | sqrt-only vec3 helpers, mulberry32, Irwin–Hall noise, FNV-1a state hash; allocation-free hot loop | no |
| `sim/tuning.ts` | every constant (§5.5), PLAYER / RUNNER / PROTOTYPE presets, difficulty and medal tables | no |
| `sim/player.ts` | `stepBody()`: ground, jump, air, targeting + ringId, rope, collision, bonk, fall | no |
| `world/cityModel.ts` | CityModel types + CityIndex (16 m grid: `nearbySolids`, `hooksNear`, `segmentHit` → t or null, `segmentBlocked`, `groundBelow`) | no |
| `world/generate.ts` | seed + config → CityModel (layout, height clamp, towers, hook rule, adjacency, spawns, skyline) | no |
| `world/toPrefab.ts` | CityModel → r3g prefab JSON (unit boxes, shared materials, Data tags, water, skyline) | format |
| `route/graph.ts` | junction sampling, candidate edges, waypoints, graph checks (build time) | no |
| `route/bot.ts` | edge waypoints + integer steps → InputFrames for `stepBody` | no |
| `route/bake.ts` | Node-only: sweep, validate, keep edges, record, write pack + report | no |
| `route/trackPack.ts` | runtime decoder: `sample(edge, t)`, events with lookahead, exit vectors, speeds | no |
| `runner/rubberBand.ts` | m_target, smoothing, air clamp, flinch, panic budget, gassed | no |
| `runner/runner.ts` | edge/track state, dwell (look-back / taunt / head turn), away-branch policy, cornered | no |
| `game/round.ts` | round state machine + fixed-step orchestration: player, runner, tag/Yoink/fall/timer, stats | no |
| `sidekick/george.ts` | George's follow model and clip choice (§10) | no |
| `anim/animMachine.ts` | sim phase + events → Animator commands and orientation hints | no |
| `camera/rig.ts` | spring arm, collision pull-in, FOV, rope bias, look-at-runner, scripted shots | no |
| `input/input.ts` | keyboard/mouse/pointer lock (touch later) → latched InputFrame; recording | no |
| `ui/*` | React DOM overlay, UI store, settings + bests, challenge URLs | no |
| `audio/sfx.ts` | WebAudio one-shots (whoosh, grab, land, bonk, yoink, bubble blip, George meow), one master gain | no |
| `tools/*` | Node CLIs: `gen-city`, `bake`, `balance`, `probe:canyon`, `assets`, `verify` (gen-city + bake into a temp dir and compare hashes with the committed files — the CI entry point) | no |
| `app/Animator.tsx`, `app/FlatLook.tsx` | ported; + `startAt`, root policy, explicit priority | yes |
| `app/VrmModel.tsx` + `vrm/*` | Milady load, unlit swap, blink, runtime retarget | yes |
| `app/SimDriver.tsx` | 120 Hz accumulator → `round.step`; snapshots; UI store at 10 Hz; `__probe` (test build) | yes |
| `app/ActorsView.tsx` | interpolated poses → character nodes via `usePrefab().getObject` (simulation state, never `prefab.update`); rope tilt; facing; neck look-at + head turn; bag on LeftHand + hand-off; events → animMachine | yes |
| `app/GeorgeView.tsx` | `sidekick/george.ts` output → George's node + his Animator | yes |
| `app/CameraView.tsx` | rig output → prefab Camera node | yes |
| `app/FxView.tsx` | plain R3F: balloon InstancedMesh, reticle ring, rope/lasso from RightHand, blob shadows, runner trail, flying rug (procedural subdivided 2 × 1.2 m plane with vertex ripple) | yes |
| `app/LoadBridge.tsx` | pending-loads count → UI store | yes |
| `app/GameScene.tsx` | `<GameCanvas flat>` + `<PrefabRoot>` for the play prefab composed in code (PrefabRefs to city.json/decor.json, character nodes, George, Milady node, Camera); mounted once | yes |
| `app/dev/*` | RouteView, TunePanel, EditorPage, BotDriver (`?bot=follow|yoink`, test build only) | yes |

**Frame order** (all negative so r3g's internals keep priority 0; negative priorities don't take over
rendering): `SimDriver −5` → `ActorsView −4` and `GeorgeView −4` → `Animator −3` (mixer update) →
`CameraView −2` → `FxView −1` (reads bones with `getWorldPosition()`).

**Engine rules** (from hands-on testing of 0.0.113):
- Don't fork the upstream starter (0.0.112-only, licence unclear); write our own code.
- `gameEvents` and the component registry are page-global: never call `gameEvents.clear()`; one
  canvas per page.
- **Restart never remounts** `GameCanvas`/`PrefabRoot`: the asset runtime, geometry/material pools,
  instancing registry and GPU pipelines live inside `PrefabRoot`'s SceneProvider. The Round lives
  outside React, keyed by runId (StrictMode-safe).
- Game code moves objects via `usePrefab().getObject(id)` transforms (simulation state), never via
  prefab document mutations.

## 14. Data flow

**Build time** (`npm run level`; `tools/verify` in CI):
1. `generate(seed 7, city.config.json)` → `city.model.json` + (via toPrefab) `city.json`.
2. `graph.build(CityModel)` → junctions + candidate edges.
3. `bake` drives `bot` + `stepBody` (RUNNER) hop by hop, validates, drops failures, runs graph checks.
4. Output: `runner.pack.bin` + `bake.report.json` (windows, margins, hashes).
5. `tools/assets` turns the owner's GLBs into web GLBs + clip packs; `decor.json` is hand-edited in
   `?editor`.

**Load (browser):** fetch `city.model.json` + `runner.pack.bin` → CityIndex + decoded pack (a few ms)
→ preload the manifest (§12) → mount the play prefab once → `createRound({city, pack, difficulty,
chaser, runner, seed})` outside React. After PLAY, `VrmModel` fetches the Milady independently.

**Each fixed step (120 Hz, ≤ 30 per frame):** `input.consume(aim)` → `stepBody(player)` (targeting,
ringId, rope) → `rubberBand(d, flinch, budget)` → `runner.advance(rate)` (pose, events, dwell,
branch) → round checks (Yoink/tag, fall/respawn, timer) → push the player snapshot into George's ring
buffer → store snapshots, queue events.

**Each render frame:** `alpha = acc/dt` → ActorsView + GeorgeView (interpolated poses, events →
animMachine → Animator) → Animator mixers → CameraView → FxView → every 100 ms the UI store.

**End of round:** CAUGHT/ESCAPED → personal best to localStorage → Share builds a URL. R creates a
fresh Round with a new seed; canvas, prefab, asset cache and GPU pipelines untouched. Nothing leaves
the client.

## 15. Repository, privacy, licensing, toolchain

- Public repo **`github.com/dexedrne/rug-run`**; every commit authored as
  `dexedrne <331735862+dexedrne@users.noreply.github.com>`. Vercel project under a pseudonymous name.
- No legal name anywhere: UI, `package.json` author, commits, Vercel project, OG/meta tags, credits.
  No tool attribution lines in commits or docs. No references to unrelated work. Local machine paths
  stay in the untracked plan.
- Committed assets: the processed Radbro and George GLBs and clip packs. **Not committed:** Pockit
  Milady VRMs.
- **react-three-game licence:** a joke licence ("PFYL"/"VPL") with no explicit grant; the upstream
  starter has stale GPL headers. We copy no starter code. **On M0 day 1** send prnth one written
  message asking for (1) a real licence for react-three-game (ideally MIT) and (2) OK to load Pockit
  VRMs at runtime from his repo given their metadata (OnlyAuthor / Redistribution_Prohibited /
  commercial Disallow / violent Disallow). His written OK is required before the public launch (M6).
- Third-party: three, R3F, drei, zustand, three-text, @pixiv/three-vrm, gltf-transform — all MIT.
- **Exact pins** (the verified tree): react-three-game 0.0.113, three 0.186.0, @types/three 0.186.0,
  @react-three/fiber 9.8.0 (peer react ≥19 <19.4), @react-three/drei 10.7.8, react + react-dom
  19.3.0, zustand 5.0.15, three-text 0.6.5 (required peer of r3g), @pixiv/three-vrm 3.5.5.
  `package-lock.json` committed; CI runs `npm ci`.
- **Node:** ≥ 23.6 (verified on 26.9.0); tests run TypeScript natively (type stripping). Rules for all
  code shared with Node: relative imports end in `.ts`; type-only imports use `import type`; no
  `enum`, `namespace` or parameter properties. `tsconfig`: `allowImportingTsExtensions`,
  `erasableSyntaxOnly`, `verbatimModuleSyntax`.

## 16. Testing

**Node tests** (`node --test`, no browser; CI on every push):
1. **Prototype equivalence** (§5.6): PROTOTYPE preset reproduces `trace.json` within 1e-9 m, same
   landing steps.
2. **Determinism:** a recorded 60 s InputFrame log replayed under five frame patterns (60/144/30 Hz,
   24-144 fps jitter, 5-7 fps) gives an identical final state hash (including ringId).
3. **Sim invariants:** `|p − a| ≤ len + 1e-9` every step; len never below target; speed ≤ 28 m/s;
   rope end never above the hook while taut; firing the body at every face/corner at 28 m/s never
   embeds or tunnels it; ringId never flickers during a scripted chain.
4. **City lint:** alley Δh ≤ 1.0 m, street Δh ≤ 4 m; hooks at the §6 heights and ≥ 2 m from any box;
   solids ground-rooted and unrotated; **reach:** every street-facing roof edge has a hook within
   `aimRadius − 0.5` of a standing takeoff point (`p` at the edge); `city.json` has ≤ 3 geometry
   signatures and ≤ 12 batch keys; `decor.json` ≤ 40 nodes and ≤ 6 batch keys.
5. **Bake + graph:** every kept hop has swing window ≥ 400 ms / alley window ≥ 250 ms, lands ≥ 1.5 m
   inside its roof, no wall contact; junction snap < 5 cm; graph strongly connected, no forced
   U-turns, 300 s random walk never stalls; fresh-bake pack hash equals the committed one; bake
   < 60 s. Dropped edges never fail the build; these checks do.
6. **Rubber band:** bounded, monotonic as d shrinks, air clamp, flinch cap 0.9, budget
   drain/regen/gassed, continuous across junctions, uses `M_SMOOTH` only.
7. **Runner:** away-branch choice in fixture positions; seeded reproducible noise; cornered beat;
   event lookahead; **the head turn starts exactly 36 steps before the first step of the outgoing
   edge**; taunt only when d > 35 m.
8. **Round:** tag at 1.49 m horizontal but not 1.51 m, and the |dy| gate; Yoink at d = R − 0.01 but
   not R + 0.01, and not with a tower or roof between the chests; timer → ESCAPED; fall → respawn
   −3 s at the nearest point; the same seed gives the same start junction and spawn; a new round after
   a round hashes identically to a cold start with that seed.
9. **Balance (build-failing):** the **follower** starts at the round's player spawn and moves
   kinematically along the runner's recorded trail at `k × (current edge's pack along-path speed ×
   difficulty base)`, ignoring m, catching by tag or Yoink through `round.step`. 200 rounds each over
   random seeds:

   | Difficulty | k | Must |
   |---|---|---|
   | Normal | 1.0 | 0% caught within 90 s |
   | Normal | 1.2 | median catch 35-70 s |
   | Chill | 1.0 | ≥ 90% caught, median 60-75 s |

   The **camper** waits at the junction nearest the player spawn and catches by tag or Yoink: < 25%
   of Normal rounds.
10. **Canyon probe** (M1 gate, run on a hand-made 3-block city **before** `world/generate.ts` is
    written; then a regression): a chain bot using `pickTarget` with ±2 m lateral and ±10° aim noise
    runs down 12, 14 and 16 m streets between 24-34 m facades. Pass = ≥ 13 m/s with < 10% bonks on
    in-window releases. Keep 14 m if it passes; otherwise the passing width with the fewest bonks
    (and tune `bonkMinSpeed` / `bonkRatio`); if none passes, M1 fails the feel gate.
11. **George:** the §10 follow-model tests.

**Browser tests** (puppeteer-core against the **test build**, real time; every headless Chromium
launch uses a throwaway `--user-data-dir`, never a real profile; the Milady URL is intercepted and
served from a local fixture):
- `?bot=follow&k=1.3&seed=123&d=normal&c=652&r=4764` on WebGPU and again forced to WebGL2. Assert via
  `window.__probe`: the **runner's** phases include swing/release/land; his clip names include Rope
  Hang Idle; George's clips include Run and Leap_Air; outcome CAUGHT at the step Node predicts (± 1);
  no console errors.
- `?bot=yoink&seed=123`: presses web whenever `ringId = RUNNER`; asserts a YOINK catch.
- The same run with the Milady URL returning 404: the game still loads, plays and catches.
- Screenshots at countdown, mid-swing (rope + ring visible), YOINK and results.
- Live-input smoke test (synthetic keys hop and grab on roof 1).

**Budgets** (checked in CI from real numbers, re-baselined at M0 and M4):
- Production dist ≤ 9 MB raw after deleting the unused Draco files (≈ 2.7 MB code, ≈ 2.4 MB for
  three Radbros, ≈ 2.2 MB clip packs, ≈ 0.6 MB George, ≈ 0.3 MB levels).
- **First-round transfer ≤ 7 MB** (sum of response sizes in the browser test: code + two Radbros +
  two clip packs + George + levels + Draco decoder). The Milady is listed separately (not counted).
- Draw calls ≤ 20 for city + decor + characters + George + FX, plus ~8 for the Milady.

**Performance:** real-GPU frame time logged at M1 and M6 (software rendering doesn't count).

**Manual:** the **owner's 15-minute feel check at the end of M1 is the go/no-go** before any runner
work; M3 playtest (3 people × 5 rounds, catch times logged) sets constants and medals; M6 device pass
(Safari, Firefox, an integrated GPU, a WebGL2-only browser).

## 17. Milestones and plans

Estimates are solo-developer days.

| # | Milestone | Deliverable | Days |
|---|---|---|---|
| M0 | Scaffold + assets | Vite + React + TS app with the exact pins and lockfile; Node TS rules + tsconfig; §0 inputs copied (fixtures, Animator, FlatLook, VRM helpers); `tools/assets` producing web GLBs for #652/#4764/#2564 and George; draco-file cleanup; `node --test` wired; an empty `<GameCanvas flat>` page on a Vercel preview under a pseudonymous project name. **Day 1: the licence + Milady message to prnth.** | 1 |
| M1 | Free-swing sandbox + feel gate | math, tuning (all presets), player with tests 1-3; hand-made 3-block city + canyon probe (test 10) picks street width + bonk params; **then** generate + toPrefab + test 4; SimDriver with interpolation, input latch + pointer lock, camera rig, FxView (balloons, ring, rope, blob shadows) with a box stand-in; `?sandbox` + `?tune`; real-GPU frame time. **Owner's 15-minute feel check = go/no-go.** | 3.5 |
| M2 | Runner pipeline | graph, bot, bake, trackPack, runner playback + dwell, `npm run bake`, tests 5 + 7; committed pack with CI hash check (`tools/verify`); `?routeview`; a box runner flees across the graph while you chase in the sandbox | 3 |
| M3 | **Playable chase (MVP-0)** | round (seeded), rubber band, Yoink, falls/respawn, restart < 100 ms, tests 6/8/9; HUD, title (three cards), pause, results; test build + BotDriver; playable with box characters on a Vercel preview; first human playtest | 2 |
| M4 | Characters + animation | day 1: buy the 10 clips × 3 Radbros (90 credits) + #2564 Fishing_Cast/Waltz; clip packs + `clips.meta.json`; Animator `startAt` + root policy; animMachine for all three; rope tilt; lasso; look-back + head turn; bag + hand-off; end beats; George in the scene with countdown/result beats; full round on WebGPU and WebGL2; budgets re-baselined | 2.5 |
| M5 | Content + juice + sidekick + cameo | decor.json in `?editor`; per-character bubble lines; catch slow-mo + orbit, countdown dolly, rug escape, trail, SFX, share links, personal bests; **George follow model** + test 11; **Milady** behind its gate; second playtest re-tunes | 2.5 |
| M6 | Ship v1 | puppeteer suite green on WebGPU + WebGL2; budgets hold; device pass; OG image; credits (handle only); **prnth's written OK received**; Vercel production link | 1.5 |
| — | Contingency | device fixes, feel tuning, re-buying any clip that retargets badly | 2 |

**Total to v1 ≈ 18 days; MVP-0 playable ≈ day 9.5.**

**Implementation is planned as three plans.** Plan A = M0 + M1, ending at the owner's go/no-go.
Plan B = M2 + M3, ending at MVP-0 on a Vercel preview plus the first playtest. Plan C = M4-M6,
starting only after the clips are bought and the M3 constants are recorded. Each plan starts from the
previous plan's merged main.

**Post-v1 stretch, in order:** touch controls + phone perf pass (3 d) · a harder difficulty + a daily
district seed (1 d) · a verified ghost of your best run in challenge links (input-log codec, ~750
chars per 90 s) (2 d) · gameplay edits in PrefabEditor via Data tags → CityModel (1.5 d) · prnth's
Radbro as a guest skin after a re-rig.

**Cut order if time runs short:** touch (already stretch) → SFX and runner trail → catch slow-mo,
countdown dolly and rug cinematic (fade to results instead) → neck glance and bag hand-off polish →
Milady cameo → George's follow model (George appears only at countdown and results) → decor prefab
and editor page → half the bought clips (the cut list, §9) → Chill tuning (ship Normal only, with a
wider Yoink).

**Never cut:** the pure fixed-step sim and its tests, bake validation and graph checks, the rubber
band with flinch and panic budget, away-branching at junctions, Yoink, and fall recovery.

## 18. Risks

| Risk | Mitigation |
|---|---|
| **3D swing feel** — only the 2D sim is verified; auto-aim, air control, rope steer and camera are new | canyon probe before the generator, `?sandbox` + `?tune`, owner's feel check as go/no-go, "easy grab" fallback scheme |
| Runner feels on rails | ~12 junctions × 2-3 branches, player-dependent choices, seeded random start, head-turn tell; if playtests still say "rails", shorten edges (more junctions) before considering a live planner |
| Junction stops read as checkpoints | 0.45 s dwell hidden by the look-back and head turn; later: bake "through" variants for common edge pairs |
| Rubber band feels like cheating | capped (+20% Normal, ±10% airborne), visible PANIC/GASSED, flinch rule; balance CI contract |
| Average players never catch him | Chill default, 6.5 m Yoink on Chill, constants gated on human playtests |
| Balance bots are a proxy | authority rule (§3): humans set the numbers, bots re-pin them |
| Bakes brittle to generator changes | failing edges discarded automatically; the build fails only on the test-5 checks; ≥ 400 ms windows keep margin |
| Reach margin in this city | aimRadius 17 from the body centre, reach lint in test 4, held LMB retries every step |
| Real-GPU/Safari/WebGL2 performance unmeasured (two 61k-tri skinned Radbros + George + a 39k-tri Milady) | measure at M1; ≤ 20 draws + ~8 for the Milady; shadow maps off; dpr [1, 1.5]; fall back to the ~30k-tri simplified Radbros; the Milady is cuttable |
| Bought clips don't fit (wind-ups, root motion, hand pose, bind poses) | buy on M4 day 1, inspect hips range, `startAt` + root policy, cut-list substitutes |
| George's follow model looks wrong (clipping, sliding) | delayed player path is collision-free by construction; ground clamp; speed-matched playback; cuttable to countdown/results only |
| Simplified collision (box vs ground-rooted AABBs, no rope wrap) | accepted; LOS check at attach + solids lint |
| Engine is 0.0.x from one author; licence unresolved | exact pins; ~70% pure TS; engine layer ≈ 14 files (≈ 2.5-day port); licence asked on M0 day 1, required before launch |
| Milady files (blink only, PBR materials, metadata restrictions, third-party hosting) | body-clip reactions, unlit swap, runtime fetch only with prnth's OK, never blocks the game, verification gate, cuttable |
| Engine singletons + StrictMode | Round outside React keyed by runId; never `gameEvents.clear()`; restart never remounts |
| Draco decoder from gstatic | fine for a public link; quantised GLBs as fallback |
| Pointer-lock quirks (Safari, iframes, Esc) | pause on lock loss + click-to-resume overlay |
| Privacy leak | handle-only everywhere; dexedrne commit identity; local paths only in the untracked plan; review before every push |

## 19. Credits (3D service)

| Item | Credits |
|---|---|
| #2564 model, rig, 7 base clips (built) | ~85 |
| George mesh (built; rig and clips made in Blender) | ≤ 80 |
| Game clips: 10 × 3 Radbros | 90 |
| #2564 Fishing_Cast + Waltz (text-to-motion) | ~20 |
| **Planned total** | **≈ 275 of 501** |
| Optional wave 2 (3 clips × 3) | +27 |

## 20. Errata (supersedes earlier sections where they conflict)

1. **Rope hang placement (§9).** Root rotated so body-up (feet → head) points from `p` toward the
   hook, facing the swing tangent, positioned so `RightHand`'s world position equals `p`. Model
   origin (feet) = `p − h·û` (û = unit vector p→hook, h = RightHand height above feet in Rope Hang
   Idle, measured into `clips.meta.json`, ≈ 2 m). No fixed 0.7 m shift.
2. **Runner selection (§2, §3).** The runner is fixed when PLAY is pressed: a challenge link's `r` if
   valid and ≠ chaser, else one of the other two via `Math.random()` (cosmetic). The pair is kept for
   every Retry (R only changes the seed; nothing loads). The pair changes only via Menu → PLAY, which
   goes through LOADING for uncached models; `GameCanvas`/`PrefabRoot` stay mounted and only the
   character nodes (keyed by Radbro id) mount/unmount. Invalid link fields, or c = r, are ignored
   field by field.
3. **Frame order (§13).** `SimDriver −6` (steps, snapshots, `george.step`) → `ActorsView −5` and
   `GeorgeView −5` (root transforms, facing, rope tilt, animMachine commands) → `Animator −4` (mixer)
   → ActorsView bone pass `−3` (neck look-at, head turn, Yoink arm raise — after the mixer) and
   `VrmModel −3` (her mixer, look-at, blink, `vrm.update`) → `CameraView −2` → `FxView −1`.
4. **Boot and loading (§12, §14).** Boot: GameScene mounts `<GameCanvas flat>` + `PrefabRoot` once
   with the city/decor PrefabRefs and camera; TITLE appears when `useScenePendingLoads()` (via
   `<LoadBridge/>`) first reaches 0. LOADING (after PLAY) = 5 GLBs: chaser, runner, their clip packs,
   George, requested with `useAssetRuntime().loadModel()`; an entry is resolved when `getModel(path)`
   is non-null; progress = resolved/5; a failed entry shows an error with Retry. `clips.meta.json`
   and `george_clips.json` are written by `tools/assets` to `src/generated/` and imported as JSON
   modules. Load order: city.model.json + runner.pack.bin → GameScene (city + decor) → TITLE → PLAY
   → manifest → character + George nodes → `createRound(...)`.
5. **Cut fallback cost (§9):** 45 credits (5 clips × 3 Radbros × 3).
6. **Milady (§11).** Clips are retargeted from the **chaser's** clip pack (always loaded; the retarget
   re-aims each source's own A-pose rest). Only Idle, Big Wave Hello and Victory Cheer are
   retargeted. N is chosen once per page load and the VRM is reused across rounds. Parse, unlit swap,
   retarget and mount run only on the title, in COUNTDOWN or at RESULTS — never mid-chase. Her stand
   is a decor.json node tagged `Data {kind: "miladyStand"}`; GameScene copies its transform once.
   Browser tests intercept both Milady URL patterns and serve `test/fixtures/vrm/stub.vrm`, a minimal
   generated VRM 0.0 (21 bones on boxes, one bound blink, no Pockit data).
7. **Draw calls (§16, §18):** ≤ 30 (city ≤ 12 + decor ≤ 6 + two Radbros + bag + George + FX ≤ 8),
   plus ~8 for the Milady.
8. **First-round transfer (§16):** ≤ 8 MB **decoded** (`decodedBodySize` sum from page load to the
   first COUNTDOWN frame), excluding the test-only chunk; the Milady listed separately.
9. **Bots (§16 test 9, browser tests).** Pure `game/bots.ts` shared by test 9, `tools/balance` and
   `app/dev/BotDriver`. The follower drives `round.step` through a kinematic override
   `{p, v, grounded, phase, roofId}` replacing `stepBody`'s integration for that step (targeting,
   catch checks, George buffer, snapshots unchanged); starts at the player spawn, moves straight to
   the runner's start junction, then follows his trail at `k × (owning edge's along-path speed ×
   base)`, copying grounded/phase/roofId; aim = horizontal unit vector chest → runner chest. With
   `yoink: true` it sets `webPressed` on each step after one whose snapshot has `ringId = RUNNER`;
   otherwise it catches by tag only. Test 9 and the camper use `yoink: true`. `?bot=follow` =
   `yoink: false`; `?bot=yoink` = `yoink: true`.
10. **George follow model (§10).** Buffer entries hold `p`, grounded, phase, roofId. `s` = entry 60
    steps old. Tangent `t̂` = normalised horizontal `p[s+6] − p[s−6]`; if < 0.05 m keep the previous
    (initially player → runner). `L = (t̂z, 0, −t̂x)` (path's left). George position = target, no
    extra steering: `s.p − (0, 0.9, 0) + 0.9·w·L`, where w → 1 while `s` is grounded and → 0 while
    airborne, by 1/18 per step. Grounded `s`: x/z clamped into roof `s.roofId` inset 0.4 m, y = roof
    top. Airborne `s`: no clamp. `george.step()` runs inside the fixed step (outside the Round and its
    hash); `SimDriver` keeps prev/curr George snapshots and `GeorgeView` interpolates. Speed =
    horizontal |Δpos|/dt smoothed by 1/12 per step. Until the buffer holds 60 steps he sits
    (Sit_Idle) at his placement point. Falls: George keeps his own `lastGrounded` (position +
    roofId); on the fall step he is placed there (hidden by the fade) and sits; on respawn the buffer
    clears and he is placed at the respawn point + 0.9 m along `L` (from the snapped camera yaw),
    clamped into the roof inset 0.4 m. Playback rate = speed / (clip ground speed × render-scale
    ratio), clamped 0.7-1.6; `george_clips.json` names the root bone the Animator pins. Tests: no
    sideways step > 0.9/18 m.
11. **Determinism rule** also covers `world/cityModel.ts`, `route/trackPack.ts` and `game/bots.ts`.
12. **Plan C** starts with the owner's clip purchase; nothing else in Plan C starts before it.
13. **Budgets:** dist size from M0; first-round transfer and draw calls from the M3 browser test on;
    re-baselined at M3 and M4.
14. **Dev pages** are stripped from the production deployment only; Vercel preview deployments build
    with `vite build --mode test` so `?sandbox`/`?tune` and playtests run on previews.
15. **Simplified Radbros:** add to §0 — the ~30k-tri #652/#4764 GLBs from prototyping; #2564's made
    by `tools/assets --simplify 30000`; served from `public/models/lite/` only when the fallback is on.
