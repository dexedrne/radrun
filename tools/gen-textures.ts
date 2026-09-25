// npm run gen-textures: writes the city's tileable level textures to public/textures/ (+ manifest.json
// for the editor's texture picker). Opaque greyscale-ish PNGs: the material colour in the prefab
// materials table tints them (colour x map), so one texture serves several facade colours.
// In the game every repeating level texture is mapped in WORLD space (src/app/cityLook.tsx): the
// material's repeatCount is "tiles per metre", so windows keep their size on any building height.
//   facade_grid.png   office grid, 8 bays x 8 floors (bay 2 m, floor 3 m)  -> repeatCount [0.0625, 0.041667]
//   facade_brick.png  brick + punched windows, same grid                    -> repeatCount [0.0625, 0.041667]
//   facade_glass.png  curtain wall (towers), same grid                      -> repeatCount [0.0625, 0.041667]
//   roof.png          gravel roof with seams, 4 x 4 m                        -> repeatCount [0.25, 0.25]
//   street.png        one block pitch (block:street = 2:1): pavement, asphalt, lanes, zebras -> repeatCount
//                     1 / (block + street) per district (world/toPrefab.ts cityMaterials)
//   water.png         soft ripples, 16 x 16 m                                -> repeatCount [0.0625, 0.0625]
// Deterministic (seeded); re-running rewrites byte-identical files.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT = path.resolve(import.meta.dirname, "..", "public", "textures");

// ---- tiny PNG encoder (RGB, 8 bit) ------------------------------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = clamp255(r); raw[o + 1] = clamp255(g); raw[o + 2] = clamp255(b);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))]);
}
const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

// ---- helpers ----------------------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Hash noise in [0,1) for integer coordinates. */
const hash2 = (x: number, y: number, s = 0) => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
type C = [number, number, number];
const grey = (v: number): C => [v, v, v];
const mixc = (a: C, b: C, t: number): C => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c: C, k: number): C => [c[0] * k, c[1] * k, c[2] * k];
const hex = (s: string): C => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];

// Window glass palette (multiplied by the facade tint in game, so keep it fairly neutral).
const GLASS_DARK = hex("#2c3544"), GLASS_SKY = hex("#6f8aa8"), GLASS_BLIND = hex("#cfc7b4"), GLASS_WARM = hex("#f2d9a0");

/** One window pane colour for cell (i, j) of a facade tile, with a vertical sky-reflection gradient. */
function glassFor(i: number, j: number, seed: number) {
  const r = hash2(i, j, seed);
  const base = r < 0.06 ? GLASS_WARM : r < 0.18 ? GLASS_BLIND : mixc(GLASS_DARK, GLASS_SKY, 0.25 + 0.5 * hash2(j, i, seed + 7));
  return (t: number) => (r < 0.18 ? shade(base, 0.92 + 0.08 * t) : mixc(base, shade(GLASS_SKY, 1.15), 0.45 * t)); // t = 0 bottom .. 1 top of the pane
}

// Facade tiles: 8 bays x 8 floors, 32 x 48 px per cell (16 px/m: bay 2 m, floor 3 m).
const CW = 32, CH = 48, NX = 8, NY = 8;

function facadeGrid(): Buffer {
  return png(CW * NX, CH * NY, (x, y) => {
    const i = Math.floor(x / CW), j = Math.floor(y / CH);
    const cx = x % CW, cy = CH - 1 - (y % CH); // cy = 0 at the floor slab
    const n = 0.01 * Math.floor(3 * hash2(x >> 1, y >> 1, 11)) - 0.01;
    if (cy < 3) return grey(0.74 + n); // floor slab band
    if (cx < 3 || cx > CW - 4) return grey(0.9 + n); // pier between bays
    if (cy < 9) return grey(0.86 + n); // spandrel under the window
    if (cy > CH - 5) return grey(0.88 + n); // head above the window
    if (cy === 9 || cx === 3 || cx === CW - 4 || cy === CH - 5 || cx === CW >> 1) return grey(0.55); // frame + mullion
    const g = glassFor(i, j, 1)((cy - 10) / (CH - 16));
    return mixc(g, grey(1), n);
  });
}

function facadeBrick(): Buffer {
  const rand = rng(5);
  const brickTone = Array.from({ length: 4096 }, () => 0.84 + 0.12 * rand());
  return png(CW * NX, CH * NY, (x, y) => {
    const i = Math.floor(x / CW), j = Math.floor(y / CH);
    const cx = x % CW, cy = CH - 1 - (y % CH);
    // Punched window: 18 x 26 px (1.1 x 1.6 m), centred, sill + lintel.
    const wx0 = 7, wx1 = CW - 8, wy0 = 12, wy1 = 38;
    if (cx >= wx0 - 1 && cx <= wx1 + 1 && (cy === wy0 - 1 || cy === wy0 - 2)) return grey(0.95); // sill
    if (cx >= wx0 - 2 && cx <= wx1 + 2 && cy >= wy1 + 1 && cy <= wy1 + 3) return grey(0.62); // lintel
    if (cx >= wx0 && cx <= wx1 && cy >= wy0 && cy <= wy1) {
      if (cx === wx0 || cx === wx1 || cy === wy0 || cy === wy1 || cy === wy0 + 17) return grey(0.93); // white frame + transom
      return glassFor(i, j, 3)((cy - wy0) / (wy1 - wy0));
    }
    // Running-bond brick: 3 px courses (~19 cm), 8 px bricks, mortar lines.
    const course = Math.floor(y / 3);
    if (y % 3 === 2) return grey(0.97);
    const bx = x + (course % 2 ? 4 : 0);
    if (bx % 8 === 7) return grey(0.97);
    const t = brickTone[(course * 37 + Math.floor(bx / 8)) % brickTone.length];
    return grey(t * (0.97 + 0.03 * hash2(x, y, 9)));
  });
}

