// Procedural music (audio/score.ts, round 4): the score is deterministic, stays in range, varies across
// the loop, and the close-chase layer switches on under 20 m (or while he panics) with hysteresis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYER_OFF, LAYER_ON, barNotes, musicTarget, tempoFor, type MusicInput } from "../src/audio/score.ts";
import fs from "node:fs";
import path from "node:path";
import { CHASE_TRACK, CHILL_TRACK, CHILL_TRACKS, MUSIC_STYLES, TAUNT_LINES, allAudioFiles, chaseTrack, chillTrack, musicPath, roundTrack, tauntKey } from "../src/audio/catalog.ts";
import { RADBROS } from "../src/game/round.ts";
import { TAUNTS } from "../src/ui/strings.ts";
import { DISTRICT_IDS } from "../src/world/districts.ts";

test("score: deterministic, in range, varies across the chase loop and between cycles", () => {
  const sig = (bar: number) => JSON.stringify(barNotes("chase", bar).base.filter(n => n.voice === "lead").map(n => [n.step, n.midi]));
  assert.equal(sig(3), sig(3));
  for (const mode of ["chase", "calm", "intro"] as const) {
    for (let bar = 0; bar < 48; bar++) {
      const b = barNotes(mode, bar);
      for (const n of [...b.base, ...b.layer]) {
        assert.ok(n.step >= 0 && n.step < 16 && n.len >= 1 && n.vel > 0 && n.vel <= 1, `${mode} ${bar} ${JSON.stringify(n)}`);
        if (n.midi) assert.ok(n.midi >= 36 && n.midi <= 96, `${mode} ${bar} midi ${n.midi}`);
      }
      assert.ok(b.base.some(n => n.voice === "kick"), `${mode} bar ${bar} has a kick`);
    }
  }
  const loop = new Set(Array.from({ length: 16 }, (_, i) => sig(i)));
  assert.ok(loop.size >= 6, `16-bar loop has ${loop.size} distinct lead bars`);
  assert.notEqual([0, 1, 2, 3].map(sig).join(), [16, 17, 18, 19].map(sig).join(), "the next cycle changes the melody");
  // Only the layer carries the arp; the calm and intro bars have no layer.
  assert.ok(!barNotes("chase", 0).base.some(n => n.voice === "arp"));
  assert.ok(barNotes("chase", 0).layer.some(n => n.voice === "arp"));
  assert.equal(barNotes("calm", 0).layer.length, 0);
  assert.ok(tempoFor("chase", "chill") < tempoFor("chase", "normal") && tempoFor("chase", "normal") < tempoFor("chase", "degen"));
  assert.ok(tempoFor("chase", "normal") >= 120 && tempoFor("chase", "degen") <= 140);
});

test("music target: calm title/results, intro countdown, chase + close layer with hysteresis", () => {
  const base: MusicInput = { title: false, results: false, practice: false, phase: "chase", d: 40, panic: false, gassed: false };
  assert.deepEqual(musicTarget({ ...base, title: true, phase: "" }, false), { mode: "calm", layer: false });
  assert.deepEqual(musicTarget({ ...base, phase: "countdown" }, false), { mode: "intro", layer: false });
  assert.deepEqual(musicTarget(base, false), { mode: "chase", layer: false });
  assert.equal(musicTarget({ ...base, d: LAYER_ON - 1 }, false).layer, true);
  assert.equal(musicTarget({ ...base, d: (LAYER_ON + LAYER_OFF) / 2 }, true).layer, true, "stays on inside the band");
  assert.equal(musicTarget({ ...base, d: (LAYER_ON + LAYER_OFF) / 2 }, false).layer, false, "does not switch on inside the band");
  assert.equal(musicTarget({ ...base, d: LAYER_OFF + 1 }, true).layer, false);
  assert.equal(musicTarget({ ...base, panic: true }, false).layer, true);
  assert.equal(musicTarget({ ...base, panic: true, gassed: true }, false).layer, false);
  assert.deepEqual(musicTarget({ ...base, practice: true, d: 5 }, false), { mode: "chase", layer: false });
  assert.deepEqual(musicTarget({ ...base, phase: "caught" }, true), { mode: "calm", layer: false });
  assert.deepEqual(musicTarget({ ...base, results: true, phase: "escaped" }, false), { mode: "calm", layer: false });
});

