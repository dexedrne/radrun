/**
 * Retarget humanoid clips from a plain glTF rig (Meshy / Mixamo naming) onto a
 * VRM's *normalized* humanoid bones, by baking world-space rotation deltas.
 *
 * Why baked instead of the per-track three-vrm example (loadMixamoAnimation):
 *  - that example assumes the source rest pose is a T-pose. The Radbro (Meshy)
 *    rig rests in an A-pose (upper arms ~60deg down), so its arms would come out
 *    ~60deg too high on a T-posed VRM. Here each limb bone's rest is re-aimed at
 *    the VRM's rest direction first (swing-only correction).
 *  - source/target hierarchies differ (Meshy has 3 spine bones, the Pockit VRMs
 *    have spine+chest, no upperChest). Deltas are computed in world space and
 *    re-parented to the nearest *mapped* VRM ancestor, so a skipped bone's
 *    rotation is folded into its child instead of being lost.
 *
 * VRM0 models face -Z (VRM1 and glTF sources face +Z): VRM0 output is mirrored
 * by a 180deg Y conjugation (negate quaternion x/z, position x/z), which is the
 * same thing the official example does. Pair it with VRMUtils.rotateVRM0(vrm).
 */
import {
  AnimationClip,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  PropertyBinding,
  type Interpolant,
} from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { VRMHumanBoneParentMap, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";

export type RigMap = Partial<Record<string, VRMHumanBoneName>>;

/** Meshy auto-rig (Radbro delivery GLBs): Hips > Spine02 > Spine01 > Spine > neck > Head. */
export const MESHY_RIG: RigMap = {
  Hips: "hips",
  Spine02: "spine",
  Spine01: "chest",
  Spine: "upperChest",
  neck: "neck",
  Head: "head",
  LeftShoulder: "leftShoulder",
  LeftArm: "leftUpperArm",
  LeftForeArm: "leftLowerArm",
  LeftHand: "leftHand",
  RightShoulder: "rightShoulder",
  RightArm: "rightUpperArm",
  RightForeArm: "rightLowerArm",
  RightHand: "rightHand",
  LeftUpLeg: "leftUpperLeg",
  LeftLeg: "leftLowerLeg",
  LeftFoot: "leftFoot",
  LeftToeBase: "leftToes",
  RightUpLeg: "rightUpperLeg",
  RightLeg: "rightLowerLeg",
  RightFoot: "rightFoot",
  RightToeBase: "rightToes",
};

/** Mixamo (names after GLTFLoader/FBXLoader sanitising, i.e. "mixamorigHips"; the prefix is optional). */
export const MIXAMO_RIG: RigMap = Object.fromEntries(
  Object.entries({
    Hips: "hips", Spine: "spine", Spine1: "chest", Spine2: "upperChest", Neck: "neck", Head: "head",
    LeftShoulder: "leftShoulder", LeftArm: "leftUpperArm", LeftForeArm: "leftLowerArm", LeftHand: "leftHand",
    RightShoulder: "rightShoulder", RightArm: "rightUpperArm", RightForeArm: "rightLowerArm", RightHand: "rightHand",
    LeftUpLeg: "leftUpperLeg", LeftLeg: "leftLowerLeg", LeftFoot: "leftFoot", LeftToeBase: "leftToes",
    RightUpLeg: "rightUpperLeg", RightLeg: "rightLowerLeg", RightFoot: "rightFoot", RightToeBase: "rightToes",
  }).flatMap(([k, v]) => [[k, v], [`mixamorig${k}`, v]]),
) as RigMap;

/** Limb bone -> the bone whose rest position defines its direction (for the A/T-pose correction). */
const AIM_CHILD: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>> = {
  leftShoulder: "leftUpperArm", leftUpperArm: "leftLowerArm", leftLowerArm: "leftHand",
  rightShoulder: "rightUpperArm", rightUpperArm: "rightLowerArm", rightLowerArm: "rightHand",
  leftUpperLeg: "leftLowerLeg", leftLowerLeg: "leftFoot", leftFoot: "leftToes",
  rightUpperLeg: "rightLowerLeg", rightLowerLeg: "rightFoot", rightFoot: "rightToes",
};
/** Leaves inherit their parent's correction. */
const AIM_INHERIT: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>> = {
  leftHand: "leftLowerArm", rightHand: "rightLowerArm", leftToes: "leftFoot", rightToes: "rightFoot",
};

export type RetargetOptions = {
  /** Pin hips X/Z to the rest position (strip root motion, keep vertical). */
  inPlace?: boolean;
  /** Sampling rate of the baked clip. */
  fps?: number;
  /** Re-aim limb rest directions onto the VRM's (fixes A-pose sources). Default true. */
  alignRestPose?: boolean;
};

type Bound = { node: Object3D; path: "quaternion" | "position" | "scale"; interp: Interpolant };

/**
 * Bake `clip` (authored on `sourceRoot`, a glTF scene whose default node transforms are the rest pose)
 * into a clip that drives `vrm`'s normalized humanoid bones. Play it with an AnimationMixer on vrm.scene
 * and call vrm.update(delta) every frame.
 */
export function retargetClip(clip: AnimationClip, sourceRoot: Object3D, vrm: VRM, rig: RigMap, options: RetargetOptions = {}): AnimationClip {
  const { inPlace = false, fps = 30, alignRestPose = true } = options;
  const humanoid = vrm.humanoid;
  const isVRM0 = vrm.meta?.metaVersion === "0";

  // --- source: private clone at rest ---------------------------------------------------------
  const src = cloneSkeleton(sourceRoot);
  src.position.set(0, 0, 0);
  src.quaternion.identity();
  src.scale.set(1, 1, 1);
  src.updateMatrixWorld(true);

  // target bone -> source node (only bones present on both sides)
  const pairs: Array<{ bone: VRMHumanBoneName; srcNode: Object3D; tgtNode: Object3D }> = [];
  for (const [srcName, bone] of Object.entries(rig)) {
    if (!bone) continue;
    const srcNode = src.getObjectByName(srcName);
    const tgtNode = humanoid.getNormalizedBoneNode(bone);
    if (srcNode && tgtNode && !pairs.some(p => p.bone === bone)) pairs.push({ bone, srcNode, tgtNode });
  }
  const byBone = new Map(pairs.map(p => [p.bone, p]));
  const parentOf = (bone: VRMHumanBoneName): VRMHumanBoneName | null => {
    let p = VRMHumanBoneParentMap[bone];
    while (p && !byBone.has(p)) p = VRMHumanBoneParentMap[p];
    return p ?? null;
  };

  // --- rest poses ------------------------------------------------------------------------------
  const tmp = new Vector3();
  const srcRestPos = new Map<VRMHumanBoneName, Vector3>();
  const srcRestQ = new Map<VRMHumanBoneName, Quaternion>();
  for (const p of pairs) {
    srcRestPos.set(p.bone, p.srcNode.getWorldPosition(new Vector3()));
    srcRestQ.set(p.bone, p.srcNode.getWorldQuaternion(new Quaternion()));
  }
  // VRM normalized rest: identity rotations, positions = sum of local offsets along the chain (native frame).
  const tgtRestPos = new Map<VRMHumanBoneName, Vector3>();
  const restPose = humanoid.normalizedRestPose;
  const tgtWorld = (bone: VRMHumanBoneName): Vector3 => {
    const cached = tgtRestPos.get(bone);
    if (cached) return cached;
    const local = new Vector3().fromArray(restPose[bone]?.position ?? [0, 0, 0]);
    let parent = VRMHumanBoneParentMap[bone];
    while (parent && !restPose[parent]) parent = VRMHumanBoneParentMap[parent];
    const world = parent ? local.add(tgtWorld(parent)) : local;
    tgtRestPos.set(bone, world);
    return world;
  };
  const toSourceFrame = (v: Vector3) => (isVRM0 ? v.set(-v.x, v.y, -v.z) : v);

  // Corrected rest S'_b = C_b * S_b, where C_b swings the source bone direction onto the VRM's.
  const correction = new Map<VRMHumanBoneName, Quaternion>();
  if (alignRestPose) {
    for (const p of pairs) {
      const child = AIM_CHILD[p.bone];
      if (!child || !byBone.has(child)) continue;
      const srcDir = srcRestPos.get(child)!.clone().sub(srcRestPos.get(p.bone)!).normalize();
      const tgtDir = toSourceFrame(tgtWorld(child).clone().sub(tgtWorld(p.bone))).normalize();
      correction.set(p.bone, new Quaternion().setFromUnitVectors(srcDir, tgtDir));
    }
    for (const [leaf, from] of Object.entries(AIM_INHERIT) as Array<[VRMHumanBoneName, VRMHumanBoneName]>) {
      const c = correction.get(from);
      if (c && byBone.has(leaf)) correction.set(leaf, c.clone());
    }
  }
  const restInv = new Map<VRMHumanBoneName, Quaternion>();
  for (const p of pairs) {
    const s = srcRestQ.get(p.bone)!.clone();
    const c = correction.get(p.bone);
    if (c) s.premultiply(c);
    restInv.set(p.bone, s.invert());
  }

  // --- bind source tracks directly (no mixer: exact, deterministic sampling) -------------------
  const bound: Bound[] = [];
  for (const track of clip.tracks) {
    const parsed = PropertyBinding.parseTrackName(track.name);
    const node = src.getObjectByName(parsed.nodeName);
    const path = parsed.propertyName as Bound["path"];
    if (!node || !["quaternion", "position", "scale"].includes(path)) continue;
    bound.push({ node, path, interp: (track as unknown as { createInterpolant(): Interpolant }).createInterpolant() });
  }

  // --- sample --------------------------------------------------------------------------------
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(frames);
  const rotValues = new Map<VRMHumanBoneName, Float32Array>(pairs.map(p => [p.bone, new Float32Array(frames * 4)]));
  const hipsPair = byBone.get("hips");
  const hipsValues = new Float32Array(frames * 3);
  const hipsRestSrc = hipsPair ? srcRestPos.get("hips")!.clone() : new Vector3();
  const hipsRestTgt = hipsPair ? new Vector3().fromArray(restPose.hips?.position ?? [0, 0, 0]) : new Vector3();
  const hipsScale = hipsPair && hipsRestSrc.y > 1e-4 ? tgtWorld("hips").y / hipsRestSrc.y : 1;
  let hipsStart: Vector3 | null = null;

  const delta = new Map<VRMHumanBoneName, Quaternion>(pairs.map(p => [p.bone, new Quaternion()]));
  const w = new Quaternion();
  const local = new Quaternion();
  const invParent = new Quaternion();

  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps);
    times[f] = t;
    for (const b of bound) {
      const v = b.interp.evaluate(t) as unknown as number[];
      if (b.path === "quaternion") b.node.quaternion.fromArray(v).normalize();
      else b.node[b.path].fromArray(v);
    }
    src.updateMatrixWorld(true);
    for (const p of pairs) delta.get(p.bone)!.copy(p.srcNode.getWorldQuaternion(w)).multiply(restInv.get(p.bone)!);
    for (const p of pairs) {
      const parent = parentOf(p.bone);
      if (parent) invParent.copy(delta.get(parent)!).invert();
      else invParent.identity();
      local.copy(invParent).multiply(delta.get(p.bone)!);
      if (isVRM0) local.set(-local.x, local.y, -local.z, local.w);
      local.toArray(rotValues.get(p.bone)!, f * 4);
    }
    if (hipsPair) {
      const d = hipsPair.srcNode.getWorldPosition(tmp).sub(hipsRestSrc).multiplyScalar(hipsScale);
      if (inPlace) {
        hipsStart ??= d.clone();
        d.x = 0;
        d.z = 0;
      }
      if (isVRM0) d.set(-d.x, d.y, -d.z);
      d.add(hipsRestTgt).toArray(hipsValues, f * 3);
    }
  }

  const tracks = pairs.map(p => new QuaternionKeyframeTrack(`${p.tgtNode.name}.quaternion`, times, rotValues.get(p.bone)!));
  if (hipsPair) tracks.push(new VectorKeyframeTrack(`${hipsPair.tgtNode.name}.position`, times, hipsValues));
  return new AnimationClip(clip.name, clip.duration, tracks);
}
