// Post-build: r3g fetches its Draco decoder from gstatic at runtime, so three's bundled decoder files
// are never requested. Delete dist/assets/draco_* and print the dist size (informational only).
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(import.meta.dirname, "..", "dist");
const assets = path.join(dist, "assets");
let removed = 0;
if (fs.existsSync(assets)) {
  for (const f of fs.readdirSync(assets)) {
    if (f.startsWith("draco_")) {
      fs.rmSync(path.join(assets, f), { force: true });
      removed++;
    }
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
console.log(`postbuild: removed ${removed} draco_* file(s); dist = ${(total / 1e6).toFixed(2)} MB (budget 9 MB, not enforced)`);
