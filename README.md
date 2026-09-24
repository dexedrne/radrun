# Rug Run

A rooftop chase with balloon swinging, built on [react-three-game](https://prnth.com/react-three-game/).
Design: `docs/specs/2026-09-23-rug-run-design.md`.

Status: M0-M3 — playable chase with box stand-ins for the Radbros (title, countdown, 90 s chase,
tag / YOINK, falls, results, retry). Characters, animation, George and the Milady come in M4-M5.

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
with the test bot.

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

Tools (print results, never gate the build): `npm run balance` (follower/camper bots per difficulty),
`npm run probe:canyon` (street-width probe), `RUGRUN_CHROME_PROFILE=<throwaway dir> npm run shot`
(headless mid-swing screenshot of `?autoplay`), `RUGRUN_CHROME_PROFILE=<throwaway dir> npm run botshot`
(headless `?bot` round: outcome vs the Node prediction + screenshots).

Credits: Radbro #652, #4764 and #2564 · dexedrne · built on react-three-game by prnth.
