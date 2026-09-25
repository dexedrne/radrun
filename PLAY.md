# Playing RadRun

He swiped your bag. You have 90 seconds to tag him (touch) or YOINK him (lasso) before the rug shows up.

**Play it: https://radrun.vyvanse.beer** (desktop with a mouse, or a phone / tablet in landscape; the old
https://rugrun.vyvanse.beer and https://radbro-rug-run.vercel.app addresses redirect there, query strings included).

## Run it

```sh
npm ci
npm run dev        # open http://localhost:4870/  -> pick a Radbro -> Chill / Normal / Degen -> PLAY (or PRACTICE)
```

Node 23.6 or newer. A WebGPU browser is best (recent Chrome/Chromium); `?webgl2` forces the WebGL2
backend. `npm run build && npm run preview` serves the production build on http://localhost:4871/.

## Controls

| | |
|---|---|
| Mouse | look / aim (PLAY captures the mouse; click the canvas if the browser refused) |
| WASD | run |
| Space | jump; **Space again in the air = double jump** (once per airtime, not on the rope; landing or a rope grab recharges it) |
| LMB hold | web onto the balloon with the ring; let go to release (LMB on a roof with a ringed balloon = jump + grab) |
| E / Shift | **web zip**: a straight, fast pull to the ringed balloon (let go near it with a forward + up fling), or, with no balloon ringed, onto the roof ledge you are aiming at (a cyan marker shows it). 1.5 s cooldown: the thin ring around the reticle fills back up |
| (sky balloons) | the bigger **gold / cream / white** clusters hang 15-35 m above the roofs over crossings and plazas (the Towers, Vertigo) and can be grabbed from **30 m** (street balloons 17 m): long ropes, big pendulum swings, a re-grab in mid-fall. Street balloons keep the ring when both are in reach |
| LMB on the red ring (on him, in range, in sight) | YOINK |
| Q / RMB | ease the camera toward him |
| R | retry (hold 1 s mid-round; tap on the results screen) |
| M | mute / unmute (same as the speaker button on the title and the HUD) |
| Esc | pause (Settings: quality, sensitivity, music / sound-effects / voice volume, mute, FOV, invert Y, reduced motion, easy grab) |

**Phone / tablet (touch).** Turns on by itself on a touch screen (coarse pointer, or at the first touch);
`?touch` forces it on, `?touch=0` off. Landscape plays best (portrait shows a "rotate your phone" hint).
On a phone-sized screen the title's controls list folds into a small **controls** button next to the
credits (tap to show it), so the whole title fits on one screen.

| | |
|---|---|
| Left thumb (anywhere on the left half) | floating stick: run / steer on the rope |
| Drag on the right half | look / aim |
| WEB (hold) | web onto the ringed balloon; let go to release; slide the thumb while holding to turn the camera. Turns red = YOINK |
| JUMP | jump; tap again in the air = double jump |
| ZIP | web zip (ringed balloon, or the roof ledge ahead); dimmed while it recharges |
| HIM (hold) | ease the camera toward him |
| II | pause (Resume / Restart / Settings / Quit; Settings has the Low / High quality switch and the volumes) |
| speaker (under II) | mute / unmute |

Touch helps your aim: the cone widens to 85 degrees (desktop 70), balloon picking leans toward where you
are going, and the Yoink range is 1 m longer. The first tap goes fullscreen (and locks landscape where the
browser allows it). There is no pointer lock, and leaving the tab pauses. On phones the canvas renders at up
to 1.25x the CSS pixel size (1.5x on tablets and desktop). Touch values are `TOUCH` in `src/sim/tuning.ts`.

**iPhone: play it from the Home Screen.** Safari on iPhone can't go fullscreen from a web page, and in
landscape its toolbars take a big slice off the top. Two fixes:
- **Add to Home Screen** (Share -> Add to Home Screen): the RadRun icon then opens full screen with no
  Safari bars at all (`public/manifest.webmanifest`, icons in `public/icons/` from `node tools/icons.ts`).
  The Home Screen app keeps its own save, so campaign stars and bests start fresh there.
- **In a Safari tab:** while the toolbars show in landscape (title, campaign, results or pause, never
  mid-round), an overlay asks for one **swipe up**; Safari then minimises its bars. "not now" hides it
  for the rest of the tab session. The title also shows a one-time "Add to Home Screen" tip (✕ hides it).

