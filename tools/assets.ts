// npm run assets -- --radbros <dir> [--george <dir>]
// Turns the owner's character GLBs into web GLBs + clip packs in public/models/ and writes
// src/generated/clips.meta.json (and george_clips.json when George's delivery exists).
//
// <radbros> is the owner's Radbro folder: delivery/radbro{652,4764,2564}_animations.glb, plus
// game-clips/ (radbro<id>.clips.glb packs, re-rigged radbro<id>_character.glb replacements and
// manifest.json). A re-rigged character replaces its delivery GLB (the old rig no longer matches
// the bought clips). <george> is George's folder: delivery/george_animations.glb + george_clips.json.
// Both can also come from RUGRUN_RADBROS / RUGRUN_GEORGE. Source paths are never written anywhere.
//
// Character recipe (spec §9, exact order; draco LAST - unlit after it silently drops compression):
//   unlit -> drop sit/lie clips -> resize 1024 -> webp 90 -> resample -> draco
// Clip packs: skeleton + animations only, resample + prune + dedup (no mesh, nothing to draco).
//
// `npm run assets -- --meta-only` re-measures the jump timings (Regular_Jump takeoff / apex / land,
// forward kinematics of the feet) from the committed public/models GLBs and updates only those fields
// in clips.meta.json (no source folder needed, no GLB rewritten).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { NodeIO, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, resample } from "@gltf-transform/functions";
import { Matrix4, Quaternion, Vector3 } from "three";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "public", "models");
const GEN = path.join(ROOT, "src", "generated");
const BIN = path.join(ROOT, "node_modules", ".bin", "gltf-transform");
const IDS = ["652", "4764", "2564"] as const;
const DROP = ["Stand_to_Sit_Transition_M", "Chair_Sit_Idle_M", "Sit_Lie_Bed"];

function arg(name: string, env: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : process.env[env];
  return v ? path.resolve(v) : null;
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "rugrun-assets-"));
const kb = (f: string) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;

function gt(...args: string[]): void {
  execFileSync(BIN, args, { stdio: ["ignore", "ignore", "inherit"] });
}

async function dropClips(inp: string, out: string, names: string[]): Promise<string[]> {
  const doc = await io.read(inp);
  const kept: string[] = [];
  for (const a of doc.getRoot().listAnimations()) {
    if (names.includes(a.getName())) a.dispose();
    else kept.push(a.getName());
  }
  await doc.transform(prune());
  await io.write(out, doc);
  return kept;
}

/** Character GLB: the exact §9 CLI recipe (the clip drop between unlit and resize uses the API). */
async function character(src: string, out: string): Promise<{ kept: string[]; measured: ReturnType<typeof measure> }> {
  const a = path.join(tmp, "a.glb"), b = path.join(tmp, "b.glb"), c = path.join(tmp, "c.glb"), d = path.join(tmp, "d.glb"), e = path.join(tmp, "e.glb");
  gt("unlit", src, a);
  const kept = await dropClips(a, b, DROP);
  gt("resize", b, c, "--width", "1024", "--height", "1024");
  gt("webp", c, d, "--quality", "90");
  gt("resample", d, e);
  const measured = measure(await io.read(e)); // the draco'd output needs a decoder to read back
  gt("draco", e, out);
  return { kept, measured };
}

/** Clip pack: strip anything that is not skeleton or animation, then resample / prune / dedup. */
async function clipPack(src: string, out: string): Promise<string[]> {
  const doc = await io.read(src);
  const root = doc.getRoot();
  for (const n of root.listNodes()) { n.setMesh(null); n.setSkin(null); }
  for (const x of [...root.listMeshes(), ...root.listSkins(), ...root.listMaterials(), ...root.listTextures()]) x.dispose();
  await doc.transform(resample(), prune({ keepLeaves: true }), dedup());
  await io.write(out, doc);
  return root.listAnimations().map(x => x.getName());
}

