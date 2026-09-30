// SPIDER-TAG wager client: settling a locked match between the two players (docs/WAGER.md §1 safety valves, §3.2
// settleMutual) when the referee is gone. One player picks the result and signs it with the wallet; the page shows a
// code to send the other player, whose page checks that it names this match and was signed by the first player's
// wallet, signs the same Result with its own wallet and submits settleMutual. Session keys can't sign this, and a win
// always pays the match's full captured fee (no holder rate without the referee).
import { useState } from "react";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { SETTLE_CODE_PREFIX, decodeSettleCode, encodeSettleCode, type SettleCode } from "./mutual.ts";
import { useWager, type WagerApp } from "./app.ts";
import type { MatchView } from "./chain.ts";
import { OUTCOME_VOID, OUTCOME_WIN, ZERO_ADDRESS, ZERO_HASH, payout, resultTypedData, type Result } from "./eip712.ts";
import { Amount, C, Notice, input, label, small } from "./ui.tsx";
import { sameAddress, shortAddress } from "./units.ts";

/** Shown on a locked match whose referee seems gone: the two wallets can settle it themselves before settleBy. */
export function MutualPanel({ app, matchId, m, logHash, onDone }: { app: WagerApp; matchId: Hex; m: MatchView; logHash: Hex | null; onDone: (tx: Hex) => void }) {
  const me = useWager(s => s.address);
  const info = useWager(s => s.info);
  const dep = useWager(s => s.dep)!;
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [paste, setPaste] = useState("");
  const [theirs, setTheirs] = useState<SettleCode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me || !info || m.state !== "locked") return null;
  const side = sameAddress(me, m.playerA) ? 0 : sameAddress(me, m.playerB) ? 1 : null;
  if (side === null) return null;
  const other = side === 0 ? m.playerB : m.playerA;
  const result = (winner: Address | null): Result =>
    winner ? { matchId, outcome: OUTCOME_WIN, winner, feeBps: m.feeBps, logHash: logHash ?? ZERO_HASH } : { matchId, outcome: OUTCOME_VOID, winner: ZERO_ADDRESS, feeBps: 0, logHash: logHash ?? ZERO_HASH };
  const say = (r: Result) => (r.outcome === OUTCOME_VOID ? "void: both stakes back" : sameAddress(r.winner, me) ? "you win" : "they win");
  const sign = async (winner: Address | null) => {
    setErr(null);
    setBusy(true);
    const r = result(winner);
    const sig = await app.signResult(r);
    setBusy(false);
    if (sig) setCode(encodeSettleCode({ r, sig, by: me }));
  };
  const check = async (text: string) => {
    setPaste(text);
    setTheirs(null);
    setErr(null);
    if (!text.trim()) return;
    const c = decodeSettleCode(text);
    if (!c) { setErr("that isn't a settle code"); return; }
    if (c.r.matchId.toLowerCase() !== matchId.toLowerCase()) { setErr("that code is for another match"); return; }
    if (!sameAddress(c.by, other)) { setErr("that code wasn't made by your opponent"); return; }
    const ok = c.r.outcome === OUTCOME_VOID ? sameAddress(c.r.winner, ZERO_ADDRESS) && c.r.feeBps === 0
      : c.r.outcome === OUTCOME_WIN && (sameAddress(c.r.winner, m.playerA) || sameAddress(c.r.winner, m.playerB)) && c.r.feeBps === m.feeBps;
    if (!ok) { setErr("the vault wouldn't take that result"); return; }
    const signer = await recoverTypedDataAddress({ ...resultTypedData(dep.chainId, app.chain!.vault, c.r), signature: c.sig }).catch(() => null);
    if (!signer || !sameAddress(signer, other)) { setErr("the signature in that code isn't your opponent's wallet"); return; }
    setTheirs(c);
  };
  const submit = async () => {
    if (!theirs) return;
    setBusy(true);
    const mine = await app.signResult(theirs.r);
    const tx = mine ? await app.settleMutual(theirs.r, side === 0 ? mine : theirs.sig, side === 0 ? theirs.sig : mine) : null;
    setBusy(false);
    if (tx) onDone(tx);
  };
  const pay = payout(m.stake, m.feeBps);
  return (
    <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: C.card, border: `1px solid ${C.line}`, fontSize: 13 }} data-testid="wager-mutual">
      {!open ? (
        <div>
          the referee is gone? <button style={small(false)} onClick={() => setOpen(true)} data-testid="wager-mutual-open">SETTLE IT BETWEEN YOU</button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ lineHeight: 1.5 }}>
            Both wallets sign the same result and the vault pays it: a win pays <Amount v={pay.winner} decimals={info.decimals} symbol={info.symbol} /> (fee {m.feeBps / 100}%), a void gives both stakes back.
            Possible until the settle deadline; after it, anyone can refund.
          </div>
          <div>
            <div style={label}>1 · one of you picks and signs</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              <button style={small(false)} disabled={busy} onClick={() => void sign(me)} data-testid="wager-mutual-me">I WON</button>
              <button style={small(false)} disabled={busy} onClick={() => void sign(other)} data-testid="wager-mutual-them">{shortAddress(other)} WON</button>
              <button style={small(false)} disabled={busy} onClick={() => void sign(null)} data-testid="wager-mutual-void">VOID</button>
            </div>
            {code && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 12, color: C.dim }}>send this code to your opponent ({say(decodeSettleCode(code)!.r)}):</div>
                <textarea readOnly value={code} onFocus={e => e.currentTarget.select()} style={{ ...input, width: "100%", height: 54, fontSize: 11, fontFamily: "ui-monospace, monospace" }} data-testid="wager-mutual-code" />
              </div>
            )}
          </div>
          <div>
            <div style={label}>2 · the other pastes it, checks it and submits</div>
            <textarea value={paste} onChange={e => void check(e.target.value)} placeholder={`${SETTLE_CODE_PREFIX}…`} style={{ ...input, width: "100%", height: 54, fontSize: 11, marginTop: 4, fontFamily: "ui-monospace, monospace" }} data-testid="wager-mutual-paste" />
            {theirs && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                <span>your opponent signed: <b>{say(theirs.r)}</b></span>
                <button style={small(true)} disabled={busy} onClick={() => void submit()} data-testid="wager-mutual-submit">SIGN AND SETTLE</button>
              </div>
            )}
          </div>
          {err && <Notice kind="error" text={err} />}
        </div>
      )}
    </div>
  );
}