function facadeGlass(): Buffer {
  return png(CW * NX, CH * NY, (x, y) => {
    const i = Math.floor(x / CW), j = Math.floor(y / CH);
    const cx = x % CW, cy = CH - 1 - (y % CH);
    if (cy < 11) return grey(0.8 + 0.04 * hash2(i, j, 4)); // spandrel band
    if (cx < 2 || cx > CW - 3 || cy < 13 || cx === CW >> 1) return grey(0.5); // mullions + transom
    const t = (cy - 13) / (CH - 14);
    const r = hash2(i, j, 6);
    const base = r < 0.05 ? GLASS_WARM : mixc(hex("#3b4b63"), hex("#9fb7d2"), 0.3 + 0.3 * hash2(j, i, 6));
    return mixc(base, grey(0.95), 0.35 * t + 0.1 * Math.max(0, 1 - Math.abs(cx - 8 - 3 * i) / 3)); // sky gradient + a highlight streak
  });
}

function roof(): Buffer {
  // 4 x 4 m at 32 px/m: gravel speckle, seams every 2 m, a few darker tar patches.
  const S = 128;
  return png(S, S, (x, y) => {
    const n = hash2(x, y, 21), m = hash2(x >> 2, y >> 2, 22);
    if (x % 64 === 0 || y % 64 === 0) return grey(0.72);
    if (x % 64 === 1 || y % 64 === 1) return grey(0.84);
    let v = 0.9 + 0.08 * (n - 0.5) + 0.04 * (m - 0.5);
    if (n > 0.93) v -= 0.12;
    return grey(v);
  });
}

function street(): Buffer {
  // One 42 m block pitch (block 28 m + street 14 m) at ~12.2 px/m. u = world x, v = world z; image rows
  // are written top-down, so row r is v = 1 - (r + 0.5) / S (textures are flipped on upload).
  const S = 512, P = 42, B = 28;
  const ppm = S / P;
  const asphalt = (x: number, y: number) => grey(0.3 + 0.012 * Math.floor(4 * hash2(x >> 1, y >> 1, 31)) + 0.02 * Math.floor(2 * hash2(x >> 4, y >> 4, 32)));
  return png(S, S, (px, py) => {
    const wx = (px + 0.5) / ppm, wz = (1 - (py + 0.5) / S) * P;
    const inX = wx < B, inZ = wz < B; // inside the block span along each axis
    if (inX && inZ) {
      // Block: pavement with a 2 m paving grid and a kerb along the edges.
      const edge = Math.min(wx, B - wx, wz, B - wz);
      if (edge < 0.3) return grey(0.92);
      const gx = wx % 2 < 0.09 || wz % 2 < 0.09;
      return grey((gx ? 0.66 : 0.78) + 0.01 * Math.floor(3 * hash2(px >> 1, py >> 1, 33)));
    }
    const a = asphalt(px, py);
    const sx = wx - B, sz = wz - B; // 0..14 across the street
    if (!inX && !inZ) {
      // Intersection: plain asphalt.
      return a;
    }
    // A street segment: along = the axis inside the block span, across = 0..14 m.
    const across = inX ? sz : sx, along = inX ? wx : wz;
    // Zebra crossing at both ends (first/last 3 m of the segment), stripes 0.5 m on/off.
    if ((along < 3 || along > B - 3) && across > 1 && across < 13) {
      if (Math.floor(across / 0.5) % 2 === 0) return grey(0.93);
      return a;
    }
    // Stop line and lane edges.
    if ((along >= 3 && along < 3.3) || (along > B - 3.3 && along <= B - 3)) return across > 1 && across < 13 ? grey(0.9) : a;
    if (Math.abs(across - 1) < 0.08 || Math.abs(across - 13) < 0.08) return grey(0.82);
    // Dashed centre line: 3 m dash, 3 m gap.
    if (Math.abs(across - 7) < 0.1 && Math.floor((along - 3.3) / 3) % 2 === 0) return mixc(hex("#f2c14e"), a, 0.1);
    return a;
  });
}

function water(): Buffer {
  // 16 x 16 m at 16 px/m; tileable ripples from integer-frequency sines.
  const S = 256, tau = Math.PI * 2;
  const waves: Array<[number, number, number, number]> = [[3, 1, 0.3, 0.8], [-2, 3, 1.7, 0.6], [5, -2, 2.9, 0.35], [1, 6, 0.9, 0.3], [7, 4, 4.1, 0.2]];
  return png(S, S, (x, y) => {
    const u = x / S, v = y / S;
    let h = 0;
    for (const [a, b, ph, amp] of waves) h += amp * Math.sin(tau * (a * u + b * v) + ph);
    const crest = Math.max(0, h - 1.1) * 0.5;
    return mixc(grey(0.84 + 0.07 * h / 2.25), grey(1), Math.min(1, crest));
  });
}

fs.mkdirSync(OUT, { recursive: true });
const files: Array<[string, Buffer]> = [
  ["facade_grid.png", facadeGrid()],
  ["facade_brick.png", facadeBrick()],
  ["facade_glass.png", facadeGlass()],
  ["roof.png", roof()],
  ["street.png", street()],
  ["water.png", water()],
];
for (const [name, data] of files) {
  fs.writeFileSync(path.join(OUT, name), data);
  console.log(`gen-textures: public/textures/${name} (${(data.length / 1024).toFixed(1)} KB)`);
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ files: files.map(([n]) => `/textures/${n}`) }, null, 1) + "\n");
