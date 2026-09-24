# Playing Rug Run

He swiped your bag. You have 90 seconds to tag him (touch) or YOINK him (lasso) before the rug shows up.

**Play it: https://radbro-rug-run.vercel.app** (desktop with a mouse, or a phone / tablet in landscape).

## Run it

```sh
npm ci
npm run dev        # open http://localhost:4870/  -> pick a Radbro -> Chill / Normal / Degen -> PLAY
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
| Esc | pause (Settings: quality, sensitivity, volume, FOV, invert Y, reduced motion, easy grab) |

**Phone / tablet (touch).** Turns on by itself on a touch screen (coarse pointer, or at the first touch);
`?touch` forces it on, `?touch=0` off. Landscape plays best (portrait shows a "rotate your phone" hint).

| | |
|---|---|
| Left thumb (anywhere on the left half) | floating stick: run / steer on the rope |
| Drag on the right half | look / aim |
| WEB (hold) | web onto the ringed balloon; let go to release; slide the thumb while holding to turn the camera. Turns red = YOINK |
| JUMP | jump |
| HIM (hold) | ease the camera toward him |
| II | pause (Resume / Restart / Settings / Quit; Settings has the Low / High quality switch) |

Touch helps your aim: the cone widens to 85 degrees (desktop 70), balloon picking leans toward where you
are going, and the Yoink range is 1 m longer. The first tap goes fullscreen (and locks landscape where the
browser allows it). There is no pointer lock, and leaving the tab pauses. On phones the canvas renders at up
to 1.25x the CSS pixel size (1.5x on tablets and desktop). Touch values are `TOUCH` in `src/sim/tuning.ts`.

**Quality (pause -> Settings).** High is the default everywhere (on touch devices High already caps the
pixel ratio: 1.25x on phones, 1.5x on tablets). Low = pixel ratio 1, anti-aliasing off (after a reload),
no blob shadows, no runner trail, and no rooftop AC units or antennas (the water towers stay). It switches
immediately and is remembered in the browser (localStorage). Try Low if a phone runs hot or choppy.

Falling off the city = "rekt.": respawn on your last roof, -3 s. He panics (sprints) when you get close
and gets GASSED when his panic budget runs out. He stops to taunt you when you are over 35 m back.

## Difficulties

| | runner | Yoink range | medals (RAD / GOLD / SILVER, s) |
|---|---|---|---|
| **Chill** | jogs (0.9x), sprints to 1.1x, gassed after ~14 s of sprinting, wanders | 6.5 m | 35 / 55 / 75 |
| **Normal** | sprints up to 1.5x from 40 m out, 30 s panic budget | 5 m | 25 / 40 / 60 |
| **Degen** | 1.2x base, sprints up to 2x from 50 m out, barely wanders, short taunts | 4 m | 30 / 45 / 65 |

Tuned against a swinging bot (below): a strong swinger catches him on Normal in about 25-30 s (median),
on Degen in about 45 s when it catches him at all (about a quarter of Degen rounds he escapes).

## Dev pages (dev server and `npm run build:test` only; stripped from `npm run build`)

| URL | What |
|---|---|
| `?sandbox` | free-roam swinging, no runner (`?sandbox&autoplay` = scripted chain-swinger) |
| `?tune` | live sliders for player, camera, the Chill/Normal runner table and George; Save writes `tuning.json` |
| `?editor` | react-three-game PrefabEditor on `public/levels/city.json` (gameplay layout) |
| `?editor=decor` | the same editor on `public/levels/decor.json` (signs, rooftop props, the Milady stand) |
| `?routeview` | the runner's junction graph, with a live runner fleeing your mouse |
| `?bot=follow&k=1.3&seed=123&d=chill&c=652&r=4764` | a whole round played by the test bot (`bot=yoink` lassoes, `bot=chase` = the swinging balance bot on the real sim, `bot=swing` chain-swings for screenshots); `d=chill|normal|degen` |
| `?portrait=652` | one Radbro's Idle bust from its game GLB (`&yaw=`, `&bust=`, `&t=`); `npm run portraits` saves all three to `public/ui/` for the title cards |

Challenge links (all builds): `?c=652&r=4764&d=normal&t=41.2` preselects the title and shows the time to beat
(`d=chill|normal|degen`).

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
and `difficulty.chill` / `difficulty.normal` / `difficulty.degen` (the runner's rubber band). Edit it by
hand or with `?tune`.

Runner table keys: `base` (playback speed of his baked runs), `gStar` (the gap he tries to keep: closer =
he speeds up by 2.5 %/m), `mMin` / `mMax` (slowest / fastest rate), `panicBudget` (seconds of full sprint
before GASSED), `airMin` / `airMax` (rate clamp while airborne), `sigma` (branch noise: higher = dumber
choices), `yoinkRange` (m), `taunt` (seconds he stops to taunt when you are far back).

Swing defaults (changed from the spec's 28 m/s cap):

| key | value | effect |
|---|---|---|
| `speedCap` | 20 | hard speed limit; a clean chain settles here (~16 m/s along the street vs his ~9.5) |
| `releaseBoost` | 3 | kick on release; **the runner's own street swings need it** (1.5 broke 105 of 107 bake edges) |
| `reelSpeed` | 6 | how fast the rope reels in; lower = swings fall short into the canyon |
| `ropeScale` | 0.75 | rope reels to this fraction of its length; this is what builds chain speed |
| `ropeSteer` | 5 | steering force while on the rope |

The runner is baked with the same player constants, so after changing any `player` value run
`npm run level` (the dev-server Save does it), then `npm run balance` to see the catch rates, and commit
the regenerated `runner.pack.bin` and `bake.report.json`.

`npm run balance` plays 200 seeded rounds per row with three kinds of bot: the follower (runs his trail
at k x his speed, never swings), the camper, and the **swinging chaser** (`SwingBot` in
`src/game/bots.ts`: the real player sim, chain-swinging down the streets at ~16 m/s, letting go past
each balloon near the bottom of the arc, cutting over to him and Yoinking after a ~0.1-0.2 s reaction).
Targets: Normal swinger median 25-40 s, Degen swinger median ~45-70 s with some escapes, the old
follower targets for Normal/Chill. `--set normal.gStar=36` tries a value, `--only swing` runs just those
rows, `--n 500` more seeds. `npm run probe:canyon`
reports chain speed on test canyons with the current `tuning.json`.

**George** (visual only, never affects the chase) has his own section in `?tune` and an optional `george`
section in `tuning.json`, read at startup:

| key | default | effect |
|---|---|---|
| `scale` | 1.16 | render scale (withers ~0.36 m); his gait speeds scale with it |
| `maxTrail` | 2.6 | never more than this much path (m) behind you (keeps him in frame at speed) |
| `delay` | 60 | he follows where you were this many 120 Hz steps ago (60 = 0.5 s), capped by `maxTrail` |
| `side` | 0.9 | sideways offset (m) to your left |
| `idleBelow` / `walkBelow` / `trotBelow` | 0.2 / 0.56 / 1.7 | gait thresholds in m/s (Idle / Walk / Trot, Run above) |
| `rateMin` / `rateMax` | 0.7 / 2.2 | Walk and Trot playback-rate clamp |
| `runRateMin` / `runRateMax` | 0.6 / 4 | Run playback-rate clamp (4x = cartoon speed to keep up with you) |

The built-in defaults are `GEORGE` in `src/sidekick/george.ts`; the model switch is in
`src/app/george.config.ts`. Changing George never needs `npm run level`.

## Placeholder / known issues

- **Before a public launch:** the react-three-game licence and permission to load Pockit Milady VRMs at
  runtime from prnth's repo are still pending.
- Frame rate is only measured in headless software rendering (5-25 fps there); check the fps counter
  (bottom right) on a real GPU.
- Balance is tuned against a bot, not people: play-test Normal and Degen and adjust `difficulty.*` in
  `?tune` if catches come too easily or too hard. Some rounds end in seconds when his first run bends back
  toward you (his runs are pre-baked; he only re-decides at junctions).
- The Milady loads from GitHub raw (raw.githubusercontent.com) with jsDelivr as the fallback (jsDelivr
  404'd on some cold files, e.g. #270). `?milady=0` turns her off.
- SFX are synthesised tones, there is no music.
- George's paws slide a little above ~4.8 m/s (his run plays up to 4x to keep up); he hides when the
  camera is pulled in close to him.
- The production build is ~9 MB (models ~5.8 MB); the budget is not enforced.

## Link previews

`index.html` carries the title, description, theme colour, favicon and the Open Graph / Twitter card
tags. The image URLs are absolute on https://radbro-rug-run.vercel.app, so change them if the game moves.
`public/og.jpg` (1200x630) is a mid-swing frame from the game with the logo, the pitch and the three
Radbro portraits; `public/favicon.svg` is drawn by hand. `npm run og-image` (dev server up,
`RUGRUN_CHROME_PROFILE` set) re-renders `og.jpg` and `apple-touch-icon.png`: `--pick N` takes another
frozen swing from the `?bot=swing` round, and `--bg <png>` re-composites over a saved frame.
