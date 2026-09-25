// Safe-area insets (spec §4 "Touch"). With viewport-fit=cover the canvas runs edge to edge on phones,
// so fixed HUD pieces and touch buttons add the inset on their side: the notch / Dynamic Island side
// and the home indicator never cover a control. The inset is 0 on desktop, so nothing moves there.
export type Side = "top" | "right" | "bottom" | "left";

/** `px` plus the safe-area inset on that side, as a CSS length. */
export const safe = (side: Side, px: number): string => `calc(${px}px + env(safe-area-inset-${side}, 0px))`;

/** Padding that keeps a full-screen layer's content inside the safe area. */
export const safePad = "env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)";
