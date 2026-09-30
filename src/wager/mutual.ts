// SPIDER-TAG wager client: the code two players pass each other to settle a locked match between themselves
// (settleMutual, docs/WAGER.md §3.2): one wallet's signature over a Result, and who signed it. The other page checks it
// and adds its own wallet's signature. Pure TS; no DOM.
import type { Address, Hex } from "viem";
import type { Result } from "./eip712.ts";

export const SETTLE_CODE_PREFIX = "radrun-settle:";

export type SettleCode = { r: Result; sig: Hex; by: Address };

export const encodeSettleCode = (c: SettleCode): string => `${SETTLE_CODE_PREFIX}${btoa(JSON.stringify(c))}`;

export function decodeSettleCode(text: string): SettleCode | null {
  const t = text.trim();
  if (!t.startsWith(SETTLE_CODE_PREFIX)) return null;
  try {
    const j = JSON.parse(atob(t.slice(SETTLE_CODE_PREFIX.length))) as SettleCode;
    if (!j?.r || typeof j.sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(j.sig) || typeof j.by !== "string" || typeof j.r.matchId !== "string") return null;
    return { r: { matchId: j.r.matchId, outcome: Number(j.r.outcome), winner: j.r.winner, feeBps: Number(j.r.feeBps), logHash: j.r.logHash }, sig: j.sig, by: j.by };
  } catch {
    return null;
  }
}
