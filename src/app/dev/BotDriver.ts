// ?bot=follow|yoink (dev and test builds only): skip the title and play a whole round with the pure
// test bot from game/bots.ts. Params: k (follower speed factor), seed, d (chill|normal), c / r (Radbro
// ids). Progress and the outcome are exposed on window.__play (PlayDriver).
import type { PlayGame } from "../../game/play.ts";
import { RADBROS, type RadbroId } from "../../game/round.ts";

export function botParams(search: string): { kind: "follow" | "yoink"; k: number; seed: number; d: "chill" | "normal"; c: RadbroId; r: RadbroId } | null {
  const q = new URLSearchParams(search);
  const kind = q.get("bot");
  if (kind !== "follow" && kind !== "yoink") return null;
  const id = (v: string | null, dflt: RadbroId) => (v && (RADBROS as readonly string[]).includes(v) ? (v as RadbroId) : dflt);
  const c = id(q.get("c"), "652");
  let r = id(q.get("r"), c === "4764" ? "652" : "4764");
  if (r === c) r = RADBROS.find(x => x !== c)!;
  return {
    kind,
    k: Number(q.get("k") ?? 1.3) || 1.3,
    seed: Number(q.get("seed") ?? 123) >>> 0,
    d: q.get("d") === "normal" ? "normal" : "chill",
    c,
    r,
  };
}

export function startBot(game: PlayGame, p: NonNullable<ReturnType<typeof botParams>>): void {
  game.botOptions = { kind: "follow", k: p.k, yoink: p.kind === "yoink" };
  game.startRound({ chaser: p.c, runner: p.r, difficulty: p.d, seed: p.seed });
  console.info(`[rug-run] bot=${p.kind} k=${p.k} seed=${p.seed} d=${p.d} c=${p.c} r=${p.r}`);
}
