# RadRun

A rooftop chase with pendulum web swinging and parkour through 40-230 m canyon cities, built on [react-three-game](https://prnth.com/react-three-game/).
Design: `docs/specs/2026-09-23-rug-run-design.md`. Quick guide (run, controls, editing, tuning, known
issues): `PLAY.md`. Live: https://radrun.vyvanse.beer (the old https://rugrun.vyvanse.beer and
https://radbro-rug-run.vercel.app addresses redirect there, query strings included, so old challenge / ghost
links keep working). Working title: Rug Run (the `rugrun.*` storage keys and `RUGRUN_*` env vars keep that name).

Status: M0-M5 — the playable chase with the real characters: pick Radbro #652, #4764, #2564 or #723 (the cowboy), chase
the runner for 90 s (tag or YOINK him), with George the cat trailing you, the Pockit Milady running the
balloon stand, rope hangs, the bag, lasso, runner trail, flying-rug escape, catch slow-mo, and
procedural WebAudio music + SFX (no audio files).

## Run

```sh
npm ci
npm run dev          # http://localhost:4870/  (title -> PLAY)
npm test             # node --test: sim, determinism, city lint, bake checks, runner + round rules
npm run build        # production build (dev pages stripped) + draco cleanup
npm run build:test   # build keeping the dev pages and ?bot (preview deployments)
```

Controls: PLAY captures the mouse · mouse look/aim · WASD run · Space jump (again in the air = double
jump; on a wall = wall kick) · hold LMB to web the building ahead (the ring sits on a rim, corner or
facade), let go at the bottom of the arc to fling (LMB on a roof with a ring = jump + web) · C slide ·
E / Shift web-zip to the ringed building or the roof ledge ahead · wall runs, run-ups, ledge grabs +
climbs, vaults and landing rolls happen by themselves · red ring on him + LMB = YOINK · Q / RMB ease the
camera toward him · R retry (hold 1 s mid-round) · M mute · Esc pause. Round 9 (webs on buildings, a
real pendulum, parkour, the taller cities): `docs/specs/2026-09-25-round9-movement.md`, PLAY.md "Moving".

PRACTICE on the title = free swinging in the city with your Radbro and George (no runner, no timer);
first-run tips show once each (pause -> Settings -> show tips again).

Challenge links: `?c=<652|4764|2564|723>&r=<runner>&d=<chill|normal|degen>&t=<seconds>` preselect the title.
Ghost links add `&s=<seed>&g=<packed run>`: that exact round with the challenger's run replayed as a
translucent ghost, checked on the title ("verified replay" / "unverified"); Share after a catch makes one,
and your personal best's run is kept for "race your best" (`src/game/ghost.ts`, PLAY.md "Ghost links").

Auto quality: if the first 10 s of a chase on High run below ~40 fps, the game switches to Low once and
says so (a quality picked by hand in Settings always wins; `?autoq=0` turns it off).

Dev pages (dev and test builds): `?sandbox` free roam (`?autoplay` scripted swinging) · `?tune` live
sliders incl. the runner difficulty table (save writes `public/levels/tuning.json` and re-bakes) ·
`?editor` / `?editor=decor` PrefabEditor on `city.json` / `decor.json` · `?routeview` junction graph +
a live runner fleeing your mouse · `?bot=follow|yoink|chase&k=1.3&seed=123&d=chill&c=652&r=4764` plays a
round with a test bot (`chase` = the swinging balance bot on the real player sim) · `?bot=swing&seed=77&c=2564&r=652` drives the real player sim with the scripted
chain-swinger (it freezes 0.25 s into each swing for screenshots) · `?webgl2` forces the WebGL2 backend ·
`?milady=<1..3333>` picks her file, `?milady=0` turns her off.

## Levels

`public/levels/city.json` is the hand-editable source of truth for the city (an r3g prefab of unit
boxes). Nodes tagged `Data {kind}` drive gameplay: `roof` (landable), `tower` (solid, not landable) and
`prop` (a solid rooftop box you vault or climb, inside a roof). Web anchors are found on the buildings at
run time (there are no grab points to place; old `hook` nodes are ignored with a warning). Solids must
stay unrotated boxes standing on the ground; `npm run level` lints the round 9 rules (anchor coverage,
runnable roofs, props, wall-run notches, heights).

- `npm run gen-city -- [--seed 7] [--street 14] [--force]` writes the first `city.json` (never overwrites
  it without `--force`), seeds `decor.json` / `tuning.json` if missing, then runs `level`.
- `npm run level` (alias `bake`): `city.json` -> `city.model.json` (the sim model, lint printed) -> the
  runner bake -> `runner.pack.bin` (his recorded tracks: swings on baked building anchors, zips up,
  wall runs, climbs, drops) + `bake.report.json`. Commit all four files. `--all` does every district,
  `--no-bake` only derives + lints.
  Saving `city.json` or `tuning.json` from the dev pages under `npm run dev` runs this automatically.
- `public/levels/tuning.json` holds the player/camera constants and the Chill/Normal/Degen runner
  table, read at startup.

## Characters

`npm run assets -- --radbros <Radbro folder> [--george <George folder>]` builds `public/models/` from the
owner's delivery files: `radbro<id>.glb` (unlit -> drop sit/lie clips -> resize 1024 -> webp 90 ->
resample -> draco), `radbro<id>.clips.glb` (skeleton + bought clips), `george.glb`, and writes
`src/generated/clips.meta.json` (per-clip hips range, root policy, takeoff/land times, rope-hang hand
height, the round 9 parkour clips' key times) and `src/generated/george_clips.json`. Re-rigged `game-clips/radbro<id>_character.glb` files
replace their delivery GLBs. George's switch, render scale and gait speeds are in
`src/app/george.config.ts` (empty `GEORGE_GLB` = the procedural placeholder cat); his scale and follow
values can also be tuned in `?tune` / tuning.json's `george` section.

Rooftop decor (signs, the Milady's balloon stand tagged `Data {kind: "miladyStand"}`, and the
`rooftop-props` group of water towers / AC units / antennas from `npm run gen-props`) lives in
`public/levels/decor.json`, editable in `?editor=decor`. City textures (`public/textures/`, from
`npm run gen-textures`) are mapped in world space at runtime (`src/app/cityLook.tsx`); `PLAY.md` has the
details. `npm run portraits` renders the title-card busts into `public/ui/`.

Tools (print results, never gate the build): `npm run balance` (follower/camper/swinging bots per difficulty),
`npm run probe:canyon` (street-width probe), `RUGRUN_CHROME_PROFILE=<throwaway dir> npm run shot`
(headless mid-swing screenshot of `?autoplay`), `RUGRUN_CHROME_PROFILE=<throwaway dir> npm run botshot`
(headless `?bot` round: outcome vs the Node prediction + screenshots; `?bot=swing` URLs save mid-swing
shots).

## Use it

RadRun is under the [Viral Public License](LICENSE), the same license as Milady, Remilio and
react-three-game. Fork it, remix it, ship your own version, sell it; no credit needed. Anything made
from it keeps the license. The four Radbros are also free to use on their own, as rigged and animated
models: [dexedrne/radbros-3d](https://github.com/dexedrne/radbros-3d).

The license covers what is in this repo. It does not cover the Pockit Milady model: she is prnth's,
she loads at runtime from his repo, and she is not part of this one. Ask him before using her in your
own thing.

Credits: Radbros #652, #4764, #2564 and #723 are dexedrne's own, used with permission from the Radbro
Webring dev · the Pockit Milady is by prnth, used with his permission · built on
[react-three-game](https://prnth.com/react-three-game/) by prnth.