The HUD, the touch buttons and the menus stay clear of the notch / Dynamic Island side and the home
indicator (safe-area insets), and a landscape phone under 400 px tall (toolbars showing, small phones)
gets a tighter title: no pitch line, smaller cards.

**Quality (pause -> Settings).** High is the default everywhere (on touch devices High already caps the
pixel ratio: 1.25x on phones, 1.5x on tablets). Low = pixel ratio 1, anti-aliasing off (after a reload),
no blob shadows, no runner trail, and no rooftop AC units or antennas (the water towers stay). It switches
immediately and is remembered in the browser (localStorage). Try Low if a phone runs hot or choppy.

**Auto quality.** During the first 10 s of each chase on High (after a 1.5 s warm-up) the game measures
its frame time. If the median says it runs below ~40 fps, it switches to Low once and shows "switched to
Low quality for smoother play — change in Settings". That choice is remembered; it never switches back by
itself, and once you pick Low or High in Settings it never touches the setting again. `?autoq=0` turns
it off for that page load. The numbers are `AUTO_Q` in `src/app/autoQuality.ts`.

## Sound

Recorded music, stings, voice lines and sound effects (109 mp3s under `public/audio/`), with the older
synthesised WebAudio sound as the fallback whenever a file is not loaded yet or fails, so a round is never
silent. Sound starts when you press PLAY or PRACTICE (browsers only allow audio after a click or a key
press). Nothing is fetched on page open: a round loads about 3 MB alongside its Radbros, without delaying
the LOADING screen (the countdown sounds go first).

- **Music:** a calm loop on the title and results; the countdown build (its cut lands exactly on GO); then
  the district's **chase loop** from GO: Downtown, Night Market, Docks, Towers and **Vertigo** each have
  their own (an unknown district plays Downtown's). When he is within 20 m (or panicking) the loop gets
  brighter and louder. A catch plays the win sting (a YOINK sting for a YOINK), "He rugged you." its own
  sting; the calm loop comes back under their tail. Pause dims it; a hidden tab or mute pauses it. The
  loops play at their own tempo on every difficulty.
- **Voices:** one line at a time (a line waits its turn or is skipped; the music dips about 4 dB under
  speech). The announcer calls 3-2-1-GO, "rekt" on a fall, gassed, YOINK / tagged, rugged and a new best.
  The runner says "finders keepers" right after GO, his taunts (the exact bubble; quieter the further ahead
  he is), panic, cornered, gassed, caught and escaped; your Radbro cheers after a catch. A line that is not
  loaded falls back to the old chatter blips.
- **Sound effects:** rope thwip and release whoosh, jump, **double jump** (the jump, a fifth higher),
  **web zip** (a thwip into a whoosh), light / heavy landings by impact, bonk, the YOINK lasso crack, the
  coin grab, countdown beeps, the "rekt." whistle, balloon pops, wind gusts, the rug swoosh, George's
  meows and a wind loop that grows with speed in the air. Variations are picked at random with a slight
  pitch spread.
- **Controls:** the speaker button (title top right; in a round top left, or under II on touch) and **M**
  mute everything. Pause -> Settings has **music**, **sound effects** and **voices** sliders and a mute
  box, all remembered in the browser. Leaving the tab (or muting) suspends the audio completely.
- **Code:** `src/audio/catalog.ts` lists every file (a test checks each exists and nothing unlisted ships)
  and maps district ids to chase loops; `samples.ts` loads (4 at a time); `tracks.ts` streams and
  crossfades the music; `voice.ts` queues the lines; `sfx.ts` plays samples with the synth fallback; the
  fallback music is `score.ts` / `music.ts`. Low quality loads one variation per sound and plays at most 6
  sampled SFX at once. Dev / test builds report the track, voice lines and files loaded / failed in
  `window.__play.audio`.

## Practice and tips

**PRACTICE** (title, next to PLAY) drops your Radbro and George on a roof in the real city with no runner,
no timer and no fall penalty: free swinging to learn the rope. The panel shows speed, the current swing
chain, best chain, top speed and falls. Hold R (desktop) = back to the start roof; Esc / II = pause ->
Resume / Back to start / Settings / Back to title.

**First-run tips** pop up under your Radbro (above it on touch) the moment they matter, once each:
"hold LMB/WEB while a balloon has the yellow ring" (a balloon is ringed), "let go at the bottom of the arc
to fling forward" (you are on the rope), "chain swings down the streets to go fast" (after your first
let-go), "red ring on him = click / tap WEB to YOINK" (the first red ring in a real round), then "press
Space / tap JUMP again in the air to double jump" (airborne) and "press E or Shift / tap ZIP to web-zip"
(on a roof with a ringed balloon). They are remembered in the browser; pause -> Settings -> **show tips
again** brings them back.