type Vec = [number, number, number];
type ClipMeta = {
  duration: number;
  loop: boolean;
  /** Hips translation (parent space) at the first key and its range over the clip. */
  hips: { start: Vec; min: Vec; max: Vec };
  rootPolicy: { xz: "keep" | "pin"; y: "keep" | "pin" };
  /** Run_and_Jump: from the clip manifest. Regular_Jump: measured (jumpTimes): feet leave / hips top / feet back. */
  takeoffAt?: number;
  apexAt?: number;
  landAt?: number;
  /** Rope_Hang_Idle: RightHand height above the feet (errata 1). */
  handHeight?: number;
};

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function measure(doc: Document, rootBone = "Hips"): Record<string, Omit<ClipMeta, "loop" | "rootPolicy">> {
  const out: Record<string, Omit<ClipMeta, "loop" | "rootPolicy">> = {};
  for (const a of doc.getRoot().listAnimations()) {
    let duration = 0;
    const hips = { start: [0, 0, 0] as Vec, min: [Infinity, Infinity, Infinity] as Vec, max: [-Infinity, -Infinity, -Infinity] as Vec };
    for (const ch of a.listChannels()) {
      const s = ch.getSampler();
      const t = s?.getInput()?.getArray();
      if (t && t.length) duration = Math.max(duration, t[t.length - 1]);
      if (ch.getTargetNode()?.getName() !== rootBone || ch.getTargetPath() !== "translation") continue;
      const v = s!.getOutput()!.getArray()!;
      hips.start = [r3(v[0]), r3(v[1]), r3(v[2])];
      for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { hips.min[k] = Math.min(hips.min[k], v[i + k]); hips.max[k] = Math.max(hips.max[k], v[i + k]); }
    }
    hips.min = hips.min.map(r3) as Vec;
    hips.max = hips.max.map(r3) as Vec;
    out[a.getName()] = { duration: r3(duration), hips, ...(JUMP_CLIPS.includes(a.getName()) ? jumpTimes(doc, a.getName()) : {}) };
  }
  return out;
}

/** Clips whose takeoff / apex / land are measured from the feet (the in-place standing jump). */
const JUMP_CLIPS = ["Regular_Jump"];
const FEET = ["LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase"];

/**
 * Forward kinematics over the clip (60 Hz): takeoffAt = the last frame before the apex with the lowest
 * foot within 2 cm of its first-frame height (the feet leave the ground right after), apexAt = the
 * highest Hips, landAt = the first frame after the apex with the feet back down.
 */
function jumpTimes(doc: Document, clip: string): { takeoffAt: number; apexAt: number; landAt: number } | Record<string, never> {
  const anim = doc.getRoot().listAnimations().find(a => a.getName() === clip);
  const nodes = new Map(doc.getRoot().listNodes().map(n => [n.getName(), n]));
  if (!anim || !nodes.has("Hips") || FEET.some(f => !nodes.has(f))) return {};
  type Track = { t: ArrayLike<number>; v: ArrayLike<number> };
  const tracks = new Map<string, Track>();
  let dur = 0;
  for (const ch of anim.listChannels()) {
    const s = ch.getSampler(), n = ch.getTargetNode();
    const t = s?.getInput()?.getArray(), v = s?.getOutput()?.getArray();
    if (!t || !v || !n) continue;
    dur = Math.max(dur, t[t.length - 1]);
    tracks.set(`${n.getName()}.${ch.getTargetPath()}`, { t, v });
  }
  const sample = (tr: Track, time: number, k: number): number[] => {
    const { t, v } = tr;
    let i = 0;
    while (i < t.length - 2 && t[i + 1] < time) i++;
    const f = t.length < 2 ? 0 : Math.min(1, Math.max(0, (time - t[i]) / (t[i + 1] - t[i] || 1)));
    const a = Array.from({ length: k }, (_, j) => v[i * k + j]);
    const b = t.length < 2 ? a : Array.from({ length: k }, (_, j) => v[(i + 1) * k + j]);
    if (k === 4) { const q = new Quaternion(...a).slerp(new Quaternion(...b), f); return [q.x, q.y, q.z, q.w]; }
    return a.map((x, j) => x + (b[j] - x) * f);
  };
  type N = NonNullable<ReturnType<typeof nodes.get>>;
  const worldY = (node: N, time: number): number => {
    const m = new Matrix4();
    for (let n: N | undefined = node; n; n = n.listParents().find(p => p.propertyType === "Node") as N | undefined) {
      const nm = n.getName();
      const tr = tracks.get(`${nm}.translation`), ro = tracks.get(`${nm}.rotation`), sc = tracks.get(`${nm}.scale`);
      const local = new Matrix4().compose(
        new Vector3(...(tr ? sample(tr, time, 3) : n.getTranslation())),
        new Quaternion(...(ro ? sample(ro, time, 4) : n.getRotation())),
        new Vector3(...(sc ? sample(sc, time, 3) : n.getScale())),
      );
      m.premultiply(local);
    }
    return new Vector3().setFromMatrixPosition(m).y;
  };
  const steps = Math.round(dur * 60);
  const feet: number[] = [], hips: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const time = i / 60;
    feet.push(Math.min(...FEET.map(f => worldY(nodes.get(f)!, time))));
    hips.push(worldY(nodes.get("Hips")!, time));
  }
  const ground = feet[0] + 0.02;
  let apex = 0;
  for (let i = 1; i <= steps; i++) if (hips[i] > hips[apex]) apex = i;
  let take = apex, land = apex;
  while (take > 0 && feet[take] > ground) take--;
  while (land < steps && feet[land] > ground) land++;
  return { takeoffAt: r3(take / 60), apexAt: r3(apex / 60), landAt: r3(land / 60) };
}

