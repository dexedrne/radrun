// The move from radrun.vyvanse.beer to spidertag.vyvanse.beer: a browser keeps saves per address (campaign stars,
// settings, bests and ghosts, the TAG menu, the wager wallet and session keys), so the new address starts empty.
// Once per browser, the game at the new address loads the old address's /carry.html in a hidden frame (the same site,
// so that frame sees the old saves; vercel.json keeps that one path from redirecting), which posts back every
// rugrun.* / radrun.* key. Those are written here (the old values win: this page has only had a moment to write its
// defaults) and the page reloads once so everything reads them. No answer within 10 s: nothing is marked, and the
// next visit tries again. Anywhere but the new address (dev, previews, the old address itself) it does nothing.
export const NEW_ORIGIN = "https://spidertag.vyvanse.beer";
export const OLD_ORIGIN = "https://radrun.vyvanse.beer";
export const CARRY_MSG = "spidertag:carry";
export const CARRIED = "spidertag.carried";
const SAVE_KEY = /^(rugrun|radrun)\./;

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };

/** Write the old address's saves (string values of rugrun.* / radrun.* keys only); returns how many keys changed. */
export function applyCarry(store: KV, items: unknown): number {
  if (!items || typeof items !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(items as Record<string, unknown>)) {
    if (!SAVE_KEY.test(k) || typeof v !== "string" || store.getItem(k) === v) continue;
    store.setItem(k, v);
    n++;
  }
  return n;
}

/** main.tsx calls it once, before the first render. */
export function carryOldSaves(w: Window = window): void {
  if (w.location.origin !== NEW_ORIGIN) return;
  let store: Storage;
  try {
    store = w.localStorage;
    if (store.getItem(CARRIED)) return;
  } catch {
    return; // no storage: nothing to carry into
  }
  const t0 = performance.now();
  const frame = w.document.createElement("iframe");
  const stop = () => {
    clearTimeout(timer);
    w.removeEventListener("message", onMessage);
    frame.remove();
  };
  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: unknown; items?: unknown } | null;
    if (e.origin !== OLD_ORIGIN || e.source !== frame.contentWindow || !d || d.type !== CARRY_MSG) return;
    stop();
    let n = 0;
    try {
      n = applyCarry(store, d.items);
      store.setItem(CARRIED, "1");
    } catch {
      return; // storage full or blocked: try again next visit
    }
    // Only right after the load (never under a round already being played): later, the saves count from the next visit.
    if (n > 0 && performance.now() - t0 < 20_000) w.location.reload();
  };
  const timer = setTimeout(stop, 10_000);
  w.addEventListener("message", onMessage);
  frame.src = `${OLD_ORIGIN}/carry.html`;
  frame.title = "carry saves";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  w.document.body.appendChild(frame);
}
