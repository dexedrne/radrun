// ActorsView (spec §13, §20 items 1-3): the two Radbros of the round as skinned models with their
// own AnimPlayer (the Animator core), driven from the sim through anim/animMachine.ts.
//   -5 actors pass: root transforms (feet at p - 0.9, or hanging from the hand on the rope), facing,
//      rope tilt, animMachine commands.
//   -4 animator pass: mixers (scaled by the catch slow-mo).
//   -3 bone pass (after the mixer): rope-hand correction (RightHand lands exactly on p), neck
//      look-back + the 0.3 s head-turn tell, the Yoink arm raise.
// Only the two Radbros of the round are mounted (keyed by id); both are already loaded by LOADING.
import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useAssetRuntime } from "react-three-game";
import { Group, Matrix4, Quaternion, Vector3, type AnimationClip, type Bone, type Material, type Mesh, type Object3D } from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { PlayGame } from "../game/play.ts";
import { RESULTS_AFTER } from "../game/play.ts";
import type { RadbroId } from "../game/round.ts";
import { EV_ATTACH, EV_BONK, EV_DJUMP, EV_JUMP, EV_LAND, EV_RELEASE, EV_ZIP, EV_ZIP_END, RING_RUNNER } from "../sim/player.ts";
import { RM_EDGE, RM_TAUNT } from "../runner/runner.ts";
import { PHASE_AIR, PHASE_GROUND, PHASE_ROPE } from "../route/trackPack.ts";
import { A_ATTACH, A_BONK, A_DJUMP, A_JUMP, A_LAND, A_RELEASE, AnimMachine, CLIP, type AnimCmd, type Beat } from "../anim/animMachine.ts";
import { AnimPlayer } from "./animPlayer.ts";
import { CLIP_META, clipsPath, handHeight, modelPath } from "./characters.ts";
import { useUi } from "../ui/store.ts";
import { FRAME } from "./frame.ts";

const UP = new Vector3(0, 1, 0);

export type ActorRig = {
  id: RadbroId;
  root: Group;
  model: Object3D;
  player: AnimPlayer;
  machine: AnimMachine;
  bones: { hips?: Bone; neck?: Bone; head?: Bone; leftHand?: Bone; rightHand?: Bone; rightArm?: Bone };
  materials: Material[];
  hand: number;
  // per-frame view state
  yaw: number;
  off: Vector3;
  ropeW: number;
  look: number;
  arm: number;
  prevPhase: number;
  prevP: Vector3;
  vel: Vector3;
  fade: number;
  /** World point the body point p maps to this frame (for the rope-hand correction). */
  p: Vector3;
  hook: number;
};

/** Mounted rigs by Radbro id (read by the FX pass for hands, bag, rope and lasso). */
export const rigs = new Map<RadbroId, ActorRig>();

function findBone(root: Object3D, name: string): Bone | undefined {
  let out: Bone | undefined;
  root.traverse(o => { if (!out && o.name === name) out = o as Bone; });
  return out;
}

export function makeRig(id: RadbroId, src: Object3D, pack: Object3D | null): ActorRig {
  const model = cloneSkeleton(src);
  const materials: Material[] = [];
  model.traverse(o => {
    const m = o as Mesh;
    o.frustumCulled = false;
    if (m.isMesh) {
      // Per-instance materials (clones share them) so the chaser can fade when the camera is close.
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material).clone();
      m.material = mat;
      materials.push(mat);
    }
  });
  const root = new Group();
  root.name = `radbro-${id}`;
  root.add(model);
  const meta = CLIP_META[id]?.clips ?? {};
  const ref = meta.Idle?.hips.start;
  const own = ((src as unknown as { animations?: AnimationClip[] }).animations ?? []) as AnimationClip[];
  const lib = ((pack as unknown as { animations?: AnimationClip[] } | null)?.animations ?? []) as AnimationClip[];
  // CLIP.land = Regular_Jump again with the hips' height kept (the landing crouch plants the feet).
  const player = new AnimPlayer(model, [own, lib], {
    policy: name => (name === CLIP.land ? { xz: "pin", y: "keep" } : meta[name]?.rootPolicy), reference: ref, fade: 0.2,
    alias: { [CLIP.land]: CLIP.jump },
  });
  const jump = meta[CLIP.jump];
  const machine = new AnimMachine({
    has: n => player.has(n),
    takeoffAt: n => meta[n]?.takeoffAt ?? 0,
    apexAt: n => meta[n]?.apexAt ?? (jump?.duration ?? 1.875) * 0.43,
    landAt: n => meta[n]?.landAt ?? (jump?.duration ?? 1.875) * 0.6,
  });
  return {
    id, root, model, player, machine, materials, hand: handHeight(id),
    bones: {
      hips: findBone(model, "Hips"), neck: findBone(model, "neck"), head: findBone(model, "Head"),
      leftHand: findBone(model, "LeftHand"), rightHand: findBone(model, "RightHand"), rightArm: findBone(model, "RightArm"),
    },
    yaw: 0, off: new Vector3(0, -0.9, 0), ropeW: 0, look: 0, arm: 0, prevPhase: PHASE_GROUND, prevP: new Vector3(), vel: new Vector3(),
    fade: 1, p: new Vector3(), hook: -1,
  };
}

