// Every player-facing string (spec §12: single definition) + medals, heat labels, share text.
import { MEDALS, type Difficulty } from "../sim/tuning.ts";
import { charName, charTag, isRetardio, type RadbroId } from "../game/round.ts";

export const S = {
  title: "SPIDERTAG",
  /** The coin wagers are played for, on its own page (spidertag.vyvanse.beer/token redirects there too). */
  tokenUrl: "https://token.spidertag.vyvanse.beer",
  pitch: "He swiped your bag. 90 seconds. Tag him or YOINK him before the rug shows up.",
  /** The title's terminal-font line under the wordmark, and its "[ OK ]" status line. */
  tagline: "web-slinger tag over the rooftops",
  host: "spidertag.vyvanse.beer",
  /** vyvanse.beer's tip jar (SOL to vyvanse.sol or ETH), opened in a new tab like the shooters' titles. */
  tipUrl: "https://vyvanse.beer/#tip",
  youChase: "You chase one of the others",
  countdownBubble: "finders keepers",
  panicTag: "PANIC",
  gassedBadge: "GASSED",
  gassedFeed: "He's gassed!",
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
  credits: "Radbro #4764, #652, #3704, #3710, #723, #3171 and #2564 · Retardio #555 and #85 · dexedrne · George the cat · built on react-three-game by prnth · Pockit Milady by prnth",
} as const;

/** The title's links to the other vyvanse.beer games, bottom right (their wordmarks in their own colours). */
export const OTHER_GAMES: readonly { id: string; mark: readonly [string, string]; colors: readonly [string, string]; short: string; url: string }[] = [
  { id: "radpayne", mark: ["RAD", "PAYNE"], colors: ["#f3eada", "#ff3fa8"], short: "bullet-time noir", url: "https://radpayne.vyvanse.beer" },
  { id: "rbgo", mark: ["RB", "GO"], colors: ["#ff3fa4", "#22d3ee"], short: "the bomb · Sunbake", url: "https://rbgo.vyvanse.beer" },
  { id: "radzombies", mark: ["RAD", "ZOMBIES"], colors: ["#e9e4ff", "#77ff67"], short: "the dead · Rad Palace", url: "https://radzombies.vyvanse.beer" },
];

/** Runner taunt bubbles (voice taunt_1..6): slots 1-4 are reactions (a laugh, a scoff, a hum), 5-6 the only words. */
export const TAUNTS: Record<RadbroId, string[]> = {
  "652": ["hehe", "ha!", "phew", "hi", "i'll take good care of it", "you're so close"],
  "4764": ["heh", "pff", "ha.", "hm.", "i'm not even running", "take your time"],
  "3704": ["heh", "ha", "phew", "hm", "catch the yellow blur", "next roof, bro"],
  "3710": ["hehe", "oh", "ha", "hey", "green means go", "keep up, bro"],
  "2564": ["hehe", "shh", "ha", "\u266A", "over here", "wrong roof"],
  "723": ["heh heh", "oh, man", "ahh", "nah", "nice day for it", "you good back there?"],
  "3171": ["heh", "oop", "ha", "yeah?", "don't mind the halo", "almost had me"],
  retardio555: ["hehe", "oi", "ha", "mm", "cheers for the bag", "too slow, mate"],
  retardio85: ["heh", "tch", "ha", "hm", "porsche fund, sorry", "i need it more"],
};

/**
 * Per-character bubbles for the panic / cornered / catch / escape lines, as he says them (#652 earnest,
 * #4764 deadpan, #2564 quiet, #723 easygoing, #3171 impish; Retardio #555 cheeky, Retardio #85 saving up).
 */
export const LINES: Record<"panic" | "cornered" | "caught" | "escaped", Record<RadbroId, string>> = {
  panic: { "652": "!", "4764": "!", "3704": "!", "3710": "hey!", "2564": "!", "723": "oh, hey", "3171": "!", retardio555: "oi!", retardio85: "!" },
  cornered: { "652": "nope, sorry", "4764": "nope", "3704": "one more roof", "3710": "wrong turn", "2564": "nope", "723": "oh, nope", "3171": "wasn't me", retardio555: "oh no", retardio85: "nah" },
  caught: { "652": "okay. you got me.", "4764": "bro.", "3704": "nice catch, bro", "3710": "okay, your bag", "2564": "oh. hello.", "723": "fair enough", "3171": "worth a shot", retardio555: "fair cop", retardio85: "there goes the porsche" },
  escaped: { "652": "sorry! good bag though", "4764": "mine now.", "3704": "yellow wins", "3710": "green light, bro", "2564": "thank you", "723": "see ya", "3171": "later", retardio555: "cheers, mate", retardio85: "porsche fund +1" },
};

export const DIFF_LABEL: Record<Difficulty, string> = { chill: "Chill", normal: "Normal", degen: "Degen" };
export const DIFF_BLURB: Record<Difficulty, string> = {
  chill: "he jogs, gets gassed fast, big Yoink range",
  normal: "he sprints when you close in - swing to catch him",
  degen: "faster, smarter, short taunts, 4 m Yoink - chain or get rugged",
};

export const PERSONA: Record<RadbroId, string> = {
  "652": "earnest",
  "4764": "deadpan",
  "3704": "golden",
  "3710": "seafoam",
  "2564": "quiet",
  "723": "easygoing",
  "3171": "impish",
  retardio555: "cheeky",
  retardio85: "saving up",
};

export const RADBRO_COLOR: Record<RadbroId, { body: string; accent: string }> = {
  "652": { body: "#ff8a3d", accent: "#2b2b35" },
  "4764": { body: "#8e6cff", accent: "#16161d" },
  "3704": { body: "#ffd23f", accent: "#18251a" },
  "3710": { body: "#4acb9a", accent: "#16161d" },
  "2564": { body: "#eef3fa", accent: "#b9c6d6" },
  "723": { body: "#a8683a", accent: "#1b1b22" },
  "3171": { body: "#ffb020", accent: "#1a1a1a" },
  retardio555: { body: "#ff7aa8", accent: "#4a3426" },
  retardio85: { body: "#5aa8ff", accent: "#121218" },
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

export function shareText(kind: "tag" | "yoink" | "yank" | "", runner: string, t: number): string {
  return `I ${kind === "yoink" ? "yoinked" : kind === "yank" ? "yanked" : "tagged"} ${isRetardio(runner) ? charName(runner) : charTag(runner)} in ${t.toFixed(1)} s in SPIDERTAG`;
}
