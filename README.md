# Rug Run

A rooftop chase with balloon swinging, built on [react-three-game](https://prnth.com/react-three-game/).
Design: `docs/specs/2026-09-23-rug-run-design.md`. Quick guide (run, controls, editing, tuning, known
issues): `PLAY.md`.

Status: M0-M5 — the playable chase with the real characters: pick Radbro #652, #4764 or #2564, chase
the runner for 90 s (tag or YOINK him), with George the cat trailing you, the Pockit Milady running the
balloon stand, rope hangs, the bag, lasso, runner trail, flying-rug escape, catch slow-mo and SFX.

## Run

```sh
npm ci
npm run dev          # http://localhost:4870/  (title -> PLAY)
npm test             # node --test: sim, determinism, city lint, bake checks, runner + round rules
npm run build        # production build (dev pages stripped) + draco cleanup
npm run build:test   # build keeping the dev pages and ?bot (preview deployments)
```

Controls: PLAY captures the mouse · mouse look/aim · WASD run · Space jump · hold LMB to web onto the
ringed balloon, release to let go (LMB on the ground with a ringed balloon = jump + grab) · red ring on
him + LMB = YOINK · Q / RMB ease the camera toward him · R retry (hold 1 s mid-round) · Esc pause.

Challenge links: `?c=<652|4764|2564>&r=<runner>&d=<chill|normal>&t=<seconds>` preselect the title.

Dev pages (dev and test builds): `?sandbox` free roam (`?autoplay` scripted swinging) · `?tune` live
sliders incl. the runner difficulty table (save writes `public/levels/tuning.json` and re-bakes) ·
`?editor` / `?editor=decor` PrefabEditor on `city.json` / `decor.json` · `?routeview` junction graph +
a live runner fleeing your mouse · `?bot=follow|yoink&k=1.3&seed=123&d=chill&c=652&r=4764` plays a round
with the test bot · `?bot=swing&seed=77&c=2564&r=652` drives the real player sim with the scripted
chain-swinger (it freezes 0.25 s into each swing for screenshots) · `?webgl2` forces the WebGL2 backend ·
`?milady=<1..3333>` picks her file, `?milady=0` turns her off.

## Levels

`public/levels/city.json` is the hand-editable source of truth for the city (an r3g prefab of unit
boxes). Nodes tagged `Data {kind}` drive gameplay: `roof` (landable), `tower` (solid, not landable),
`hook` (an extra balloon at the node's position; auto balloons within 3 m give way). Balloons are
otherwise derived from the roofs by rule. Solids must stay unrotated boxes standing on the ground.

- `npm run gen-city -- [--seed 7] [--street 14] [--force]` writes the first `city.json` (never overwrites
  it without `--force`), seeds `decor.json` / `tuning.json` if missing, then runs `level`.
- `npm run level` (alias `bake`): `city.json` -> `city.model.json` (the sim model, lint printed) -> the
  runner bake -> `runner.pack.bin` (his recorded tracks) + `bake.report.json`. Commit all four files.
  Saving `city.json` or `tuning.json` from the dev pages under `npm run dev` runs this automatically.
- `public/levels/tuning.json` holds the player/camera constants and the Chill/Normal runner table,
  read at startup.

## Characters

`npm run assets -- --radbros <Radbro folder> [--george <George folder>]` builds `public/models/` from the
owner's delivery files: `radbro<id>.glb` (unlit -> drop sit/lie clips -> resize 1024 -> webp 90 ->
resample -> draco), `radbro<id>.clips.glb` (skeleton + bought clips), `george.glb`, and writes
`src/generated/clips.meta.json` (per-clip hips range, root policy, takeoff/land times, rope-hang hand
height) and `src/generated/george_clips.json`. Re-rigged `game-clips/radbro<id>_character.glb` files
replace their delivery GLBs. George's switch, render scale and gait speeds are in
`src/app/george.config.ts` (empty `GEORGE_GLB` = the procedural placeholder cat).

Rooftop decor (signs, the Milady's balloon stand tagged `Data {kind: "miladyStand"}`, and the
`rooftop-props` group of water towers / AC units / antennas from `npm run gen-props`) lives in
`public/levels/decor.json`, editable in `?editor=decor`. City textures (`public/textures/`, from
`npm run gen-textures`) are mapped in world space at runtime (`src/app/cityLook.tsx`); `PLAY.md` has the
details. `npm run portraits` renders the title-card busts into `public/ui/`.

Tools (print results, never gate the build): `npm run balance` (follower/camper bots per difficulty),
`npm run probe:canyon` (street-width probe), `RUGRUN_CHROME_PROFILE=<throwaway dir> npm run shot`
(headless mid-swing screenshot of `?autoplay`), `RUGRUN_CHROME_PROFILE=<throwaway dir> npm run botshot`
(headless `?bot` round: outcome vs the Node prediction + screenshots; `?bot=swing` URLs save mid-swing
shots).

Credits: Radbro #652, #4764 and #2564 · dexedrne · built on react-three-game by prnth.
