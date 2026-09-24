// (i) Custom kinematic swing: our own fixed-step integrator, no physics engine.
// Rope = position-based constraint: integrate freely, and if the character is farther than the
// rope length from the anchor, project it back onto the circle and cancel the outward radial
// velocity (tangential velocity kept, slack rope allowed). The rope reels in toward
// ropeScale * attach-length at reelSpeed. Pure TS: runs in Node and inside useFrame.
import { HALF_H, RADIUS, failY, pickAnchor, type Input, type Level, type Tuning } from "./level.ts";

export type Phase = "run" | "air" | "swing" | "dead" | "done";
export type KState = {
  t: number; x: number; y: number; vx: number; vy: number;
  phase: Phase; grounded: boolean; roof: number; maxRoof: number;
  rope: { anchor: number; len: number; target: number } | null; heldFor: number; coyote: number; log: string[];
};

export const FIXED_DT = 1 / 120;

export function createKinematic(level: Level): KState {
  return {
    t: 0, x: 0, y: level.roofs[0].top + HALF_H, vx: 0, vy: 0, phase: "run", grounded: true,
    roof: 0, maxRoof: 0, rope: null, heldFor: 0, coyote: 0, log: [],
  };
}

export function stepKinematic(s: KState, dt: number, input: Input, level: Level, k: Tuning) {
  if (s.phase === "dead" || s.phase === "done") return;
  s.t += dt;
  s.heldFor = input.swingHeld ? s.heldFor + dt : 0;
  s.coyote = Math.max(0, s.coyote - dt);
  const px = s.x, feetBefore = s.y - HALF_H;

  if (s.grounded) {
    s.vx = k.runSpeed;
    if (input.jumpPressed) {
      s.vy = k.jumpSpeed; s.grounded = false; s.log.push(`${s.t.toFixed(2)} jump x=${s.x.toFixed(1)}`);
    }
  } else if (input.jumpPressed && s.coyote > 0) {
    s.vy = k.jumpSpeed; s.coyote = 0; s.log.push(`${s.t.toFixed(2)} jump(coyote) x=${s.x.toFixed(1)}`);
  } else if (!s.rope && input.swingHeld && s.heldFor >= k.holdDelay) {
    const a = pickAnchor(level, s.x, s.y, k.aimRadius);
    if (a >= 0) {
      const d = Math.hypot(level.anchors[a].x - s.x, level.anchors[a].y - s.y);
      s.rope = { anchor: a, len: d, target: d * k.ropeScale };
      s.log.push(`${s.t.toFixed(2)} attach A${a} len=${s.rope.len.toFixed(2)}`);
    }
  } else if (s.rope && !input.swingHeld) {
    const sp = Math.hypot(s.vx, s.vy) || 1;
    s.vx += (s.vx / sp) * k.releaseBoost;
    s.vy += (s.vy / sp) * k.releaseBoost;
    s.log.push(`${s.t.toFixed(2)} release v=(${s.vx.toFixed(1)},${s.vy.toFixed(1)})`);
    s.rope = null;
  }

  // Integrate (semi-implicit Euler).
  if (!s.grounded) s.vy -= k.gravity * dt;
  s.x += s.vx * dt;
  s.y += s.vy * dt;

  // Rope: reel in, then position projection + cancel radial velocity beyond the reel-in rate.
  if (s.rope) {
    const reel = s.rope.len > s.rope.target ? k.reelSpeed : 0;
    s.rope.len = Math.max(s.rope.target, s.rope.len - reel * dt);
    const a = level.anchors[s.rope.anchor];
    const dx = s.x - a.x, dy = s.y - a.y, dist = Math.hypot(dx, dy);
    if (dist > s.rope.len) {
      const nx = dx / dist, ny = dy / dist;
      s.x = a.x + nx * s.rope.len;
      s.y = a.y + ny * s.rope.len;
      const vr = s.vx * nx + s.vy * ny;
      if (vr > -reel) { s.vx -= (vr + reel) * nx; s.vy -= (vr + reel) * ny; }
    }
  }

  // Rooftop collision (AABB feet/sides vs building boxes that extend to the street).
  const feet = s.y - HALF_H;
  let supported = false;
  level.roofs.forEach((r, i) => {
    if (s.x + RADIUS <= r.x0 || s.x - RADIUS >= r.x1) return;
    if (feet > r.top + 1e-6) return;
    if (feetBefore >= r.top - 1e-6 && s.vy <= 0) {
      s.y = r.top + HALF_H; s.vy = 0; supported = true;
      if (!s.grounded) {
        s.grounded = true; s.rope = null; s.roof = i; s.maxRoof = Math.max(s.maxRoof, i);
        s.log.push(`${s.t.toFixed(2)} land roof-${i} x=${s.x.toFixed(2)}`);
      }
    } else if (px + RADIUS <= r.x0 + 1e-6) {
      s.x = r.x0 - RADIUS; s.vx = Math.min(s.vx, 0);
      s.log.push(`${s.t.toFixed(2)} wall roof-${i}`);
    }
  });
  if (s.grounded && !supported) { s.grounded = false; s.coyote = k.coyoteTime; } // ran off the edge
  s.phase = s.grounded ? "run" : s.rope ? "swing" : "air";
  if (feet < failY(level)) { s.phase = "dead"; s.log.push(`${s.t.toFixed(2)} FELL`); }
  if (s.grounded && s.roof === level.roofs.length - 1) { s.phase = "done"; s.log.push(`${s.t.toFixed(2)} DONE`); }
}
