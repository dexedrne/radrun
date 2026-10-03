// Favicon + Home Screen / install icons from the square SPIDERTAG logo (the ST mark, 1024 px, kept outside the repo):
//   public/favicon.png (64 px) and public/icons/icon-192.png, icon-512.png (rounded tiles),
//   public/icons/icon-maskable-512.png (full-bleed background, the mark inside the 80 % safe zone) and
//   public/apple-touch-icon.png (180 px, square: iOS rounds it), for index.html and public/manifest.webmanifest.
//   node tools/icons.ts <logo.png>
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const pub = path.join(root, "public");
const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error("usage: node tools/icons.ts <square logo png>");
  process.exit(1);
}
const BG = "#0d1022";
fs.mkdirSync(path.join(pub, "icons"), { recursive: true });

async function out(img: ReturnType<typeof sharp>, rel: string) {
  const file = path.join(pub, rel);
  await img.png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 }).toFile(file); // 8-bit palette: a fraction of the size
  console.log(`icons: public/${rel} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
}
/** The logo at `size`, with the corners rounded like the old tile (rx = 14/64). */
async function tile(size: number) {
  const r = Math.round((size * 14) / 64);
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" fill="#fff"/></svg>`);
  return sharp(src).resize(size, size, { kernel: "lanczos3" }).composite([{ input: mask, blend: "dest-in" }]);
}

await out(await tile(64), "favicon.png");
await out(await tile(192), "icons/icon-192.png");
await out(await tile(512), "icons/icon-512.png");
// Maskable: the mark at 72 % on the navy it is drawn on, its edges feathered into it (no visible square).
const feather = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="368" height="368"><filter id="f"><feGaussianBlur stdDeviation="12"/></filter><rect x="16" y="16" width="336" height="336" rx="40" fill="#fff" filter="url(#f)"/></svg>`);
const inner = await sharp(src).resize(368, 368, { kernel: "lanczos3" }).composite([{ input: feather, blend: "dest-in" }]).png().toBuffer();
await out(sharp({ create: { width: 512, height: 512, channels: 4, background: BG } }).composite([{ input: inner, gravity: "centre" }]), "icons/icon-maskable-512.png");
await out(sharp(src).resize(180, 180, { kernel: "lanczos3" }).flatten({ background: BG }), "apple-touch-icon.png");
