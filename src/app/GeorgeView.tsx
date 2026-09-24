// GeorgeView (spec §10, errata 3 + 10): George's interpolated follow-model output -> his node (-5), plus
// his animation. With GEORGE_GLB set (src/app/george.config.ts) the delivered George plays his clips by
// name through an AnimPlayer (root bone pinned per george_clips.json); with it empty he falls back to a
// small procedural black low-poly cat animated by the same clip names.
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useAssetRuntime } from "react-three-game";
import {
  BoxGeometry, ConeGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, MeshBasicMaterial, Quaternion, Vector3,
  type AnimationClip, type Object3D,
} from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { PlayGame } from "../game/play.ts";
import { AnimPlayer } from "./animPlayer.ts";
import { GEORGE_GLB, GEORGE_JUMP, GEORGE_RENDER, GEORGE_ROOT_BONE } from "./george.config.ts";
import type { RootPolicy } from "./animPlayer.ts";
import { FRAME } from "./frame.ts";
import { lowQuality } from "./quality.tsx";
import { loadProgress } from "../game/campaign.ts";
import { headRestInverse, makeHats, placeHats } from "./hats.ts";

const UP = new Vector3(0, 1, 0);

type Cat = { root: Group; body: Group; head: Group; tail: Group; legs: Mesh[]; ears: Mesh[] };

/** ~150-tri black cat, shoulder height ~0.36 m. */
function makeCat(): Cat {
  const black = new MeshBasicMaterial({ color: "#16161c" });
  const dark = new MeshBasicMaterial({ color: "#2a2a34" });
  const eye = new MeshBasicMaterial({ color: "#c8e84a" });
  const pink = new MeshBasicMaterial({ color: "#e89aa8" });
  const root = new Group();
  const body = new Group();
  body.position.y = 0.3;
  root.add(body);
  const torso = new Mesh(new IcosahedronGeometry(0.17, 1), black);
  torso.scale.set(0.95, 0.85, 1.55);
  body.add(torso);
  const head = new Group();
  head.position.set(0, 0.13, 0.27);
  body.add(head);
  const skull = new Mesh(new IcosahedronGeometry(0.12, 1), black);
  skull.scale.set(1.05, 0.92, 0.95);
  head.add(skull);
  const ears: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const ear = new Mesh(new ConeGeometry(0.045, 0.1, 4), black);
    ear.position.set(0.065 * sx, 0.11, -0.01);
    ear.rotation.z = -0.25 * sx;
    head.add(ear);
    ears.push(ear);
    const e = new Mesh(new IcosahedronGeometry(0.022, 0), eye);
    e.position.set(0.045 * sx, 0.02, 0.1);
    head.add(e);
  }
  const nose = new Mesh(new IcosahedronGeometry(0.012, 0), pink);
  nose.position.set(0, -0.015, 0.117);
  head.add(nose);
  const tail = new Group();
  tail.position.set(0, 0.05, -0.24);
  body.add(tail);
  const t = new Mesh(new CylinderGeometry(0.018, 0.028, 0.34, 5), dark);
  t.position.y = 0.17;
  tail.add(t);
  tail.rotation.x = -0.6;
  const legs: Mesh[] = [];
  const legGeo = new BoxGeometry(0.05, 0.24, 0.05);
  legGeo.translate(0, -0.12, 0);
  for (const [x, z] of [[-0.08, 0.16], [0.08, 0.16], [-0.08, -0.16], [0.08, -0.16]]) {
    const leg = new Mesh(legGeo, black);
    leg.position.set(x, -0.04, z);
    body.add(leg);
    legs.push(leg);
  }
  root.traverse(o => (o.frustumCulled = false));
  return { root, body, head, tail, legs, ears };
}

