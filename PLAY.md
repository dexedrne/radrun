# Playing SPIDERTAG

Web-slinger tag over the rooftops. Two modes: **TAG** (whoever holds the bag chases; vs 1-3 bots, or 1v1 online) and
the **CHASE**: he swiped your bag, and you have 90 seconds to tag him (touch) or YOINK him (lasso) before the rug shows
up (PLAY on the title, plus CAMPAIGN and PRACTICE). SPIDERTAG wagers (beta) are 1v1 TAG for tokens on Robinhood Chain.
The coin, $SPIDERTAG, has its own page: https://token.spidertag.vyvanse.beer (also https://spidertag.vyvanse.beer/token).

**Play it: https://spidertag.vyvanse.beer** (desktop with a mouse, or a phone / tablet in landscape; the old
https://radrun.vyvanse.beer, https://rugrun.vyvanse.beer and https://radbro-rug-run.vercel.app addresses redirect there,
path and query strings included, so old challenge, ghost, room and wager links keep working). The game was called
RadRun until October 2026: storage keys, relay Worker names, the radbro.fun slug and the wager contracts keep the old
names, so saves, scores and signatures carry over. A browser keeps saves per address, so the first time it opens the new
one, the game fetches them from the old one once (a hidden frame on radrun.vyvanse.beer/carry.html, the one path there
that doesn't redirect; `src/ui/carry.ts`) and reloads, unless it was opened on a room, invite or series link or has
already had a key, click or touch: then they count from the next load.

## Run it

```sh
npm ci
npm run dev        # open http://localhost:4870/  -> PLAY (or your Radbro's row: pick him, Chill / Normal / Degen, the district)
```

Node 23.6 or newer. A WebGPU browser is best (recent Chrome/Chromium); `?webgl2` forces the WebGL2
backend. `npm run build && npm run preview` serves the production build on http://localhost:4871/.

## The title

Laid out like the shooters' titles (RadZombies'): the key art full-bleed under soft shading, the SPIDERTAG wordmark
and a terminal-font tagline top left, then the menu as a list of big items with a pink focus bar: **PLAY** (RACE GHOST
on a ghost link), **RACE YOUR BEST** (when you have a best run for this Radbro, difficulty and mutators),
**CAMPAIGN** with your stars, **PRACTICE**, **TAG**, **your Radbro's row** (his bust, his name, the difficulty and the
district), **CONTROLS** (the keys, the touch buttons or the pad's, and the credits) and, framed by vyvanse.beer,
**BACK TO VYVANSE.BEER**. A line under the list says what the focused entry does. Bottom left the
"[ OK ] spidertag.vyvanse.beer" status line ("[ .. ] loading the city" until PLAY is ready), bottom right links to
RadPayne, RBGO and RadZombies; top right the $SPIDERTAG token page, the tip jar (vyvanse.beer/#tip in a new tab) and
the speaker. The token and the tip jar never show inside someone else's portal (radbro.fun); the other games' links
open in a new tab when the game is framed. Your Radbro's row opens the **character select**: the seven as cards, then
the difficulty, the district (a district change reloads the page) and any mutators you have unlocked; DONE (or Esc,
or Circle / B) goes back. The arrow keys move the focus down the list, on through the other games and back to the top
(as on the shooters; left / right on your Radbro's row changes him), the mouse moves the same focus, Enter picks what is
highlighted, Tab follows the same order; a pad's up / down walks the same loop. Landscape phones get the list in two
columns, portrait phones one narrow column, both inside the safe areas; a title or character select that would scroll
(a challenge or ghost line on a short window, a small phone with the districts and mutators unlocked) shrinks its type
and gaps until it fits. Behind the key art the city stops rendering while the title is up (`src/ui/title.tsx`).

## Controls

| | |
|---|---|
| Mouse | look / aim (PLAY captures the mouse; click the canvas if the browser refused) |
| WASD | run |
| Space | jump; **Space again in the air = double jump** (once per airtime, not on the rope; landing, a rope grab, a wall run or a ledge grab recharges it); on a wall (or just off one) = **wall kick** (round 12: each kick without touching the ground or the rope goes 0.8 m/s higher, three times); hanging on a ledge = climb-jump; **at the end of a zip = zip pop** (round 12); **right as you slam a wall = rebound kick** (round 12) |
| LMB hold | **swing**: the yellow ring sits on a rim, a corner, a facade, or (round 12) a **cable across the street** or a gantry / skybridge / tank / billboard - whatever your aim (and your speed) points at - and glides along it as you turn; **the higher you are, the higher and further ahead it goes** (a longer web: a long sweeping arc that bottoms out over the street). Hold to stay attached through the arc and around corners; you **speed up through the bottom**. Let go **near the top of the forward arc** (32-58 degrees past the bottom) for a **perfect release**: the web flashes white, a ding, +4.5 m/s and a pop up. A wall or ground impact can cut the web with a red snap; the snapping-web mutator can cut it too. LMB on a roof with a ring pulls you up and off the edge. No ring = nothing tall enough ahead: run, vault, zip, leap or drop off instead |
| G hold in the air | **wingsuit glide** without a web: spread the arms and legs, keep forward speed with a slow sink. Look down to dive and gain speed; pull up to trade speed for height. Steer with WASD and mouse aim. Speed and height are capped by the energy you carry into the glide. Release G to drop; a web or zip keeps your speed, and landing becomes a roll |
| C | round 12: **tap = slide** (while running fast; Space out of a slide = slide-jump), **hold = charge a leap** (a ring fills at your feet, yellow at full after 0.7 s; let go - or press Space - to launch: from a roof up to ~10 m up and 30 m across, from a wall run / run-up a big wall jump, from a ledge hang straight up, on the rope a **slingshot**), **in the air = dive** (a fresh press with 6+ m under you, held: head first, faster than a fall - up to 46 m/s - and the stick steers it; **web out of it and the swing keeps the dive's speed**: the dive-into-swing; land holding C to slide into a charge) |
| E / Shift | round 12: **zip where you look** - a straight pull at 30 m/s along the camera (tilted up 8 degrees) to the first thing it hits within 45 m: a rim = up and the **ledge pop** onto that roof at 12 m/s; a facade = a wall run (fast, at an angle), else a run-up, else a push off; a **cable** = a fling past it along the zip, or with LMB held you swing on it; a roof top = you land. A **white diamond** shows the target every frame (grey = out of zips / cooling down). Nothing hit = the ringed anchor if it is within 15 degrees of the aim, else the **zip fan** (the same ray again 10 and 20 degrees off the aim, 8 ways round, up first: falling down a canyon while you look at him still finds a facade, a rim or a cable), else **no zip** (the grey X; nothing spent). **Two zips per airtime** (landing, a rope grab, a wall run or a ledge grab refills them), 0.35 s apart; a second E or LMB ends a zip early. When the **red dashed ring** is on him (within 12 m on Normal / 9 m on Degen, in the aim cone, in sight; no yank on Chill), E is the **web-yank**: a homing zip at him for 0.7 s (a miss: 2.5 s before the next) |
| (by themselves) | **wall run** (hit a facade at an angle while airborne), **run-up** (hit it head-on with the stick into it: ~5 m up the wall, then a ledge grab if the top is in reach), **ledge grab + climb** (a roof edge within reach in front of you), **vault** (a low rooftop box ahead while running), **landing roll** (a hard landing with the stick forward) |
| LMB on the red ring (on him, in range, in sight) | YOINK |
| Q / RMB | ease the camera toward him |
| R | retry (hold 1 s mid-round; tap on the results screen) |
| M | mute / unmute (same as the speaker button on the title and the HUD) |
| Esc | pause (Settings: quality, music style (Chill / Chase), sensitivity, music / sound-effects / voice volume, mute, FOV, invert Y, reduced motion, easy grab; the controller settings once a pad has been used) |
| (a gamepad) | everything, menus included: see **Controller** below |

**Phone / tablet (touch).** Turns on by itself on a touch screen (coarse pointer, or at the first touch);
`?touch` forces it on, `?touch=0` off. Landscape plays best (portrait shows a "rotate your phone" hint).
The title's **CONTROLS** lists the touch controls (the touch buttons are labelled and the first-run tips teach them).

| | |
|---|---|
| Left thumb (anywhere on the left half) | floating stick: run / steer on the rope (sideways only) / push into a wall for a run-up |
| Drag on the right half | look / aim |
| WEB (hold) | web the ringed building; let go to release (near the top of the arc = perfect); the stick into a cross street at speed = corner swing; slide the thumb while holding to turn the camera. Turns red = YOINK |
| JUMP | jump; tap again in the air = double jump; on a wall = wall kick; end of a zip = zip pop |
| GLIDE (hold) | wingsuit in the air: steer and pitch with the right-side drag; release to drop; landing rolls |
| SLIDE | tap = slide, hold = charge a leap (the button wears a yellow ring; let go to launch), in the air = head-first dive, held (small, left of JUMP) |
| ZIP | zip where you look (the drag on the right half sets the pitch too; the white diamond is drawn larger on touch); on the red dashed ring = the yank; dimmed while it recharges |
| HIM (hold) | ease the camera toward him |
| II | pause (Resume / Restart / Settings / Quit; Settings has the Low / High quality switch and the volumes) |
| speaker (under II) | mute / unmute |

Touch helps your aim: the cone widens to 85 degrees (desktop 70), anchor picking leans toward where you
are going, and the Yoink range is 1 m longer. The first tap goes fullscreen (and locks landscape where the
browser allows it). There is no pointer lock, and leaving the tab pauses. On phones the canvas renders at up
to 1.25x the CSS pixel size (1.5x on tablets and desktop). Touch values are `TOUCH` in `src/sim/tuning.ts`.

### Controller (round 14)

Any pad the browser reports with the standard mapping works: DualSense / DualShock (USB or Bluetooth), Xbox pads,
most others. Plug it in (or pair it) and press a button; it works on radbro.fun too (the frame allows gamepads).
The **last device you used decides the prompts**: a pad switches every hint, tip, controls list and menu to
**PlayStation glyphs** (Cross, Circle, Square, Triangle, L1 / R1 / L2 / R2, Options, Create) when its name looks like a
Sony pad, **Xbox glyphs** (A, B, X, Y, LB / RB / LT / RT, Menu, View) otherwise; a key press, a click or a real mouse
move switches back to the keyboard prompts. More than one pad: the one pressed last plays.

| PlayStation | Xbox | |
|---|---|---|
| left stick | left stick | run (a light push = a jog: the stick is analog) |
| right stick | right stick | look / aim (held at the rim it speeds up for a quick about-face) |
| R2 (hold) | RT (hold) | **swing** (steer into a cross street = corner swing); let go near the top = perfect release; on the red ring = **YOINK** |
| Cross | A | jump; again in the air = double jump; on a wall = wall kick; end of a zip = zip pop; right at a wall slam = rebound |
| Circle | B | tap = slide, hold = **charge a leap**, in the air = head-first **dive** (web out of it for a fast swing; the C key) |
| R1 or L2 | RB or LT | **zip where you look**; on the red dashed ring = the **yank** (E / Shift) |
| L1 (hold) | LB (hold) | wingsuit glide in the air; right stick pitches down for speed and up for height |
| R3 | RS click | ease the camera toward him (Q) |
| Triangle (hold 1 s) | Y (hold 1 s) | retry mid-round (practice: back to the start roof) |
| Options | Menu | pause |
| Create | View | mute |

Easy grab (pause -> Settings) works on the pad too: Cross / A is the Space key (tap = jump, hold = swing).

**Menus** (title, campaign, pause and its settings, results, loading errors, TAG menu, results and pause, the
online lobby): a yellow ring shows the focus (on the title, the menu's pink bar and a pale ring on its cards, chips and
links); the d-pad or the left stick moves it to the nearest control that way,
**Cross / A** presses it, **Circle / B** is back (pause: resume; results: menu; campaign, TAG and online:
back), **Options / Menu** resumes from the pause and starts a campaign level, **Triangle / Y** on the results =
retry / rematch. On a slider, left / right changes it. The first press after using the keyboard or mouse only shows
the ring (so it never starts a round by surprise). A legend in the bottom-right corner shows the menu buttons.
The online room code: Cross on the code box opens an on-screen picker (Cross types the ringed character, Square
deletes, Circle cancels, Options = done). A pad never captures the mouse (a pad press can't grant the pointer lock
and needs none); Esc still pauses, and a click on the canvas captures the mouse again.

**Settings** (pause -> Settings -> controller, shown once a pad has been used; remembered in the browser with the
other settings): stick look speed (0.3-2.5x), stick dead zone (4-35 %, radial: the direction is kept), invert Y for
the right stick (separate from the mouse's), vibration on / off (dual-rumble where the browser supports it: light on
webs, zips, yanks and hard landings, firmer on bonks, falls and catches; in TAG on tags). The stick shaping
is `PAD` in `src/input/gamepad.ts`; the button layout is its `LAYOUT` table (the prompts and the controls lists are
built from it).

**Replays and online stay the same:** the pad writes the same input as the keyboard, mouse and touch (the left stick
is the move a touch stick gives, the right stick turns the same camera), so it records the same quantised input word:
ghost format 4, share links v6, runner packs v3 and the TAG online inputs did not change, and a run made on a
pad replays exactly like any other. A full-tilt stick is exactly full speed in every direction (same as W / W+D).

**Sound:** browsers only start audio after a click or a key press in the page; a pad press does not count. Playing
with only a pad, the menus say so ("sound starts after one click or key press"); click once anywhere.

**iPhone: play it from the Home Screen.** Safari on iPhone can't go fullscreen from a web page, and in
landscape its toolbars take a big slice off the top. Two fixes:
- **Add to Home Screen** (Share -> Add to Home Screen): the SPIDERTAG icon then opens full screen with no
  Safari bars at all (`public/manifest.webmanifest`, icons in `public/icons/` from `node tools/icons.ts`).
  The Home Screen app keeps its own save, so campaign stars and bests start fresh there.
- **In a Safari tab:** while the toolbars show in landscape (title, campaign, results or pause, never
  mid-round), an overlay asks for one **swipe up**; Safari then minimises its bars. "not now" hides it
  for the rest of the tab session. The title also shows a one-time "Add to Home Screen" tip (✕ hides it).

The HUD, the touch buttons and the menus stay clear of the notch / Dynamic Island side and the home
indicator (safe-area insets); a landscape phone gets the title's list in two columns, so it fits on one screen with the
toolbars showing.

**Quality (pause -> Settings).** High is the default everywhere (on touch devices High already caps the
pixel ratio: 1.25x on phones, 1.5x on tablets). Low = pixel ratio 1, anti-aliasing off (after a reload),
no blob shadows, no runner trail, and no rooftop AC units or antennas (the water towers stay). It switches
immediately and is remembered in the browser (localStorage). Try Low if a phone runs hot or choppy.

**Auto quality.** During the first 10 s of each chase on High (after a 1.5 s warm-up) the game measures
its frame time. If the median says it runs below ~40 fps, it switches to Low once and shows "switched to
Low quality for smoother play — change in Settings". That choice is remembered; it never switches back by
itself, and once you pick Low or High in Settings it never touches the setting again. `?autoq=0` turns
it off for that page load. The numbers are `AUTO_Q` in `src/app/autoQuality.ts`.

## The web-slinger swing (round 15)

Design and numbers: `docs/specs/2026-09-27-web-slinger-swing.md`. The controls are the same (LMB / R2 / WEB swing,
C / Circle / SLIDE dive, every round 12 move as before); the swing itself got the big console web-slinger's shape:

- **Web length from your height.** High over a street the ring goes to a taller rim further ahead (0.35 m higher and
  0.3 m further per m your feet are over 12 m above the ground below, up to 34 m up): a longer web, a long sweeping
  arc that bottoms out over the street. Low down nothing changes. The floor clamp still keeps the bottom of the arc
  6 m over the floor, and it now reels the web in faster the faster you go, so a fast low web never scrapes the street.
  Nothing above you in range = no ring, as before.
- **Speed through the bottom.** The surge adds speed along the swing through the bottom of the arc (from ~37 degrees
  before it, full at the bottom, to ~11 degrees past it). The climb after that is yours to time.
- **Release.** Let go in the **perfect window**, 32-58 degrees past the bottom on the way up: +4.5 m/s along your
  flight and a 2.5 m/s pop up, the web flashes white, and your Radbro flips (every other one a twirl). The web stays
  attached while held, including at the top of an arc and through a corner swing. A ground or wall hit or the
  snapping-web mutator cuts it with a red snap effect. Round 11's timed lift past 15 degrees is +6 m/s up.
- **Corner swings.** Swinging (or flying with the web held) at 9+ m/s, turn the stick 40+ degrees toward a cross
  street as you pass a building's corner on that side: a web goes onto the corner and you swing round it, level and
  at full speed while held. Let go to launch along the new street. Jump lets go with a hop. Needs the building to
  stand over you and 5 m of air under you.
- **The dive.** C in the air (6+ m under you), held: head first, faster than a fall (up to 46 m/s; a fall stops at 32),
  and the stick turns it. **Web out of a dive** (or within 0.4 s of it) and the swing keeps the dive's speed when the
  web goes taut; the speed over 32 m/s is carried and wears off at 5 m/s each second: the dive-into-swing.
- **Camera.** In the air it pulls back a little with speed and the FOV widens (to +18 degrees at 34 m/s, +3 more
  diving, with the camera a little closer: 6.5 m, was 8); it rides the swing's rise and fall instead of bobbing with every arc, leads your motion across the view so
  there is room ahead, never rolls, and the aim is still exactly where it points. Reduced motion turns this off.
- **Animation** (view only, procedural on the Radbro rigs over their clip packs): the **head-first dive** (body along
  the flight, arms swept back, legs together), a **skydive spread** on a long fall (belly down, arms and legs out,
  knees bent, a little flutter; it lets go just before the landing so the feet come down first), a livelier swing
  (the web arm up on the web, knees tucked through the bottom of the arc, legs and the free arm reaching out at its
  ends), a flip or twirl on a perfect release, and the hang pose on a corner web. The thief and ghosts get the same
  poses; TAG too.
- **Bots** play the same physics: the chase bots and TAG bots corner-swing at the crossings, the tech / sharp
  bots dive at a target well below and let go in the wider perfect window. Balance: "The chase and difficulties".
- **The thief keeps the round 12 swing** (his baked hops are unchanged: the packs are still v3 and bake byte for
  byte). Ghosts and links from before this build replay with the round 12 swing and say so (see "Ghost links").
- Every number is a `tuning.json` key with a `?tune` slider ("web-slinger swing", "corner swing", "dive", and the
  camera's `speedArm`, `lagY` / `lagYMax`, `lookAhead` / `lookAheadMax`, `diveFov`); see "tuning.json".

## Moving (rounds 9-11; round 12 below)

**The swing.** There are no grab points: webs stick to the buildings themselves. Every step the game looks
for the building face nearest an ideal point about 10 m (+ 0.5 s x your speed) ahead of you and 24 m up,
at least 5 m above you, 8-42 m away, inside the aim cone and in clear sight; a point on a roof is moved to
the roof's edge, so the ring is always on a rim, a corner or a wall, never on open sky or the middle of a
roof. On a low roof with nothing tall nearby there is no ring at all; falling with nothing in the cone, the
search widens to about 100 degrees either side (round 10), so a crossing or the end of an avenue is not a
drop to the street. **Round 11: the ring prefers anchors whose swing clears the walls.** The four best
anchors each get a quick run of the swing they would give (1.2 s ahead); one whose arc carries you head-on
into a facade (most often the anchor's own building: a web to the face ahead) or out past the edge of the
city scores 14 m worse (`anchorArcPenalty`). The rope then works as a real pendulum around a pivot out in
the street's open air (round 10: half-way across to the facing building, at most as far out as you are,
4-12 m off the wall), so a web to a side building swings you down the street instead of into its wall.
Gravity pulls harder on the rope (x1.35), the speed you had when the rope goes taut is kept (up to 1.6x),
you gain speed through the bottom of the arc (pump), and **the swing goes where you push the stick** (round
10: its sideways drift dies out in about 0.4 s, speed kept). A web snaps only when the rope itself (you to the
pivot) is blocked. One speed cap, 32 m/s.

**Timing (round 11).** Let go on the way up, from about 15 degrees past the bottom of the arc (the sweet
spot) until the auto-release: the fling gets 11 m/s more up (`releaseSweet`; round 15: 6), so a timed chain keeps its
height. Holding on, the swing lets go by itself past about 50 degrees (round 15: 58, with no release boost) or near
the pivot's height, with no extra kick; letting go at the bottom flings you flat and fast and you sink. On the upswing, with the stick
along the swing, the rope reels in a little (3 m/s, up to the sweet spot). A chain down an avenue (Node probe
from every street-facing roof edge, 10 s): released on the way up +0.4 to +0.8 m per swing, holding the web
the whole time about -0.5 m, released at the bottom about -5 m per swing (round 10: -3 m per swing for the
`?bot=swing` release, -7 m at the bottom).

**Web from a roof (round 11).** Webbing while you stand on a roof pulls you up and off it: the rope reels in
at 14 m/s until its arc clears the roof's edge by 1.5 m (`webLift`, `webLiftClear`), so the first swing
starts like the rest of the chain instead of a 1 m hop back onto the roof on a loose web (99 % of ringed
presses from a roof edge now leave the roof; round 10: 5 %).

**No more wall slams (round 11).** On the rope, and for 0.6 s after you let go, a facade you would meet
head-on within 0.7 s bends the swing along it at up to 4 rad/s, speed kept (`swingAvoid*`): into the cross
street or a wall run, not flat into the wall. A run-up that tops out short of the rim kicks you off the
wall (6 m/s, `wallUpKick`); falling along a facade off the rope with nothing to catch you pushes you off it
(3 m/s, `wallPushOff`) instead of a slide down the face; a wall run into an inside corner turns onto the new
face. Flying out past the city's edge (on the rope or not) bends you along it (`edgeAvoid`, `edgeMargin`), so
an avenue that runs out of city is not a drop off the world. Hold-forward chains (Node probe, the `?bot=swing`
policy, 30 seeds x 40 s): a swing ends on a wall about once in 200-600 swings in Downtown and the Towers
(round 10: once in 15-50), no slides down a face, and 8-14 falls per 1000 s (round 10: 42-64, all of them
off the edge of the city).

**Camera (round 11).** It keeps 3 m (`armMin`) between itself and the Radbro: when a facade behind him (or
the rope lean toward the pivot) would pull it closer, it swings round him (sideways or up) to where there is
room, at `dodgeRate`; on the rope it also keeps 0.8 m off the web line (`webClear`), and the web is never
drawn within 1.2 m of the lens. On a wall run (and just after) it keeps 1.4 m off the wall's face
(`wallCam`). The Radbro fades only when the camera itself is within 2 m of him.

**George (round 11)** tucks away (shrinks out of sight in 0.1 s) while the moment he is following is a swing,
a wall run, a ledge hang or a zip, or once he has been in the air 0.45 s (`airShow`, `showRate` in the
`george` section), and pops back in on the ground behind you. He no longer floats beside or over you
through swings and falls.

**Parkour.** Between swings you can wall-run (1.4 s along a facade at 11 m/s, light gravity), kick off a
wall (Space; alternating between two walls climbs out of an alley), run up a wall head-on (~9 m of reach
with the ledge grab; round 10: it keeps your momentum, so a swing into a facade at 25 m/s runs up it at
14 m/s, ~12 m, instead of stopping dead), grab a ledge and climb it (automatic after 0.2 s; Space =
climb-jump, the stick away = drop; round 10: a swing into a rim in reach lets go and grabs it), vault low
rooftop boxes (0.8-1.4 m AC units and crates; the 2.2-3.2 m tanks and container stacks
are climbed), slide (C / SLIDE) and roll out of a hard landing. Everything you see on a roof that is 0.5 m
or taller is solid. You fall only when you actually reach the street (feet below 2 m): respawn on the last
roof, -3 s. Every number is a `tuning.json` key with a `?tune` slider (see "tuning.json").

**The thief moves the same way** (the same sim, baked into his tracks, with round 10's pendulum: none of the
round 11 helpers above): he swings across streets on building anchors (round 10: a pendulum with its pivot
over the middle of the street, tried first; round 11: any building near the street's middle can hold one,
also a tower on the crossing's corner, and a level or downhill crossing needs only a building a little
above him), wall-runs the notches between roofs, runs up walls and climbs ledges (steps up to 9 m), and
vaults props. He **web-zips** only where nothing else works: up the podium walls too high to swing or climb
to, and the few crossings with nothing to web. Round 11: a street swing that bakes with a 100 ms release
window (a zip's) beats the zip across. Hop mix of his kept routes, swings / zips: Downtown 61 % / 7 %
(round 10: 52 / 14), Night Market 58 / 6 (42 / 25), Docks 56 / 1 (57 / 2), Towers 45 / 15 (27 / 32),
Vertigo 45 / 11 (32 / 25). He never slides, double-jumps or steers in the air.

## Round 12: web-slinger tag

Design: `docs/specs/2026-09-26-round12-spider-tag.md`. The city gets things to web between the buildings, E
zips straight where you look, holding C charges a leap, a few timing moves raise the skill ceiling, and the
thief uses the same kit.

**Structures between the buildings** (`src/world/structures.ts`, derived by `npm run level` from city.json like
the adjacency; city.json is never touched, move a building and re-run level and they follow):
- **cables** across every street (always at least 3 m under the lower roof: a roof you run on never meets one), no
  collision, web them anywhere along their length (the ring glides along the cable, 2 m clear of its ends). Downtown,
  the Towers and the Docks hang **two per facing pair**, one 2.5 m in from each end of the pair's span (`cablePairs`
  2, `cableInset`), so there is one on each side of every crossing and alley (every ~9-26 m instead of 23-40 m);
  Market (the parkour district, the owner's call: the spec's density) and Vertigo keep one per pair. Height tiers
  alternate per pair (`cableTier1` / `cableTier2`); no two cables on a street closer than 6 m;
- **sign gantries** (one per street, 13-16 m up, landable, a wall-run side) and **skybridges** (glass, 4 m wide,
  floating over the street: land on them, wall-run their sides, bump your head on them). A web to one goes to its
  **underside** and the pivot is that point (you swing under it and on down the street; the facade rule's push put the
  pivot in front of it and swung you into its face);
- **rooftop water tanks** (7-10 m tall, in a roof corner) and **billboard frames** along street edges, both
  landable and good anchors above the low roofs; **scaffolding / fire escapes** on a few street facades.
- Counts: Downtown 158 cables / 27 gantries / 6 skybridges / 9 tanks / 8 boards; Market 135 / - / - / 21 / 7 (+5
  fire escapes); Docks 104 / - / - / 13 / 2; Towers 222 / 31 / 17 / 5 / 1; Vertigo 68 / - / 5 / 9 / -. Per-district
  knobs: tuning.json `structures` (and the ?tune sliders, which re-derive them live in `?sandbox`).
- **Which anchor the ring picks** (`findAnchor`): a cable scores `rigBonus` (4) m better, but a cable point more than
  `rigSideFree` (4) m off your line (a side street's cable at a crossing: it swings you into the facades) scores
  `rigSide` (1) worse per m, and one less than `rigNearAhead` (12) m ahead (nearly overhead: a drop, not a swing)
  `rigNear` (2) worse per m short. In the canyons (read-only sampling of every street at 0.3 / 0.5 / 0.7 x the lower
  roof, 20 m/s along it) the ring is now a cable 45 / 31 / 11 % of the time in Downtown (was 33 / 25 / 7), Towers 37 /
  33 / 7 (25 / 27 / 4), Docks 23 / 11 / 3 (14 / 7 / 4). The "pivot 12-32 m ahead over the street" share is now above
  the no-structures one in the Towers (79 / 77 / 72 % vs 75 / 75 / 72) and within 2 points of it in Downtown (81 / 78 /
  72 vs 83 / 80 / 72) and the Docks (77 / 70 / 63 vs 77 / 71 / 63); the first cut was 5-7 points under it low in the
  canyons (Downtown 76 / 74, Towers 70 / 71).
- Deviations: a street run is the whole street line (the blocks are ~40-60 m, so "cut at every crossing" gave
  1-2 stations per run: all gantries, one cable tier); rooftop fixtures sit 1 m in from the roof edge and 1.5 m
  off its centre (the spec's 2.5 m / 4 m left no room on the 12-15 m roofs of Market, the Docks and Vertigo).
- Lint G9-G12 (clean everywhere) and the **G11 swing-coverage stat**, printed by `npm run level` next to the
  no-structures baseline: Downtown 72 % (71.7), Market 74 % (74.0), Docks 63 % (63.3), Towers 72 % (71.6),
  Vertigo 84 % (83.5). The spec's targets (90 / 60 / 70 / 90 / 75) are missed in Downtown, the Towers and the Docks
  and cannot be met under the spec's own height rule: G11 samples at 0.7 x the local pair's lower roof, and where
  the pairs 12-32 m ahead are lower (the skyline steps down, or a crossing), their cables hang below you - even a
  test with X-shaped span wires over every crossing (deferred by the spec) only reached Downtown 73 %, Towers 80 %.
  The misses are almost never "a cable was in the window but the ring took something else" (0-4 % of samples).
- Drawn by `src/app/StructuresView.tsx` (8 instanced draw calls, one billboard texture; Low quality drops the
  signal glow, cable highlights and board lighting, never a structure), also in `?editor`.

**E: the straight zip.** Goes where the camera points (pitched up 8 degrees), in a straight line at 30 m/s, to
the first thing the ray hits within 45 m (a white diamond previews it; grey = out of zips / cooling down).
Nothing on the ray: the ringed anchor within 15 degrees, else the zip fan (the ray again 10 and 20 degrees off the
aim, 8 ways round, up first; `zipFanCos`) - falling with nothing ringed, a zip now finds something 93-96 % of the time
in the canyons (49-76 % without the fan). Arrival: a rim = the ledge pop onto the roof at 12 m/s; a facade = wall run /
run-up / push off; a cable = a fling past it, or with LMB held you swing on it; a roof top = you land. Two zips per
airtime, 0.35 s apart. A
zip down from a roof drags you across it and off the edge. **Space at the end of a zip = zip pop** (14 m/s up,
over a rim and on).

**C: tap = slide, hold = charge, in the air = dive.** The charge fills in 0.7 s (the ring at your feet); a running
slide carries on at your speed while you charge, otherwise you crouch-walk at 4 m/s. Let go (or press Space) to
launch: from a roof up to 22 m/s (a full leap from a run: ~30 m to the same height, ~9.7 m up), from a wall a big
wall jump, from a ledge hang straight up (the climb waits while you charge), on the rope a slingshot. A fresh C
press in the air with 6+ m under you dives (12 m/s down, heavier gravity while held); landing with C held slides
into a charge.

**Tech.** Perfect release (let go 35-50 degrees past the bottom: +3 m/s, the web flashes white, a ding; round 15:
32-58 degrees, +4.5 m/s and a 2.5 m/s pop up, and a flip); rebound
kick (Space right as you would bonk: kicked back off the wall instead); kick chains (+0.8 m/s per chained wall
kick, 3 times); air carve (the flight bends toward the stick, speed kept); the **web-yank** (the red dashed ring
on him: E = a homing zip at 32 m/s for 0.7 s; reaching him is a catch, "YANKED"; a miss = 2.5 s cooldown; within
12 m on Normal / 9 m on Degen, none on Chill - the owner's ranges, never cut per district); **flow** (a perfect release, a pop, a rebound, the 3rd chained kick or a full
leap = a pip, up to 3; each raises the speed cap 2 m/s; one drains every 2.5 s; all go on a bonk, a stumble, a fall
or stopping). HUD: three small pips under the middle of the screen.

**The thief** (pack v3): zips straight onto the rims (the same pull and ledge pop), and a new **leap** hop (a
charged jump across a street or alley <= 24 m, -20..+6 m) where no swing bakes, before a zip, and on a seeded 40 %
of the level and downhill crossings (`GRAPH.leapShare`). **He swings on the cables**: every cable hangs at least 3 m
under the lower roof of its street, so it is never 5 m above his rooftop takeoff and a pendulum on it cannot lift him
back onto a roof; instead he drops off the edge, webs his street's cable once he is 3.5 m under it, swoops under it
for 0.2-0.4 s and zips up onto the far rim (`GRAPH.cable*`; a seeded 60 % of the crossings with a cable try it
first, the rest after their building swings). Street crossings over the kept edges (swings, of them on a cable /
leaps / zips): Downtown 73 % (22 %) / 21 / 6, Market 88 % (30 %) / 10 / 2, Docks 82 % (18 %) / 18 / 0, Towers 65 %
(15 %) / 18 / 16, Vertigo 67 % (3 %) / 18 / 16. His view plays the zip pose and web, the charge ring (orange), the
leap, and his web on the cable.

**Campaign.** Time stars re-set against the full-kit bot (150 seeds per level, the round 6 rule: ~60-85 %, ~30 %
on L12): L1 under 18 s (84 %), L2 under 60 (74 %), L3 under 60 (64 %), L5 under 88 (60 %: the bot catches him in 61 %
of its no-Yoink rounds), L6 under 55 (71 %), L7 under 60 (81 %), L9 under 50 (71 %), L10 under 70 (59 %), L12 under 35
(29 %). "Finish with the web" counts a yank as well as a YOINK. L10 Altitude trades its chain star for 3 tech moves
(perfect releases, zip pops, rebounds, 3rd chained kicks, full leaps; the balance bot almost never gets it: it is a
skill star). Numbers: `.local/r12fix/camp1.txt` and `camp-L*.txt` in the build worktree.

**Versions.** Links v=6 (bests / ghosts from before are the older build's), ghost format 4 (+ the pitch column and
C held; formats 1-3 replay with the charge and dive off), pack v3 (v1 / v2 packs are rejected).

## TAG (round 13)

Web-slinger tag between Radbros: one of you holds the bag, everyone else runs. **TAG** on the title opens it
(`?tag`, same district as the title; its own lazy chunk, so the single-player page load is unchanged). The game is named after
it; inside SPIDERTAG the mode is TAG (`TAG_NAME` in `src/app/TagPage.tsx`, plus the title entry in `src/ui/title.tsx`).

**Rules** (`src/game/tagMatch.ts`, the tag table `TAG`; tuning.json may carry a `"tag"` section with the same keys):
- Whoever holds the bag chases. Pass it by **touching** someone (1.5 m across, 1.8 m up / down), by **Yoink** (your
  ring on them turns red within 3.5 m: click; +1 m on touch screens) or by the **yank** (E / Shift with them in the
  red dashed ring, up to 9 m: a homing zip onto them).
- The new bagholder is **web-tangled** for 1.5 s (no moving, the camera still turns) and can't tag the one who just
  passed it for 3 s.
- **Bag heat**: hold the bag 5 s without passing it and it heats up. Over the next 20 s the holder's Yoink reach grows
  by up to 4 m, the yank's by up to 14 m (9 -> 23 m) and their top speed and yank speed by up to 8 m/s; a pass resets
  it. So nobody keeps the bag for the whole match just because they started with it. The HUD shows it ("bag heat ·
  your yank reaches 17 m"). The `TAG.heat*` keys in `src/game/tagMatch.ts` (or tuning.json `"tag"`) tune it.
- Falls respawn you on your last safe roof, 1 s before you can move again; the fall itself is the cost.
- Score = seconds holding the bag (your bag clock). **Lowest wins** at the horn; ties go to fewer falls, then more
  tags. Offline matches are 3:00.
- Spawns: distinct junction roofs, the first bagholder (seeded) at least 60 m from everyone.
- Every move of the chase works for everyone: swing, zip, wall run / kick, ledge grab, vault, slide, charge leap,
  dive, perfect releases, rebounds.

**Offline** (the menu): pick your Radbro, 1-3 bots and a bot level, PLAY vs BOTS. The bots are the round-12 swinging
bot driven by role (`src/game/tagBot.ts`): holding the bag they chase the nearest runner (leading a far one along
its velocity) with the full kit and yank / Yoink when they can; running they swing to a junction roof away from the
holder and not past him, re-picked every 1.5 s. **chill** bots only start running once you are within 45 m and
swing without the new tech; **normal** bots use the whole kit and run within 75 m; **sharp** bots never stop and
time their releases. Holding the bag, a bot that starts climbing a tower far above its target kicks off it and goes
round, and once the bag is hot it also yanks runners that are running away while the yank still reaches. Bot vs bot
on Downtown over 3:00 (12 x 1v1 normal, 8 x 4 players normal, 8 x 1v1 sharp) the bag passes about 5-6 times a match
and the longest hold is 50-60 s (median); before bag heat it was 2-3 passes and holds of 90-120 s.

**HUD**: the match clock; the board of bag clocks (lowest first, the running one red, 💰 = holder, 🕸 = tangled); a
line saying who holds it; name tags with bag clocks over the others; an arrow at the screen edge to the holder (or,
when you hold it, to your target); a red cone over the holder and the bag in their left hand; a web cocoon while
tangled; the red ring when your Yoink is up; TAG! / YANKED! / YOINKED! flashes; the bag heat line under the clock.
**Q** / right mouse turns the camera to the holder (or your target). Esc pauses offline. Results: the table, REMATCH
(R) or MENU.

**Sound** (offline and online alike): the calm loop in the menus and the lobby, the district's loop in your music
style (Chill by default, see Sound below) from the countdown through the results and on into a rematch, a little
brighter while the chase is within 20 m of you, dimmed while paused; your own Radbro's moves, the 3-2-1 / GO beeps
and the tag sounds (TAG! = the lasso crack and the coins, tagged = a bonk). Any click, tap or key on the page unlocks
the audio, so the lobby's buttons do too (online matches used to be silent: only the offline PLAY unlocked it).

### Online (1v1 private rooms)

ONLINE in the TAG menu loads the online chunk (`src/net/online.tsx`; nothing online is fetched before you
press it): **CREATE ROOM** gives a 5-letter code and an invite link (`?tag&room=CODE`), a friend types the code into
**JOIN** (or opens the link), you both pick a Radbro and press **READY**. The room plays the host's district (a
joiner on another district gets a "go there" button). REMATCH after the results = READY again; the results screen
says when you are waiting for the other player, when they want a rematch, and when they left the room (REMATCH then
becomes BACK TO THE ROOM, where the code and link still work for someone else).

**When the other player's game stops sending** (a bad connection, a hidden tab, a long hitch) your match waits for
their inputs: after 0.4 s the screen says "waiting for the other player · N s", after 5 s a LEAVE MATCH button shows
(press Esc first for the mouse), and after 30 s of waiting the match is abandoned (the relay tells them). When their
inputs come back both games catch up (up to 30 steps a frame) and play on. The same holds at the horn: the results
show once both players' last inputs are in.

How it works (multiplayer design §3-§5): both clients run the same deterministic match; only inputs travel, 6 bytes per step
(`src/net/wire.ts`), sent 30 times a second (never more than 40 messages a second: a catch-up after a hitch goes out
as a few messages of up to 128 steps, and the relay allows 90 a second with bursts of 180). Your Radbro answers at once; the other one is predicted (their last
input, presses cleared) and corrected by rollback when their real input arrives (`src/net/rollback.ts`), so a tag
happens on the same step for both of you. The relay starts the match on a shared clock with a seed, stamps who sent
what, compares state hashes every 0.5 s and the final hash at the horn ("both players' results match" on the results
screen). Input delay is picked from your round trips: 2 steps (17 ms) up to 100 ms, 3 up to 130, 4 up to 180, then 5-6.
Before joining, each browser runs a 600-step self-test fixture (`src/net/selftest.ts`) and refuses online play if it
computes a different hash. Players on different builds (or tuning) are told to reload. The web-slinger swing changed
the sim: `NET_VERSION` 2 and a new self-test hash, so a tab from before it (or a relay not yet redeployed) gets
"this game is a different version: reload to update"; redeploy the relay with the client.

Not in phase 1 (multiplayer design §7 phase 2-3): rooms bigger than 2, relay fills for a late / dropped player (so a lagging
player stalls the match for as long as they lag: past 24 steps of prediction both games wait), rejoin, checkpoints,
quick match, spectators. Cross-browser determinism
(design gate 3): Chromium and Firefox give the same `?bench` hashes (the self-test and 1200-step Downtown bot matches
with 2 and 8 Radbros); Safari on a real iPhone is still to check (open `?bench` on a test build there).

### Running the relay locally

Two ways, same room logic (`relay/src/room.ts`):

```sh
npm run relay                              # Node stand-in on http://127.0.0.1:8787 (no Cloudflare tooling at all)
node relay/dev.ts --port 8787 --lag 150    # ...with 150 ms of injected round trip between the players
npm run relay:worker                       # the real Worker + Durable Object in the local emulator (no sign-in)
```

The stand-in needs only the `ws` devDependency. `relay:worker` runs wrangler 4.141.0 through npx (pinned in
package.json; the first run downloads it); use the same version for the deploy steps below.

Then `npm run dev` and open `http://localhost:4870/?tag` -> ONLINE (dev builds use this host's port 8787 unless
`?relay=http://127.0.0.1:<port>` says otherwise). Two browser windows (or two browser profiles) = two players.
Dev / test build knobs: `&lag=150` (CREATE asks the local relay for that round trip), `&secs=60` (the host's match
length, also offline), `&bot` / `&bot=chill|normal|sharp` (your slot plays itself), `&autocreate`, `&autoready`.

### Deploying the relay (your Cloudflare account, when you are ready)

Nothing below has been done; no account, token or deployment exists. The relay needs no secrets, keeps no data and
fits the free plan (multiplayer design §5: about 170 1v1 matches a day, then refused until the daily reset, never billed).

1. Create a Cloudflare account under the pseudonymous identity (free plan, no card).
2. On your machine: `cd relay && npx wrangler@4.141.0 login` (a browser sign-in; the token stays in your home directory,
   never in the repo).
3. In `relay/wrangler.toml`, set `ALLOWED_ORIGINS` to the game's origin(s) (default `https://spidertag.vyvanse.beer` and,
   during the move, the old `https://radrun.vyvanse.beer`)
   and leave `DEV = "0"` in the top-level `[vars]`.
4. `npx wrangler@4.141.0 deploy`. The first time it asks for a `workers.dev` subdomain: pick a neutral one (it is public).
   It prints the relay URL, `https://radrun-relay.<subdomain>.workers.dev`.
5. Check it: `curl https://radrun-relay.<subdomain>.workers.dev/health` prints `ok`.
6. Tell the game where it is, at build time: add `VITE_RELAY_URL=https://radrun-relay.<subdomain>.workers.dev` to
   the Vercel project's Production environment (`vercel env add VITE_RELAY_URL production`, then
   `vercel pull --yes --environment=production` in the deploy clone before `vercel build --prod`). A build without it
   shows "Online play isn't switched on for this build yet" under ONLINE; offline TAG always works.
7. Redeploy the site as usual, open https://spidertag.vyvanse.beer/?tag -> ONLINE -> CREATE on one device and JOIN on
   another.

Later: `npx wrangler@4.141.0 tail` streams the relay's logs (counters only; it never logs IPs, names or inputs);
`npx wrangler@4.141.0 delete` takes it down. If a match ever reports "results differ", the console of both players has the
per-Radbro hashes of the first step that differed.

## WAGER (BETA)

SPIDERTAG wagers: 1v1 TAG for tokens on Robinhood Chain. Two players put up the same stake, play a 1v1 best of 3, and the winner takes the pot minus a
3% house fee (1.5% for a winner holding a Radbro; 0 to 5%, set by the vault's owner). The page is the unlisted link
`?wager` (nothing on the site links to it) and always shows its network label, **BETA · TESTNET** on the Robinhood
Chain testnet with test tokens. The full design, the trust model and every number are in
[`docs/WAGER.md`](docs/WAGER.md); the contracts' own notes are in [`contracts/README.md`](contracts/README.md).

**How a player uses it**

1. Connect a browser wallet (it adds or switches to the network). On the testnet, GET TEST TOKENS sends test tokens and
   a little test ETH.
2. DEPOSIT: the wallet approves the vault for exactly the amount, then deposits it. The balance sits in the vault
   contract under your address; WITHDRAW sends free balance straight back to your wallet at any time. No server, owner
   or referee is involved, and pausing never blocks it.
3. PLAY WITHOUT POPUPS: one wallet signature authorises a key in this browser for matches up to the stake you pick
   (3 times that in total, for 12 hours). It can only enter matches; it can never withdraw. REVOKE turns it off.
4. NEW MATCH: stake, round length, city, and who can join (the open lobby, an invite link, or one address; holders
   only; a minimum number of series). The other player joins from the lobby or the link. Your page confirms the
   joiner by itself (no popup), both stakes lock, and the series starts.
5. Best of 3 on the normal TAG scene. The referee replays both players' inputs with the game's own sim and that
   replay decides every round; the page shows the round result between rounds. Leaving mid-series forfeits it after
   20 s; not turning up before round 1 voids it (nobody pays).
6. The winner's vault balance is credited when the referee's result is settled on chain. VERIFY THIS MATCH opens the
   public match page (`?wager&verify=<match id>`): it replays the whole series in your browser and checks the result
   and its log hash against the chain. HISTORY lists your matches from the vault's events.

If something goes wrong: after the settle window (24 h) anyone can REFUND BOTH STAKES of a match nobody settled, and
each player can TAKE BACK YOUR STAKE alone. If the referee is gone, SETTLE IT BETWEEN YOU lets both wallets sign the
same result. A series the anti-cheat flags waits for the owner's review (`?wager&review=<match id>`, signed by the
vault owner's wallet: SETTLE AS REPLAYED or VOID).

**Running it locally** (a local chain, no testnet, no keys of your own: anvil's public dev accounts)

```sh
anvil --port 8547 --chain-id 31337                                       # a local chain (Foundry 1.8)
npm run wager:deploy -- --net local --rpc http://127.0.0.1:8547          # test token + vault; writes the local deployment
RPC_URLS=http://127.0.0.1:8547 node relay/wager/dev.ts --port 8820 --net local --anvil   # the wager relay stand-in
npm run dev
```

Open `http://localhost:4870/?wager&net=local&rpc=http://127.0.0.1:8547&relay=http://127.0.0.1:8820&devwallet=1` and,
in a second window, the same with `&devwallet=2` (two dev wallets on anvil accounts #1 and #2). Dev and test builds
also take `&bot=normal` (your Radbro plays itself) and `&badhash` (report a wrong end hash, for the dispute path). The
local deploy rewrites the `local` entry of `src/wager/deployments.json`: put it back before committing.

**Checks**

```sh
npm test                          # includes test/wager-*.test.ts: the relay, the client and the shared rules
npm run wager:contracts           # forge build + forge test (unit, fuzz, invariants, token quirks, gas)
npm run wager:e2e -- --shots /tmp/wager-shots   # the whole thing in two headless Chromiums (about 13 minutes)
npm run wager:verify -- <match id> --net rh-testnet --chain   # re-verify a settled series from its public log
```

The end-to-end deploys to a fresh anvil (port 8547), runs the relay stand-in (8820) and a `build:test` of the site
(5430), and plays: an open offer from the lobby, an invite between Radbro holders (the 1.5% rate), a 0% fee,
cancelled offers, a no-show, a forfeit, a forced result dispute voided on review, a flagged bot held and settled on
review, a settle both wallets sign with the relay gone, a reclaim and refund after the settle window, and both players
withdrawing (`--only` picks scenarios; `docs/WAGER.md` §9.4).

**Deploying the testnet beta** (docs/WAGER.md §11; nothing below has been run)

1. `npm run wager:deploy -- --net rh-testnet --init-keys` makes the deployer, referee, relayer and faucet keys into a
   0600 file outside the repo (never printed). Claim testnet ETH into the deployer once, by hand, from a Robinhood
   Chain testnet faucet (they have bot checks; the chain's docs list none of their own).
2. `npm run wager:deploy -- --net rh-testnet --fork-only` rehearses on a fork; without `--fork-only` it deploys the
   test token and the vault, verifies both on the explorer and writes `deployments.json`. Commit that.
3. The wager relay is its own Worker (`relay/wager/wrangler.toml`, `radrun-wager-relay`; the live `radrun-relay` is
   never touched): put `REFEREE_KEY`, `RELAYER_KEY` and `FAUCET_KEY` with `npx wrangler@4.141.0 secret put`, then
   deploy it. Never redeploy it while series are live (`GET /health` answers with an `x-wager-live` count). The same
   answer's `x-wager-relayer-wei` and `x-wager-faucet-wei` are the gas the relayer and the faucet have left: top them
   up from the deployer before they run dry (every gasless match costs the relayer a lock and a settle).
4. Build the site with `VITE_WAGER_NETS=rh-testnet` (a build without it shows the page as off) and deploy as usual.

**Mainnet** comes later, only on the owner's explicit go-ahead, with the owner's own coin (this repo never writes,
mints or launches it): `npm run wager:deploy -- --net rh-mainnet --token <coin> --house <address> --owner <address>
--max-stake <n> --max-balance <n>` is a dry run on a mainnet fork (the token probe and a whole match); the same with
`--send-it` deploys. Then the `radrun-wager-relay-main` Worker and a site build with
`VITE_WAGER_NETS=rh-mainnet,rh-testnet`.

## Sound

Recorded music, stings, voice lines and sound effects (113 mp3s under `public/audio/`), with the older
synthesised WebAudio sound as the fallback whenever a file is not loaded yet or fails, so a round is never
silent. Sound starts when you press PLAY or PRACTICE (browsers only allow audio after a click or a key
press; on the TAG page any click or key). Nothing is fetched on page open: a round loads about 3 MB
alongside its Radbros, without delaying the LOADING screen (the countdown sounds go first); the round's music loop
and the end stings start loading once the Radbros are in (they are not needed before GO, and the models get the
line to themselves), and the loop streams while it plays.

- **Music:** a calm loop on the title and results; the countdown build (its cut lands exactly on GO); then
  the round's loop from GO, in the **music style** picked in pause -> Settings (remembered with the other
  settings; TAG follows it too):
  - **Chill** (the default): laid-back instrumental loops of about two minutes, one per district mood:
    `chill_rooftops` (dusk rooftops lo-fi, ~84 bpm: Downtown), `chill_market` (night-market chillhop with a warm
    bass, ~92 bpm: Night Market), `chill_harbour` (harbour jazz-hop with sax and upright bass, ~80 bpm: Docks) and
    `chill_towers` (airy high-towers downtempo, ~88 bpm: Towers and Vertigo); a district without its own takes the
    next one each round. When he is within 20 m (or panicking) the same loop gets a little brighter and louder
    (a +2 dB shelf, +8 %), never a different track.
  - **Chase**: the district's **chase loop**: Downtown, Night Market, Docks, Towers and **Vertigo** each have
    their own (an unknown district plays Downtown's); near him it gets clearly brighter and louder.
  Switching mid-round crossfades once the other loop can play. A catch plays the win sting (a YOINK sting for
  a YOINK), "He rugged you." its own sting; the calm loop comes back under their tail. Pause dims it; a hidden
  tab or mute pauses it. The loops play at their own tempo on every difficulty, all at the same loudness
  (-18.4 LUFS, 128 kbps); each chill loop is cut at a matching bar with a short crossfade, so it repeats
  without a seam. While a loop is still loading the synthesised score fills in (on Chill its calm groove).
- **Voices:** one line at a time (a line waits its turn or is skipped; the music dips about 4 dB under
  speech). The announcer is a Milady: she calls 3-2-1-GO, "rekt" on a fall, gassed, YOINK / tagged, rugged
  ("it's so over") and a new best ("we're so back"); she is the loud one. The Radbros are flat and mostly
  don't talk: a laugh, a scoff, a hum, a breath, and now and then a dry word. The runner says "finders
  keepers" right after GO (after a menu, then one retry in three), and in the chase at most 2 taunts a
  round (a 50% roll at a junction, 25 s apart, at most one worded; he still waves every time; quieter the
  further ahead he is), a panic breath (the first, then 20 s later, 2 a round), cornered once, gassed, and
  caught / escaped (`src/audio/chatter.ts`). A bubble shows only with a sound, lined up with it ("finders
  keepers" too, after GO); a line the speech timeline skips (busy, cooldown) shows no bubble and uses up
  none of the round's budget. The round end is one call and one reply: the chase
  lines stop, she calls it (a new best instead of YOINK / tagged), then the runner answers; nothing else
  talks until the next round, and quitting to a menu cuts it. A line that is not loaded falls back to the
  old chatter blips. `?vodebug` logs every line started / cut / dropped (with its caller) to
  `window.__voiceLog`.
- **Sound effects:** rope thwip and release whoosh, jump, **double jump** (the jump, a fifth higher),
  **web zip** (a thwip into a whoosh), light / heavy landings by impact, bonk, the YOINK lasso crack, the
  coin grab, countdown beeps, the "rekt." whistle, a web snap, wall runs, wall kicks, vaults, slides and
  rolls, a soft "no" when you web with nothing ringed, wind gusts, the rug swoosh, George's
  meows and a wind loop that grows with speed in the air. Variations are picked at random with a slight
  pitch spread.
- **Controls:** the speaker button (title top right; in a round top left, or under II on touch) and **M**
  mute everything. Pause -> Settings has **music**, **sound effects** and **voices** sliders and a mute
  box, all remembered in the browser. Leaving the tab (or muting) suspends the audio completely.
- **Code:** `src/audio/catalog.ts` lists every file (a test checks each exists and nothing unlisted ships)
  and maps district ids to chill and chase loops (`roundTrack(style, district)`); `samples.ts` loads (4 at a
  time); `tracks.ts` streams and crossfades the music and holds the style; `voice.ts` queues the lines; `sfx.ts`
  plays samples with the synth fallback; the fallback music is `score.ts` / `music.ts`. Low quality loads one
  variation per sound and plays at most 6 sampled SFX at once. Dev / test builds report the track, voice lines
  and files loaded / failed in `window.__play.audio`; TAG reports its track and the audio state in
  `window.__tag`. `?sfxdebug` logs every sound asked for to `window.__sfxLog`: each SFX with whether it actually
  played (false = no audio yet, muted, hidden tab or volume 0) and each music loop, sting and fallback score as
  it starts.

## Practice and tips

**PRACTICE** (title, next to PLAY) drops your Radbro and George on a roof in the real city with no runner,
no timer and no fall penalty: free swinging to learn the rope. The panel shows speed, the current swing
chain, best chain, top speed and falls. Hold R (desktop) = back to the start roof; Esc / II = pause ->
Resume / Back to start / Settings / Back to title.

**First-run tips** pop up under your Radbro (above it on touch) the moment they matter, once each:
"hold LMB/WEB to web the building ahead (the yellow ring): it pulls you off the roof into a swing" (a
building is ringed; round 11 wording), "let go just past the bottom, on the way up, to fling forward and keep
your height" (you are on the rope), "chain swings down the avenues to go fast" (after your first let-go),
"wall run! press Space / tap JUMP to kick off the wall" (your first wall run), "red ring on him = click /
tap WEB to YOINK" (the first red ring in a real round), then "press Space / tap JUMP again in the air to
double jump" (airborne), "press E or Shift / tap ZIP to web-zip" (on a roof with a ring) and "press C / tap
SLIDE while running fast to slide" (running fast). They are remembered in the browser; pause -> Settings -> **show tips
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
ghosts that no longer verify get the same note. `v=4` is round 9: every district was rebuilt (40-230 m
canyons), webs stick to buildings and the parkour moves arrived, and ghosts record the slide button (ghost
record format 3). Links older than v4 open with the "made on an older build" note and their ghosts are not
raced. Bests and kept ghosts from before v4 belong to the old city: the old ghost is dropped, and your first
catch in the new city is a new best (the results line mentions the old city's time).

`v=7` is the web-slinger swing (ghost record format 5: the same columns as format 4, the swing's physics changed).
A v6 link's ghost (format 4) replays with the round 12 swing it was made with (so it still verifies) and the banner
says it is **from an older version** ("replayed with its own swing"); one that does not verify says "made on an
older build". Bests and kept ghosts from before v7 are the older build's (the old best shows as the older build's on
your first catch).

`v=8` adds held webs and the wingsuit glide. Ghost format 6 records the glide button; format 5 keeps the earlier
automatic web release and no glide. The runner packs are v4 and online input words are 6 bytes (network v3).

Plain `?c=652&r=4764&d=normal&t=41.2` links (no `g`) still work: they preselect the title and show "beat
41.2 s" (claimed, not checked).

How it stays exact: the sim only reads the horizontal aim direction, (round 12) the camera pitch as a sine, the
move vector and the buttons, so a live round steps with the input **rebuilt from its quantised record** (yaw in
1024 steps per turn, move in 1/64 steps, pitch in 1/100 steps; `src/game/ghost.ts`, record format 6). The replay feeds the same records to a second Round with the same
seed and gets the same result bit for bit. sin/cos come from a table built with + - * / only, so a link
made in Chrome replays the same in Safari or Firefox. The link string is varint RLE of per-step changes,
deflate-raw (CompressionStream), base64url.

## Radbros

Pick your Radbro or Retardio on the title (your Radbro's row: the character select); you chase one of the others (the link's `r=` if it names one, else at
random). All of them are playable from the start (none is a campaign unlock), and the pick is cosmetic: the
round is the same with any pair, so ghost links replay the same whoever you pick.

| | persona | taunts (a few) | caught / escaped |
|---|---|---|---|
| **#652** | earnest (sincere, a bit sheepish) | "hehe", "ha!", "hi", "i'll take good care of it", "you're so close" | "okay. you got me." / "sorry! good bag though" |
| **#4764** | deadpan (the katana) | "heh", "pff", "ha.", "i'm not even running", "take your time" | "bro." / "mine now." |
| **#2564** | quiet (whispers, hums) | "hehe", "shh", "♪", "over here", "wrong roof" | "oh. hello." / "thank you" |
| **#723** | easygoing (brown hat, the wink, "HOT TOPIC BRO" plate carrier) | "heh heh", "oh, man", "nah", "nice day for it", "you good back there?" | "fair enough" / "see ya" |
| **Retardio #555** | cheeky (long brown hair, "BRITISH FOOD" tee) | "hehe", "oi", "cheers for the bag", "too slow, mate" | "fair cop" / "cheers, mate" |
| **Retardio #85** | saving up (long black hair, "NEED MONEY FOR PORSCHE" tee) | "heh", "tch", "porsche fund, sorry", "i need it more" | "there goes the porsche" / "porsche fund +1" |

**The Retardios** (since 2026-10-02) are dexedrne's Retardio Cousin #555 and Retardio Classic #85, both boys with
long hair, built on the Radbro rig with #723's clips. Their ids are `retardio555` / `retardio85` (never a bare
number, which would be a Radbro token): links say `c=retardio555`, files are `public/models/retardio555.glb`,
`retardio555.clips.glb`, `public/ui/retardio555.webp`; the UI calls them "Retardio #555" / "#555"
(`charName` / `charTag` in `src/game/radbros.ts`). Their GLBs and meta come from
`npm run assets -- --radbros <folder> --retardios <their folder> --only retardio555,retardio85` (clip times from #723's
manifest entry, rope / ledge hand heights measured on their own clips). In the game their locomotion loops play a
little slower to match their stride (`STRIDE`) and the rope arm swings out of their hair while they hang
(`HAIR_ARM`, both in `src/app/ActorsView.tsx`). No recorded voice yet (chatter + bubbles, like #3171).

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
   `npm run og-image -- --bg <saved frame>` (the alternative card `og-frame.jpg`, one bust per Radbro); the
   card that ships, `og.jpg`, is key art: its busts are composited by the art script (untracked).
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

**Parkour clips (round 9).** Nine one-shot clips in every Radbro's clip pack: `Wall_Run` / `Wall_Run_Mirror`
(the wall on his left / right; played once, then the run rolled toward the wall), `Wall_Run_Up` (the run-up),
`Ledge_Grab` (held on its hang frame), `Ledge_Climb` (the mantle; the model's root stays at the rim while the
clip lifts him), `Vault`, `Slide` (held in the slide), `Land_Roll` and `Wall_Climb` (not used yet). Timings
come from the clip manifest into `clips.meta.json` (`hangAt`, `slideTo`, `rollFrom`, `standAt`, ...); the
rules are `RULE` in `src/anim/animMachine.ts` (a missing clip falls back to the procedural pose). The
runner plays the same clips from his pack phases (wall, ledge) and events (vault, roll).

## The chase and difficulties

Falling to the street = "rekt.": respawn on your last roof, -3 s. He panics (sprints) when you get close
and gets GASSED when his panic budget runs out. He stops to taunt you when you are over 35 m back.

| | runner | Yoink range | web-yank | medals (RAD / GOLD / SILVER, s) |
|---|---|---|---|---|
| **Chill** | jogs (0.9x), sprints to 1.25x, gassed after ~14 s of sprinting, wanders, 8 s head start | 6.5 m | none | 35 / 55 / 75 |
| **Normal** | 1.8x, speeds up inside 70 m to 2.2x, 30 s panic budget, 8 s head start | 3 m | 12 m | 25 / 40 / 60 |
| **Degen** | 1.7x, speeds up inside 70 m to 2.6x, 45 s panic budget, barely wanders, short taunts, 20 s head start | 3 m | 9 m | 30 / 45 / 65 |

(District tweaks move the runner: `chase` in `src/world/districts.ts`; they never change the yank range, and the Yoink
stays at least twice the 1.5 m tag radius everywhere.) Round 12: the straight zip, the zip fan and the owner's yank
ranges (12 m Normal, 9 m Degen) make the swinging bot very strong - against the round 11 table it caught him in
~11 s on Normal - so he is much faster (1.7-2.6x his baked pace, sprinting to 2.4-3.1x) and starts further ahead;
the Yoink is 3 m (it was 5 / 4.5 m in round 11; at 4-5 m the bot Yoinked him in ~11-16 s whatever else changed).
Catches are now mostly yanks from across the gap (Normal: 51-95 yanks per 200 rounds, 36-65 Yoinks).

**Round 15 (the web-slinger swing)**, 200 rounds per row (`npm run balance -- --all`), the same bots on the new
physics: they corner-swing at the crossings (per round, Normal / Degen: Downtown 1.0 / 1.9, Market 4.6 / 9.0, Docks
1.1 / 2.9, Towers 1.0 / 1.5, Vertigo 2.5 / 3.5), the tech bot dives at him (1.0-1.6 dives a round outside Market) and
lets go in the wider perfect window (6-11 perfect releases a round). Against the round 12 table the Degen swing bot
caught him early (Downtown 37 s, Market 29 s, Docks 39 s), so the Degen runner got faster in those districts (Downtown
2.3x, Market 3.0x, Docks 2.45x from 75 m) and the Towers' Degen runner 20 s less panic (it had dropped to 50 %):

| | Chill swing (info) | Normal swing (target median 25-40 s) | Degen swing (target 50-95 %, median 40-70 s) | Degen tech bot (target >= 80 %, 30-50 s) | falls / round (Normal / Degen) |
|---|---|---|---|---|---|
| Downtown | 100 %, 9.3 s | 86 %, 31.1 s | 60 %, 42.0 s | 63 %, 37.4 s (MISS) | 0.04 / 0.01 |
| Night Market | 100 %, 7.3 s | 99 %, 33.9 s | 71 %, 41.2 s | 74 %, 32.4 s (MISS; round 12: 82 %) | 0.13 / 0.19 |
| The Docks | 100 %, 9.2 s | 98 %, 28.9 s | 53 %, 41.3 s | 61 %, 37.2 s (MISS) | 0.03 / 0.04 |
| The Towers | 100 %, 9.1 s | 70 %, 39.8 s | 69 %, 58.7 s | 71 %, 49.4 s (MISS) | 0.02 / 0.01 |
| Vertigo | 100 %, 8.2 s | 87 %, 33.5 s | **49 %**, 20.1 s (MISS) | 48 %, 21.8 s (MISS) | 0.07 / 0.01 |

The camper is unchanged (0-18 %). Misses: the tech row everywhere (it reached 80 % only in Market before, and the
faster Market Degen runner took that away: 74 %), and Vertigo Degen, which missed before too (45 %, 48.5 s) and is
chaotic here: small runner changes move it between 25 % / 36 s, 41 % / 64 s, 49 % / 20 s and 76 % / 30 s (base +-0.02,
gStar +-10, panic, head start and Yoink all tried), so it is left on the round 12 settings for a human play-test to
decide. Corner swings were worth the most to the bot in Market (Normal median 43 s without them, 34 s with them) - and
cost it falls until a corner swing held you up (0.42 falls a round, now 0.13).

Round 12 balance, 200 rounds per row (`npm run balance -- --all`), the swing bot with the full kit (zips, leaps,
the yank; it swings to the auto-release), and the tech bot (the same plus perfect releases when he is above it, the
rebound kick, the dive at him when he is well below, and yanks at him running away while they still reach):

| | Chill swing (info) | Normal swing (target median 25-40 s) | Degen swing (target 50-95 %, median 40-70 s) | Degen tech bot (target >= 80 %, 30-50 s) | falls / round (Normal / Degen; round 11) |
|---|---|---|---|---|---|
| Downtown | 99 %, 7.0 s | 86 %, 34.0 s | 73 %, 41.9 s | 73 %, 41.6 s (MISS) | 0.03 / 0.04 (0 / 0) |
| Night Market | 100 %, 7.7 s | 95 %, 33.1 s | 73 %, 40.0 s | 82 %, 34.3 s | 0.18 / 0.25 (0.16 / 0.18) |
| The Docks | 100 %, 8.4 s | 97 %, 30.0 s | 54 %, 46.5 s | 58 %, 41.6 s (MISS) | 0.10 / 0.20 (0.04 / 0.02) |
| The Towers | 100 %, 10.9 s | 80 %, 36.4 s | 62 %, 43.9 s | 57 %, 48.2 s (MISS) | 0 / 0 (0 / 0) |
| Vertigo | 100 %, 8.2 s | 89 %, 38.6 s | **45 %**, 48.5 s (MISS: under 50 %) | 58 %, 45.3 s (MISS) | 0.04 / 0.12 (0.01 / 0.01) |

The camper stays under 20 % everywhere (0-18 %); the bot's web presses with nothing ringed are 0-0.08 a minute; Market's
no-zip swinger falls 0.64 / 0.72 a round (0.91 / 0.92 in the first cut). Misses, honestly:
- **Vertigo Degen** (45 % caught) sits just under its band. The bot's catches there swing hard with small runner
  changes (base +0.23: 57 %, 24 s; +0.25: 45-49 %, 46-49 s; +0: 66 %, 35 s), so there was no setting with both numbers
  in band; Vertigo's Degen row has missed before (round 7).
- **The tech bot** catches as often as the swing bot or more in four districts (Downtown 73 = 73, Market 82 vs 73,
  Docks 58 vs 54, Vertigo 58 vs 45; Towers 57 vs 62, inside the seed noise) and faster in most, but reaches the
  spec's 80 % only in Market: with the runner fast enough for the swing rows' bands, timing moves are not a big enough
  edge for a bot. What each move is worth to it (Degen, a test table with a 4 m Yoink, 200 seeds, caught % without the
  move minus with it, per district): the perfect release 0 to -11 points (Vertigo 51 vs 62), the dive +1 to -21
  (Vertigo 41 vs 62), the rebound 0 to -6, the long-range yank about 0; the zip pop cost it 3-7 points in four districts (it pops over
  the rim instead of taking the 12 m/s ledge pop), so the tech bot does not pop.

Round 10 balance (for reference), 200 rounds per row, all in band then:

| | Chill swing (info) | Normal swing (target median 25-40 s) | Degen swing (target 50-95 %, median 40-70 s) | Normal swing, no zip (info) |
|---|---|---|---|---|
| Downtown | 94 %, 15.1 s | 71 %, 29.2 s | 56 %, 40.5 s | 76 %, 20.9 s |
| Night Market | 99 %, 11.1 s | 89 %, 35.5 s | 62 %, 49.9 s | 63 %, 51.4 s |
| The Docks | ~86 %, ~25 s | 53 %, 38.4 s | 50 %, 44.2 s | 62 %, 35.0 s |
| The Towers | ~85 %, ~20 s | 60 %, 39.3 s | 53 %, 44.9 s | 60 %, 30.9 s |
| Vertigo | 100 %, 17.9 s | 91 %, 30.0 s | 83 %, 43.5 s | 51 %, 22.0 s |

**The swing carries the chase now** (round 10): without the web zip the same bot catches him in 51-76 % of
Normal rounds (round 9: 14-48 %), and campaign level 1 (First Pour, Chill) in 92 % (round 9: 37 %).

The follower rows (a bot that replays his exact track at his speed) are info in every district since round
10: his swing-first routes are longer, and a follower glued to his track outlasts his panic budget
(Downtown Normal k 1.0 now catches him in ~45 % of rounds, late: median ~50 s). The camper stays under 25 %
everywhere.

## Districts

Pick the district in the title's character select (your Radbro's row; a district change reloads the page; Retry never does).

| District | URL | Feel |
|---|---|---|
| **Downtown** | `/` | a canyon city: 42-77 m podium roofs on 22 m avenues, 31 towers up to ~200 m, wall-run notches, AC units and crates to vault. Swing the avenues |
| **Night Market** | `?map=market` | the parkour district: dense, low (12-39 m) rooftops on 12 m streets, lots of props, climbs and wall-run notches, only six 58-80 m towers to web near the plazas (few places to swing) |
| **The Docks** | `?map=docks` | low sheds (12-23 m) on 18 m streets under crane masts and a few offices: long pendulums over the quay, containers to climb, crates to vault |
| **The Towers** | `?map=towers` | the deepest canyons: 66-124 m roofs on 24 m avenues between 45 towers up to ~230 m. Long ropes, big swings |
| **Vertigo** | `?map=vertigo` | round 7: every ring of roofs is a spiral ramp (22 to 89 m, neighbouring rings climbing opposite ways), so next to every gentle step there is a 10-50 m cliff; five 180-211 m needles (round 9, your anchors on the way down), two plazas. A **descending chase**: he starts on one of his three highest roofs and prefers routes that end lower, dropping off roofs onto much lower ones mid-run; you start at about his height. Open from the start |

Each district has its own level files: Downtown in `public/levels/`, the others in
`public/levels/<market|docks|towers|vertigo>/` (`city.json`, `decor.json`, `city.model.json`, `runner.pack.bin`,
`bake.report.json`). `tuning.json` is shared. Generator configs and looks: `src/world/districts.ts`.

- `npm run gen-city -- --map docks [--force] [--decor]` (re)generates a district (never overwrites an
  existing `city.json` without `--force`).
- `npm run level -- --map docks` / `npm run level -- --all` re-derives and re-bakes one / every district.
- `?editor&map=docks` / `?editor=decor&map=docks` edit a district; Save writes that district's files.
- Best times and kept ghosts are per district; share links carry the district (`&m=docks`).
- **Per-district chase tweak** (`chase` in `src/world/districts.ts`): the same runner and difficulty table
  everywhere, nudged per district so the swinging bot gets the same catch times as in Downtown. Round 10:
  every district was re-tuned for the cleaner swing (Downtown got its first tweak: Normal 1.2x, Degen 1.3x
  with a 4 m Yoink); the values and why are in the comments above each `chase`. Round 9:
  the Night Market and the Docks still start you ~26-30 m behind him; the Night Market runner is a bit
  faster on Normal (1.15x) and sprints earlier; the Docks Degen runner is faster (1.3x) but gasses out
  after 5 s of sprint, with a 3 m Yoink; the Towers runner is slower (0.9x on Normal and Degen, a 5 m Degen
  Yoink); Vertigo's Normal runner is faster (1.15x) than round 7's, since the bot now zips back up to him.
  Downtown had no tweak until round 10. `npm run balance -- --all --only swing` prints every district.
- **His route graph (rounds 9-10).** Hop kinds between neighbouring roofs (`src/route/graph.ts`): **alley**
  (a jump, up to +1.2 m), **climb** (+1.2 to +9 m, round 10: he jumps at the wall and the sim's run-up,
  ledge grab and climb finish it; above +3.5 m a climb that does not bake falls back to a zip onto the rim),
  **drop** (6 m or more down: walked off at a baked pace), **street** (up to +16 m, round 10: a web swing on
  a building anchor; the bake first tries the anchors with the pivot over the middle of the street, then the
  anchors baked from the takeoff point, then falls back to a zip across), **wallrun** (a wall-run notch
  between two roofs) and **zip** (a web zip onto the near rim of a roof up to 32 m higher across at most
  26 m). Vaults over props happen on their own. Jump hops try the takeoff lateral he arrives at, then the
  span's middle and both ends (round 10). Each junction-to-junction edge is 3-8 hops; `runnerJunctions` /
  `runnerMaxHops` in a district's config (its `city.json` root) override the 12 junctions / 8 hops. The
  bake keeps each junction's best edges with the fewest zips and then the most swings, then checks the graph
  (strongly connected, no forced U-turns, press windows, landing margins).
- **Vertigo's layout and route (round 7).** `generateVertigo` in `src/world/generate.ts` (config
  `vertigo` in its district entry: ring height ranges, climb per street / alley step, needles, plazas,
  summit mesas). In Vertigo the graph also picks junctions spread out in height, tries drop-first routes
  and keeps edges with a drop first. Its chase tweak: `startHigh`, `down` (prefers edges that end lower),
  `spawnBelow` (spawn on a roof about his height, at least 0.8 x the spawn distance from him and 16 m
  clear of his first edge's route).

## Mechanics and mutators (round 4)

All deterministic and **player-only** (the runner plays his baked track and never feels them). They are
round options, part of ghost links and (where they touch the sim) the round hash.

| Mutator | What happens | Tell |
|---|---|---|
| **Snapping webs** | every web snaps after 1.6 s on the rope (`MECH.snapTime`; no release boost): chain fast | a snap sound |
| **Wind** | every 9-16 s a 2.4 s gust (8 directions, up to 7 m/s²) pushes you while airborne or swinging | HUD arrow ~1 s before the gust (yellow GUST), fills while it blows (blue WIND); a whoosh |
| **Low gravity** | your gravity x0.65: floaty jumps, long swings | - |
| **No YOINK** | no lasso: touch him | - |
| **One life** | the first fall ends the round ("He rugged you.") | - |
| **60 seconds** | a 60 s clock | the timer |
| **Night** | visual: dark sky, close fog, dimmed lights | - |

Free play starts with each district's defaults: **the Docks have wind** (the Night Market's few anchors are
part of its layout). Every other mutator appears as a toggle
in the title's character select once you have caught him in a campaign level that uses it. Campaign levels set their own
mutators.
Values live in `MECH` (`src/sim/tuning.ts`), overridable in `tuning.json` under `"mechanics"` and with the
`?tune` sliders. Bots: `&mu=<bits>` (snap 1, wind 2, lowgrav 4, noyoink 8, onelife 16, sixty 32, night 64).

## Campaign (round 4)

**CAMPAIGN** on the title: 15 levels, 3 per district, each with a difficulty, mutators and three
objectives (a star each; the first is always "catch him"). The others mix: under N s, no falls, finish
with a YOINK, chain N swings, N parkour moves (wall runs, wall kicks, ledge climbs, vaults, slides; round 9),
and in Vertigo "catch him before he reaches street level" (before he has stood on a roof below N m). The round HUD lists the level's objectives
live (crossed out once lost, ticked once met), and the results show which you got plus NEW stars.

| # | Level | District | Difficulty | Mutators |
|---|---|---|---|---|
| 1-3 | First Pour, Rush Hour, Snap Quiz | Downtown | chill, normal, normal | -, -, snap |
| 4-6 | Neon Alleys, Hands Only, Lights Out | Night Market | chill, normal, normal | -, no YOINK, night |
| 7-9 | Sea Breeze, Moon Jump, Last Call | Docks | normal | wind; wind + low gravity; wind + 60 s |
| 10-12 | Altitude, High Winds, Rugpull | Towers | normal, normal, **degen** | snap; snap + wind; snap + wind + one life |
| 13-15 | Top Floor, Free Fall, Street Level | Vertigo | chill, normal, **degen** | -, -, snap |

Vertigo's stars: Top Floor = no falls + chain 5; Free Fall = before street level (45 m) + chain 5; Street
Level = before street level (32 m; round 11, was 40 m) + no falls. (Level 10 was called "Vertigo" before round 7.) Round 9:
Neon Alleys asks for 6 parkour moves (instead of a time) and Last Call for 4 (instead of the close call).

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
- **Key art**: `public/ui/key-art.webp` (1600x900 webp, ~210 KB, preloaded by `index.html`), full-bleed behind the
  title, its overlays and the boot screens: the six web-swinging over neon rooftops in the rain, the SPIDERTAG share
  card's art. The title's terminal font is VT323 (`public/fonts/VT323.woff2`, SIL OFL, `public/fonts/OFL-VT323.txt`).

## Dev pages (dev server and `npm run build:test` only; stripped from `npm run build`)

| URL | What |
|---|---|
| `?sandbox` | the old dev free-roam page with a debug HUD (`?sandbox&autoplay` = scripted chain-swinger); players use PRACTICE |
| `?tune` | live sliders for player, camera, the Chill/Normal runner table and George; Save writes `tuning.json` |
| `?editor` | react-three-game PrefabEditor on `public/levels/city.json` (gameplay layout); `&map=<id>` for another district |
| `?editor=decor` | the same editor on `public/levels/decor.json` (signs, rooftop props, the Milady stand) |
| `?routeview` | the runner's junction graph, with a live runner fleeing your mouse |
| `?bot=follow&k=1.3&seed=123&d=chill&c=652&r=4764` | a whole round played by the test bot (`bot=yoink` lassoes, `bot=chase` = the swinging balance bot on the real sim, `bot=swing` chain-swings for screenshots); `d=chill|normal|degen`. `bot=chase&rec` sends the bot's inputs through the ghost codec, so its catch gives a ghost link (`window.__play.ghost.url`). `&snap` freezes 0.12 s into each chaser jump / release; `&snap=freefall,sky,runnerff` (any subset) freezes once in the chaser's free fall, on a long swing from a tower anchor 30+ m up (`sky`) and in the runner's free fall (`window.__unfreeze()` resumes) |
| `?portrait=652` | one Radbro's Idle bust from its game GLB (`&yaw=`, `&bust=`, `&t=`; `&clip=Free_Fall&full` any clip, whole body); `npm run portraits` saves every Radbro to `public/ui/` for the title cards (`-- --only 723` for one) |
| `?bench` | the online step / rollback cost and the determinism self-test hash (open it on a phone and in Firefox / Safari: design gates 3-4) |
| `?tag&bot=normal&secs=60` | TAG with your slot played by a tag bot (`chill` / `normal` / `sharp`) and a shorter match; online knobs in "TAG" |
| `?hats` | George's three campaign hats on his head across his clips (one row per hat, 3/4 close-ups; `&yaw=` camera angle, `&lift=` / `&fwd=` try other offsets than `HAT_LIFT` / `HAT_FWD` in `src/app/hats.ts`) |

Challenge links (all builds): `?c=652&r=4764&d=normal&t=41.2` preselects the title and shows the time to beat
(`d=chill|normal|degen`); with `&s=<seed>&g=<ghost>` it is a ghost link (see "Ghost links").

## Editing the city and decor by hand

1. `npm run dev`, open `?editor` (city) or `?editor=decor`.
2. Move, resize, add or delete boxes. In `city.json`, the `Data {kind}` tag decides gameplay: `roof`
   (landable), `tower` (solid, not landable), `prop` (a solid rooftop box inside a roof: 0.8-1.4 m to
   vault, 2.2-3.2 m to climb, at least 2.5 m inside the edges). Web anchors come from the buildings at run
   time (old `hook` nodes are ignored with a warning). Keep boxes unrotated and standing on the ground.
   `npm run level` lints the round 9 rules: every street-facing roof edge has something 12 m taller within
   34 m to web (G1; a warning in the Night Market and Vertigo), roofs at least 12 x 12 m with alley steps
   that are a hop, a climb or a drop (G2), props (G3), wall-run notches (G4), heights 10-140 m for roofs
   and up to 230 m for towers (G6).
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
- **Solid rooftop props** (round 9: AC units, crates and vents to vault, tanks and container stacks to
  climb) are `prop` solids in `city.json` (low quality never hides them). The **decor** props (antennas, small
  vents, water towers on tower tops) are the `rooftop-props` group in `decor.json`, never solid.
  `npm run gen-props` re-places those (clear of the runner's baked path; run it after `npm run level` if the
  layout changed); hand edits to other decor nodes are kept.
- `npm run restyle-city` re-applies the look from `src/world/toPrefab.ts` (materials table, facade
  rule, roof caps) to `city.json` without touching gameplay geometry.
- **The city and decor never move in the game:** their transforms are composed once and then skipped every
  frame (`FreezeStatic` in `src/app/GameScene.tsx`; visibility still switches). Something that should move
  belongs in code next to the actors (like the Milady), not in `city.json` / `decor.json`.
- The sky gradient and fog colour are `SKY_COLORS` in `src/app/cityLook.tsx`.

## tuning.json

`public/levels/tuning.json` is read at startup and overrides the built-in constants: `player`, `camera`,
and `difficulty.chill` / `difficulty.normal` / `difficulty.degen` (the runner's rubber band). Edit it by
hand or with `?tune`.

Runner table keys: `base` (playback speed of his baked runs), `gStar` (the gap he tries to keep: closer =
he speeds up by 2.5 %/m), `mMin` / `mMax` (slowest / fastest rate), `panicBudget` (seconds of full sprint
before GASSED), `airMin` / `airMax` (rate clamp while airborne), `sigma` (branch noise: higher = dumber
choices), `yoinkRange` (m), `taunt` (seconds he stops to taunt when you are far back).

Round 9 movement keys (all in `?tune`; the full list with ranges is the spec's §8,
`docs/specs/2026-09-25-round9-movement.md`):

| group | keys (default) |
|---|---|
| speed | `speedCap` 32 (one cap for every state), `carryDecay` 8, `releaseBoost` 2, `releaseUp` 3, `autoReleaseBelow` 2.5, `ropeSteer` 4 (sideways only), `swingAlign` 2.5 (round 10: 1/s the swing turns toward the stick; 0 = a free pendulum), `hysteresis` 4, `bonkMinSpeed` 14, `bonkRatio` 0.85 |
| anchor search | `ropeMin` 8, `ropeMax` 42, `anchorMinAbove` 5, `anchorAhead` 10, `anchorAheadPerSpeed` 0.5, `anchorUp` 24 (round 9: 18), `anchorVelBias` 0.6, `anchorRimBonus` 2, `anchorAlternate` 3, `aimCosFall` -0.2 (round 10: the falling fallback cone, about 100 degrees; >= `aimCos` = off) |
| pendulum | `swingOut` 12 / `swingOutFree` 0.5 / `swingOutMin` 4 (round 10: the pivot sits `swingOutFree` of the open air in front of the face out, at most as far out as you, within 4-12 m; round 9: 5 m), `swingFloorClear` 6, `swingReel` 10, `swingGravity` 1.35, `swingPump` 5, `swingKeepSpeed` 1.6, `swingReleaseCos` 0.64 (about 50 degrees; round 15: 0.53 for you, the thief keeps 0.64), `swingRehook` 0.18, `losSteps` 12 |
| wall | `wallRun`, `wallRunReach` 0.6, `wallRunMinSpeed` 5, `wallRunRatio` 1, `wallRunMinBelowTop` 1.5, `wallRunFallMax` -12, `wallRunTime` 1.4, `wallRunSpeed` 11, `wallRunAccel` 10, `wallRunGravity` 0.2, `wallRunKick` 3, `wallRunCooldown` 0.25, `wallClimbSpeed` 9, `wallClimbTime` 0.6, `wallClimbKeep` 0.55 (round 10: the run-up starts at this fraction of the speed you hit the wall at), `wallJumpOut` 7, `wallJumpUp` 9.5, `wallJumpKeep` 0.9, `wallJumpGrace` 0.15 |
| ledge | `ledgeGrab`, `ledgeLow` 0.4, `ledgeHigh` 2.3, `ledgeMaxVy` 4, `ledgeHang` 0.2, `ledgeClimbTime` 0.35, `ledgeExitSpeed` 6, `ledgeJumpUp` 7 |
| vault / slide / landing | `vault`, `vaultMax` 1.5, `vaultLook` 0.8, `vaultMinSpeed` 5, `vaultClear` 0.35 · `slide`, `slideMinSpeed` 6, `slideTime` 0.8, `slideDecay` 3, `slideSteer` 6, `slideJumpFwd` 2.5, `slideBuffer` 0.25 · `rollMinVy` -15, `rollTime` 0.45, `stumbleVy` -24, `stumbleKeep` 0.4, `stumbleLock` 0.35, `failFloor` 2 |
| camera / mechanics | `ropeBiasMax` 3, `armRope` 9, `armWall` 6.5, `fovSpeedLo` 10, `fovSpeedHi` 28 (round 15: 34), `wallAway` 1.2 / `nearWallFor` 0.7 (round 10: on a wall run and 0.7 s after leaving a wall the camera's look point sits 1.2 m off it, so webbing off a wall run keeps the Radbro in frame) · `snapTime` 1.6 |

Double jump and slide: `airJumps` (1; 0 = no double jump), `doubleJumpSpeed` (7.5). Round 12 keys (all in
`?tune`, ranges from the spec's §9, `docs/specs/2026-09-26-round12-spider-tag.md`):

| group | keys (default) |
|---|---|
| straight zip | `zipSpeed` 30, `zipPull` 60 (on the line within ~4 steps), `zipCooldown` 0.35, `zipMaxTime` 1.6, `zipReach` 45, `zipLift` 0.14 (the aim is pitched up ~8 degrees; a sine), `zipAimMin` -0.34 / `zipAimMax` 0.77 (sines), `zipRigAssist` 1.2 (a cable this close to the ray counts), `zipAssistCos` 0.966 (the ringed anchor within 15 degrees when the ray hits nothing), `zipFanCos` 0.94 (then the zip fan: the ray again at half and the full 20 degrees off the aim, 8 ways round; 1 = off), `zipStop` 1, `zipKeep` 0.85, `zipCharges` 2, `zipRimReach` 2.5, `zipLedgeSpeed` 12 / `zipLedgeUp` 4 (the ledge pop), `zipFlingUp` 3 (the cable fling), `zipPopWindow` 0.25 / `zipPopUp` 14 / `zipPopFwd` 6 (the pop) |
| rig anchors | `rigBonus` 4 (a cable scores this many m better), `rigEndInset` 2, `rigSide` 1 / `rigSideFree` 4 (a cable point more than 4 m off your line scores 1 worse per m), `rigNear` 2 / `rigNearAhead` 12 (one less than 12 m ahead scores 2 worse per m short) |
| charge | `charge`, `chargeMin` 0.15, `chargeTime` 0.55, `chargeWalk` 4, `chargeUp` 13, `chargeFwd` 8, `chargeWallOut` 6, `chargeWallUp` 8, `chargeHangMax` 1.5, `chargeFling` 8, `chargeFlingUp` 4, `chargeAir` 0.3 |
| tech (player only) | `swingPerfectCos` 0.82 (35 degrees; round 15: 0.85, 32 degrees), `releasePerfect` 3 (round 15: 4.5), `reboundWindow` 0.12, `reboundKeep` 0.6, `kickChainUp` 0.8, `dive`, `diveMinDrop` 6, `diveSpeed` 12, `diveGravity` 1.5, `yankSpeed` 32, `yankTime` 0.7, `yankCooldown` 2.5, `airTurn` 1.6, `flowCap` 2, `flowDecay` 2.5 |
| camera | `zipFov` 6, `armZip` 6.5, `armDive` 8, `chargeArm` 0.5, `chargeFov` 3 |
| web-slinger swing (round 15, player only) | `anchorHeightGain` 0.35 / `anchorHeightAhead` 0.3 / `anchorHeightFree` 12 / `anchorUpMax` 34 (web length from your height), `swingSurge` 8 / `swingSurgeCos` 0.8 (the surge), `swingReelPerSpeed` 0.7 (the floor-clamp reel per m/s), `releasePerfectUp` 2.5, `autoReleaseKeep` 0 (the share of `releaseBoost` a held-to-the-end fling gets); retuned: `swingReleaseCos` 0.53 (58 degrees; the thief keeps 0.64), `swingPerfectCos` 0.85 (32 degrees), `releasePerfect` 4.5, `releaseSweet` 6 |
| corner swing (player only) | `cornerSwing`, `cornerReach` 13, `cornerMinSpeed` 9, `cornerStick` 0.6 (the stick's sine off your way), `cornerGravity` 0.3, `cornerBoost` 3, `cornerMaxT` 1.4, `cornerExitCos` 0.97 |
| dive (player only) | `diveCap` 46 (the speed cap while diving), `diveTurn` 0.9 (rad/s), `diveCarryDecay` 5, `diveKeep` 2.5 / `diveSwingT` 0.4 (the dive-into-swing) |
| web-slinger camera | `speedArm` 1, `lagY` 4 / `lagYMax` 1.6, `lookAhead` 0.06 / `lookAheadMax` 1.4, `diveFov` 3, `armDive` 6.5 (was 8); the speed FOV now `fovBoost` 18 over `fovSpeedLo` 10 - `fovSpeedHi` 34 |
| difficulty | `yankRange` per difficulty (Chill 0 = no yank, Normal 12, Degen 9: the owner's ranges; the district tweaks never change it) |
| structures | `structures.default` + `structures.<district>`: `cables`, `cableTier1` / `cableTier2`, `cableMin`, `cableSag`, `rigApart`, `cablePairs` (1 = one cable per street pair at its centre, 2 = one near each end) / `cableInset`, `gantry`, `gantryMin` / `gantryMax` / `gantryMinL`, `skybridge` / `skybridgeLo` / `skybridgeHi`, `tanks` / `tankLo` / `tankHi`, `boards` / `boardLo` / `boardHi`, `stacks` / `stackBelowLo` / `stackBelowHi` (the §2.2 district table is the default) |

**The runner zips and charges too** (his zip-up hops and leaps), so the zip, charge, rig and structure keys
are part of his bake; the double jump, slide, tech, zip-aim / pop, web-slinger swing / corner / dive and camera keys
are not (tuning them never stales a pack; the thief's preset pins `swingReleaseCos` at 0.64). After a runner-used key or a structure knob: `npm run level -- --all`, then `npm run
balance -- --all`; after a runner-unused key: balance only; after a camera key: nothing. The structure sliders
re-derive the structures live in `?sandbox`; a chase keeps the baked `city.model.json` until `npm run level`.

The runner is baked with the same player constants, so after changing any other `player` value run
`npm run level` (the dev-server Save does it), then `npm run balance` to see the catch rates, and commit
the regenerated `runner.pack.bin` and `bake.report.json`.

`npm run balance` plays 200 seeded rounds per row with three kinds of bot: the follower (runs his trail
at k x his speed, never swings; round 9: at his speed at each point of his track, not the edge average,
since his zips and runs now share an edge), the camper, and the **swinging chaser** (`SwingBot` in
`src/game/bots.ts`: the real player sim, chain-swinging down the streets on building anchors, letting the
fling carry it, cutting over to him and Yoinking after a ~0.1-0.2 s reaction; round 9: with the double
jump, slide and web zip, which it uses to climb back onto the roofs when he is above it). Targets: Normal
swinger median 25-40 s, Degen swinger 50-95 % caught with a median of 40-70 s (every district), and the
follower / camper targets for Normal / Chill (Downtown; the other districts print them as info, as since
round 6). The `swing, no zip` rows are the classic swinger without the moves (info: in the new cities it
rarely gets back up to him). `--set normal.gStar=36` tries a value, `--only swing` runs just those rows,
`--n 500` more seeds, `--map market` / `--all` another / every district (with its chase tweak).
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
- The production build is ~24 MB (models ~7.1 MB incl. four Radbros and their round 9 parkour clips, 7.9 MB
  of audio, five districts' level files, round 4 art; runner packs 180-380 KB each); the 9 MB budget is not
  enforced. The audio is only fetched once a round starts (about 3 MB per round).
- **Rounds 9-10 need a human pass**: the swing, the parkour and every balance number were only tested
  against bots and headless screenshots (in `?tune`: `swingAlign`, `anchorUp`, `swingOut*`, the wall / ledge
  keys, the difficulty table, then a district's `chase` tweak). The balance medians swing by 5-10 s with small
  sim changes (the bot catches early or not at all), so re-run `npm run balance -- --all` after any tuning.
- **Chains still sink** about 3 m per swing (from a roof edge, ~35 m below the takeoff after 10 s), so the
  way back up to him is a run-up, a tall anchor or the zip. A probe that swings in one fixed direction from
  every street-facing roof edge ends in the street in ~21-34 % of its runs, all of them past the city's edge.
- **The Towers still lean on zips** (32 % of his hops): its podium blocks differ by 6-30 m and few towers
  stand where a crossing pendulum needs one. The Docks, Downtown and the Night Market are mostly swings.
- The camera can end up against a facade when a wall run starts with the aim pointing into the wall (seen
  in a headless shot); round 10 eases the look point 1.2 m off the wall and keeps the shoulder out of it.
- Vertigo keeps its round 7 notes: a descending chase tuned on the bot, big height range, drop hops.
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
tags (`twitter:site` / `twitter:creator` @dexedrne). The canonical / og:url / image URLs are absolute on
https://spidertag.vyvanse.beer (the canonical address; `vercel.json` permanently redirects the old radrun.vyvanse.beer,
rugrun.vyvanse.beer and vercel.app hosts there, path and query kept, and sends `/token` to
https://token.spidertag.vyvanse.beer), so change them if the game moves. Share, challenge, ghost, room and wager links
are built from the address the game was opened on.
`public/og.jpg` (1200x630) is the key-art card: the six characters over the rooftops, the SPIDERTAG wordmark (Bebas
Neue) and a VT323 `[ OK ] spidertag.vyvanse.beer` line, an HTML page rendered with headless Chromium outside the repo.
`og2.jpg` / `og3.jpg` are the RadRun cards, kept for previews cached before the move. The favicon and the install
icons are the $SPIDERTAG coin's ST mark: `node tools/icons.ts <the 1024 px logo png>` writes `favicon.png`,
`icons/*.png` and `apple-touch-icon.png`. `npm run og-image` (dev server up, `RUGRUN_CHROME_PROFILE` set) renders the
older style of card, a mid-swing frame with the wordmark, the pitch and the portraits, into `og-frame.jpg` (never over
`og.jpg`): `--pick N` takes another frozen swing from the `?bot=swing` round, and `--bg <png>` re-composites over a
saved frame.
