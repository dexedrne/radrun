// ActorsView (spec §13, §20 items 1-3): the two Radbros of the round as skinned models with their
// own AnimPlayer (the Animator core), driven from the sim through anim/animMachine.ts.
//   -5 actors pass: root transforms (feet at p - 0.9, or hanging from the hand on the rope / a ledge), facing,
//      rope tilt, round 9 procedural poses (wall run rolled toward the wall, run-up and slide pitched back,
//      ledge hang facing the wall), animMachine commands.
//   -4 animator pass: mixers (scaled by the catch slow-mo).
//   -3 bone pass (after the mixer): hand correction (RightHand lands exactly on p on the rope, on the rim on
//      a ledge), the one-arm swing (LeftArm swept back, hips pitched with the swing), neck look-back + the
//      0.3 s head-turn tell, the Yoink arm raise.
// Only the two Radbros of the round are mounted (keyed by id); both are already loaded by LOADING.
import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useAssetRuntime } from "react-three-game";
import { Euler, Group, Matrix4, Quaternion, Vector3, type AnimationClip, type Bone, type Material, type Mesh, type Object3D } from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { PlayGame } from "../game/play.ts";
import { RESULTS_AFTER } from "../game/play.ts";
import type { RadbroId } from "../game/round.ts";
import {
  EV_ATTACH, EV_BIGLAND, EV_BONK, EV_CLIMB, EV_DJUMP, EV_JUMP, EV_LAND, EV_LEDGE, EV_RELEASE, EV_ROLL, EV_SLIDE, EV_VAULT, EV_WALLJUMP,
  EV_WALLRUN, EV_ZIP, EV_ZIP_END, LEDGE_HANG, RING_RUNNER, EV_CHARGE, EV_CHARGE_START, EV_DIVE, EV_POP, EV_YANK, EV_REBOUND, EV_PERFECT,
  hangPoint,
} from "../sim/player.ts";
import { RM_EDGE, RM_TAUNT } from "../runner/runner.ts";
import { EVT_CHARGE, EVT_LEAP, EVT_ROLL, EVT_VAULT, PHASE_AIR, PHASE_GROUND, PHASE_LEDGE, PHASE_ROPE, PHASE_WALL, PHASE_ZIP, eventsBetween } from "../route/trackPack.ts";
import {
  A_ATTACH, A_BIGLAND, A_BONK, A_CLIMB, A_DJUMP, A_JUMP, A_LAND, A_LEDGE, A_RELEASE, A_ROLL, A_SLIDE, A_VAULT, A_WALLJUMP, A_WALLRUN,
  A_ZIP, A_CHARGE, A_LEAP, A_POP, A_DIVE,
  AnimMachine, CLIP, type AnimCmd, type Beat,
} from "../anim/animMachine.ts";
import type { Solid } from "../world/cityModel.ts";
import { AnimPlayer } from "./animPlayer.ts";
import { CLIP_META, clipsPath, handHeight, modelPath } from "./characters.ts";
import { useUi } from "../ui/store.ts";
import { FRAME } from "./frame.ts";
import { airBones, airInput, newAirPose, placeRoot, placeWings, poseBones, stepAirPose, wingMesh, type AirPose, type AirPoseIn, type PoseBones } from "./airPose.ts";
import { RADBRO_COLOR } from "../ui/strings.ts";

const UP = new Vector3(0, 1, 0);

