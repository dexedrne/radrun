// The title (src/ui/title.tsx): its key art stays a light web image, the page preloads it with its fonts, and its
// outside links go where they should.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OTHER_GAMES, S } from "../src/ui/strings.ts";

const root = path.resolve(import.meta.dirname, "..");

test("key art: a lossy webp, 1600x900, under 260 KB", () => {
  const b = fs.readFileSync(path.join(root, "public/ui/key-art.webp"));
  assert.equal(b.toString("ascii", 0, 4), "RIFF");
  assert.equal(b.toString("ascii", 8, 16), "WEBPVP8 ");
  // VP8 key frame: 3 tag bytes, the 9d 01 2a start code, then 14-bit width and height
  assert.deepEqual([...b.subarray(23, 26)], [0x9d, 0x01, 0x2a]);
  assert.equal(b.readUInt16LE(26) & 0x3fff, 1600);
  assert.equal(b.readUInt16LE(28) & 0x3fff, 900);
  assert.ok(b.length < 260 * 1024, `${b.length} bytes`);
});

test("index.html: preloads the key art and both fonts, which exist", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const f of ["/ui/key-art.webp", "/fonts/BebasNeue.woff2", "/fonts/VT323.woff2"]) {
    assert.ok(html.includes(`<link rel="preload" href="${f}"`), f);
    assert.ok(fs.existsSync(path.join(root, "public", f)), f);
  }
  assert.ok(fs.existsSync(path.join(root, "public/fonts/OFL-VT323.txt")));
});

test("title links: the token page, the tip jar, the other games on vyvanse.beer", () => {
  assert.equal(S.tokenUrl, "https://token.spidertag.vyvanse.beer");
  assert.equal(S.tipUrl, "https://vyvanse.beer/#tip");
  assert.equal(S.host, "spidertag.vyvanse.beer");
  assert.ok(OTHER_GAMES.length >= 2);
  for (const g of OTHER_GAMES) assert.match(g.url, /^https:\/\/[a-z]+\.vyvanse\.beer$/, g.id);
});
