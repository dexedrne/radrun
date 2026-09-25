// What the shared canvas views (CameraView, FxView) need from a game: the free-roam Sandbox and the
// PlayGame both satisfy it structurally.
import type { Body, InputFrame, SimWorld } from "../sim/player.ts";
import type { CameraTuning, Tuning } from "../sim/tuning.ts";
import type { CityModel } from "../world/cityModel.ts";
import type { Rig } from "../camera/rig.ts";
import type { Vec3 } from "../sim/math.ts";

export interface ViewGame {
  readonly model: CityModel;
  readonly world: SimWorld;
  readonly body: Body;
  readonly renderP: Vec3;
  readonly rig: Rig;
  camera: CameraTuning;
  /** The tuning the sim runs (web zip preview) and the last consumed input frame (its aim). */
  simTuning?: Tuning;
  frameInput?: InputFrame;
  frameEvents: number;
  /** Scripted shots: write eye/at and return true to override the rig this frame. */
  scriptedCamera?(eye: Vec3, at: Vec3, rigEye: Vec3, rigAt: Vec3): boolean;
}