test("sampled audio: every catalogued file ships, nothing unused ships, lines match the bubbles", () => {
  const root = path.join(import.meta.dirname, "..", "public", "audio");
  // #3171 (added 2026-09-25) has no recorded voice yet (each Radbro's voice is designed by hand, one at a time).
  // He plays fine off the VOICE[] chatter-pitch fallback in PlayViews.tsx (voice.say returning "missing" is the
  // designed path) until then; drop his voice/ lines from the completeness check until then.
  // The Retardios (added 2026-10-02) are in the same spot: chatter until their voices are designed.
  // #3704 and #3710 use the same procedural chatter until recorded lines exist.
  const want = allAudioFiles(RADBROS).filter(f => !/^voice\/(3171|3704|3710|retardio)/.test(f));
  for (const f of want) assert.ok(fs.existsSync(path.join(root, f)), `missing public/audio/${f}`);
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(root, path.join(d, e.name))]));
  const extra = walk(root).filter(f => !want.includes(f));
  assert.deepEqual(extra, [], "unreferenced files under public/audio");
  for (const who of RADBROS) assert.equal(TAUNTS[who].length, TAUNT_LINES, `${who}: one voiced taunt per bubble`);
  assert.equal(tauntKey(0), "taunt_1");
  assert.equal(tauntKey(7), "taunt_2");
  for (const id of DISTRICT_IDS) assert.notEqual(CHASE_TRACK[id], undefined, `${id} has a chase loop`);
  assert.equal(chaseTrack("vertigo"), "chase_vertigo");
  assert.equal(chaseTrack("nowhere"), "chase_downtown");
});

test("music styles: a chill loop per district (unknown districts rotate), chase keeps the chase loops", () => {
  assert.deepEqual([...MUSIC_STYLES], ["chill", "chase"]);
  for (const id of DISTRICT_IDS) {
    assert.ok(CHILL_TRACKS.includes(CHILL_TRACK[id] as (typeof CHILL_TRACKS)[number]), `${id} has a chill loop`);
    assert.equal(roundTrack("chill", id, 7), CHILL_TRACK[id], `${id}: the same chill loop every round`);
    assert.equal(roundTrack("chase", id), chaseTrack(id));
  }
  // Each chill loop is some district's, so every file is heard.
  for (const t of CHILL_TRACKS) assert.ok(Object.values(CHILL_TRACK).includes(t), `${t} is used`);
  assert.equal(chillTrack("docks"), "chill_harbour");
  // An unknown district takes the next chill loop each round, all four in turn.
  const seen = [0, 1, 2, 3].map(r => chillTrack("nowhere", r));
  assert.equal(new Set(seen).size, CHILL_TRACKS.length);
  assert.equal(chillTrack("nowhere", 4), seen[0]);
  assert.equal(chillTrack("nowhere", -1), seen[3]);
  assert.equal(roundTrack("chase", "nowhere"), "chase_downtown");
});

test("chill loops: 128 kbps mp3s of 2-3 min, under 10 MB together", () => {
  const root = path.join(import.meta.dirname, "..", "public", "audio");
  let total = 0;
  for (const t of CHILL_TRACKS) {
    const buf = fs.readFileSync(path.join(root, musicPath(t)));
    total += buf.length;
    // First MPEG frame header: MPEG-1 layer III, bitrate index 9 (128 kbps), 44.1 kHz.
    let i = 0;
    while (i < buf.length - 4 && !(buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0)) i++;
    assert.equal(buf[i + 1] & 0xfe, 0xfa, `${t}: MPEG-1 layer III`);
    assert.equal(buf[i + 2] >> 4, 9, `${t}: 128 kbps`);
    assert.equal((buf[i + 2] >> 2) & 3, 0, `${t}: 44.1 kHz`);
    const seconds = (buf.length * 8) / 128000;
    assert.ok(seconds > 110 && seconds < 190, `${t}: ${seconds.toFixed(0)} s`);
  }
  assert.ok(total < 10 * 1024 * 1024, `chill loops ${(total / 1048576).toFixed(1)} MB`);
});

test("settings: the music style defaults to Chill and is remembered", async () => {
  const store = new Map<string, string>();
  const g = globalThis as { location?: unknown; localStorage?: unknown };
  g.location ??= { href: "https://rugrun.test/", search: "" };
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    const { loadSettings, saveSettings } = await import("../src/ui/prefs.ts");
    const cam = { sensitivity: 0.002, invertY: false, fov: 65, reducedMotion: false, easyGrab: false } as Parameters<typeof loadSettings>[0];
    assert.equal(loadSettings(cam).musicStyle, "chill");
    saveSettings({ ...loadSettings(cam), musicStyle: "chase" });
    assert.equal(loadSettings(cam).musicStyle, "chase");
    store.set("rugrun.v1", JSON.stringify({ settings: { musicStyle: "disco" } }));
    assert.equal(loadSettings(cam).musicStyle, "chill");
  } finally {
    delete g.localStorage;
  }
});