export type ActorRig = {
  id: RadbroId;
  root: Group;
  model: Object3D;
  player: AnimPlayer;
  machine: AnimMachine;
  bones: { hips?: Bone; neck?: Bone; head?: Bone; leftHand?: Bone; rightHand?: Bone; rightArm?: Bone; leftArm?: Bone };
  materials: Material[];
  /** Rope hand height above the body point (m). */
  hand_: number;
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
  /** World point the body point p maps to this frame, and where the RightHand goes (rope: p; ledge: the rim). */
  p: Vector3;
  hand: Vector3;
  /** 1 while hanging from a web anchor or a ledge, else -1. */
  hook: number;
  /** Round 12: zipping (arm up along the web), his baked charge between EVT_CHARGE and EVT_LEAP, the charge ring on. */
  zip: boolean;
  charging: boolean;
  chargeOn: boolean;
  /** Round 9 procedural pose: smoothed roll (wall run) and pitch (run-up / slide), rad; swing hips pitch. */
  roll: number;
  pitch: number;
  hipPitch: number;
  /** Runner: seconds in the current pack phase and the track time last frame (pack events). */
  phaseT: number;
  prevT: number;
  /** The web-slinger air poses (airPose.ts): weights / flip clock, the limb bones, the eased root orientation under the flip. */
  air: AirPose;
  pose: PoseBones;
  wing: ReturnType<typeof wingMesh>;
  qBase: Quaternion;
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
  const wing = wingMesh(RADBRO_COLOR[id].body);
  root.add(wing);
  materials.push(wing.material);
  const meta = CLIP_META[id]?.clips ?? {};
  const ref = meta.Idle?.hips.start;
  const own = ((src as unknown as { animations?: AnimationClip[] }).animations ?? []) as AnimationClip[];
  const lib = ((pack as unknown as { animations?: AnimationClip[] } | null)?.animations ?? []) as AnimationClip[];
  // CLIP.land = Regular_Jump again with the hips' height kept (the landing crouch plants the feet).
  const stride = STRIDE[id];
  const player = new AnimPlayer(model, [own, lib], {
    policy: name => (name === CLIP.land ? { xz: "pin", y: "keep" } : meta[name]?.rootPolicy), reference: ref, fade: 0.2,
    alias: { [CLIP.land]: CLIP.jump },
    ...(stride ? { rate: (name: string) => 1 / (stride[name] ?? 1) } : {}),
  });
  const jump = meta[CLIP.jump];
  const machine = new AnimMachine({
    has: n => player.has(n),
    takeoffAt: n => meta[n]?.takeoffAt ?? 0,
    apexAt: n => meta[n]?.apexAt ?? (jump?.duration ?? 1.875) * 0.43,
    landAt: n => meta[n]?.landAt ?? (jump?.duration ?? 1.875) * 0.6,
    at: (n, key) => { const v = (meta[n] as Record<string, unknown> | undefined)?.[key]; return typeof v === "number" ? v : undefined; },
  });
  return {
    id, root, model, player, machine, materials, hand_: handHeight(id),
    bones: {
      hips: findBone(model, "Hips"), neck: findBone(model, "neck"), head: findBone(model, "Head"),
      leftHand: findBone(model, "LeftHand"), rightHand: findBone(model, "RightHand"), rightArm: findBone(model, "RightArm"),
      leftArm: findBone(model, "LeftArm"),
    },
    yaw: 0, off: new Vector3(0, -0.9, 0), ropeW: 0, look: 0, arm: 0, prevPhase: PHASE_GROUND, prevP: new Vector3(), vel: new Vector3(),
    fade: 1, p: new Vector3(), hand: new Vector3(), hook: -1, zip: false, charging: false, chargeOn: false, roll: 0, pitch: 0, hipPitch: 0, phaseT: 0, prevT: 0,
    air: newAirPose(), pose: poseBones(model), wing, qBase: new Quaternion(),
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
      rig.wing.geometry.dispose();
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

/** Round 9 procedural pose angles (spec §7 fallbacks). */
const POSE = { wallRoll: 0.61, runUpPitch: -1.05, slidePitch: -0.35, swingHips: 0.35, leftArmBack: 0.61, ropeFace: 6 } as const;

/** Outward normal of the side face of `s` nearest the point (x, z) (the runner's wall / ledge). */
function nearestFace(s: Solid, x: number, z: number, out: { x: number; z: number }): void {
  const d0 = Math.abs(x - s.x0), d1 = Math.abs(x - s.x1), d2 = Math.abs(z - s.z0), d3 = Math.abs(z - s.z1);
  const m = Math.min(d0, d1, d2, d3);
  out.x = m === d0 ? -1 : m === d1 ? 1 : 0;
  out.z = m === d0 || m === d1 ? 0 : m === d2 ? -1 : 1;
}

export function ActorsView({ game }: { game: PlayGame }) {
  const pair = useUi(s => s.pair);
  const tmp = useMemo(() => ({
    q: new Quaternion(), qYaw: new Quaternion(), qTilt: new Quaternion(), m: new Matrix4(),
    u: new Vector3(), f: new Vector3(), x: new Vector3(), v: new Vector3(), a: new Vector3(), b: new Vector3(),
    pq: new Quaternion(), wq: new Quaternion(), axis: new Vector3(), fwd: new Vector3(),
    anchor: new Vector3(), n: { x: 0, z: 0 }, qPose: new Quaternion(), e: new Vector3(), eu: new Euler(), pos: new Vector3(),
    ain: { dt: 0, dive: false, fall: false, glide: false, hanging: false, arc: 0, perfect: false, near: false } as AirPoseIn,
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

      // Web anchor this frame (a web zip hangs from its target the same way): the chaser's rope, his pack anchor.
      let anchor: Vector3 | null = null;
      let zip = false;
      if (!r.over) {
        // (a corner swing hangs from its web on the corner post the same way)
        if (isChaser && hangPoint(b, tmp.anchor)) anchor = tmp.anchor;
        // Round 12: a zip / yank is the stretched zip pose (arm up along the web), not the rope hang.
        if (isChaser && (b.zipOn || b.yankOn)) zip = true;
        if (isRunner && run.pose.phase === PHASE_ROPE && game.runnerAnchor(tmp.e)) anchor = tmp.anchor.copy(tmp.e);
        if (isRunner && run.pose.phase === PHASE_ZIP) zip = true;
      }
      rig.hook = anchor ? 1 : -1;
      rig.zip = zip;
      let charge = false, dive = false;

      // Events -> animMachine bits; round 9 wall / ledge / slide states.
      let ev = 0;
      let grounded: boolean;
      let wall = 0, ledge = 0, slide = false;
      let nx = 0, nz = 0;
      if (isChaser) {
        const fe = game.frameEvents;
        if (fe & EV_JUMP) ev |= A_JUMP;
        if (fe & EV_DJUMP) ev |= A_DJUMP;
        if (fe & (EV_ATTACH | EV_ZIP)) ev |= A_ATTACH;
        if (fe & (EV_RELEASE | EV_ZIP_END)) ev |= A_RELEASE;
        if (fe & EV_LAND) ev |= A_LAND;
        if (fe & EV_BONK) ev |= A_BONK;
        if (fe & EV_WALLRUN) ev |= A_WALLRUN;
        if (fe & EV_WALLJUMP) ev |= A_WALLJUMP;
        if (fe & EV_LEDGE) ev |= A_LEDGE;
        if (fe & EV_CLIMB) ev |= A_CLIMB;
        if (fe & EV_VAULT) ev |= A_VAULT;
        if (fe & EV_SLIDE) ev |= A_SLIDE;
        if (fe & EV_ROLL) ev |= A_ROLL;
        if (fe & EV_BIGLAND) ev |= A_BIGLAND;
        if (fe & EV_ZIP) ev |= A_ZIP;
        if (fe & EV_CHARGE_START) ev |= A_CHARGE;
        if (fe & EV_CHARGE) ev |= A_LEAP;
        if (fe & (EV_POP | EV_REBOUND)) ev |= A_POP;
        if (fe & EV_DIVE) ev |= A_DIVE;
        if (fe & EV_YANK) ev |= A_ZIP;
        charge = !r.over && b.chargeT > 0;
        dive = !r.over && b.diveOn;
        grounded = b.grounded;
        if (!r.over) {
          wall = b.wallMode;
          ledge = b.ledgeMode > 2 ? 2 : b.ledgeMode;
          slide = b.slideT > 0 && b.grounded;
          nx = wall ? b.wallNx : b.ledgeNx; nz = wall ? b.wallNz : b.ledgeNz;
        }
      } else {
        const ph = r.over ? PHASE_GROUND : run.pose.phase;
        const was = rig.prevPhase;
        rig.phaseT = ph === was ? rig.phaseT + delta : 0;
        if (ph !== was) {
          if (was === PHASE_GROUND && ph === PHASE_AIR) ev |= A_JUMP;
          if (ph === PHASE_ROPE) ev |= A_ATTACH;
          if (was === PHASE_ROPE && ph === PHASE_AIR) ev |= A_RELEASE;
          if (ph === PHASE_WALL) ev |= A_WALLRUN;
          if (ph === PHASE_LEDGE) ev |= A_LEDGE;
          if (was === PHASE_WALL && ph === PHASE_AIR) ev |= A_WALLJUMP;
          if (ph === PHASE_GROUND) ev |= was === PHASE_LEDGE ? A_CLIMB : A_LAND;
        }
        // Vaults and rolls come from the pack's events on the current edge.
        if (run.mode === RM_EDGE && run.edge >= 0) {
          const e = game.pack.edges[run.edge];
          if (run.t >= rig.prevT) for (const x of eventsBetween(e, rig.prevT, run.t)) {
            if (x.type === EVT_VAULT) ev |= A_VAULT;
            if (x.type === EVT_ROLL) ev |= A_ROLL;
            if (x.type === EVT_CHARGE) { ev |= A_CHARGE; rig.charging = true; }
            if (x.type === EVT_LEAP) { ev |= A_LEAP; rig.charging = false; }
          }
          rig.prevT = run.t;
          charge = rig.charging && run.pose.phase === PHASE_GROUND;
          if (!charge) rig.charging = false;
        } else rig.prevT = 0;
        rig.prevPhase = ph;
        grounded = ph === PHASE_GROUND;
        if (ph === PHASE_WALL || ph === PHASE_LEDGE) {
          const sol = game.model.solids[run.pose.ref];
          if (sol) { nearestFace(sol, p.x, p.z, tmp.n); nx = tmp.n.x; nz = tmp.n.z; }
          if (ph === PHASE_WALL) wall = Math.abs(rig.vel.y) > speed ? 2 : 1;
          else ledge = rig.phaseT < game.round.tuning.ledgeHang ? 1 : 2;
        }
      }

      // Beats.
      let beat: Beat = "";
      if (r.phase === "countdown") beat = isRunner ? "wave" : "idle";
      else if (r.phase === "caught") beat = waltzW > 0 ? "waltz" : isChaser ? "cheer" : "flop";
      else if (r.phase === "escaped") beat = isRunner ? "rug" : "fish";
      else if (isRunner && run.mode === RM_TAUNT) beat = "taunt";
      // Wall run side: the face normal points to his right = the wall is on his left (Wall_Run), else Wall_Run_Mirror.
      const wallSide = nx * -Math.cos(rig.yaw) + nz * Math.sin(rig.yaw) > 0 ? 1 : -1;
      applyCmd(rig.player, rig.machine.step({
        dt: delta, grounded: grounded || beat === "idle", rope: anchor !== null, speed: run.mode !== RM_EDGE && isRunner ? 0 : speed, vy, events: ev,
        landVy: isChaser ? b.landVy : 0, panic: isRunner && run.band.panic && !run.band.gassed, beat,
        // Round 7 free fall: air under the feet (the view reads the sim's index between steps).
        clearance: p.y - 0.9 - game.index.groundBelow(p.x, p.z, p.y - 0.9),
        wall, ledge, slide, wallSide, zip, charge, dive,
      }));
      rig.chargeOn = charge;
      // The web-slinger air poses: dive, skydive, the swing's tuck / reach, the flip on a perfect release.
      const clear = p.y - 0.9 - game.index.groundBelow(p.x, p.z, p.y - 0.9);
      const free = !grounded && !anchor && !zip && !wall && !ledge && beat === "";
      stepAirPose(rig.air, airInput(tmp.ain, delta, dive && beat === "", free, beat === "" ? anchor : null, p, vy, clear,
        isChaser && (game.frameEvents & EV_PERFECT) !== 0, isChaser && b.glideOn && beat === ""));

      // Facing (slerp 12 rad/s toward velocity; scripted beats face the other one).
      const faceTo = (x: number, z: number, rate: number) => {
        if (x * x + z * z < 1e-4) return;
        const want = Math.atan2(x, z);
        rig.yaw += wrap(want - rig.yaw) * Math.min(1, rate * rawDelta);
      };
      if (r.phase === "countdown") faceTo(other.x - p.x, other.z - p.z, 30);
      else if (r.phase === "caught" || (r.phase === "escaped" && isChaser)) faceTo(other.x - p.x, other.z - p.z, 5);
      else if (isRunner && run.mode !== RM_EDGE) { if (run.headX || run.headZ) faceTo(run.headX, run.headZ, 3); }
      else if ((wall === 2 || ledge) && (nx || nz)) faceTo(-nx, -nz, 14); // run-up / ledge: face the wall
      else if (speed > 0.5) faceTo(vx, vz, 12);

      // Root placement: feet at p - 0.9; on the rope the body hangs from RightHand at p (errata 1); on a
      // ledge from RightHand at the rim.
      tmp.qYaw.setFromAxisAngle(UP, rig.yaw);
      let tx = 0, ty = -0.9, tz = 0;
      rig.hand.copy(rig.p);
      if (ledge === 1) rig.hand.set(p.x - nx * 0.12, p.y + LEDGE_HANG, p.z - nz * 0.12);
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
        faceTo(tmp.f.x, tmp.f.z, POSE.ropeFace);
        tx = -rig.hand_ * tmp.u.x; ty = -rig.hand_ * tmp.u.y; tz = -rig.hand_ * tmp.u.z;
      } else {
        // Wall run: rolled so the feet run on the wall; run-up: pitched back (feet on the wall); slide:
        // pitched back a little. Smoothed so the pose eases in and out.
        // (a bought parkour clip poses the body itself: no roll / pitch while it plays)
        let wantRoll = 0, wantPitch = 0;
        if (rig.machine.posed) { /* the clip owns the pose */ }
        else if (wall === 1 && (nx || nz)) {
          const rx = -Math.cos(rig.yaw), rz = Math.sin(rig.yaw); // the model's right (it faces +z at yaw 0)
          wantRoll = (nx * rx + nz * rz > 0 ? 1 : -1) * POSE.wallRoll;
        } else if (wall === 2) wantPitch = POSE.runUpPitch;
        else if (slide) wantPitch = POSE.slidePitch;
        const kk = Math.min(1, 10 * rawDelta);
        rig.roll += (wantRoll - rig.roll) * kk;
        rig.pitch += (wantPitch - rig.pitch) * kk;
        tmp.qPose.setFromEuler(tmp.eu.set(rig.pitch, 0, rig.roll, "YXZ"));
        tmp.q.multiplyQuaternions(tmp.qYaw, tmp.qPose);
      }
      // Ledge_Climb: the root stays at the rim for the whole climb and the clip lifts the body (its last frame
      // stands at the root).
      if (ledge >= 2 && rig.machine.special === "mantle") {
        const sol = game.model.solids[isChaser ? b.ledgeSolid : run.pose.ref];
        if (sol) ty = sol.top - p.y;
      }
      const hanging = anchor !== null || ledge === 1;
      rig.ropeW += ((hanging ? 1 : 0) - rig.ropeW) * Math.min(1, (hanging ? 6 : 10) * rawDelta);
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
      placeRoot(rig, tmp.q, tmp.pos.set(px, py, pz), hanging, vx, vy, vz, rawDelta);
      // Camera closer than 2 m: the local Radbro fades to 40% (spec §8). Round 11: the camera's own distance to him
      // (the look point leans toward the pivot on the rope, so the arm alone understates it).
      if (isChaser) {
        const want = r.phase === "chase" && game.rig.bodyDist < 2 ? 0.4 : 1;
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
      // One-arm swing (W10): LeftArm swept back, hips pitched with the swing (lean in on the way down, tuck
      // on the way up); before the hand correction so the RightHand still lands on p.
      const isChaser = rig.id === s.chaser;
      const onRope = isChaser ? r.player.ropeSolid >= 0 : r.runner.pose.phase === PHASE_ROPE && rig.hook > 0;
      const wantHips = onRope ? POSE.swingHips * Math.max(-1, Math.min(1, -(isChaser ? r.player.v.y : rig.vel.y) / 12)) : 0;
      rig.hipPitch += (wantHips - rig.hipPitch) * Math.min(1, 6 * rawDelta);
      if (rig.ropeW > 0.01 && rig.hook > 0) {
        tmp.fwd.set(Math.cos(rig.yaw), 0, -Math.sin(rig.yaw));
        rotateBoneWorld(rig.bones.leftArm, tmp.fwd, -POSE.leftArmBack * rig.ropeW, tmp);
        if (Math.abs(rig.hipPitch) > 1e-3) rotateBoneWorld(rig.bones.hips, tmp.fwd, rig.hipPitch, tmp);
      }
      // The air poses' limbs (dive, skydive, swing tuck / reach, flip), before the hand correction.
      airBones(rig.air, rig.pose, rig.root, rig.hook > 0);
      placeWings(rig.wing, rig.root, rig.pose, rig.air.glide);
      hairClear(rig, tmp);
      // Hand correction: shift the root so RightHand sits on its target (weighted while the hang blends in).
      const rh = rig.bones.rightHand;
      if (rh && rig.ropeW > 0.01) {
        rig.root.updateMatrixWorld(true);
        rh.getWorldPosition(tmp.a);
        tmp.b.copy(rig.hand).sub(tmp.a).multiplyScalar(rig.ropeW);
        rig.root.position.add(tmp.b);
      }
      // Neck look-back / head-turn tell (runner).
      // Round 12 zip: the right arm up along the web (both of them).
      if (rig.zip) {
        tmp.fwd.set(Math.sin(rig.yaw), 0, Math.cos(rig.yaw));
        rotateBoneWorld(rig.bones.rightArm, tmp.fwd, -2.3, tmp);
      }
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
        const want = rig.zip ? 0 : yoinked ? 1 : r.phase === "chase" && r.player.ringId === RING_RUNNER ? 0.45 : 0;
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

/**
 * Stride against #723's (whose clips the Retardios wear, retargeted): at the same speed their feet cover this much more
 * ground per cycle, so their locomotion loops play this much slower (no foot sliding). Measured with their clips.
 */
const STRIDE: Partial<Record<RadbroId, Record<string, number>>> = {
  retardio555: { Casual_Walk: 1.03, Run_02: 1.13, Lean_Forward_Sprint: 1.09 },
  retardio85: { Casual_Walk: 0.96, Run_02: 1.03, Lean_Forward_Sprint: 1.01 },
};

/**
 * Hair clearance (the Retardios): their long hair is one solid mass, so the rope arm, straight up in Rope_Hang_Idle,
 * disappears into it and the web seems to come out of the hair. While he hangs on a web, swing that arm out to his
 * right by this much (radians about his forward axis). Call it before the hand correction so the hand still lands on
 * the web.
 */
const HAIR_ARM: Partial<Record<RadbroId, number>> = { retardio555: 0.9, retardio85: 0.9 };
const hairQ = new Quaternion(), hairFwd = new Vector3();
export function hairClear(rig: ActorRig, tmp: { pq: Quaternion; wq: Quaternion; axis: Vector3 }): void {
  const a = HAIR_ARM[rig.id];
  if (!a || rig.ropeW <= 0.01 || rig.hook < 0) return;
  rig.root.getWorldQuaternion(hairQ);
  rotateBoneWorld(rig.bones.rightArm, hairFwd.set(0, 0, 1).applyQuaternion(hairQ), a * rig.ropeW, tmp);
}

/** Rotate a bone about a world-space axis through its pivot (after the mixer wrote its pose). */
export function rotateBoneWorld(bone: Bone | undefined, axisWorld: Vector3, angle: number, tmp: { pq: Quaternion; wq: Quaternion; axis: Vector3 }): void {
  if (!bone || !bone.parent) return;
  bone.parent.getWorldQuaternion(tmp.pq);
  // L' = P^-1 * Q * P * L
  tmp.axis.copy(axisWorld).applyQuaternion(tmp.wq.copy(tmp.pq).invert()).normalize();
  tmp.wq.setFromAxisAngle(tmp.axis, angle);
  bone.quaternion.premultiply(tmp.wq);
  bone.updateMatrixWorld(true);
}