export function applyCmd(pl: AnimPlayer, c: AnimCmd | null): void {
  if (!c) return;
  if (c.kind === "shot") pl.play(c.clip, { once: !c.hold, hold: c.hold, startAt: c.startAt, fade: c.fade, then: c.then, freezeAt: c.freezeAt, timeScale: c.rate });
  else if (c.kind === "force") pl.force(c.clip, c.fade, c.scale);
  else { pl.setBase(c.clip, c.fade, c.scale); pl.setTimeScale(c.scale); }
}

/** World position of a hand bone (falls back to the body point). */
export function handWorld(id: RadbroId, which: "left" | "right", out: Vector3): Vector3 | null {
  const r = rigs.get(id);
  const b = which === "left" ? r?.bones.leftHand : r?.bones.rightHand;
  if (!r || !b || !r.root.visible) return null;
  return b.getWorldPosition(out);
}

function Radbro({ id }: { id: RadbroId }) {
  const assets = useAssetRuntime();
  const rig = useMemo(() => {
    const src = assets.getModel(modelPath(id));
    if (!src) return null;
    return makeRig(id, src, assets.getModel(clipsPath(id)));
  }, [assets, id]);
  useEffect(() => {
    if (!rig) return;
    rigs.set(id, rig);
    rig.root.visible = false;
    return () => {
      rigs.delete(id);
      rig.player.dispose();
      for (const m of rig.materials) m.dispose();
    };
  }, [id, rig]);
  return rig ? <primitive object={rig.root} /> : null;
}

