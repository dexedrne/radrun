# RadRun — the web-slinger swing (design + notes)

**Date:** 2026-09-27 · **Branch:** `swing-ps4`
**Owner ask:** "the swinging is pretty decent, could be better, more like the big web-slinger console game; also there's
no free-fall dive animation".

**In one line:** the swing gets the console web-slinger's shape - a web that goes further up and ahead the higher you are
(long sweeping arcs that bottom out over the street), a real speed gain through the bottom of the arc, a later release
point with a wider perfect window and a pop up, corner swings round building corners, and a head-first dive that goes
faster than a fall and pours its speed into the next swing - while every round 12 skill move (straight zip, charge leap,
yank, wall kick, zip pop, perfect release, rebound, kick chains) stays as it was. The Radbros get procedural air poses
(head-first dive, skydive spread, a livelier one-arm swing, a flip on a perfect release) layered over the clip packs,
view only. The thief (a baked runner) and ghosts made before this build keep the round 12 swing exactly.

---

## 1. The swing (sim, player only)

Every new behaviour is a `Tuning` key (`SWING_KEYS`, tuning.json "player", a `?tune` slider under "web-slinger swing",
"corner swing" and "dive"). `SWING_OFF` holds their off values: the runner's preset (`runnerFrom`) spreads it, so his sim
and the bake's tuning hash are unchanged (the committed packs still bake byte for byte), and `SWING_R12` (= `SWING_OFF`
plus the round 12 values of the retuned player-only keys) is what an older ghost replays with.

| What | How | Keys |
|---|---|---|
| Web length from your height | the ideal anchor point (`anchorAhead` + `anchorAheadPerSpeed` x speed ahead, `anchorUp` up) moves up `anchorHeightGain` and ahead `anchorHeightAhead` m per m your feet are over `anchorHeightFree` m above the ground below, up to `anchorUpMax` m up: high over a street the ring goes to a taller rim further ahead (ropes ~5 m longer on a chain, the arc bottoming out nearer the street; the floor clamp still keeps it `swingFloorClear` over the floor) | `anchorHeightGain` 0.35, `anchorHeightAhead` 0.3, `anchorHeightFree` 12, `anchorUpMax` 34 |
| Speed through the bottom | the surge: along the swing near the bottom of the arc (from `swingSurgeCos` from straight down, full at the bottom), on the way down and up to ~11 deg past it; the climb after that is the player's to time | `swingSurge` 8, `swingSurgeCos` 0.8 |
| Ground clearance | the floor-clamp reel runs `swingReel` + `swingReelPerSpeed` x speed, so a fast low web shortens before the arc reaches the street | `swingReelPerSpeed` 0.7 |
| Release | the auto-release moves from 50 to 58 deg past the bottom (`swingReleaseCos` 0.64 -> 0.53; the runner keeps 0.64), the perfect window opens at 32 deg (`swingPerfectCos` 0.82 -> 0.85) and runs to the auto-release; a perfect release adds `releasePerfect` 4.5 (was 3) along the velocity and `releasePerfectUp` 2.5 up; round 11's timed lift past 15 deg is `releaseSweet` 6 (was 11); held to the auto-release the fling gets `autoReleaseKeep` 0 of the release boost | as listed |
| Corner swing | web held, flying or swinging at `cornerMinSpeed`+ with the stick turned `cornerStick` (sine) or more off your way: a grounded building's vertical corner on that side, abreast of you (<= 1 m ahead, <= 2.5 m behind), within `cornerReach` m, with the building behind the corner (so the orbit runs round its outside into the street past it), standing over you and in sight, takes a web (`EV_CORNER` + `EV_ATTACH`). A level orbit (`cornerGravity` x gravity, the orbit radius only ever shortens, the horizontal speed kept) until you head within `cornerExitCos` of the stick, let go of the stick or the web, turn round or `cornerMaxT` s pass; then + `cornerBoost` along the new way (`EV_RELEASE`). Jump lets go with a hop | `cornerSwing`, `cornerReach` 13, `cornerMinSpeed` 9, `cornerStick` 0.6, `cornerGravity` 0.3, `cornerBoost` 3, `cornerMaxT` 1.4, `cornerExitCos` 0.97 |
| The dive | still a fresh C press in the air with 6+ m under you, held; now the speed cap while diving is `diveCap` (a higher terminal speed than `speedCap`) and the stick turns the dive at `diveTurn` rad/s. The speed over the cap after it (`Body.capX`) wears off at `diveCarryDecay` m/s^2 | `diveCap` 46, `diveTurn` 0.9, `diveCarryDecay` 5 |
| Dive into swing | a web within `diveSwingT` s of a dive (`Body.ropeDive`) keeps up to `diveKeep` x its speed when it goes taut (instead of `swingKeepSpeed` 1.6): the dive's speed becomes swing speed, carried over the cap by `capX` | `diveKeep` 2.5, `diveSwingT` 0.4 |

Determinism: only `+ - * / sqrt min max abs`, fixed iteration order (solids ascending, corners 0-3), no allocation. New
`Body` fields (`capX`, `diveT`, `ropeDive`, `corner*`) are copied, reset and hashed.

