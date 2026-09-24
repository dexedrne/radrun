// Shared, renderer-free level + tuning + scripted input for BOTH swing implementations.
// Pure TS (no three / react imports) so tools/headless.ts can run it under plain Node.
import type { Prefab } from "react-three-game";

export type Roof = { x0: number; x1: number; top: number };
export type Anchor = { x: number; y: number };
export type Level = { roofs: Roof[]; anchors: Anchor[] };

// Character stand-in: capsule/box 0.7 wide, 1.8 tall. Position = its centre.
export const HALF_H = 0.9;
export const RADIUS = 0.35;

// Runs along +x in the z=0 plane. Gaps 12-14 m: too wide to jump (a flat jump covers ~6.5 m),
// so every gap needs a swing off the anchor floating above it.
export const LEVEL: Level = {
  roofs: [
    { x0: -30, x1: 12, top: 30 },
    { x0: 24, x1: 36, top: 28.5 },
    { x0: 50, x1: 62, top: 29.5 },
    { x0: 76, x1: 90, top: 27.5 },
    { x0: 104, x1: 150, top: 29 },
  ],
  anchors: [
    { x: 18, y: 40 },
    { x: 43, y: 40 },
    { x: 69, y: 40 },
    { x: 97, y: 39.5 },
  ],
};

export type Tuning = {
  gravity: number; // m/s^2 (earth is 9.81; platformers feel right at ~2.5x)
  runSpeed: number; // auto-run speed on rooftops, m/s
  jumpSpeed: number; // vertical take-off speed, m/s
  aimRadius: number; // auto-aim: max distance to an anchor you can grab
  ropeScale: number; // rope reels in to distance-at-attach * ropeScale (<1 = grapple pull)
  reelSpeed: number; // m/s the rope shortens toward that target (pumps energy into the swing)
  releaseBoost: number; // m/s added along the velocity direction on release
  holdDelay: number; // one-button scheme: hold this long before the rope fires (tap = pure jump)
  coyoteTime: number; // jump still allowed this long after running off an edge (hides input latency)
};

export const TUNING: Tuning = {
  gravity: 25,
  runSpeed: 9,
  jumpSpeed: 9,
  aimRadius: 14,
  ropeScale: 0.75,
  reelSpeed: 6,
  releaseBoost: 3,
  holdDelay: 0.12,
  coyoteTime: 0.1,
};

export type Input = { jumpPressed: boolean; swingHeld: boolean };

// One-button scripted input: [pressAt, releaseAt] in SIMULATION seconds.
// Press = jump if on a roof; keep holding (>= holdDelay) while airborne = grab nearest anchor ahead.
// The short 0.08 s tap on roof 1 is a plain hop (proves tap != swing).
// Tuned by `node tools/headless.ts tune` (middle of the widest working release window per gap).
export const SCRIPTS: Record<"kinematic" | "crashcat", [number, number][]> = {
  kinematic: [[1.2, 2.24], [3.28, 3.36], [3.6, 4.69], [5.9, 7.22], [8.9, 10.24]],
  crashcat: [[1.2, 2.38], [3.47, 3.55], [3.8, 4.99], [6.4, 7.67], [9.4, 10.81]],
};

/** Evaluate the one-button script at sim time t. `prevHeld` gives edge detection. */
export function scriptInput(t: number, prevHeld: boolean, script: [number, number][]): Input {
  const held = script.some(([a, b]) => t >= a && t < b);
  return { jumpPressed: held && !prevHeld, swingHeld: held };
}

/** Auto-aim: nearest anchor that is above and not behind the character, within aimRadius. */
export function pickAnchor(level: Level, x: number, y: number, aimRadius: number): number {
  let best = -1;
  let bestD = Infinity;
  level.anchors.forEach((a, i) => {
    if (a.x < x - 0.5 || a.y < y + 1) return;
    const d = Math.hypot(a.x - x, a.y - y);
    if (d <= aimRadius && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

export const failY = (level: Level) => Math.min(...level.roofs.map(r => r.top)) - 8;

// ---------------------------------------------------------------------------------------------
// r3g prefab for the scene. Physics components are only added for the crashcat implementation
// (instanced:false on every physics node: auto-instancing detaches meshes -> lost colliders).
type Node = Prefab["root"];
const mesh = (
  id: string,
  pos: [number, number, number],
  geometryType: string,
  args: number[],
  materialId: string,
  extra: Record<string, unknown> = {},
  instanced = true,
): Node => ({
  id,
  components: {
    transform: { type: "Transform", properties: { position: pos } },
    mesh: { type: "Mesh", properties: { instanced } },
    geometry: { type: "Geometry", properties: { geometryType, args } },
    material: { type: "Material", properties: { materialId } },
    ...extra,
  },
});

export function buildPrefab(level: Level, withPhysics: boolean): Prefab {
  const phys = (props: Record<string, unknown>) =>
    withPhysics ? { physics: { type: "CrashcatPhysics", properties: props } } : {};
  const skyline: Node[] = Array.from({ length: 16 }, (_, i) => {
    const h = 18 + ((i * 37) % 23);
    return mesh(`bg-${i}`, [-20 + i * 12, h / 2, -38 - (i % 3) * 8], "box", [9, h, 9], "far");
  });
  return {
    id: "rooftops",
    name: "Radbro Rooftop Swing",
    materials: {
      building: { color: "#3f4a5c", roughness: 0.9 },
      roofTop: { color: "#9aa5b1", roughness: 0.8 },
      anchor: { materialType: "basic", color: "#facc15" },
      player: { color: "#ef4444", roughness: 0.5 },
      far: { materialType: "basic", color: "#6b7fa3" },
      street: { color: "#1f2430" },
    },
    root: {
      id: "root",
      children: [
        {
          id: "camera",
          components: {
            transform: { type: "Transform", properties: { position: [0, 33, 20], rotation: [-0.12, -0.28, 0] } },
            camera: { type: "Camera", properties: { fov: 55, far: 400 } },
          },
        },
        {
          id: "sun",
          components: {
            transform: { type: "Transform", properties: { position: [30, 80, 40] } },
            light: { type: "DirectionalLight", properties: { intensity: 2.2, targetOffset: [-25, -60, -35] } },
          },
        },
        {
          id: "sky",
          components: {
            light: { type: "HemisphereLight", properties: { skyColor: "#bcd7ff", groundColor: "#3a3140", intensity: 1.1 } },
          },
        },
        mesh("street", [60, -0.05, 0], "box", [400, 0.1, 60], "street"),
        ...level.roofs.map((r, i) =>
          mesh(`roof-${i}`, [(r.x0 + r.x1) / 2, r.top / 2, 0], "box", [r.x1 - r.x0, r.top, 10], "building",
            phys({ type: "fixed", colliders: "cuboid", friction: 0 }), !withPhysics),
        ),
        ...level.roofs.map((r, i) =>
          mesh(`trim-${i}`, [(r.x0 + r.x1) / 2, r.top - 0.1, 0], "box", [r.x1 - r.x0 + 0.02, 0.22, 10.02], "roofTop"),
        ),
        ...level.anchors.map((a, i) =>
          mesh(`anchor-${i}`, [a.x, a.y, 0], "sphere", [0.45, 20, 14], "anchor",
            phys({ type: "fixed", colliders: "ball", sensor: true }), !withPhysics),
        ),
        ...skyline,
        mesh("player", [0, level.roofs[0].top + HALF_H, 0], "box", [RADIUS * 2, HALF_H * 2, RADIUS * 2], "player", {}, false),
      ],
    },
  };
}
