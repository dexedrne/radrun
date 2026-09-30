// SPIDER-TAG wager client: your matches, from the vault's events (docs/WAGER.md §3.9): MatchLocked as player A or B,
// then how each ended (MatchSettled / MatchVoided, or your own StakeReclaimed). Date, opponent, stake, result, payout, transactions and the
// verify link. Nothing here comes from the relay.
import { useEffect, useState } from "react";
import { useWager, type WagerApp } from "./app.ts";
import { VaultChain, type HistoryRow } from "./chain.ts";
import { keepParams } from "./site.ts";
import { Amount, C, Section, TxLink, small } from "./ui.tsx";
import { ConnectWallet } from "./WalletPanel.tsx";
import { classifyError } from "./errors.ts";
import { dateText, shortAddress } from "./units.ts";

const VOIDS: Record<number, string> = { 1: "void", 2: "void (both agreed)", 3: "refunded (timeout)" };

export function HistoryView({ app }: { app: WagerApp }) {
  const address = useWager(s => s.address);
  const info = useWager(s => s.info);
  const dep = useWager(s => s.dep)!;
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [partial, setPartial] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!address || !app.chain || !info) return;
    let live = true;
    setRows(null);
    setErr(null);
    app.chain.history(address).then(r => {
      if (!live) return;
      setRows(VaultChain.withLockTimes(r.rows, info.settleWindow));
      setPartial(r.partial);
    }, e => live && setErr(classifyError(e).message));
    return () => { live = false; };
  }, [address, app, info, n]);
  if (!address) return <Section title="HISTORY" testid="wager-history"><ConnectWallet app={app} /></Section>;
  const d = info?.decimals ?? 18, sym = info?.symbol ?? "";
  return (
    <Section title="HISTORY" testid="wager-history">
      {err && <div style={{ color: C.red, fontSize: 13 }}>{err} <button style={small(false)} onClick={() => setN(n + 1)}>RETRY</button></div>}
      {!rows && !err && <div style={{ opacity: 0.8 }}>reading the vault's events…</div>}
      {rows && rows.length === 0 && <div style={{ opacity: 0.8 }}>no matches yet</div>}
      {rows && rows.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          {rows.map(r => {
            const col = r.state === "won" ? C.green : r.state === "lost" ? C.red : C.ice;
            return (
              <div key={r.matchId} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", padding: "6px 10px", borderRadius: 8, background: C.card, fontSize: 13 }} data-testid="wager-history-row">
                <span style={{ width: 118, color: C.dim, fontSize: 12 }}>{r.lockedAt > 0 ? dateText(r.lockedAt) : ""}</span>
                <span style={{ flex: "1 1 120px" }}>vs {shortAddress(r.opponent)}</span>
                <span><Amount v={r.stake} decimals={d} symbol={sym} /></span>
                <span style={{ color: col, fontWeight: 900, minWidth: 70 }}>{r.state === "won" ? "WON" : r.state === "lost" ? "LOST" : r.state === "void" ? VOIDS[r.voidReason ?? 1] ?? "void" : r.state === "reclaimed" ? "stake taken back" : "LIVE"}</span>
                {r.state === "won" && <span>+<Amount v={r.payout} decimals={d} symbol={sym} /></span>}
                <span style={{ display: "flex", gap: 8, fontSize: 12 }}>
                  <TxLink dep={dep} hash={r.lockTx} text="lock" />
                  <TxLink dep={dep} hash={r.endTx} text={r.state === "void" || r.state === "reclaimed" ? "refund" : "settle"} />
                  <a href={`?wager&verify=${r.matchId}${keepParams()}`} style={{ color: C.ice }}>verify</a>
                  {r.state === "locked" && <a href={`?wager&match=${r.matchId}${keepParams()}`} style={{ color: C.gold }}>open</a>}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {partial && <div style={{ fontSize: 11, color: C.dim, marginTop: 6 }}>older matches weren't loaded (the network limits how far back one page reads)</div>}
    </Section>
  );
}