/** Procedural gaits for the placeholder by clip name. */
function poseCat(c: Cat, clip: string, t: number, rate: number, speed: number): void {
  const b = c.body, L = c.legs;
  b.rotation.set(0, 0, 0);
  b.position.set(0, 0.3, 0);
  c.head.rotation.set(0, 0, 0);
  c.tail.rotation.set(-0.6 + 0.25 * Math.sin(t * 2.2), 0.3 * Math.sin(t * 1.3), 0);
  for (const e of c.ears) e.rotation.x = 0;
  for (const l of L) l.rotation.set(0, 0, 0);
  const gait = (freq: number, amp: number, bob: number) => {
    const ph = t * freq;
    L[0].rotation.x = Math.sin(ph) * amp;
    L[3].rotation.x = Math.sin(ph) * amp;
    L[1].rotation.x = -Math.sin(ph) * amp;
    L[2].rotation.x = -Math.sin(ph) * amp;
    b.position.y = 0.3 + Math.abs(Math.sin(ph)) * bob;
    c.tail.rotation.x = -0.9 + 0.2 * Math.sin(ph * 0.5);
  };
  switch (clip) {
    case "Sit_Idle":
    case "Sulk":
      b.rotation.x = -0.55;
      b.position.set(0, 0.24, -0.06);
      L[0].rotation.x = 0.55; L[1].rotation.x = 0.55;
      L[2].rotation.x = -1.0; L[3].rotation.x = -1.0;
      c.tail.rotation.set(1.2, 0.8, 0);
      if (clip === "Sulk") { c.head.rotation.x = 0.55; for (const e of c.ears) e.rotation.x = -0.7; }
      else c.head.rotation.set(0.45 + 0.05 * Math.sin(t * 1.1), 0.25 * Math.sin(t * 0.4), 0);
      break;
    case "Walk": gait(7 * rate, 0.35, 0.01); break;
    case "Trot": gait(11 * rate, 0.55, 0.025); break;
    case "Run": gait(15 * rate, 0.9, 0.05); b.rotation.x = 0.05 * Math.sin(t * 15 * rate); break;
    case "Jump":
    case "Leap_Air":
      b.rotation.x = clip === "Jump" ? -0.35 : 0.1;
      L[0].rotation.x = -1.1; L[1].rotation.x = -1.1; L[2].rotation.x = 1.0; L[3].rotation.x = 1.0;
      c.tail.rotation.x = -1.4;
      break;
    case "Land":
      b.position.y = 0.24;
      L[0].rotation.x = 0.4; L[1].rotation.x = 0.4; L[2].rotation.x = -0.4; L[3].rotation.x = -0.4;
      break;
    case "Happy":
      b.position.y = 0.3 + Math.abs(Math.sin(t * 9)) * 0.18;
      c.tail.rotation.set(-0.1, 0.4 * Math.sin(t * 12), 0);
      c.head.rotation.x = -0.25;
      break;
    default: // Idle
      c.head.rotation.y = 0.35 * Math.sin(t * 0.7);
      void speed;
  }
}

/** The delivered George (GEORGE_GLB): clone + AnimPlayer; clips named like GeorgeClip. */
function useGeorgeGlb(): { root: Object3D; player: AnimPlayer } | null {
  const assets = useAssetRuntime();
  const g = useMemo(() => {
    if (!GEORGE_GLB) return null;
    const src = assets.getModel(GEORGE_GLB);
    if (!src) return null;
    const root = cloneSkeleton(src);
    root.traverse(o => (o.frustumCulled = false));
    const clips = ((src as unknown as { animations?: AnimationClip[] }).animations ?? []) as AnimationClip[];
    // george_clips.json rootPolicy: xz pinned everywhere (no clip moves it); Jump's airborne arc is
    // pinned too because the follow model flies him along your path.
    const policy = (name: string): RootPolicy => (name === "Jump" ? { xz: "pin", y: "pin" } : { xz: "pin", y: "keep" });
    return { root, player: new AnimPlayer(root, [clips], { fade: 0.15, rootBone: GEORGE_ROOT_BONE, policy }) };
  }, [assets]);
  useEffect(() => () => g?.player.dispose(), [g]);
  return g;
}

/** Clips he stands in; entering Sit_Idle from one of these plays the Sit transition first. */
const STANDING = new Set(["Idle", "Walk", "Trot", "Run", "Land", "Happy"]);

