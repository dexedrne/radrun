// vyvanse.beer plays this game inside its page, in a full-screen iframe. A pad gets back to its menu by holding
// View + Menu, but once the game has the focus a keyboard can't, so framed there the pause menu and the title
// offer "back to vyvanse.beer": it posts { type: "vyvanse:menu" } to the parent (to that origin only, never "*")
// and the launcher closes the game. Opened on its own, or framed by any other page (radbro.fun's portal
// included), nothing shows and nothing is sent. Dev and test builds also accept an http://localhost or
// http://127.0.0.1 parent (the headless check frames the dev server from a page there).

export const VYVANSE_ORIGIN = "https://vyvanse.beer";
export const VYVANSE_MENU = { type: "vyvanse:menu" } as const;
const DEV_PARENT = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MEMO = "rugrun.vyvanseParent";

/** The parts of `window` the hook uses (a fake one in the tests). */
export type VyvanseWindow = {
  top: unknown;
  parent: unknown;
  location: { origin: string; ancestorOrigins?: ArrayLike<string> };
  document: { referrer: string };
  sessionStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
};
type Target = { postMessage(message: unknown, targetOrigin: string): void };

const originOf = (url: string): string | null => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

/** The vyvanse.beer parent's origin when this page is framed by it (or by a dev parent in a dev build), else null. */
export function vyvanseParent(w: VyvanseWindow, dev: boolean): string | null {
  if (w.top === w) return null;
  const ok = (o: string | null | undefined): o is string => !!o && (o === VYVANSE_ORIGIN || (dev && DEV_PARENT.test(o)));
  const anc = w.location.ancestorOrigins;
  const parent = anc?.[0];
  const ref = originOf(w.document.referrer);
  const found = ok(parent) ? parent : ok(ref) ? ref : null;
  // A district switch or SPIDER-TAG reloads the frame, and the referrer becomes this game's own page; a browser
  // without ancestorOrigins then keeps what the frame's first page found (in this tab's session storage).
  try {
    const st = w.sessionStorage;
    if (!found && !anc && ref === w.location.origin) {
      const memo = st?.getItem(MEMO);
      return ok(memo) ? memo : null;
    }
    if (found) st?.setItem(MEMO, found);
    else st?.removeItem(MEMO);
  } catch {
    /* no storage: fine */
  }
  return found;
}

export type VyvanseHook = {
  /** The parent's origin (framed by vyvanse.beer), else null: no entry, back() does nothing. */
  readonly origin: string | null;
  /** Ask vyvanse.beer to close the game and show its menu. */
  back(): void;
};

export function createVyvanseHook(w: VyvanseWindow, dev: boolean): VyvanseHook {
  const origin = vyvanseParent(w, dev);
  return {
    origin,
    back: () => {
      if (!origin) return;
      try {
        (w.parent as Target).postMessage({ ...VYVANSE_MENU }, origin);
      } catch {
        /* parent gone */
      }
    },
  };
}

let current: VyvanseHook = { origin: null, back() {} };
/** main.tsx starts it once. */
export function startVyvanseHook(dev: boolean): VyvanseHook {
  current = createVyvanseHook(window as unknown as VyvanseWindow, dev);
  return current;
}
/** Framed by vyvanse.beer: show the "back to vyvanse.beer" entries. */
export const vyvanseFramed = (): boolean => current.origin !== null;
export const backToVyvanse = (): void => current.back();
