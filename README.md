# Rug Run

A rooftop chase with balloon swinging, built on [react-three-game](https://prnth.com/react-three-game/).
Design: `docs/specs/2026-09-23-rug-run-design.md`.

Status: M0 + M1 — the free-swing sandbox (box stand-in, no runner yet).

## Run

```sh
npm ci
npm run dev          # http://localhost:4870/  (the sandbox)
npm test             # node --test: prototype equivalence, determinism, city lint, sim invariants
npm run build        # production build (dev pages stripped) + draco cleanup
npm run build:test   # build keeping ?tune / ?editor (preview deployments)
```

Controls: click to capture the mouse · mouse look · WASD run · Space jump · hold LMB to web onto the
ringed balloon, release to let go (LMB on the ground with a ringed balloon = jump + grab) · R restart ·
Esc pause.

Pages: `/` or `?sandbox` free roam · `?tune` live sliders (save writes `public/levels/tuning.json`) ·
`?editor` / `?editor=decor` PrefabEditor on `city.json` / `decor.json` · `?autoplay` scripted swinging.

## Levels

`public/levels/city.json` is the hand-editable source of truth for the city (an r3g prefab of unit
boxes). Nodes tagged `Data {kind}` drive gameplay: `roof` (landable), `tower` (solid, not landable),
`hook` (an extra balloon at the node's position; auto balloons within 3 m give way). Balloons are
otherwise derived from the roofs by rule. Solids must stay unrotated boxes standing on the ground.

- `npm run gen-city -- [--seed 7] [--street 14] [--force]` writes the first `city.json` (never overwrites
  it without `--force`), seeds `decor.json` / `tuning.json` if missing, then runs `level`.
- `npm run level` reads `city.json` and writes `city.model.json` (what the sim uses) and prints the lint.
  Saving `city.json` from `?editor` under `npm run dev` runs this automatically.
- `public/levels/tuning.json` holds the gameplay/camera constants, read at startup.

Tools: `npm run probe:canyon` (street-width probe), `RUGRUN_CHROME_PROFILE=<throwaway dir> npm run shot`
(headless mid-swing screenshot of `?autoplay`).

Credits: Radbro #652, #4764 and #2564 · dexedrne · built on react-three-game by prnth.
