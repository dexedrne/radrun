// SPIDER-TAG wager client: the verify page's verdict lines (docs/WAGER.md §7.3 "Verify"), apart from the page so tests
// can check them. The replay's verdict, plus what ties the log to the chain: the log is this page's match on this
// vault, the hash of the log's contents equals the one the vault stored, and the vault paid the replayed winner (or
// voided a series the log says is void). A refund after the settle window stores no log hash, so that check is skipped
// for it, and a settle both players signed themselves is theirs to decide. Pure TS.
import type { Address, Hex } from "viem";
import { VOID_MUTUAL, VOID_TIMEOUT } from "./eip712.ts";
import { seriesLogHash, type SeriesLog } from "./log.ts";
import type { SeriesVerdict } from "./replay.ts";
import type { MatchEnd } from "./chain.ts";
import { sameAddress, shortAddress } from "./units.ts";

/** ok: passed; false: failed; null: not there yet (a live or held series has nothing on chain). */
export type Check = { ok: boolean | null; text: string };

export function matchChecks(o: {
  log: SeriesLog;
  verdict: SeriesVerdict;
  /** How the match ended on chain: undefined while reading, null when it hasn't ended there. */
  end: MatchEnd | null | undefined;
  held: boolean;
  /** This page's network, vault (null when it isn't known yet) and match. */
  page: { chainId: number; vault: Address | null; matchId: Hex };
}): Check[] {
  const { log, verdict, end, page } = o;
  const checks: Check[] = [];
  const mine = log.chainId === page.chainId && (page.vault === null || sameAddress(log.vault, page.vault)) && log.matchId.toLowerCase() === page.matchId.toLowerCase();
  checks.push({ ok: mine, text: mine ? "the log is this match's, on this vault" : "the relay served a log for another match, vault or network" });
  checks.push({ ok: verdict.ok, text: verdict.ok ? "the replay of every round gives the logged results and outcome" : "the replay found problems (below)" });
  if (end === undefined) {
    checks.push({ ok: null, text: "reading the chain…" });
    return checks;
  }
  if (end === null) {
    checks.push({ ok: null, text: o.held ? "held for review: nothing on chain until the review (or a refund after the settle window)" : "not settled on chain yet" });
    return checks;
  }
  if (end.kind === "voided" && end.reason === VOID_TIMEOUT) {
    // refundExpired stores no log hash (nobody signed a result): both stakes went back, whatever the log says.
    checks.push({ ok: true, text: "refunded after the settle window: nobody settled it, so both stakes went back" });
    return checks;
  }
  if ((end.kind === "settled" && end.mutual) || (end.kind === "voided" && end.reason === VOID_MUTUAL)) {
    // settleMutual: both players' wallets signed the result themselves (the referee was gone): their agreement decides it.
    checks.push({ ok: true, text: "settled by both players' own wallet signatures, not the referee: the log doesn't decide it" });
    return checks;
  }
  // The hash of the log's own contents (not the hash the log claims for itself): a log edited after the settle can't
  // pass by keeping the old logHash field.
  const h = seriesLogHash(log);
  const sameHash = end.logHash.toLowerCase() === h.toLowerCase();
  checks.push({ ok: sameHash, text: sameHash ? "the log hashes to the one the vault stored at settle" : `the vault stored ${end.logHash}, the log hashes to ${h}` });
  if (end.kind === "settled") {
    const w = log.outcome.kind === "win" && log.outcome.winner !== null ? log.players[log.outcome.winner] : null;
    const paid = !!w && sameAddress(w, end.winner);
    checks.push({ ok: paid, text: paid ? `the vault paid the replayed winner (${shortAddress(end.winner)})` : "the vault's winner differs from the log's" });
  } else {
    const isVoid = log.outcome.kind === "void";
    checks.push({ ok: isVoid, text: isVoid ? "voided, as the log says" : "the vault voided a series the log says was won" });
  }
  return checks;
}
