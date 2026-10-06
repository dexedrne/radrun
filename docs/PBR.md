# City surface maps

`npm run pbr-maps` derives the six tiling city albedos in `public/textures/` into
`public/textures/pbr/`. Requires ImageMagick (`magick` on PATH); no package or engine
upgrade is needed. Run after `npm run gen-textures`. `npm run pbr-maps -- --check`
regenerates into a temporary directory and compares bytes and source/output hashes
without rewriting the shipped assets. The manifest records each input, profile and
output. Height maps are inspection assets; the game loads only normal and roughness.

The height estimate combines perceptual luminance and a periodic high-pass filter.
Masks matching `gen-textures.ts` recess bright brick mortar, facade joints, glazing,
roof seams and pavement grout. Painted window reflections and street markings do not
become raised bumps. Water troughs are smoother than ripple crests. Binomial smoothing,
half-size filtering and central differences wrap across opposite edges. Existing albedo
colour remains unchanged. Normals use OpenGL / three.js +Y (R = -column derivative,
G = +image-row derivative, B outward). PNGs store linear data with no sRGB conversion.

`CityLook` applies maps only to the known lit level albedos. Maps share the albedo's
repeat/offset/rotation and world-space UV projection. A matching world-space tangent
frame handles opposing walls and top faces correctly without relying on the stretched
unit-box UVs. Normals affect lighting only; geometry, anchors, collision and simulation
remain unchanged. The unlit distant skyline keeps its existing basic material. Characters,
billboards, signs and decals keep their own materials.

Desktop High uses native-size normals and roughness. Low and touch devices use half-size
roughness and omit normals, including on High mobile (the existing DPR cap remains).
This is a fixed device/preset rule; it does not depend on fluctuating frame times.
Textures are shared by source and UV transform. Switching presets disposes unused maps,
so a High-to-Low switch actually releases the normal texture allocations. Editor changes
and late texture loads are picked up by the existing periodic material scan.

`RUGRUN_CHROME_PROFILE=<throwaway-dir> npm run pbr-shots -- <dev-url> <output-dir> before|after`
captures fixed canyon and rooftop cameras in daylight and with the actual night mutator.
The script uses the repository's existing browser driver, one page/browser at a time,
and records renderer.info texture bytes, texture count, draws, triangles, mapped material
counts, requests and camera coordinates alongside canvas screenshots. A material-only
RGBA8/mipmap estimate is recorded separately; renderer.info includes other GPU textures
and renderer allocations. The capture also records a loaded-size correction using r186's
texture format/mipmap accounting for uploaded material textures that were first counted as
TextureLoader placeholders. Both raw counters and corrections remain in the JSON. The mobile pass uses the supported
`?touch=1` override to select touch handling at the same viewport for a comparable resource budget, not a phone frame-rate benchmark.

## Captured budgets

Fixed Downtown rooftop view at 1280 × 720, WebGPU. Loaded texture estimates include
renderer allocations plus the correction described above; they are texture resource
budgets, not driver/process memory. High and Low have unchanged draw counts.

| Preset | Before | After | Before → after draws |
| --- | ---: | ---: | ---: |
| High | 30.21 MiB | 37.37 MiB | 121 → 121 |
| Low | 30.21 MiB | 32.01 MiB | 117 → 117 |

The deterministic material-map pool (RGBA8 including mip levels) is 17.32 → 23.82 MiB
on High and 17.32 → 18.13 MiB on Low/mobile: the new maps cost 6.50 / 0.81 MiB.
Dropping normals and shrinking roughness frees 5.69 MiB during a live High → Low switch.
Low and touch cold loads request no normal PNGs. WebGL2 captures also retain 121 / 117 draws.
The extra water shading uses the same existing water box and material batch.

Day/night canyon and rooftop pairs, Low/mobile images, renderer reports and check logs
are in the local `~/Documents/pbr-st/` capture directory. The screenshots were inspected:
relief remains subtle, with broken lighting along joints/seams and no obvious tiling seams,
excessive gloss or noisy grain. `--backends=webgpu --qualities=high,low --budget=1` limits
captures to the budget view; `--switch=1` adds the live allocation-release check.

Validation: typecheck, both build modes, byte-identical map regeneration and 26 city/district
checks pass. The full game suite reports 342 passes, one skip and one failure: the existing
fresh-bake test's 60-second wall-clock assertion (387 s with the full suite, 115 s in
isolation on the busy host). Simulation, collision, city model hashes and committed runner packs
are unchanged; the timing assertion was left intact.