export function GeorgeView({ game }: { game: PlayGame }) {
  const cat = useMemo(makeCat, []);
  const hats = useMemo(makeHats, []);
  const glb = useGeorgeGlb();
  const headBone = useMemo(() => glb?.root.getObjectByName("head") ?? null, [glb]);
  // Bind-pose head rotations (measured before any clip plays) so the hat follows the head's motion.
  const glbRest = useMemo(() => (glb && headBone ? headRestInverse(glb.root, headBone) : null), [glb, headBone]);
  const catRest = useMemo(() => headRestInverse(cat.root, cat.head), [cat]);
  const shadow = useRef<Mesh>(null);
  const tmp = useMemo(() => ({ q: new Quaternion(), yaw: 0, t: 0, clip: "", wasOn: false, hat: "none" }), []);
  useFrame((state, rawDelta) => {
    const g = game.george;
    const on = game.mode === "round";
    const node = glb ? glb.root : cat.root;
    node.visible = on;
    if (shadow.current) shadow.current.visible = on && !lowQuality();
    // The campaign hat: read once per round start (the campaign screen may have changed it).
    if (on && !tmp.wasOn) {
      tmp.hat = loadProgress().hat;
      for (const h of hats.children) h.visible = h.name === tmp.hat;
    }
    tmp.wasOn = on;
    hats.visible = false;
    if (!on) return;
    const delta = rawDelta * game.timeScale;
    tmp.t += delta;
    const a = game.round.over ? 1 : game.stepper.alpha;
    const x = g.px + (g.x - g.px) * a, y = g.py + (g.y - g.py) * a, z = g.pz + (g.z - g.pz) * a;
    node.position.set(x, y, z);
    // Facing: his motion, or you while sitting / at the end.
    let fx = g.fx, fz = g.fz;
    if (g.sitting || game.round.over) { fx = game.renderP.x - x; fz = game.renderP.z - z; }
    if (fx * fx + fz * fz > 1e-6) {
      const want = Math.atan2(fx, fz);
      let d = want - tmp.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      tmp.yaw += d * Math.min(1, 10 * rawDelta);
    }
    node.quaternion.setFromAxisAngle(UP, tmp.yaw);
    // Mid-swing he leaps along your arc ~0.5 s behind you, i.e. right past the camera: hide him there.
    const c = state.camera.position;
    const cd = (c.x - x) * (c.x - x) + (c.y - y - 0.3) * (c.y - y - 0.3) + (c.z - z) * (c.z - z);
    node.visible = cd > 3.2 * 3.2;
    node.scale.setScalar(GEORGE_RENDER.scale);
    if (glb) {
      if (g.clip !== tmp.clip) {
        const from = tmp.clip;
        tmp.clip = g.clip;
        const p = glb.player;
        if (g.clip === "Jump") p.play("Jump", { hold: true, fade: 0.06, startAt: GEORGE_JUMP.startAt });
        else if (g.clip === "Land" || g.clip === "Happy") p.play(g.clip, { hold: true, fade: 0.08 });
        else if (g.clip === "Sit_Idle" && STANDING.has(from)) { p.base = "Sit_Idle"; p.play("Sit", { once: true, then: "Sit_Idle", fade: 0.15 }); }
        else p.force(g.clip, g.clip === "Leap_Air" ? 0.1 : 0.15, g.rate);
      } else glb.player.setTimeScale(g.rate);
      glb.player.update(delta);
    } else poseCat(cat, g.clip, tmp.t, g.rate, g.speed);
    if (tmp.hat !== "none" && node.visible) {
      const head = glb ? headBone : cat.head;
      const rest = glb ? glbRest : catRest;
      if (head && rest) {
        node.updateMatrixWorld(true);
        placeHats(hats, head, rest, GEORGE_RENDER.scale);
        hats.visible = true;
      }
    }
    const sh = shadow.current;
    if (sh) {
      const gy = game.index.groundBelow(x, z, y + 0.05);
      sh.position.set(x, gy + 0.03, z);
    }
  }, FRAME.actors);
  return (
    <>
      {glb ? <primitive object={glb.root} /> : <primitive object={cat.root} />}
      <primitive object={hats} />
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <circleGeometry args={[0.3, 14]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.28} depthWrite={false} />
      </mesh>
    </>
  );
}
