// useFrame priorities (spec §20 item 3). All negative: r3g internals keep priority 0 and negative
// priorities never take over rendering.
export const FRAME = {
  sim: -6, // SimDriver: fixed steps, snapshots, george.step
  actors: -5, // ActorsView / GeorgeView / the box stand-in: root transforms, facing, rope tilt
  animator: -4, // Animator mixers
  bones: -3, // ActorsView bone pass, VrmModel
  camera: -2, // CameraView
  fx: -1, // FxView (reads bones / final transforms)
} as const;
