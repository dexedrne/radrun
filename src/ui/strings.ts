// Every player-facing string (spec §12: single definition) + medals, heat labels, share text.
import { MEDALS, type Difficulty } from "../sim/tuning.ts";
import type { RadbroId } from "../game/round.ts";

export const S = {
  title: "RADRUN",
  pitch: "He swiped your bag. 90 seconds. Tag him or YOINK him before the rug shows up.",
  youChase: "You chase one of the other three",
  countdownBubble: "finders keepers",
  panicBubble: "it's so over",
  panicTag: "PANIC",
  gassedBadge: "GASSED",
  gassedFeed: "He's gassed!",
  corneredBubble: "pls no",
  fall: "rekt.",
  escape: "He rugged you.",
  goneFishing: "gone fishing",
  yoink: "YOINK",
  go: "GO!",
  loading: "LOADING",
  paused: "PAUSED",
  practice: "PRACTICE",
  ghost: "GHOST",
  autoLow: "switched to Low quality for smoother play — change in Settings",
  credits: "Radbro #652, #4764, #2564 and #723 · dexedrne · George the cat · built on react-three-game by prnth · Pockit Milady by prnth",
} as const;

export const TAUNTS: Record<RadbroId, string[]> = {
  "652": ["stay rad, fren", "catch me if u can", "this bag is so comfy", "we're so back", "gm from up here", "wagmi (except u)"],
  "4764": ["cope, fren", "the katana is just for vibes", "network spirituality. u wouldn't get it", "milady would be disappointed", "kino chase tbh", "tfw too slow"],
  "2564": ["boo, fren", "can't catch a ghost", "the miladys are watching", "just vibes and tin foil", "the balloons are listening", "so comfy in the void"],
  "723": ["howdy, fren", "yeehaw", "mighty comfy up here", "hold onto ur hat", "stay rad, partner", "we're so back, y'all"],
};

/** Per-character one-liners for the catch / escape beats (#652 sweet, #4764 deadpan, #2564 ghost, #723 cowboy). */
export const LINES: Record<"caught" | "escaped", Record<RadbroId, string>> = {
  caught: { "652": "ok... u got me, fren", "4764": "based, i guess", "2564": "how did u see me", "723": "well dang. gg, fren" },
  escaped: { "652": "gn, fren", "4764": "few understand", "2564": "i was never here, fren", "723": "happy trails, fren" },
};

export const DIFF_LABEL: Record<Difficulty, string> = { chill: "Chill", normal: "Normal", degen: "Degen" };
export const DIFF_BLURB: Record<Difficulty, string> = {
  chill: "he jogs, gets gassed fast, big Yoink range",
  normal: "he sprints when you close in - swing to catch him",
  degen: "faster, smarter, short taunts, 4 m Yoink - chain or get rugged",
};

export const PERSONA: Record<RadbroId, string> = {
  "652": "sweet",
  "4764": "deadpan",
  "2564": "ghost",
  "723": "cowboy",
};

export const RADBRO_COLOR: Record<RadbroId, { body: string; accent: string }> = {
  "652": { body: "#ff8a3d", accent: "#2b2b35" },
  "4764": { body: "#8e6cff", accent: "#16161d" },
  "2564": { body: "#eef3fa", accent: "#b9c6d6" },
  "723": { body: "#a8683a", accent: "#1b1b22" },
};

export function heat(d: number): { label: string; color: string; fill: number } {
  if (d < 8) return { label: "ON HIS HEELS", color: "#ff3b3b", fill: 1 };
  if (d < 20) return { label: "HOT", color: "#ff8a3d", fill: 0.75 };
  if (d <= 40) return { label: "WARM", color: "#ffd23f", fill: 0.45 };
  return { label: "COLD", color: "#6ec6ff", fill: 0.18 };
}

export function medal(d: Difficulty, t: number): string {
  const m = MEDALS[d];
  if (t <= m.rad) return "RAD";
  if (t <= m.gold) return "GOLD";
  if (t <= m.silver) return "SILVER";
  return "BRONZE";
}

export const MEDAL_COLOR: Record<string, string> = { RAD: "#ff4fd8", GOLD: "#ffd23f", SILVER: "#d7dde6", BRONZE: "#d08a4a" };

export function clockText(s: number): string {
  // Round to tenths first (9.96 s left used to print "1:010.0", 59.96 s "0:60.0").
  const tenths = Math.round(Math.max(0, s) * 10);
  const m = Math.floor(tenths / 600);
  const r = (tenths - m * 600) / 10;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}

export function shareText(kind: "tag" | "yoink" | "", runner: string, t: number): string {
  return `I ${kind === "yoink" ? "yoinked" : "tagged"} #${runner} in ${t.toFixed(1)} s in RadRun`;
}
