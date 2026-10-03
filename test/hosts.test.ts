// The SPIDERTAG move: the old hosts redirect to spidertag.vyvanse.beer (path and query kept), /token goes to the
// coin's page, the link previews name the new host, and both relays accept the new origin and still the old one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const SITE = "https://spidertag.vyvanse.beer";

test("vercel.json: radrun / rugrun / vercel.app hosts go to spidertag.vyvanse.beer, /token to the token page", () => {
  type R = { source: string; destination: string; permanent: boolean; has?: { type: string; value: string }[] };
  const rules = (JSON.parse(read("vercel.json")) as { redirects: R[] }).redirects;
  const of = (host: string) => rules.filter(r => r.has?.some(h => h.type === "host" && h.value === host)).map(r => [r.source, r.destination, r.permanent]);
  for (const host of ["rugrun.vyvanse.beer", "radbro-rug-run.vercel.app"]) {
    assert.deepEqual(of(host), [["/", `${SITE}/`, true], ["/:path+", `${SITE}/:path+`, true]], host);
  }
  // radrun.vyvanse.beer: everything but /carry.html, which hands this browser's saves to the new address (ui/carry.ts).
  const carryRule = "/:path((?!carry\\.html$).+)";
  assert.deepEqual(of("radrun.vyvanse.beer"), [["/", `${SITE}/`, true], [carryRule, `${SITE}/:path`, true]]);
  const re = /^\/((?!carry\.html$).+)$/; // what path-to-regexp makes of carryRule
  assert.equal(re.exec("/carry.html"), null);
  assert.equal(re.exec("/levels/city.json")?.[1], "levels/city.json");
  assert.equal(re.exec("/carry.html/x")?.[1], "carry.html/x");
  assert.equal(re.exec("/"), null, "the root has its own rule");
  const token = rules.filter(r => r.source.startsWith("/token"));
  assert.deepEqual(token.map(r => [r.source, r.destination]), [
    ["/token{/}?", "https://token.spidertag.vyvanse.beer/"],
    ["/token/:path+", "https://token.spidertag.vyvanse.beer/:path+"],
  ]);
  assert.ok(token.every(r => !r.has), "/token works on every host");
  const bare = /^\/token(?:\/)?$/; // what path-to-regexp makes of "/token{/}?": /token/ too, not /tokens
  assert.ok(bare.test("/token") && bare.test("/token/") && !bare.test("/tokens") && !bare.test("/token/x"));
});

test("index.html: canonical, og:url and the share image are on spidertag.vyvanse.beer", () => {
  const html = read("index.html");
  assert.ok(!html.includes("radrun.vyvanse.beer"));
  assert.ok(html.includes(`<link rel="canonical" href="${SITE}/" />`));
  assert.ok(html.includes(`content="${SITE}/og.jpg"`));
  assert.ok(fs.existsSync(path.join(root, "public/og.jpg")) && fs.existsSync(path.join(root, "public/favicon.png")));
});

test("relays: every deployed config allows spidertag.vyvanse.beer and, during the move, radrun.vyvanse.beer", () => {
  for (const f of ["relay/wrangler.toml", "relay/wager/wrangler.toml"]) {
    const lists = [...read(f).matchAll(/^ALLOWED_ORIGINS = "([^"]*)"/gm)].map(m => m[1].split(",").map(s => s.trim())).filter(l => l[0]);
    assert.ok(lists.length >= 1, f);
    for (const l of lists) assert.ok(l.includes(SITE) && l.includes("https://radrun.vyvanse.beer"), `${f}: ${l.join(",")}`);
  }
});
