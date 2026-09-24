// Every player-facing string (spec §12: single definition) + medals, heat labels, share text.
import { MEDALS, type Difficulty } from "../sim/tuning.ts";
import type { RadbroId } from "../game/round.ts";

export const S = {
  title: "RUG RUN",
  pitch: "He swiped your bag. 90 seconds. Tag him or YOINK him before the rug shows up.",
  youChase: "You chase one of the other three",
  countdownBubble: "finders keepers",
  panicBubble: "wtf",
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
  "652": ["too slow, ser", "watch and learn", "catch me if u can", "main character energy", "clip that", "wagmi (not you)"],
  "4764": ["cope", "ngmi", "have fun staying poor", "skill issue", "sir this is my bag", "buying the dip on you"],
  "2564": ["they're watching", "can't catch a ghost", "the balloons are listening", "you're being followed", "who sent you", "rad response team, stand down"],
  "723": ["yeehaw", "this rooftop ain't big enough for the two of us", "catch me at Hot Topic, partner", "you're slower than dial-up", "hold onto your hat", "giddy up, bagholder"],
};

/** Per-character one-liners for the catch / escape beats (#652 showboat, #4764 smug, #2564 paranoid ghost, #723 cowboy). */
export const LINES: Record<"caught" | "escaped", Record<RadbroId, string>> = {
  caught: { "652": "ok ok, good content", "4764": "this changes nothing", "2564": "how did you see me", "723": "well, dang. fair draw, partner" },
  escaped: { "652": "gm, bagholder", "4764": "few understand", "2564": "i was never here", "723": "happy trails, partner" },
};

export const DIFF_LABEL: Record<Difficulty, string> = { chill: "Chill", normal: "Normal", degen: "Degen" };
export const DIFF_BLURB: Record<Difficulty, string> = {
  chill: "he jogs, gets gassed fast, big Yoink range",
  normal: "he sprints when you close in - swing to catch him",
  degen: "faster, smarter, short taunts, 4 m Yoink - chain or get rugged",
};

export const PERSONA: Record<RadbroId, string> = {
  "652": "showboat",
  "4764": "smug",
  "2564": "paranoid ghost",
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
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const r = t - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}

export function shareText(kind: "tag" | "yoink" | "", runner: string, t: number): string {
  return `I ${kind === "yoink" ? "yoinked" : "tagged"} #${runner} in ${t.toFixed(1)} s in Rug Run`;
}
