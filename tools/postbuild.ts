// Post-build: the game decodes Draco with three's own glTF decoder, shipped in the build (src/app/draco.ts; gstatic's
// decoder broke under three's loader, 2026-10-17). three's DRACOLoader also references its full decoder and the pure-JS
// fallback, which nothing here requests: keep the glTF pair (the wrapper that names draco_decoder_gltf.wasm, and the
// smaller wasm), delete the rest of dist/assets/draco_*, then print the dist size (informational only).
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(import.meta.dirname, "..", "dist");
const assets = path.join(dist, "assets");
let removed = 0;
let kept = 0;
if (fs.existsSync(assets)) {
  const draco = fs.readdirSync(assets).filter(f => f.startsWith("draco_"));
  const wasm = draco.filter(f => f.endsWith(".wasm")).sort((a, b) => fs.statSync(path.join(assets, a)).size - fs.statSync(path.join(assets, b)).size);
  for (const f of draco) {
    const full = path.join(assets, f);
    const keep = f.startsWith("draco_wasm_wrapper") ? fs.readFileSync(full, "utf8").includes("draco_decoder_gltf") : f.endsWith(".wasm") && f === wasm[0];
    if (keep) kept++;
    else { fs.rmSync(full, { force: true }); removed++; }
  }
}

function size(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return n;
}
const total = fs.existsSync(dist) ? size(dist) : 0;
console.log(`postbuild: kept ${kept} draco_* file(s) (three's glTF decoder), removed ${removed}; dist = ${(total / 1e6).toFixed(2)} MB (budget 9 MB, not enforced)`);
