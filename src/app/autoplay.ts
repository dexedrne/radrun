// ?autoplay: a scripted chain-swinger for smoke screenshots (the canyon-probe policy). Walks from the
// spawn to its street edge, turns to look down the street, webs the ringed building, lets go once past the
// pivot on the way up and re-grabs; after a landing or respawn it starts over. Also drives ?bot=swing (a
// real round with the real characters, for mid-swing screenshots).
import type { Body, InputFrame } from "../sim/player.ts";
import { rigLook, type Rig } from "../camera/rig.ts";
import type { CityModel } from "../world/cityModel.ts";

/** What the script needs (the sandbox, or a round via ?bot=swing). */
export type AutoplayTarget = { readonly body: Body; readonly rig: Rig; readonly model: CityModel; readonly stats: { readonly falls: number }; readonly spawnYaw: number };

export function autoplayScript(game: AutoplayTarget): (f: InputFrame, i: number) => void {
  let mode: "walk" | "swing" = "walk";
  let held = false, press = false, cooldown = 0;
  let sx = 0, sz = 0, startYaw = game.rig.yaw;
  const restart = () => {
    mode = "walk";
    held = false;
    sx = game.body.p.x;
    sz = game.body.p.z;
    startYaw = game.spawnYaw;
    game.rig.yaw = startYaw;
    game.rig.pitch = 0.25;
    rigLook(game.rig, 0, 0, 0, false);
  };
  restart();
  let lastSteps = -1;
  return f => {
    const b = game.body;
    const r = game.rig;
    if (game.stats.falls !== lastSteps) { if (lastSteps >= 0) restart(); lastSteps = game.stats.falls; }
    f.jumpPressed = false;
    if (mode === "walk") {
      f.moveX = -r.sy; f.moveZ = -r.cy;
      const along = (b.p.x - sx) * -r.sy + (b.p.z - sz) * -r.cy;
      if (along >= 4.8) {
        // Turn 90 degrees to look down the street, then zip.
        r.yaw = startYaw - Math.PI / 2;
        rigLook(r, 0, 0, 0, false);
        mode = "swing";
        held = true;
        press = true;
      }
    } else {
      f.moveX = -r.sy; f.moveZ = -r.cy;
      if (b.ropeSolid >= 0) {
        const h = b.ropeP;
        const ahead = (b.p.x - h.x) * -r.sy + (b.p.z - h.z) * -r.cy;
        const hs = Math.sqrt(b.v.x * b.v.x + b.v.z * b.v.z);
        if (ahead >= 0 && b.v.y > 0 && b.v.y >= 0.4 * hs) { held = false; cooldown = 6; }
      } else if (b.grounded) {
        held = true;
        press = b.ringId >= 0;
      } else if (!held && --cooldown <= 0) {
        held = true;
        press = true;
      }
    }
    f.webPressed = press;
    f.webHeld = held;
    press = false;
  };
}