Numbers from a scripted chain swinger along the long street lanes (scratch tool, 60 runs x 10 s per district; "perfect"
lets go early in the perfect window and flies until falling before webbing again, "hold" just holds the web):

| Downtown | mean horizontal speed | street clearance on the rope | bonks |
|---|---|---|---|
| round 12, perfect | 21.2 m/s | >= 7.5 m | 2 |
| web-slinger, perfect | 23.1 m/s | >= 6 m | 1 |
| round 12, hold | 13.5 m/s | | 0 |
| web-slinger, hold | 16.1 m/s | | 0 |

A dive from 75 m over a street reaches 46 m/s (a fall: 32); webbing out of it swings at up to 46 m/s and lets go at
~35 m/s (out of a fall: ~17).

## 2. Versions

- Ghost **format 5** (same columns as format 4: the input word is unchanged, so the pad / touch / keyboard records and
  the online wire are the same bytes). Formats 1-4 decode with `swing: false` and replay with `SWING_R12`; a golden
  digest test (`test/swing.test.ts`) checks `SWING_R12` steps exactly like the round 12 build.
- **LINK_VERSION 7.** A v6 link's ghost replays with the round 12 swing and the title banner says it is from an older
  version ("replayed with its own swing"; an unverified one still says "made on an older build"). Bests and kept ghosts
  from before v7 are the older build's.
- **Runner packs stay v3**: his sim is unchanged, the committed packs re-bake byte for byte.
- **NET_VERSION 2** and the online self-test hash (`SELFTEST_HASH`) updated: an old tab joining a new relay (or the
  other way round) gets "this game is a different version: reload to update"; the tuning hash in the hello differs too.

## 3. Camera (view only)

`rig.ts`: in the air the arm pulls back up to `speedArm` (1) m with speed; the look point's height trails the body's by up
to `lagYMax` m (eased at `lagY` /s), so the camera rides the arcs instead of bobbing with each one; sideways it leads the
body's motion across the view by `lookAhead` s (at most `lookAheadMax` m) so there is room ahead; diving adds `diveFov` (3)
deg with the arm at `armDive` 6.5 m (was 8: the dive read too small); the speed FOV now spans 10-34 m/s (+18 deg). The view direction is still exactly the aim (the look point and the
camera move together), the horizon never rolls, and reduced motion turns all of it off.

## 4. Animation (view only)

`src/app/airPose.ts`, used by `ActorsView` (the chaser and the thief), `GhostView` and `TagActors` (every SPIDER-TAG
Radbro). No new asset files; nothing feeds back into the sim.

- **Weights** (`stepAirPose`, eased per frame): `dive` (the sim's `diveOn`), `sky` (airborne with no web / zip / wall /
  ledge, falling faster than 7 m/s with 4.5+ m below), `swing` (hanging from a web: rope or corner post) with its `tuck`
  share from the web's angle (0.82 -> 0.97 cosine from straight down = the bottom of the arc), and a flip clock started
  by a perfect release (0.62 s; every other one a twirl). Close above the ground (`near`: under max(2.2 m, 0.09 s of the
  fall)) every air pose lets go fast, so the landing clips see feet first.
- **Root** (`placeRoot`, the -5 pass): the view's own orientation (yaw, rope tilt, wall roll) is turned toward the dive
  (model up along the velocity, belly to the ground) and the skydive (level, belly down, head 0.22 rad up) by their
  weights and eased as before; the flip is applied on top (not eased); while a pose turns the body the root sits round
  the body's centre (its origin 0.9 m down the body's axis), not round the feet.
- **Limbs** (`airBones`, the -3 pass, after the mixer and the view's arm / hip turns, before the rope-hand correction):
  each upper / lower arm and leg bone (and the chest) is turned so the direction to its child points where the blended
  pose wants it, in the body's frame (right / up / forward), by the pose weight - rig-agnostic (only the Mixamo-style
  bone names every Radbro rig has), so the clip underneath shows through as the weights fade. The swing layer never
  touches the web arm (the right hand stays on the web). The skydive has a small flutter.
- **The clip under it**: the dive now plays the free-fall loop (upright, arms sculling) instead of the bought swan-dive
  clips (they read as the wrong dives); the skydive rides the same loop; the swing keeps the hang clip.

Checked headless on the test build (`?bot=chase&tech&snap=dive,skydive,tuck,reach,flip,corner` freezes on each pose;
close-up shots through the dev camera hook): the catch step matched Node, and the only console errors were the
sandbox's blocked external downloads.

## 5. Bots and balance

The bots play the same physics (their input goes through the same sim): the full-kit swing bot corner-swings at the
crossings when it changes lanes, the tech bot (and SPIDER-TAG's sharp bots) dive at a target well below and let go in
the wider perfect window. Degen was retuned per district (`src/world/districts.ts`); PLAY.md "The chase and
difficulties" has the before / after table. Every banded swing row is in band except the tech rows (they missed in 4
of 5 districts before; Market's slipped from 82 to 74 % with the faster Degen runner there) and Vertigo Degen (a miss
before too; chaotic under every knob tried).