const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function ActorsView({ game }: { game: PlayGame }) {
  const pair = useUi(s => s.pair);
  const tmp = useMemo(() => ({
    q: new Quaternion(), qYaw: new Quaternion(), qTilt: new Quaternion(), m: new Matrix4(),
    u: new Vector3(), f: new Vector3(), x: new Vector3(), v: new Vector3(), a: new Vector3(), b: new Vector3(),
    pq: new Quaternion(), wq: new Quaternion(), axis: new Vector3(), fwd: new Vector3(),
  }), []);

  // -5: roots, facing, rope tilt, animMachine.
  useFrame((_, rawDelta) => {
    const delta = rawDelta * game.timeScale;
    const s = game.setup;
    const r = game.round;
    const inRound = game.mode === "round";
    const waltzW = inRound && r.phase === "caught" ? smooth((game.endT - RESULTS_AFTER.caught) / 0.5) : 0;
    for (const rig of rigs.values()) {
      const isChaser = inRound && rig.id === s.chaser, isRunner = inRound && !game.practice && rig.id === s.runner;
      rig.root.visible = isChaser || isRunner;
      if (!rig.root.visible) continue;
      const p = isChaser ? game.renderP : game.runnerP;
      const other = isChaser ? game.runnerP : game.renderP;
      rig.p.set(p.x, p.y, p.z);
      // Render-space velocity (runner) / sim velocity (chaser).
      if (rawDelta > 0) rig.vel.set((p.x - rig.prevP.x) / rawDelta, (p.y - rig.prevP.y) / rawDelta, (p.z - rig.prevP.z) / rawDelta);
      rig.prevP.set(p.x, p.y, p.z);
      const b = r.player, run = r.runner;
      const vx = isChaser ? b.v.x : game.runnerVel.x, vz = isChaser ? b.v.z : game.runnerVel.z;
      const vy = isChaser ? b.v.y : rig.vel.y;
      const speed = Math.sqrt(vx * vx + vz * vz);

      // Rope hook this frame (a web zip hangs from its anchor the same way).
      let hook = -1;
      let zip = false;
      if (!r.over) {
        if (isChaser && b.ropeHook >= 0) hook = b.ropeHook;
        if (isChaser && b.zipOn) zip = true;
        if (isRunner && run.pose.phase === PHASE_ROPE) hook = run.pose.ref;
      }
      rig.hook = hook;

      // Events -> animMachine bits.
      let ev = 0;
      let grounded: boolean;
      if (isChaser) {
        const fe = game.frameEvents;
        if (fe & EV_JUMP) ev |= A_JUMP;
        if (fe & EV_DJUMP) ev |= A_DJUMP;
        if (fe & (EV_ATTACH | EV_ZIP)) ev |= A_ATTACH;
        if (fe & (EV_RELEASE | EV_ZIP_END)) ev |= A_RELEASE;
        if (fe & EV_LAND) ev |= A_LAND;
        if (fe & EV_BONK) ev |= A_BONK;
        grounded = b.grounded;
      } else {
        const ph = r.over ? PHASE_GROUND : run.pose.phase;
        const was = rig.prevPhase;
        if (ph !== was) {
          if (was === PHASE_GROUND && ph === PHASE_AIR) ev |= A_JUMP;
          if (ph === PHASE_ROPE) ev |= A_ATTACH;
          if (was === PHASE_ROPE && ph === PHASE_AIR) ev |= A_RELEASE;
          if (ph === PHASE_GROUND) ev |= A_LAND;
        }
        rig.prevPhase = ph;
        grounded = ph === PHASE_GROUND;
      }

      // Beats.
      let beat: Beat = "";
      if (r.phase === "countdown") beat = isRunner ? "wave" : "idle";
      else if (r.phase === "caught") beat = waltzW > 0 ? "waltz" : isChaser ? "cheer" : "flop";
      else if (r.phase === "escaped") beat = isRunner ? "rug" : "fish";
      else if (isRunner && run.mode === RM_TAUNT) beat = "taunt";
      applyCmd(rig.player, rig.machine.step({
        dt: delta, grounded: grounded || beat === "idle", rope: hook >= 0 || zip, speed: run.mode !== RM_EDGE && isRunner ? 0 : speed, vy, events: ev,
        landVy: isChaser ? b.landVy : 0, panic: isRunner && run.band.panic && !run.band.gassed, beat,
      }));

      // Facing (slerp 12 rad/s toward velocity; scripted beats face the other one).
      const faceTo = (x: number, z: number, rate: number) => {
        if (x * x + z * z < 1e-4) return;
        const want = Math.atan2(x, z);
        rig.yaw += wrap(want - rig.yaw) * Math.min(1, rate * rawDelta);
      };
      if (r.phase === "countdown") faceTo(other.x - p.x, other.z - p.z, 30);
      else if (r.phase === "caught" || (r.phase === "escaped" && isChaser)) faceTo(other.x - p.x, other.z - p.z, 5);
      else if (isRunner && run.mode !== RM_EDGE) { if (run.headX || run.headZ) faceTo(run.headX, run.headZ, 3); }
      else if (speed > 0.5) faceTo(vx, vz, 12);

      // Root placement: feet at p - 0.9; on the rope the body hangs from RightHand at p (errata 1).
      tmp.qYaw.setFromAxisAngle(UP, rig.yaw);
      let tx = 0, ty = -0.9, tz = 0;
      const anchor = hook >= 0 ? game.model.hooks[hook] : zip ? b.zipP : null;
      if (anchor) {
        const h = anchor;
        tmp.u.set(h.x - p.x, h.y - p.y, h.z - p.z).normalize();
        // Facing = swing tangent (velocity minus its rope component), else the current yaw.
        tmp.v.set(vx, vy, vz);
        tmp.f.copy(tmp.v).addScaledVector(tmp.u, -tmp.v.dot(tmp.u));
        if (tmp.f.lengthSq() < 0.5) {
          tmp.f.set(Math.sin(rig.yaw), 0, Math.cos(rig.yaw));
          tmp.f.addScaledVector(tmp.u, -tmp.f.dot(tmp.u));
        }
        tmp.f.normalize();
        tmp.x.crossVectors(tmp.u, tmp.f).normalize();
        tmp.f.crossVectors(tmp.x, tmp.u);
        tmp.m.makeBasis(tmp.x, tmp.u, tmp.f);
        tmp.q.setFromRotationMatrix(tmp.m);
        faceTo(tmp.f.x, tmp.f.z, 12);
        tx = -rig.hand * tmp.u.x; ty = -rig.hand * tmp.u.y; tz = -rig.hand * tmp.u.z;
      } else tmp.q.copy(tmp.qYaw);
      rig.ropeW += ((anchor ? 1 : 0) - rig.ropeW) * Math.min(1, (anchor ? 6 : 10) * rawDelta);
      const k = Math.min(1, 14 * rawDelta);
      rig.off.x += (tx - rig.off.x) * k; rig.off.y += (ty - rig.off.y) * k; rig.off.z += (tz - rig.off.z) * k;
      let px = p.x + rig.off.x, py = p.y + rig.off.y, pz = p.z + rig.off.z;
      // Results after a catch: face to face for the waltz.
      if (waltzW > 0) {
        let dx = other.x - p.x, dz = other.z - p.z;
        const dl = Math.sqrt(dx * dx + dz * dz) || 1;
        dx /= dl; dz /= dl;
        const mx = (p.x + other.x) / 2, mz = (p.z + other.z) / 2;
        const gy = game.renderP.y - 0.9;
        px += (mx - dx * 0.45 - px) * waltzW;
        pz += (mz - dz * 0.45 - pz) * waltzW;
        py += (gy - py) * waltzW;
      }
      rig.root.position.set(px, py, pz);
      rig.root.quaternion.slerp(tmp.q, Math.min(1, 14 * rawDelta));
      // Camera closer than 2 m: the local Radbro fades to 40% (spec §8).
      if (isChaser) {
        const want = r.phase === "chase" && game.rig.armUsed < 2 ? 0.4 : 1;
        if (want !== rig.fade) {
          rig.fade = want;
          for (const m of rig.materials) { m.transparent = want < 1; m.opacity = want; m.needsUpdate = true; }
        }
      }
    }
  }, FRAME.actors);

  // -4: mixers (slowed during the catch slow-mo).
  useFrame((_, delta) => {
    for (const rig of rigs.values()) if (rig.root.visible) rig.player.update(delta * game.timeScale);
  }, FRAME.animator);

  // -3: bone pass.
  useFrame((_, rawDelta) => {
    const s = game.setup, r = game.round;
    for (const rig of rigs.values()) {
      if (!rig.root.visible) continue;
      const isRunner = rig.id === s.runner;
      // Rope-hand correction: shift the root so RightHand sits on p (weighted while the rope blends in).
      const rh = rig.bones.rightHand;
      if (rh && rig.ropeW > 0.01) {
        rig.root.updateMatrixWorld(true);
        rh.getWorldPosition(tmp.a);
        tmp.b.copy(rig.p).sub(tmp.a).multiplyScalar(rig.ropeW);
        rig.root.position.add(tmp.b);
      }
      // Neck look-back / head-turn tell (runner).
      if (isRunner) {
        const run = r.runner;
        const p = game.runnerP;
        let want = 0;
        if (r.phase === "chase" || r.phase === "countdown") {
          if (run.headX !== 0 || run.headZ !== 0) want = wrap(Math.atan2(run.headX, run.headZ) - rig.yaw);
          else if (run.lookAt || r.phase === "countdown") want = wrap(Math.atan2(game.renderP.x - p.x, game.renderP.z - p.z) - rig.yaw);
        }
        want = Math.max(-1.3, Math.min(1.3, want));
        rig.look += (want - rig.look) * Math.min(1, 16 * rawDelta);
        if (Math.abs(rig.look) > 1e-3) {
          rotateBoneWorld(rig.bones.neck, UP, rig.look * 0.45, tmp);
          rotateBoneWorld(rig.bones.head, UP, rig.look * 0.55, tmp);
        }
      } else {
        // Yoink arm raise (chaser): half-raised while he is ringed red, full on the lasso throw.
        const yoinked = r.phase === "caught" && r.stats.catchKind === "yoink" && game.endT < 0.9;
        const want = yoinked ? 1 : r.phase === "chase" && r.player.ringId === RING_RUNNER ? 0.45 : 0;
        rig.arm += (want - rig.arm) * Math.min(1, 10 * rawDelta);
        if (rig.arm > 0.01) {
          tmp.fwd.set(Math.sin(rig.yaw), 0, Math.cos(rig.yaw));
          rotateBoneWorld(rig.bones.rightArm, tmp.fwd, -1.9 * rig.arm, tmp);
        }
      }
    }
  }, FRAME.bones);

  return <>{pair && [pair.chaser, pair.runner].map(id => <Radbro key={id} id={id} />)}</>;
}

/** Rotate a bone about a world-space axis through its pivot (after the mixer wrote its pose). */
function rotateBoneWorld(bone: Bone | undefined, axisWorld: Vector3, angle: number, tmp: { pq: Quaternion; wq: Quaternion; axis: Vector3 }): void {
  if (!bone || !bone.parent) return;
  bone.parent.getWorldQuaternion(tmp.pq);
  // L' = P^-1 * Q * P * L
  tmp.axis.copy(axisWorld).applyQuaternion(tmp.wq.copy(tmp.pq).invert()).normalize();
  tmp.wq.setFromAxisAngle(tmp.axis, angle);
  bone.quaternion.premultiply(tmp.wq);
  bone.updateMatrixWorld(true);
}
