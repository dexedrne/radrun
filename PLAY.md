# Playing Rug Run

He swiped your bag. You have 90 seconds to tag him (touch) or YOINK him (lasso) before the rug shows up.

## Run it

```sh
npm ci
npm run dev        # open http://localhost:4870/  -> pick a Radbro -> Chill or Normal -> PLAY
```

Node 23.6 or newer. A WebGPU browser is best (recent Chrome/Chromium); `?webgl2` forces the WebGL2
backend. `npm run build && npm run preview` serves the production build on http://localhost:4871/.

## Controls

| | |
|---|---|
| Mouse | look / aim (PLAY captures the mouse; click the canvas if the browser refused) |
| WASD | run |
| Space | jump |
| LMB hold | web onto the balloon with the ring; let go to release (LMB on a roof with a ringed balloon = jump + grab) |
| LMB on the red ring (on him, in range, in sight) | YOINK |
| Q / RMB | ease the camera toward him |
| R | retry (hold 1 s mid-round; tap on the results screen) |
| Esc | pause (settings: sensitivity, volume, FOV, invert Y, reduced motion, easy grab) |

Falling off the city = "rekt.": respawn on your last roof, -3 s. He panics (sprints) when you get close
and gets GASSED when his panic budget runs out. He stops to taunt you when you are over 35 m back.

## Dev pages (dev server and `npm run build:test` only; stripped from `npm run build`)

| URL | What |
|---|---|
| `?sandbox` | free-roam swinging, no runner (`?sandbox&autoplay` = scripted chain-swinger) |
| `?tune` | live sliders for player, camera and the Chill/Normal runner table; Save writes `tuning.json` |
| `?editor` | react-three-game PrefabEditor on `public/levels/city.json` (gameplay layout) |
| `?editor=decor` | the same editor on `public/levels/decor.json` (signs, rooftop props, the Milady stand) |
| `?routeview` | the runner's junction graph, with a live runner fleeing your mouse |
| `?bot=follow&k=1.3&seed=123&d=chill&c=652&r=4764` | a whole round played by the test bot (`bot=yoink` lassoes, `bot=swing` chain-swings for screenshots) |
| `?portrait=652` | one Radbro's Idle bust from its game GLB (`&yaw=`, `&bust=`, `&t=`); `npm run portraits` saves all three to `public/ui/` for the title cards |

Challenge links (all builds): `?c=652&r=4764&d=normal&t=41.2` preselects the title and shows the time to beat.

## Editing the city and decor by hand

1. `npm run dev`, open `?editor` (city) or `?editor=decor`.
2. Move, resize, add or delete boxes. In `city.json`, the `Data {kind}` tag decides gameplay: `roof`
   (landable), `tower` (solid, not landable), `hook` (an extra balloon; auto balloons within 3 m make
   way). Everything else about balloons is derived from the roofs. Keep boxes unrotated and standing on
   the ground.
3. Save. Under `npm run dev` Save writes the file and, for `city.json`, runs `npm run level` for you
   (new sim model + a fresh runner bake). Outside the dev server Save downloads the file: copy it into
   `public/levels/` and run `npm run level` yourself.
4. Reload the game page. `npm run level` prints lint errors and bake checks; if the bake fails (graph
   not connected, too few junctions) the layout needs more reachable roofs around the failing spot.
5. Commit `city.json`, `city.model.json`, `runner.pack.bin` and `bake.report.json` together
   (`decor.json` alone for decor edits; decor never affects gameplay).

### The city look

- **Materials** live in the `materials` table of `city.json` (facadeA-E, tower, roofCap, skyline,
  ground, water) and `decor.json`; pick one in the editor's Material panel to change colour, texture or
  repeat. Buildings sharing a material draw in one instanced batch, so recolour a look rather than
  adding one material per building.
- **Textures are world-space:** in the game, a level material whose texture has *Repeat Texture* on is
  mapped by world position (walls: along the face x height; tops: x, z), and *Repeat (X, Y)* means
  tiles per metre. Windows keep their size on any building. The facade tiles are 16 x 24 m (8 bays of
  2 m, 8 floors of 3 m) = repeat `0.0625, 0.041667`; streets repeat every 42 m (one block pitch).
  Textures are in `public/textures/` (`npm run gen-textures` regenerates them).
- **Rooftop props** (water towers, AC units, antennas) are the `rooftop-props` group in `decor.json`,
  never solid. `npm run gen-props` re-places them (clear of the runner's baked path; run it after
  `npm run level` if the layout changed); hand edits to other decor nodes are kept.
- `npm run restyle-city` re-applies the look from `src/world/toPrefab.ts` (materials table, facade
  rule, roof caps) to `city.json` without touching gameplay geometry.
- The sky gradient and fog colour are `SKY_COLORS` in `src/app/cityLook.tsx`.

## tuning.json

`public/levels/tuning.json` is read at startup and overrides the built-in constants: `player`, `camera`,
and `difficulty.chill` / `difficulty.normal` (the runner's rubber band). Edit it by hand or with `?tune`.

Swing defaults (changed from the spec's 28 m/s cap):

| key | value | effect |
|---|---|---|
| `speedCap` | 20 | hard speed limit; a clean chain settles here (~16 m/s along the street vs his ~9.5) |
| `releaseBoost` | 3 | kick on release; **the runner's own street swings need it** (1.5 broke 105 of 107 bake edges) |
| `reelSpeed` | 6 | how fast the rope reels in; lower = swings fall short into the canyon |
| `ropeScale` | 0.75 | rope reels to this fraction of its length; this is what builds chain speed |
| `ropeSteer` | 5 | steering force while on the rope |

The runner is baked with the same player constants, so after changing any `player` value run
`npm run level` (the dev-server Save does it), then `npm run balance` to see the Chill/Normal catch
rates, and commit the regenerated `runner.pack.bin` and `bake.report.json`. `npm run probe:canyon`
reports chain speed on test canyons with the current `tuning.json`.

George's follow settings are not in `?tune`: edit `GEORGE` in `src/sidekick/george.ts` (trail cap,
delay, gait thresholds) and `src/app/george.config.ts` (model switch, render scale).

## Placeholder / known issues

- **Before a public launch:** the react-three-game licence and permission to load Pockit Milady VRMs at
  runtime from prnth's repo are still pending.
- Frame rate is only measured in headless software rendering (5-25 fps there); check the fps counter
  (bottom right) on a real GPU.
- Balance bots never swing. With the 20 m/s cap a good human chain is ~1.7x his speed; play-test
  Normal and adjust `difficulty.normal` (gStar, mMax, panicBudget) if catches come too easily.
- The Milady loads from jsDelivr with a GitHub raw fallback; some files 404 on jsDelivr (one console
  error, then the fallback loads her). `?milady=0` turns her off.
- SFX are synthesised tones, there is no music.
- George's paws slide a little above ~4.8 m/s (his run plays up to 4x to keep up); he hides when the
  camera is pulled in close to him.
- The production build is ~9 MB (models ~5.8 MB); the budget is not enforced.
