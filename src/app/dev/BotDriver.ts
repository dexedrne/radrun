// ?bot=follow|yoink|chase (dev and test builds only): skip the title and play a whole round with a
// test bot from game/bots.ts (follow / yoink = the kinematic follower; chase = the swinging chaser
// SwingBot on the real player sim, same result as Node). ?bot=swing instead drives the real player sim
// with the scripted chain-swinger (app/autoplay.ts) - no catch expected; it is for mid-swing
// screenshots. Params: k (follower speed factor), seed, d (chill|normal|degen), c / r (Radbro ids);
// rec (with bot=chase): the bot's inputs go through the ghost codec, so a catch gives a ghost link
// (window.__play.ghost.url) like a player's round. snap (any bot): freeze the sim 0.12 s into each of
// the chaser's airborne jumps / rope releases (window.__frozen, __frozenWhy = "jump" | "release") so a
// screenshot catches the airborne pose; resume through window.__unfreeze. Round 7: snap=freefall,sky,
// runnerff (any subset) instead freezes once each: the chaser 0.45 s into his Free_Fall loop, 0.35 s
// into a swing (sky: on a tower anchor), the runner 0.45 s into his free fall.
// Progress and the outcome are exposed on window.__play (PlayDriver).
import type { PlayGame } from "../../game/play.ts";
import { RADBROS, type RadbroId } from "../../game/round.ts";
import { EV_JUMP, EV_RELEASE } from "../../sim/player.ts";
import { DIFFICULTIES, type Difficulty } from "../../sim/tuning.ts";
import { autoplayScript } from "../autoplay.ts";
import { PHASE_AIR } from "../../route/trackPack.ts";
import { rigs } from "../ActorsView.tsx";

export function botParams(search: string): { kind: "follow" | "yoink" | "swing" | "chase"; k: number; seed: number; d: Difficulty; c: RadbroId; r: RadbroId; rec: boolean; moves: boolean; snap: boolean; snapKinds: string[]; mu: number } | null {
  const q = new URLSearchParams(search);
  const kind = q.get("bot");
  if (kind !== "follow" && kind !== "yoink" && kind !== "swing" && kind !== "chase") return null;
  const id = (v: string | null, dflt: RadbroId) => (v && (RADBROS as readonly string[]).includes(v) ? (v as RadbroId) : dflt);
  const c = id(q.get("c"), "652");
  let r = id(q.get("r"), c === "4764" ? "652" : "4764");
  if (r === c) r = RADBROS.find(x => x !== c)!;
  return {
    kind,
    k: Number(q.get("k") ?? 1.3) || 1.3,
    seed: Number(q.get("seed") ?? 123) >>> 0,
    d: (DIFFICULTIES as readonly string[]).includes(q.get("d") ?? "") ? (q.get("d") as Difficulty) : "chill",
    c,
    r,
    rec: q.has("rec"),
    /** Round 9: `&moves` = the chase bot also double-jumps, slides and web-zips (the balance rows' bot). */
    moves: q.has("moves"),
    snap: q.has("snap"),
    snapKinds: (q.get("snap") ?? "").split(",").filter(Boolean),
    /** Round 4 mutator bits (&mu=); default = none (predictions in tools/botshot use the same). */
    mu: (Number(q.get("mu") ?? 0) >>> 0) & 127,
  };
}

export function startBot(game: PlayGame, p: NonNullable<ReturnType<typeof botParams>>): void {
  game.botOptions = p.kind === "swing" ? null : p.kind === "chase" ? { kind: "swing", k: 1, yoink: true, moves: p.moves } : { kind: "follow", k: p.k, yoink: p.kind === "yoink" };
  game.recordBot = p.rec;
  game.startRound({ chaser: p.c, runner: p.r, difficulty: p.d, seed: p.seed, mutators: p.mu });
  if (p.kind === "swing") {
    const script = autoplayScript({
      get body() { return game.round.player; },
      rig: game.rig,
      model: game.model,
      get stats() { return game.round.stats; },
      get spawnYaw() { return game.round.spawn.yaw; },
    });
    // Freeze the sim 0.25 s into each swing so a screenshot catches the hang (tools/botshot resumes it
    // through window.__unfreeze).
    let onRope = 0;
    const w = window as unknown as { __frozen?: boolean; __unfreeze?: () => void };
    w.__unfreeze = () => { w.__frozen = false; game.paused = false; };
    game.input.script = (f, i) => {
      script(f, i);
      const b = game.round.player;
      onRope = b.ropeSolid >= 0 ? onRope + 1 : 0;
      if (onRope === 30 && game.round.phase === "chase") { w.__frozen = true; game.paused = true; }
    };
  }
  if (p.snap) { if (p.snapKinds.length) snapRound7(game, p.snapKinds); else snapAirborne(game); }
  console.info(`[rug-run] bot=${p.kind} k=${p.k} seed=${p.seed} d=${p.d} c=${p.c} r=${p.r}${p.rec ? " rec" : ""}`);
}

/** ?snap=freefall,sky,runnerff (round 7): freeze once per kind (see the header). */
function snapRound7(game: PlayGame, kinds: string[]): void {
  const w = window as unknown as { __frozen?: boolean; __frozenWhy?: string; __unfreeze?: () => void };
  w.__unfreeze = () => { w.__frozen = false; game.paused = false; };
  const left = new Set(kinds);
  let sky = 0;
  const frame = game.frame.bind(game);
  game.frame = (delta: number) => {
    const n = frame(delta);
    if (game.round.phase !== "chase" || w.__frozen) return n;
    const s = game.setup, b = game.round.player;
    const chaser = rigs.get(s.chaser), runner = rigs.get(s.runner);
    // "sky" (round 7) = a long web from high up (a tower / needle anchor 30+ m above).
    sky = b.ropeSolid >= 0 && b.ropeA.y - b.p.y >= 30 ? sky + delta : 0;
    let why = "";
    // (the rig's machine lags the sim by a frame: also require the body to be falling free right now)
    const run = game.round.runner.pose;
    if (left.has("freefall") && chaser?.machine.ff && chaser.machine.ffT >= 0.45 && !b.grounded && b.ropeSolid < 0 && b.v.y < -3) why = "freefall";
    else if (left.has("sky") && sky >= 0.35) why = "sky";
    else if (left.has("runnerff") && runner?.machine.ff && runner.machine.ffT >= 0.45 && run.phase === PHASE_AIR) why = "runnerff";
    if (why) {
      left.delete(why);
      w.__frozenWhy = why;
      w.__frozen = true;
      game.paused = true;
    }
    return n;
  };
}

/** ?snap: freeze 0.12 s after each airborne jump / rope release of the chaser (animation screenshots). */
function snapAirborne(game: PlayGame): void {
  const w = window as unknown as { __frozen?: boolean; __frozenWhy?: string; __unfreeze?: () => void };
  w.__unfreeze = () => { w.__frozen = false; game.paused = false; };
  let armed = "", t = 0;
  const frame = game.frame.bind(game);
  game.frame = (delta: number) => {
    const n = frame(delta);
    const b = game.round.player, ev = game.frameEvents;
    if (ev & (EV_JUMP | EV_RELEASE)) { armed = ev & EV_RELEASE ? "release" : "jump"; t = 0; }
    if (armed && (b.grounded || b.ropeSolid >= 0 || game.round.phase !== "chase")) armed = "";
    if (armed && n > 0 && (t += delta) >= 0.12) {
      w.__frozenWhy = armed;
      w.__frozen = true;
      game.paused = true;
      armed = "";
    }
    return n;
  };
}
