// Round 4 campaign hats for George (party / crown / tin foil), picked on the campaign screen. They are
// not parented to the rig (its bone scales never matter); every frame placeHats() puts them on the head
// bone with the head's own motion: the head's world rotation relative to its bind pose (so a turn, nod
// or tilt of the head turns the hat with it, and the bind pose = upright on the body's yaw), lifted
// HAT_LIFT above the bone and HAT_FWD forward along the head's facing (metres at render scale 1).
import {
  ConeGeometry, CylinderGeometry, DoubleSide, Group, IcosahedronGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3,
  type Object3D,
} from "three";

/** Height above the head bone and forward offset (m at render scale 1); ?hats (dev) previews them. */
export const HAT_LIFT = 0.015;
export const HAT_FWD = 0.012;

export function makeHats(): Group {
  const hats = new Group();
  const party = new Group();
  party.name = "party";
  const cone = new Mesh(new ConeGeometry(0.05, 0.13, 10), new MeshBasicMaterial({ color: "#ff3d7f" }));
  cone.position.y = 0.065;
  const pom = new Mesh(new IcosahedronGeometry(0.018, 0), new MeshBasicMaterial({ color: "#ffd23f" }));
  pom.position.y = 0.135;
  party.add(cone, pom);
  party.rotation.z = 0.18;
  const crown = new Group();
  crown.name = "crown";
  const gold = new MeshBasicMaterial({ color: "#f5c542", side: DoubleSide });
  const band = new Mesh(new CylinderGeometry(0.058, 0.052, 0.035, 10, 1, true), gold);
  band.position.y = 0.018;
  crown.add(band);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spike = new Mesh(new ConeGeometry(0.014, 0.035, 4), gold);
    spike.position.set(Math.sin(a) * 0.054, 0.052, Math.cos(a) * 0.054);
    crown.add(spike);
  }
  const foil = new Group();
  foil.name = "foil";
  const tin = new Mesh(new ConeGeometry(0.066, 0.12, 7), new MeshStandardMaterial({ color: "#d9dee6", metalness: 0.85, roughness: 0.3, flatShading: true }));
  tin.position.y = 0.05;
  tin.rotation.y = 0.4;
  foil.add(tin);
  foil.rotation.x = -0.12;
  hats.add(party, crown, foil);
  hats.visible = false;
  return hats;
}

/**
 * The inverse of the head's bind-pose rotation relative to the body root (call once, on the freshly
 * cloned rig before any clip plays).
 */
export function headRestInverse(root: Object3D, head: Object3D): Quaternion {
  root.updateMatrixWorld(true);
  const rq = root.getWorldQuaternion(new Quaternion());
  const hq = head.getWorldQuaternion(new Quaternion());
  return rq.invert().multiply(hq).invert();
}

const tmpP = new Vector3();
const tmpQ = new Quaternion();
const tmpO = new Vector3();

/** Put the hats on the head (world space; `hats` must sit directly in the scene). */
export function placeHats(hats: Object3D, head: Object3D, restInv: Quaternion, scale: number, lift = HAT_LIFT, fwd = HAT_FWD): void {
  head.getWorldPosition(tmpP);
  head.getWorldQuaternion(tmpQ).multiply(restInv);
  hats.quaternion.copy(tmpQ);
  tmpO.set(0, lift * scale, fwd * scale).applyQuaternion(tmpQ);
  hats.position.copy(tmpP).add(tmpO);
  hats.scale.setScalar(scale);
}