## Ghost links

Every real round records your inputs (camera yaw, WASD / stick, jump / web buttons: one small record per
120 Hz step). After a catch, **Share** (it reads **Share ghost** once the run is packed) copies a link like
`?c=652&r=4764&d=normal&s=<seed>&t=41.2&g=<ghost>`: the exact round (city seed, both Radbros,
difficulty), your claimed time and your packed run (about 1 KB for a 30-45 s catch).

Opening a ghost link shows a **GHOST RACE** banner on the title. The game replays the run in the
background first (~15 ms). If the replay catches him on its last recorded step at the claimed time, the
banner says **verified replay**; otherwise **unverified** (a tampered link, or a link from an older version
of the game whose tuning or city has changed). **RACE GHOST** starts that exact round with the challenger
as a translucent Radbro with a "GHOST" tag, replaying their inputs through its own copy of the sim
(its own runner, never solid, never touches your round). Its time sits under the clock, the feed says when
it catches him, and the results say whether you beat it. Retry races the same round again; picking another
Radbro or difficulty on the title plays a normal round instead.

Your personal best per Radbro x difficulty keeps its run in the browser: **race your best · 41.2 s** on the
title replays it as a ghost.

Since round 4 links are versioned: `?v=2&m=docks&mu=2&c=...` carries the link version, the district
(`m=`, left out for Downtown) and the mutator bits (`mu=`, left out when none). A link without `v` is an
older link: it opens Downtown with no mutators, and if its replay does not verify the banner adds "made on
an older build". `v=3` is the double jump + web zip build: its ghosts record the zip button (ghost record
format 2). Ghosts recorded before it (format 1, incl. kept personal bests) replay with both moves off, so
they still verify; any link older than the current version gets the "older build" note if it does not.
`v=3` is also the round 7 build (Vertigo, and the sky balloons that re-laid the Towers), so older Towers
ghosts that no longer verify get the same note.

Plain `?c=652&r=4764&d=normal&t=41.2` links (no `g`) still work: they preselect the title and show "beat
41.2 s" (claimed, not checked).

How it stays exact: the sim only reads the horizontal aim direction, the move vector and three buttons, so
a live round steps with the input **rebuilt from its quantised record** (yaw in 1024 steps per turn, move
in 1/64 steps; `src/game/ghost.ts`). The replay feeds the same records to a second Round with the same
seed and gets the same result bit for bit. sin/cos come from a table built with + - * / only, so a link
made in Chrome replays the same in Safari or Firefox. The link string is varint RLE of per-step changes,
deflate-raw (CompressionStream), base64url.

## Radbros

Pick your Radbro on the title; you chase one of the other three (the link's `r=` if it names one, else at
random). All four are playable from the start (none is a campaign unlock), and the pick is cosmetic: the
round is the same with any pair, so ghost links replay the same whoever you pick.

| | persona | taunts (a few) | caught / escaped |
|---|---|---|---|
| **#652** | showboat | "too slow, ser", "main character energy" | "ok ok, good content" / "gm, bagholder" |
| **#4764** | smug | "cope", "skill issue" | "this changes nothing" / "few understand" |
| **#2564** | paranoid ghost | "they're watching", "the balloons are listening" | "how did you see me" / "i was never here" |
| **#723** | cowboy (brown hat, the wink, "HOT TOPIC BRO" plate carrier) | "yeehaw", "this rooftop ain't big enough for the two of us", "catch me at Hot Topic, partner", "you're slower than dial-up" | "well, dang. fair draw, partner" / "happy trails, partner" |

