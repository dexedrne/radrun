// tools/wager-verify.ts --chain (docs/WAGER.md §5.1): how the vault closed a match against the public log. A referee
// Result must carry the log's hash and pay the log's winner at a captured fee (or void a void); a refund after the
// settle window and anything both players signed themselves are reported, not judged.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { judgeChainEnd } from "../tools/wager-verify.ts";
import type { SeriesLog } from "../src/wager/log.ts";

const A = "0x00000000000000000000000000000000000000a1" as Address, B = "0x00000000000000000000000000000000000000b2" as Address;
const H = `0x${"11".repeat(32)}` as Hex, Z = `0x${"00".repeat(32)}` as Hex;
const log = (o: SeriesLog["outcome"]) => ({ players: [A, B], feeBps: 300, holderFeeBps: 150, logHash: H, outcome: o }) as unknown as SeriesLog;
const won = log({ kind: "win", winner: 1, reason: "played", score: [1, 2] });
const voided = log({ kind: "void", winner: null, reason: "noshow", score: [0, 0] });

test("wager:verify --chain: the vault's winner, fee and hash must be the log's; refunds and mutual settles are reported, not judged", () => {
  const settled = (winner: Address, feeBps = 300, logHash = H, mutual = false) => ({ event: "MatchSettled" as const, logHash, winner, feeBps, mutual });
  assert.equal(judgeChainEnd(won, settled(B)).ok, true);
  assert.equal(judgeChainEnd(won, settled(B, 150)).ok, true, "the holder fee");
  assert.equal(judgeChainEnd(won, settled(A)).ok, false, "a referee that paid the loser, with the right hash, is caught");
  assert.equal(judgeChainEnd(won, settled(B, 0)).ok, false);
  assert.equal(judgeChainEnd(won, settled(B, 300, Z)).ok, false);
  assert.equal(judgeChainEnd(voided, settled(A)).ok, false, "a payout for a void");
  assert.equal(judgeChainEnd(won, settled(A, 300, Z, true)).ok, null, "settleMutual is the players' own word");
  const voidEv = (reason: number, logHash = H) => ({ event: "MatchVoided" as const, logHash, reason });
  assert.equal(judgeChainEnd(voided, voidEv(1)).ok, true);
  assert.equal(judgeChainEnd(won, voidEv(1)).ok, false, "a void of a series the log says was won");
  assert.equal(judgeChainEnd(won, voidEv(3, Z)).ok, null, "a refund after the settle window carries no Result");
  assert.match(judgeChainEnd(won, voidEv(3, Z)).text, /refunded/);
  assert.equal(judgeChainEnd(won, voidEv(2, Z)).ok, null);
});
