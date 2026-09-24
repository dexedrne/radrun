# Rug Run — round 4: depth (design)

**Date:** 2026-09-24 · **Status:** approved direction, built in this round
**Goal:** more difficulty, harder maps, more depth — districts, harder mechanics, a campaign — without
breaking the verified core (deterministic sim, baked runner, no-remount restart, instanced city).

## 1. Districts

| id | Name | Feel | Generator config (vs Downtown) |
|---|---|---|---|
| `downtown` | Downtown | the current city | unchanged (seed 7) |
| `market` | Night Market | dense, narrow, twisty; many junctions, short runner edges | blocks 8×6, building 10, alley 3, block 23, street 10, roofs 18-26, street Δh ≤ 3, 4 towers, some balloon-free street spans |
| `docks` | The Docks | low warehouses, wide streets, long flights | blocks 7×3, building 14, alley 4, block 32, street 17, roofs 12-20, merge 0.35 (long sheds), 3 towers (cranes), hooks 9 m above |
| `towers` | The Towers | tall, big height swings, vertical chases | roofs 34-62, street Δh ≤ 5.5, alley Δh ≤ 1, 10 towers of 90-130 m, hooks 11 m above |

- **Files.** Downtown stays in `public/levels/` (old links and tests keep working). New districts live in
  `public/levels/<id>/` with their own `city.json`, `decor.json`, `city.model.json`, `runner.pack.bin`,
  `bake.report.json`. `tuning.json` stays shared at `public/levels/tuning.json`.
- **Registry.** `src/world/districts.ts`: id, name, blurb, level dir, look (sky / fog colours), default
  mechanics. Everything that loads level files asks the registry for the base URL.
- **Switching district = a page navigation** (`?map=<id>`; also read from ghost links' `m=`). The
  PlayGame, the canvas and the PrefabRefs stay single-district per page, so every existing invariant
  (restart never remounts, one CityIndex, baked pack) is untouched; a district change is a new page
  load (GLBs are HTTP-cached). Retry inside a district still never remounts.
- **Tools.** `npm run gen-city -- --map <id> [--force]` writes a district's `city.json` + `decor.json`
  once (hand-editable afterwards, same rule as Downtown). `npm run level -- --map <id>` / `--all`
  derives and bakes one / every district; tuning is read from the shared root file.
- **Editor.** `?editor&map=<id>` (and `?editor=decor&map=<id>`); the dev save endpoint accepts a map.
- **Bake envelope.** The bake validates every edge (swing window ≥ 300 ms, alley ≥ 100 ms, landing
  margin, snap). Districts that push height differences further simply drop more candidate edges; the
  graph checks (connected, no forced U-turns, 300 s walk) still gate the build per district.

## 2. Mechanics (all deterministic; the runner is never affected)

- **Popping balloons (player only).** `SimWorld.pop = {share, respawnSteps}` + `SimWorld.hookDown:
  Int32Array` (step until which a hook is gone). A hook is *fragile* when
  `hash32(hookId, seed) / 2^32 < share` (integer hash, no trig). Releasing a fragile hook pops it:
  `hookDown[id] = step + respawnSteps` (default 6 s). `pickTarget` skips popped hooks, so the ring
  never lands on one. The array is part of the Round hash, so ghosts replay pops exactly. The runner
  plays his baked track and never reads `hookDown`; his rope may use a balloon the player popped (his
  rope is drawn, the balloon stays hidden for the player — accepted cosmetic).
  Tells: fragile balloons render cracked/pale; a pop plays a burst + sound; a faint ring marks the
  respawn.
- **Wind gusts (player only).** A gust schedule from its own rng (`mulberry32(seed ^ 0x5bd1e995)`, so
  the round rng draws are unchanged): every 9-16 s a gust of 2.4 s (0.4 s ramp in/out) from one of 8
  directions with strength `windMax` (default 7 m/s²). The Round writes `SimWorld.wind` each step;
  `stepBody` adds it to v only while airborne (rope or free). HUD: a wind arrow that appears 1 s before
  a gust and fills while it blows; streak particles.
- **Balloon-free gaps (layout).** `CityConfig.hookGapChance`: each street facing pair drops all its
  hooks with that chance (seeded from the city seed, by pair order). Players must route around or carry
  momentum; the bake only keeps edges that still validate, and the graph checks gate the build.

## 3. Campaign, stars, mutators, unlocks

- **Levels** (`src/game/campaign.ts`, 12): district × difficulty × mutators × 3 objectives each.
  Downtown 1-3 (tutorial arc: catch / faster / pops), Night Market 4-6 (gaps, night), Docks 7-9 (wind,
  low gravity), Towers 10-12 (wind + pops, one life, Degen).
- **Objectives:** `catch`, `under(s)`, `noFalls`, `yoink`, `chain(n)`, `closeCall` (catch with < 10 s
  left). Evaluated from the Round's end stats; a star is kept once earned (best-of).
- **Mutators** (bit flags, part of the round options, the ghost link and the hash): `pops`, `wind`,
  `lowGravity` (player gravity ×0.65), `noYoink`, `oneLife` (a fall ends the round: "rugged"),
  `sixty` (60 s clock), `night` (visual only: dark sky, close fog, lit balloons).
- **Unlocks** (localStorage `rugrun.campaign.v1`, try/catch): level n+1 when level n is caught; a
  district opens in free play once its first campaign level is caught (Downtown always); a mutator
  opens in free play once a campaign level using it is caught; Degen free play at 12 stars;
  cosmetics — George hats: party hat (9 ★), crown (21 ★), tin-foil (33 ★ = all stars on 11 levels).
- **Title flow:** CAMPAIGN (level grid with stars and locks) / FREE PLAY (district, difficulty,
  unlocked mutators) / PRACTICE. A campaign level in another district navigates to
  `?map=<id>&lvl=<n>` and opens straight into that level.

## 4. Ghost / challenge links

`?v=2&m=<district>&mu=<mutator bits>` join the existing `c r d s t g`. A link without `v` is a v1
link: Downtown, no mutators. If a replay no longer verifies and the link is older than the current
build, the title says "made on an older build" next to "unverified". Links for another district open
that district (the page boots the link's `m`).

## 5. Art (OpenAI images, ≤ 25 generations, `gpt-image-2`, medium quality)

| Asset | Count | Size → shipped | Use |
|---|---|---|---|
| District sky panoramas (horizon strip, no characters) | 4 (+ 2 retries) | 1536×1024 → 2048×~680 webp ≤ 350 KB | sky cylinder behind the skyline, per district |
| Billboard art (Radbro / crypto humour, no brands or real people, little or no text) | 8 | 1024×1024 or 1536×1024 → ≤ 80 KB webp | decor billboards via the materials table (editable in `?editor`) |
| Title / loading key art background | 1-2 | 1536×1024 → ≤ 200 KB webp | title + loading screen; the Radbros are composited from the existing renders (never drawn by the model) |
| Campaign district cards | 4 | 1024×1024 → ≤ 60 KB | campaign level grid headers |

Prompts and the file map go in the untracked `.local/NOTES.md`.
