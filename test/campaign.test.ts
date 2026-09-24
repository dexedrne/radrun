// Round 4 campaign: star evaluation, best-of progress and unlocks, guarded storage, and versioned links
// (v=2 carries the district + mutators; a link without v is an older Downtown / no-mutator link).
import { test } from "node:test";
import assert from "node:assert/strict";

// prefs.ts reads the page's district from location at import time: pretend to be a Docks page.
(globalThis as { location?: unknown }).location = { href: "https://rugrun.test/?map=docks", search: "?map=docks" };
const { readChallenge, challengeUrl, ghostUrl, LINK_VERSION } = await import("../src/ui/prefs.ts");
const {
  LEVELS, TOTAL_STARS, DEGEN_STARS, emptyProgress, evaluate, recordLevel, starCount, levelUnlocked, districtUnlocked,
  unlockedMutators, degenUnlocked, hatUnlocked, loadProgress, saveProgress,
} = await import("../src/game/campaign.ts");
const { M_POPS, M_WIND, M_LOWGRAV, M_SIXTY } = await import("../src/game/mutators.ts");
const { districtFromSearch } = await import("../src/world/districts.ts");

const stats = (o: Partial<{ maxChain: number; falls: number; catchKind: "tag" | "yoink" | ""; catchTime: number }> = {}) =>
  ({ maxChain: 0, topSpeed: 10, falls: 0, closest: 0, catchKind: "tag" as const, catchTime: 30, ...o });

test("campaign: 12 levels, 36 stars, stable numbering, every district and mutator used", () => {
  assert.equal(LEVELS.length, 12);
  assert.equal(TOTAL_STARS, 36);
  LEVELS.forEach((l, i) => assert.equal(l.n, i + 1));
  for (const id of ["downtown", "market", "docks", "towers"]) assert.ok(LEVELS.some(l => l.map === id), id);
  const all = LEVELS.reduce((m, l) => m | l.mutators, 0);
  assert.equal(all, 127, "every mutator appears in some level");
  for (const l of LEVELS) assert.equal(l.goals[0].kind, "catch");
});

test("campaign: star evaluation", () => {
  const l1 = LEVELS[0]; // catch / under 30 / no falls
  assert.deepEqual(evaluate(l1, "caught", stats({ catchTime: 20 }), 70), [true, true, true]);
  assert.deepEqual(evaluate(l1, "caught", stats({ catchTime: 31, falls: 1 }), 59), [true, false, false]);
  assert.deepEqual(evaluate(l1, "escaped", stats(), 0), [false, false, false], "no stars without the catch");
  const l2 = LEVELS[1]; // chain 4
  assert.equal(evaluate(l2, "caught", stats({ maxChain: 4 }), 40)[2], true);
  assert.equal(evaluate(l2, "caught", stats({ maxChain: 3 }), 40)[2], false);
  const l3 = LEVELS[2]; // yoink
  assert.equal(evaluate(l3, "caught", stats({ catchKind: "yoink" }), 40)[1], true);
  assert.equal(evaluate(l3, "caught", stats({ catchKind: "tag" }), 40)[1], false);
  const l9 = LEVELS[8]; // close call: under 10 s left
  assert.equal(l9.mutators, M_WIND | M_SIXTY);
  assert.equal(evaluate(l9, "caught", stats({ catchTime: 55 }), 5)[2], true);
  assert.equal(evaluate(l9, "caught", stats({ catchTime: 20 }), 40)[2], false);
});

test("campaign: stars are best-of, fresh stars reported once, best time kept", () => {
  const p = emptyProgress();
  assert.deepEqual(recordLevel(p, 1, [true, false, true], 70), [true, false, true]);
  assert.deepEqual(recordLevel(p, 1, [true, true, false], 50), [false, true, false]);
  assert.deepEqual(p.stars[1], [true, true, true]);
  assert.equal(p.best[1], 50);
  recordLevel(p, 1, [false, false, false], null);
  assert.deepEqual(p.stars[1], [true, true, true], "a failed run never takes stars away");
  assert.equal(starCount(p), 3);
});

test("campaign: unlocks - levels, districts, mutators, Degen, hats", () => {
  const p = emptyProgress();
  assert.ok(levelUnlocked(p, 1));
  assert.ok(!levelUnlocked(p, 2));
  assert.ok(districtUnlocked(p, "downtown"));
  assert.ok(!districtUnlocked(p, "market"));
  assert.equal(unlockedMutators(p), 0);
  recordLevel(p, 1, [true, false, false], 80);
  assert.ok(levelUnlocked(p, 2));
  recordLevel(p, 3, [true, false, false], 80); // Pop Quiz: pops
  assert.equal(unlockedMutators(p), M_POPS);
  recordLevel(p, 4, [true, false, false], 80); // Neon Alleys opens the Night Market
  assert.ok(districtUnlocked(p, "market"));
  recordLevel(p, 8, [true, false, false], 80); // Moon Jump: wind + low gravity
  assert.equal(unlockedMutators(p), M_POPS | M_WIND | M_LOWGRAV);
  assert.ok(!degenUnlocked(p));
  for (let n = 1; n <= DEGEN_STARS / 3; n++) recordLevel(p, n, [true, true, true], 30);
  assert.ok(degenUnlocked(p));
  assert.ok(hatUnlocked(p, "party"));
  assert.ok(!hatUnlocked(p, "foil"));
});

test("campaign: progress storage round-trips and survives junk / blocked storage", () => {
  const mem = new Map<string, string>();
  const store = { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => void mem.set(k, v) };
  const p = emptyProgress();
  recordLevel(p, 1, [true, true, false], 42);
  p.hat = "party";
  saveProgress(p, store);
  assert.deepEqual(loadProgress(store), p);
  mem.set("rugrun.campaign.v1", "{not json");
  assert.deepEqual(loadProgress(store), emptyProgress());
  const blocked = { get: () => { throw new Error("SecurityError"); }, set: () => { throw new Error("SecurityError"); } };
  assert.deepEqual(loadProgress(blocked), emptyProgress());
});

test("links: v2 links carry version, district and mutators; unversioned links are older Downtown links", () => {
  assert.equal(LINK_VERSION, 2);
  const url = ghostUrl("652", "4764", "normal", 41.26, 777, "abcdEFGH_-12", M_WIND | M_SIXTY);
  const q = new URL(url).search;
  assert.equal(districtFromSearch(q), "docks");
  const c = readChallenge(q);
  assert.equal(c.v, 2);
  assert.equal(c.mu, M_WIND | M_SIXTY);
  assert.equal(c.s, 777);
  assert.equal(c.t, 41.3);
  assert.equal(c.g, "abcdEFGH_-12");
  const plain = readChallenge(new URL(challengeUrl("652", "4764", "chill", 30)).search);
  assert.equal(plain.v, 2);
  assert.equal(plain.mu, 0);
  // A pre-round-4 link: no v, no m, no mu -> v1, Downtown, no mutators.
  const old = "?c=652&r=4764&d=normal&s=5&t=40.0&g=abcdEFGH_-12";
  assert.equal(readChallenge(old).v, 1);
  assert.equal(readChallenge(old).mu, 0);
  assert.equal(districtFromSearch(old), "downtown");
  // Junk mutator values are masked / ignored.
  assert.equal(readChallenge("?v=2&mu=9999").mu, 9999 & 127);
  assert.equal(readChallenge("?v=2&mu=-3").mu, 0);
});
