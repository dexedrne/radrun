// SPIDER-TAG wager client: amounts in the token's own decimals, fees, addresses and times as the page shows them.
// Pure TS; no DOM, no chain access (docs/WAGER.md §7.2: decimals and the symbol always come from the token).
import { formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";

/** Parse what a player typed ("12", "0.5", "1,000.25") into base units; null when it is not an amount in these decimals. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(/[,_\s]/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const [, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  try {
    return parseUnits(t.startsWith(".") ? `0${t}` : t.endsWith(".") ? t.slice(0, -1) : t, decimals);
  } catch {
    return null;
  }
}

/**
 * Base units as the page shows them: thousands separators and at most `maxFrac` decimals, cut (never rounded up, so
 * a balance never shows more than there is). A nonzero amount that cuts to zero shows as "<0.0001".
 */
export function formatAmount(v: bigint, decimals: number, maxFrac = 4): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const full = formatUnits(abs, decimals);
  const [int, frac = ""] = full.split(".");
  const cut = frac.slice(0, maxFrac).replace(/0+$/, "");
  const intSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (abs > 0n && intSep === "0" && !cut) return `${neg ? "-" : ""}<0.${"0".repeat(Math.max(0, maxFrac - 1))}1`;
  return `${neg ? "-" : ""}${intSep}${cut ? `.${cut}` : ""}`;
}

/** An amount with its symbol ("194 tSPIDERTAG"). */
export const withSymbol = (v: bigint, decimals: number, symbol: string, maxFrac = 4): string => `${formatAmount(v, decimals, maxFrac)} ${symbol}`;

/** Basis points as a percentage ("3%", "1.5%", "0%"). */
export const bpsText = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

/** "0x1234…abcd". */
export const shortAddress = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** A checksummed address, or null for anything else (named-opponent input, ?join links). */
export function parseAddress(text: string): Address | null {
  const t = text.trim();
  return isAddress(t, { strict: false }) ? getAddress(t) : null;
}

export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** A 32-byte hex id (match ids, hashes) or null. */
export const parseHex32 = (s: string | null | undefined): `0x${string}` | null => (s && /^0x[0-9a-fA-F]{64}$/.test(s) ? (s.toLowerCase() as `0x${string}`) : null);

/** "4:05", "1:02:03" from seconds (never negative). */
export function clockText(s: number): string {
  const t = Math.max(0, Math.ceil(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** "in 3 h", "in 12 min", "in 40 s", "2 h ago" from a unix-seconds time. */
export function relTime(unixS: number, nowS = Date.now() / 1000): string {
  const d = unixS - nowS, a = Math.abs(d);
  const txt = a >= 86_400 ? `${Math.round(a / 86_400)} d` : a >= 3600 ? `${Math.round(a / 3600)} h` : a >= 60 ? `${Math.round(a / 60)} min` : `${Math.round(a)} s`;
  return d >= 0 ? `in ${txt}` : `${txt} ago`;
}

/** A short date and time in the viewer's locale. */
export const dateText = (unixS: number): string =>
  new Date(unixS * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Round length in words ("90 s rounds", "2 min rounds"). */
export const roundText = (s: number): string => (s % 60 === 0 && s >= 120 ? `${s / 60} min rounds` : `${s} s rounds`);