// Loop / root policy per clip (spec §9 table + the clip manifest's measured suggestions).
const POLICY: Record<string, { loop: boolean; xz: "keep" | "pin"; y: "keep" | "pin" }> = {
  Idle: { loop: true, xz: "pin", y: "keep" },
  Casual_Walk: { loop: true, xz: "pin", y: "keep" },
  Run_02: { loop: true, xz: "pin", y: "keep" },
  Lean_Forward_Sprint: { loop: true, xz: "pin", y: "keep" },
  Regular_Jump: { loop: false, xz: "pin", y: "pin" },
  Run_and_Jump: { loop: false, xz: "pin", y: "pin" },
  Fall_1: { loop: true, xz: "pin", y: "pin" },
  Grab_Bar_and_Swing_Forward: { loop: false, xz: "pin", y: "keep" },
  Rope_Hang_Idle: { loop: true, xz: "pin", y: "keep" },
  Leap_of_Faith: { loop: false, xz: "pin", y: "pin" },
  Roll_Dodge: { loop: false, xz: "pin", y: "keep" },
  Big_Wave_Hello: { loop: false, xz: "pin", y: "keep" },
  Victory_Cheer: { loop: true, xz: "pin", y: "keep" },
  Falling_Down: { loop: false, xz: "pin", y: "keep" },
  Fishing_Cast: { loop: false, xz: "pin", y: "keep" },
  Waltz: { loop: false, xz: "pin", y: "keep" },
};

