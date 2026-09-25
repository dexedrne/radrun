// Home Screen / install icons from public/favicon.svg (the balloon):
//   public/icons/icon-192.png, icon-512.png (the rounded tile as drawn) and icon-maskable-512.png
//   (full-bleed background, the balloon inside the 80 % safe zone), for public/manifest.webmanifest.
//   node tools/icons.ts
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const pub = path.join(root, "public");
const outDir = path.join(pub, "icons");
fs.mkdirSync(outDir, { recursive: true });
const svg = fs.readFileSync(path.join(pub, "favicon.svg"), "utf8");
const BG = "#141833";

async function png(src: string, size: number, name: string) {
  const out = path.join(outDir, name);
  await sharp(Buffer.from(src), { density: Math.ceil((72 * size) / 64) }).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
  console.log(`icons: ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
}

// Maskable: square background to the edges, the drawing scaled to 72 % and centred.
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<rect[^>]*\/>/, "");
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${BG}"/><g transform="translate(32 32) scale(0.72) translate(-32 -32)">${inner}</g></svg>`;

await png(svg, 192, "icon-192.png");
await png(svg, 512, "icon-512.png");
await png(maskable, 512, "icon-maskable-512.png");