Lines, personas and card colours are in `src/ui/strings.ts` (`TAUNTS`, `LINES`, `PERSONA`, `RADBRO_COLOR`);
the chatter pitch per Radbro is `VOICE` in `src/app/PlayViews.tsx` (#723 has the lowest). A speech bubble
stays up 1.8 s, longer for long lines (about 60 ms a character).

Adding a Radbro (how #723 went in):
1. In the owner's Radbro folder: `game-clips/radbro<id>_character.glb` (mesh + locomotion clips),
   `game-clips/radbro<id>.clips.glb` (the other clips on the same rig) and the `manifest.json` entry.
2. Add the id to `RadbroId` / `RADBROS` (`src/game/round.ts`) and `IDS` (`tools/assets.ts`), then fill
   the per-Radbro tables (`npm run typecheck` lists what is missing).
3. `npm run assets -- --radbros <folder> --only <id>` builds that Radbro's web GLB + clip pack and its
   `clips.meta.json` entry (the other Radbros' files stay untouched); `npm run assets -- --meta-only`
   measures the Regular_Jump takeoff / apex / feet-down times (#723: 0.467 / 0.8 / 1.1 s).
4. Dev server up, `RUGRUN_CHROME_PROFILE` set: `npm run portraits -- --only <id>` (title card),
   `npm run og-image -- --bg <saved frame>` (share card, one bust per Radbro); the key art busts are
   composited by the art script (untracked).
5. `npm test` (`test/roster.test.ts` checks the files, clip meta, lines and links for every Radbro).

**In the air (round 7).** A jump is Regular_Jump frozen on its upright apex; a long drop (falling faster
than 9 m/s with more than 4 m of air below, or 6 m of air below while dropping) crossfades into
**Free_Fall**, an upright loop treading air (arms sculling, legs kicking, never a dive), for you, the runner
and ghosts alike. A rope grab ends it. Landing after at least 0.35 s of free fall (or faster than 17 m/s)
plays **Big_Land**, a feet-first superhero crouch (one hand down, one arm up): the whole 1.4 s when you
stand still, cut after 0.5 s when you run on; shorter hard landings keep the Regular_Jump crouch. Rules:
`RULE` in `src/anim/animMachine.ts`. Both clips come from the owner's clip packs
(`game-clips/radbro<id>.clips.glb`, manifest entries `Free_Fall` / `Big_Land`); after new clips land there,
`npm run assets -- --radbros <folder> --packs-only` rebuilds just the four clip packs and their
`clips.meta.json` entries (the character GLBs stay untouched). `?portrait=<id>&clip=Free_Fall&t=1&full&yaw=90`
(dev / test build) renders one pose on its own.

## The chase and difficulties

Falling off the city = "rekt.": respawn on your last roof, -3 s. He panics (sprints) when you get close
and gets GASSED when his panic budget runs out. He stops to taunt you when you are over 35 m back.

| | runner | Yoink range | medals (RAD / GOLD / SILVER, s) |
|---|---|---|---|
| **Chill** | jogs (0.9x), sprints to 1.1x, gassed after ~14 s of sprinting, wanders | 6.5 m | 35 / 55 / 75 |
| **Normal** | sprints up to 1.5x from 40 m out, 30 s panic budget | 5 m | 25 / 40 / 60 |
| **Degen** | 1.2x base, sprints up to 2x from 50 m out, barely wanders, short taunts | 4 m | 30 / 45 / 65 |

Tuned against a swinging bot (below): a strong swinger catches him on Normal in about 25-30 s (median),
on Degen in about 45 s when it catches him at all (about a quarter of Degen rounds he escapes). Every
district lands in the same bands (see Districts).

## Districts

Pick the district on the title (a district change reloads the page; Retry never does).

| District | URL | Feel |
|---|---|---|
| **Downtown** | `/` | the original skyline: wide streets, balloons everywhere |
| **Night Market** | `?map=market` | dense and narrow (10 m streets, 10 m roofs), many junctions, some street stretches with **no balloons** (route around or carry momentum), purple dusk |
| **The Docks** | `?map=docks` | low warehouses (12-20 m), wide 15 m streets, long flights over the water |
| **The Towers** | `?map=towers` | tall roofs (38-52 m) between eight 90-130 m towers, deeper falls, sky balloons over the crossings |
| **Vertigo** | `?map=vertigo` | round 7: every ring of roofs is a spiral ramp (22 to 86 m, neighbouring rings climbing opposite ways), so next to every gentle step there is a 10-50 m cliff; three needle towers (120-170 m), two plazas, gold sky balloons everywhere. A **descending chase**: he starts on one of his three highest roofs and prefers routes that end lower, dropping off roofs onto much lower ones mid-run; you start at about his height. Open from the start |

Each district has its own level files: Downtown in `public/levels/`, the others in
`public/levels/<market|docks|towers|vertigo>/` (`city.json`, `decor.json`, `city.model.json`, `runner.pack.bin`,
`bake.report.json`). `tuning.json` is shared. Generator configs and looks: `src/world/districts.ts`.

- `npm run gen-city -- --map docks [--force] [--decor]` (re)generates a district (never overwrites an
  existing `city.json` without `--force`).
- `npm run level -- --map docks` / `npm run level -- --all` re-derives and re-bakes one / every district.
- `?editor&map=docks` / `?editor=decor&map=docks` edit a district; Save writes that district's files.
- Best times and kept ghosts are per district; share links carry the district (`&m=docks`).
- **Per-district chase tweak** (`chase` in `src/world/districts.ts`): the same runner and difficulty table
  everywhere, nudged per district so the swinging bot gets the same catch times as in Downtown (without
  it the Night Market fell in ~18 s on Normal and a quarter of its Chill rounds within ~3 s, the Docks
  and Towers in ~20 s). The Night Market and the Docks start you ~26-30 m behind him (their blocks
  squeezed the spawn); in the Night Market he sprints earlier and harder (his runs twist, so a swinger
  cuts corners); the Docks and Towers get a faster sprint, and a shorter Yoink on Degen (3 m) and on
  Towers Normal (4.5 m). Downtown has no tweak. `npm run balance -- --all --only swing` prints every
  district.
- **Vertigo's layout and route (round 7).** `generateVertigo` in `src/world/generate.ts` (config
  `vertigo` in its district entry: ring height ranges, climb per street / alley step, needles, plazas,
  summit mesas); `sky` adds the sky balloons (`chance`, `min`/`max` metres above the tallest roof within
  `radius`, grab `reach`; the Towers use it too), `lowTierDh` a second, lower balloon tier on streets
  that cross a big height step. His graph gains a third hop kind, the **drop**: an alley hop down by 6 m
  or more is walked off at a baked pace (the bake sweeps 20-100 % of his run speed and keeps the middle of
  the widest run that lands >= 1.5 m inside the lower roof with no wall contact; at least 8 points wide).
  Climbs he can never make (alley > 1.2 m, street > 4.5 m) are not linked at all. In Vertigo the graph
  also picks junctions spread out in height, tries drop-first routes and keeps edges with a drop first
  (14 junctions, 61 edges, 21 drop hops, falls up to ~30 m). Its chase tweak: `startHigh`, `down`
  (prefers edges that end lower), `spawnBelow` (spawn on a roof about his height, at least 0.8 x the spawn
  distance from him and 16 m clear of his first edge's route) and a slower runner that also slows down
  more for a chaser who got lost (`mMin`), with a 4 m Normal Yoink (numbers in the tweak's comment).

## Mechanics and mutators (round 4)

All deterministic and **player-only** (the runner plays his baked track and never feels them). They are
round options, part of ghost links and (where they touch the sim) the round hash.

| Mutator | What happens | Tell |
|---|---|---|
| **Popping balloons** | about 55 % of balloons (seeded per round) pop when your rope leaves them and grow back after 6 s | fragile balloons are pale; a pop sound |
| **Wind** | every 9-16 s a 2.4 s gust (8 directions, up to 7 m/s²) pushes you while airborne or swinging | HUD arrow ~1 s before the gust (yellow GUST), fills while it blows (blue WIND); a whoosh |
| **Low gravity** | your gravity x0.65: floaty jumps, long swings | - |
| **No YOINK** | no lasso: touch him | - |
| **One life** | the first fall ends the round ("He rugged you.") | - |
| **60 seconds** | a 60 s clock | the timer |
| **Night** | visual: dark sky, close fog, dimmed lights | - |

Free play starts with each district's defaults: **the Docks have wind, the Towers have popping balloons**
(the Night Market's balloon-free streets are part of its layout). Every other mutator appears as a toggle
on the title once you have caught him in a campaign level that uses it. Campaign levels set their own
mutators.
Values live in `MECH` (`src/sim/tuning.ts`), overridable in `tuning.json` under `"mechanics"` and with the
`?tune` sliders. Bots: `&mu=<bits>` (pops 1, wind 2, lowgrav 4, noyoink 8, onelife 16, sixty 32, night 64).

## Campaign (round 4)

**CAMPAIGN** on the title: 15 levels, 3 per district, each with a difficulty, mutators and three
objectives (a star each; the first is always "catch him"). The others mix: under N s, no falls, finish
with a YOINK, chain N swings, a close call (under N s left), and in Vertigo "catch him before he reaches
street level" (before he has stood on a roof below N m). The round HUD lists the level's objectives
live (crossed out once lost, ticked once met), and the results show which you got plus NEW stars.

| # | Level | District | Difficulty | Mutators |
|---|---|---|---|---|
| 1-3 | First Pour, Rush Hour, Pop Quiz | Downtown | chill, normal, normal | -, -, pops |
| 4-6 | Neon Alleys, Hands Only, Lights Out | Night Market | chill, normal, normal | -, no YOINK, night |
| 7-9 | Sea Breeze, Moon Jump, Last Call | Docks | normal | wind; wind + low gravity; wind + 60 s |
| 10-12 | Altitude, High Winds, Rugpull | Towers | normal, normal, **degen** | pops; pops + wind; pops + wind + one life |
| 13-15 | Top Floor, Free Fall, Street Level | Vertigo | chill, normal, **degen** | -, -, pops |

Vertigo's stars: Top Floor = no falls + chain 5; Free Fall = before street level (45 m) + chain 5; Street
Level = before street level (40 m) + no falls. (Level 10 was called "Vertigo" before round 7.)

Unlocks: the next level once you catch him in the previous one; a district in free play once you catch him
in its first level (Downtown and Vertigo are open from the start; `ALWAYS_OPEN` in `src/game/campaign.ts`); a mutator toggle once you catch him in a level using it; **Degen** in free play at 12
stars; hats for George at 9 / 21 / 33 stars (party hat, crown, tin foil; pick on the campaign screen).
Stars are best-of and live in the browser (`localStorage` "rugrun.campaign.v1", named for the working title and kept so progress carries over). Level list, objectives and
unlock thresholds: `src/game/campaign.ts`. A level in another district reloads the page on that district
(`?map=docks&lvl=7` opens the campaign screen on level 7). Bots: `&lvl=N` scores a bot round as level N
(pass that level's `d` and `mu` too).

## Art (round 4)

- **Skies**: one painted panorama per district, `public/sky/<district>.webp`, wrapped once round the
  horizon (the image is made tileable: its right edge cross-fades into its left, so no cloud shows twice
  and there is no seam); it fades into the district's zenith colour on top and the fog colour below
  (`SkyGradient` in `src/app/cityLook.tsx`, `SKY_Y0` / `SKY_Y1` set how high it reaches). The colour
  gradient shows until it loads; the night mutator still swaps in its own dark sky. A replacement
  panorama must tile horizontally (left and right edges continue into each other). Vertigo's (round 7) is a
  high morning above a cloud sea with needle spires far off (one generation, same seamless recipe).
- **Billboards**: eight painted ads (`public/textures/billboards/*.webp`) are materials `ad_<name>` in
  every district's `decor.json`, so in `?editor=decor` a billboard face's material can be switched to any
  of them. `npm run billboards` re-applies them to boards that still use a text Sign (keeps hand edits);
  `gen-city --decor` makes new decor with them (`src/world/billboards.ts`). Banners stay text Signs.
  The WAGMI board reads "SWING · CHASE · YOINK · REPEAT / WE'RE ALL GONNA MAKE IT" (its painted
  taglines were lettered over; no money or earning lines on the boards). To change a board, replace its
  `.webp` (same name) or point the `ad_<name>` material in `decor.json` at another texture.
- **Key art**: `public/ui/key-art.webp` behind the title while the city loads (the four Radbro busts are
  composited from the title-card renders, never generated).

## Dev pages (dev server and `npm run build:test` only; stripped from `npm run build`)

| URL | What |
|---|---|
| `?sandbox` | the old dev free-roam page with a debug HUD (`?sandbox&autoplay` = scripted chain-swinger); players use PRACTICE |
| `?tune` | live sliders for player, camera, the Chill/Normal runner table and George; Save writes `tuning.json` |
| `?editor` | react-three-game PrefabEditor on `public/levels/city.json` (gameplay layout); `&map=<id>` for another district |
| `?editor=decor` | the same editor on `public/levels/decor.json` (signs, rooftop props, the Milady stand) |
| `?routeview` | the runner's junction graph, with a live runner fleeing your mouse |
| `?bot=follow&k=1.3&seed=123&d=chill&c=652&r=4764` | a whole round played by the test bot (`bot=yoink` lassoes, `bot=chase` = the swinging balance bot on the real sim, `bot=swing` chain-swings for screenshots); `d=chill|normal|degen`. `bot=chase&rec` sends the bot's inputs through the ghost codec, so its catch gives a ghost link (`window.__play.ghost.url`). `&snap` freezes 0.12 s into each chaser jump / release; `&snap=freefall,sky,runnerff` (any subset) freezes once in the chaser's free fall, on a sky-balloon swing and in the runner's free fall (`window.__unfreeze()` resumes) |
| `?portrait=652` | one Radbro's Idle bust from its game GLB (`&yaw=`, `&bust=`, `&t=`; `&clip=Free_Fall&full` any clip, whole body); `npm run portraits` saves every Radbro to `public/ui/` for the title cards (`-- --only 723` for one) |
| `?hats` | George's three campaign hats on his head across his clips (one row per hat, 3/4 close-ups; `&yaw=` camera angle, `&lift=` / `&fwd=` try other offsets than `HAT_LIFT` / `HAT_FWD` in `src/app/hats.ts`) |

Challenge links (all builds): `?c=652&r=4764&d=normal&t=41.2` preselects the title and shows the time to beat
(`d=chill|normal|degen`); with `&s=<seed>&g=<ghost>` it is a ghost link (see "Ghost links").

## Editing the city and decor by hand

1. `npm run dev`, open `?editor` (city) or `?editor=decor`.
2. Move, resize, add or delete boxes. In `city.json`, the `Data {kind}` tag decides gameplay: `roof`
   (landable), `tower` (solid, not landable), `hook` (an extra balloon; auto balloons within 3 m make
   way). Everything else about balloons is derived from the roofs. Keep boxes unrotated and standing on
   the ground.
3. Save. Under `npm run dev` Save writes the file and, for `city.json`, runs `npm run level` for you
   (new sim model + a fresh runner bake). Outside the dev server Save downloads the file: copy it into
   the district's level dir (`public/levels/` or `public/levels/<id>/`) and run `npm run level -- --map <id>`.
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

Double jump + web zip (player only; the runner bake and old ghosts run with them off, so these never need
a re-bake): `airJumps` (1; 0 = no double jump), `doubleJumpSpeed` (7.5: v.y = max(v.y, this)), `webZip`,
`zipSpeed` (26 m/s, but the speed cap wins), `zipPull` (how fast the velocity turns onto the line),
`zipRange` / `zipRise` / `zipDrop` (ledge search along the aim, how far above / below you), `zipCooldown`
(1.5 s), `zipRelease` / `zipMaxTime` (auto-release distance / time), `zipFlingFwd` / `zipFlingUp`
(balloon release fling), `zipLedgeSpeed` / `zipLedgeUp` (the hop onto the roof). All in `?tune`.

The runner is baked with the same player constants, so after changing any other `player` value run
`npm run level` (the dev-server Save does it), then `npm run balance` to see the catch rates, and commit
the regenerated `runner.pack.bin` and `bake.report.json`.

`npm run balance` plays 200 seeded rounds per row with three kinds of bot: the follower (runs his trail
at k x his speed, never swings), the camper, and the **swinging chaser** (`SwingBot` in
`src/game/bots.ts`: the real player sim, chain-swinging down the streets at ~16 m/s, letting go past
each balloon near the bottom of the arc, cutting over to him and Yoinking after a ~0.1-0.2 s reaction).
Targets: Normal swinger median 25-40 s, Degen swinger median ~45-70 s with some escapes, the old
follower targets for Normal/Chill. The `swing+moves` rows are the same bot also double-jumping off drops
and web-zipping at him from the roofs (info: Downtown Normal median ~20 s vs ~28 s, Degen ~38 s vs ~45 s;
the runner table was left alone). `--set normal.gStar=36` tries a value, `--only swing` runs just those
rows, `--n 500` more seeds, `--map market` / `--all` another / every district (with its chase tweak).
`npm run probe:canyon`
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
  `?tune` (or a district's `chase` tweak) if catches come too easily or too hard. A few rounds still end
  in seconds when his first run bends back toward you (his runs are pre-baked; he only re-decides at
  junctions): for the swinging bot about 1 in 10 Chill rounds ends within ~4-6 s, in every district.
- The Milady loads from GitHub raw (raw.githubusercontent.com) with jsDelivr as the fallback (jsDelivr
  404'd on some cold files, e.g. #270). `?milady=0` turns her off.
- Ghost links replay only on the same game version: a later change to `tuning.json` (player or difficulty
  values), the city or the runner pack makes older ghosts drift and show as "unverified".
- Nobody has listened to the recorded audio yet: the mix (loop levels, the dip under speech, the brighter
  close-chase loop, the Towers loop seam) was set from measured levels, not by ear. Levels live in
  `src/audio/tracks.ts`, `voice.ts` and the gains in `sfx.ts`.
- George's paws slide a little above ~4.8 m/s (his run plays up to 4x to keep up); he hides when the
  camera is pulled in close to him.
- The production build is ~23 MB (models ~6.6 MB incl. four Radbros, 7.9 MB of audio, five districts' level
  files, round 4 art; Vertigo's runner pack is 401 KB); the 9 MB budget is not enforced. The audio is only
  fetched once a round starts (about 3 MB per round).
- Round 7 re-baked the Towers (sky balloons renumbered its balloons; his runs are the same), so Towers ghost
  links made before it show as "unverified". Vertigo is tuned against the swinging bot, which is all or
  nothing there: when a street line crosses his route it swings in fast (his drops cost him horizontal
  speed), otherwise it gets lost under the cliffs. Swing bot, 600 seeds: Chill 98 % caught (median 9 s),
  Normal 73 % (27 s, in the 25-40 s band; Downtown 93 % / 27 s), Degen 67 % (32 s; the Degen band wants
  40-70 s, Downtown 73 % / 46 s). Runner tuning only trades catch rate for median here (tried: speed,
  sprint, sprint budget, rubber band, Yoink, taunts, spawn distance, start roofs), so Degen stays below its
  band on the bot. A human pass decides whether Vertigo's runner is too soft or too hard.
- Round 4 districts, mechanics and campaign are tuned against bots only: the campaign's time / chain
  objectives (`src/game/campaign.ts`; the time stars were re-set in round 6 so the bot needs a good run
  for them) and the district mechanics (`MECH`, `?tune`) need a human pass.
- The round-6 district retune changed Night Market / Docks / Towers rounds, so ghost links made there
  before it show as "unverified" (Downtown links are unchanged).
- George's hats ride his head bone (they turn, nod and tilt with his head). `HAT_LIFT` / `HAT_FWD` in
  `src/app/hats.ts` set where they sit (preview: `?hats`); the crown and the tin-foil hat let his ears
  poke through, which is intended.

## Link previews

`index.html` carries the title, description, theme colour, favicon and the Open Graph / Twitter card
tags (`twitter:site` / `twitter:creator` @dexedrne). The canonical / og:url / image URLs are absolute on https://radrun.vyvanse.beer (the canonical
address; `vercel.json` permanently redirects the old rugrun.vyvanse.beer and vercel.app hosts there, path and
query kept), so change them if the game moves. Share and
challenge / ghost links are built from the address the game was opened on.
`public/og.jpg` (1200x630) is a mid-swing frame from the game with the logo, the pitch and the four
Radbro portraits; `public/favicon.svg` is drawn by hand. `npm run og-image` (dev server up,
`RUGRUN_CHROME_PROFILE` set) re-renders `og.jpg` and `apple-touch-icon.png`: `--pick N` takes another
frozen swing from the `?bot=swing` round, and `--bg <png>` re-composites over a saved frame.