async function radbros(dir: string) {
  const clipsDir = path.join(dir, "game-clips");
  const manifestPath = path.join(clipsDir, "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { characters: {} };
  const meta: Record<string, { clipPack: boolean; clips: Record<string, ClipMeta> }> = {};
  const notes: string[] = [];
  for (const id of IDS) {
    const replacement = path.join(clipsDir, `radbro${id}_character.glb`);
    const delivery = path.join(dir, "delivery", `radbro${id}_animations.glb`);
    const src = fs.existsSync(replacement) ? replacement : delivery;
    const out = path.join(OUT, `radbro${id}.glb`);
    const { kept, measured: own } = await character(src, out);
    console.log(`radbro${id}.glb  ${kb(out)}  (${src === replacement ? "re-rigged replacement" : "delivery"}; clips: ${kept.join(", ")})`);
    const packSrc = path.join(clipsDir, `radbro${id}.clips.glb`);
    const packOut = path.join(OUT, `radbro${id}.clips.glb`);
    let packClips: string[] = [];
    if (fs.existsSync(packSrc)) {
      packClips = await clipPack(packSrc, packOut);
      console.log(`radbro${id}.clips.glb  ${kb(packOut)}  (${packClips.join(", ")})`);
    } else {
      if (fs.existsSync(packOut)) fs.rmSync(packOut);
      notes.push(`#${id}: no clip pack found, falling back to its owned clips only`);
    }
    // Measure: owned clips from the processed character, bought clips from the processed pack.
    const measured = { ...own, ...(packClips.length ? measure(await io.read(packOut)) : {}) };
    const man = manifest.characters?.[id]?.clips ?? {};
    const clips: Record<string, ClipMeta> = {};
    for (const [name, m] of Object.entries(measured)) {
      const pol = POLICY[name] ?? { loop: true, xz: "pin", y: "keep" };
      const c: ClipMeta = { ...m, loop: pol.loop, rootPolicy: { xz: pol.xz, y: pol.y } };
      if (man[name]?.takeoffAt !== undefined) c.takeoffAt = man[name].takeoffAt;
      if (man[name]?.landAt !== undefined) c.landAt = man[name].landAt;
      if (name === "Rope_Hang_Idle" && man[name]?.rightHandMean) c.handHeight = r3(man[name].rightHandMean[1]);
      clips[name] = c;
    }
    meta[id] = { clipPack: packClips.length > 0, clips };
  }
  fs.mkdirSync(GEN, { recursive: true });
  fs.writeFileSync(path.join(GEN, "clips.meta.json"), `${JSON.stringify(meta, null, 1)}\n`);
  console.log(`src/generated/clips.meta.json written`);
  for (const n of notes) console.log(`NOTE ${n}`);
}

async function george(dir: string) {
  const glb = path.join(dir, "delivery", "george_animations.glb");
  const json = path.join(dir, "delivery", "george_clips.json");
  if (!fs.existsSync(glb) || !fs.existsSync(json)) {
    console.log("George: no delivery/george_animations.glb + george_clips.json yet; the placeholder cat stays (src/app/george.config.ts)");
    return;
  }
  const a = path.join(tmp, "g1.glb"), b = path.join(tmp, "g2.glb"), c = path.join(tmp, "g3.glb"), d = path.join(tmp, "g4.glb");
  const out = path.join(OUT, "george.glb");
  gt("unlit", glb, a);
  gt("resize", a, b, "--width", "1024", "--height", "1024");
  gt("webp", b, c, "--quality", "90");
  gt("resample", c, d);
  gt("draco", d, out);
  fs.mkdirSync(GEN, { recursive: true });
  fs.copyFileSync(json, path.join(GEN, "george_clips.json"));
  console.log(`george.glb  ${kb(out)}  + src/generated/george_clips.json - set GEORGE_GLB in src/app/george.config.ts`);
}

/** --meta-only: jump timings from the committed web GLBs (draco decoder for the character meshes). */
async function metaOnly() {
  const file = path.join(GEN, "clips.meta.json");
  const meta = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { clipPack: boolean; clips: Record<string, ClipMeta> }>;
  // draco3dgltf ships with @gltf-transform/cli (pinned devDependency).
  const spec = "draco3dgltf"; // untyped module
  const draco = (await import(spec)) as { default: { createDecoderModule(): Promise<unknown> } };
  io.registerDependencies({ "draco3d.decoder": await draco.default.createDecoderModule() });
  for (const id of IDS) {
    for (const f of [path.join(OUT, `radbro${id}.glb`), path.join(OUT, `radbro${id}.clips.glb`)]) {
      if (!fs.existsSync(f)) continue;
      const doc = await io.read(f);
      for (const name of JUMP_CLIPS) {
        const c = meta[id]?.clips[name];
        if (!c || !doc.getRoot().listAnimations().some(a => a.getName() === name)) continue;
        Object.assign(c, jumpTimes(doc, name));
        console.log(`#${id} ${name}: takeoffAt ${c.takeoffAt} apexAt ${c.apexAt} landAt ${c.landAt}`);
      }
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(meta, null, 1)}\n`);
  console.log(`src/generated/clips.meta.json updated`);
}

if (process.argv.includes("--meta-only")) {
  await metaOnly();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
const radbroDir = arg("radbros", "RUGRUN_RADBROS");
const georgeDir = arg("george", "RUGRUN_GEORGE");
if (!radbroDir && !georgeDir) {
  console.error("usage: npm run assets -- --radbros <dir> [--george <dir>]   (or RUGRUN_RADBROS / RUGRUN_GEORGE)   |   --meta-only");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
try {
  if (radbroDir) await radbros(radbroDir);
  if (georgeDir) await george(georgeDir);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
