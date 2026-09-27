// Round 14: the gamepad's prompts. Texts carry button tokens ({R2}, {SOUTH}, {LS}...) that <PadText> draws as
// PlayStation or Xbox glyphs (whichever pad was used last) and padPlain() spells out ("R2 / RT") where only text
// fits (the radbro.fun play guide). The RadRun lines are built from the layout table in input/gamepad.ts.
import { LAYOUT, type PadAction, type PadKind } from "../input/gamepad.ts";

/** A token: a standard-mapping button, or LS / RS (the sticks) / DPAD. */
export type PadToken = "SOUTH" | "EAST" | "WEST" | "NORTH" | "L1" | "R1" | "L2" | "R2" | "SELECT" | "START" | "L3" | "R3" | "LS" | "RS" | "DPAD";

export const PAD_NAMES: Record<PadKind, Record<PadToken, string>> = {
  ps: {
    SOUTH: "Cross", EAST: "Circle", WEST: "Square", NORTH: "Triangle", L1: "L1", R1: "R1", L2: "L2", R2: "R2", SELECT: "Create", START: "Options",
    L3: "L3", R3: "R3", LS: "left stick", RS: "right stick", DPAD: "d-pad",
  },
  xbox: {
    SOUTH: "A", EAST: "B", WEST: "X", NORTH: "Y", L1: "LB", R1: "RB", L2: "LT", R2: "RT", SELECT: "View", START: "Menu",
    L3: "LS click", R3: "RS click", LS: "left stick", RS: "right stick", DPAD: "d-pad",
  },
};

export const TOKEN_RE = /\{(SOUTH|EAST|WEST|NORTH|L1|R1|L2|R2|SELECT|START|L3|R3|LS|RS|DPAD)\}/g;

/** Text with the tokens spelled out for one pad kind, or for both ("Cross / A") when no kind is given. */
export function padPlain(text: string, kind?: PadKind): string {
  return text.replace(TOKEN_RE, (_, t: PadToken) => {
    if (kind) return PAD_NAMES[kind][t];
    const a = PAD_NAMES.ps[t], b = PAD_NAMES.xbox[t];
    return a === b ? a : `${a} / ${b}`;
  });
}

/** The tokens of a RadRun action ("{R1} / {L2}"). */
export const keysOf = (a: PadAction): string => LAYOUT[a].map(b => `{${b}}`).join(" / ");

/** An action's buttons in words for both pad kinds: "R1 or L2 / RB or LT". */
export function plainKeys(a: PadAction): string {
  const ps = LAYOUT[a].map(b => PAD_NAMES.ps[b as PadToken]).join(" or "), xb = LAYOUT[a].map(b => PAD_NAMES.xbox[b as PadToken]).join(" or ");
  return ps === xb ? ps : `${ps} / ${xb}`;
}

/** The title's controls list on a pad: [keys, what it does]. */
export function radrunPadControls(easyGrab = false): [string, string][] {
  const web = easyGrab ? `hold ${keysOf("jump")}` : `hold ${keysOf("web")}`;
  return [
    ["{LS}", "run"],
    ["{RS}", "look / aim"],
    [web, "swing (let go near the top = faster)"],
    [keysOf("zip"), "zip where you look (red dashed ring on him = yank)"],
    [keysOf("jump"), "jump (again in the air = double jump; on a wall = wall kick; end of a zip = pop)"],
    [keysOf("slide"), "tap = slide · hold = charge a leap · in the air = dive"],
    [`red ring on him + ${easyGrab ? keysOf("jump") : keysOf("web")}`, "YOINK"],
    [keysOf("face"), "look at him"],
    [`hold ${keysOf("retry")}`, "retry"],
    [keysOf("pause"), "pause"],
    [keysOf("mute"), "mute"],
  ];
}

/** The in-round reminder line (first 10 s of a round) on a pad. */
export function radrunPadHud(practice: boolean, easyGrab: boolean): string {
  const web = easyGrab ? `hold ${keysOf("jump")}` : `hold ${keysOf("web")}`;
  const base = `{LS} run · ${keysOf("jump")} jump (x2 in the air, wall kick) · ${web} = web · ${keysOf("slide")} slide · ${LAYOUT.zip.map(b => `{${b}}`)[0]} zip`;
  return practice
    ? `${base} · hold ${keysOf("retry")} = back to start · ${keysOf("pause")} = menu`
    : `${base} · red ring = ${easyGrab ? keysOf("jump") : keysOf("web")} to YOINK · ${LAYOUT.face.map(b => `{${b}}`)[0]} look at him · hold ${keysOf("retry")} retry`;
}

/** The menus' legend. */
export const MENU_LEGEND = { move: "{DPAD}", select: "{SOUTH}", back: "{EAST}" } as const;

/** The radbro.fun play guide's controller entries (one control per entry, no commas: the portal joins them with commas). */
export const RADRUN_PAD_GUIDE: readonly string[] = [
  "Controller: left stick run · right stick look / aim",
  `Controller ${plainKeys("web")}: hold to web swing (on the red ring: YOINK)`,
  `Controller ${plainKeys("jump")}: jump / double jump / wall kick · ${plainKeys("slide")}: slide / hold to charge / dive`,
  `Controller ${plainKeys("zip")}: zip where you look (on the red dashed ring: yank) · ${plainKeys("pause")}: pause`,
];
