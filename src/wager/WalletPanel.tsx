// SPIDER-TAG wager client: the wallet panel (docs/WAGER.md §7.3). Connect (EIP-6963 wallets), the right network,
// balances (wallet, free and locked in the vault, gas), deposit (approve exactly the amount, then deposit), withdraw
// (an amount or all, optionally to another address), the test-network faucet, the session key ("play without
// popups": its limits, used / cap, expiry, revoke) and, for Radbro holders, the name and cosmetics.
import { useState } from "react";
import { cleanName } from "../net/wire.ts";
import type { WagerApp } from "./app.ts";
import { useWager } from "./app.ts";
import { checkSession } from "./sessionKey.ts";
import type { TrailStyle, WebColor } from "./protocol.ts";
import { Amount, C, Notice, Section, TxList, WEB_COLORS, btn, input, label, small } from "./ui.tsx";
import { formatAmount, parseAddress, parseAmount, relTime } from "./units.ts";

const NUM = "0123456789.";

export function ConnectWallet({ app }: { app: WagerApp }) {
  const wallets = useWager(s => s.wallets);
  const busy = useWager(s => s.busy);
  return (
    <div data-testid="wager-connect">
      {wallets.length === 0 ? (
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          No browser wallet found. Install one (MetaMask, Rabby, …) and reload this page; the page adds the network for you.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {wallets.map((w, i) => (
            <button key={w.info.uuid} style={{ ...btn(i === 0), display: "flex", gap: 8, alignItems: "center" }} onClick={() => void app.connect(w)} disabled={!!busy}
              data-pad-default={i === 0 ? "" : undefined} data-testid={`wager-wallet-${i}`}>
              {w.info.icon && <img src={w.info.icon} alt="" width={20} height={20} style={{ borderRadius: 4 }} />}
              {w.info.name}
            </button>
          ))}
        </div>
      )}
      {busy === "connecting your wallet…" && <div style={{ marginTop: 6, fontSize: 12, color: C.ice }}>{busy}</div>}
    </div>
  );
}

function AmountInput({ value, set, onMax, testid, placeholder }: { value: string; set: (s: string) => void; onMax?: () => void; testid: string; placeholder?: string }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
      <input value={value} onChange={e => set(e.target.value.replace(/[^\d.,]/g, "").slice(0, 32))} inputMode="decimal" placeholder={placeholder ?? "amount"}
        data-pad-chars={NUM} style={{ ...input, width: 150, flex: "1 1 120px" }} data-testid={testid} />
      {onMax && <button style={small(false)} onClick={onMax} data-testid={`${testid}-max`}>MAX</button>}
    </div>
  );
}

export function WalletPanel({ app }: { app: WagerApp }) {
  const s = useWager();
  const [dep, setDep] = useState("");
  const [wd, setWd] = useState("");
  const [to, setTo] = useState("");
  const [toOpen, setToOpen] = useState(false);
  const [sessPick, setSessPick] = useState("");
  const [name, setName] = useState("");
  const info = s.info, bal = s.bal, config = s.config;
  if (!s.dep) return null;
  if (!s.address) return <Section title="WALLET" testid="wager-wallet"><ConnectWallet app={app} /></Section>;
  if (!info || !config) return <Section title="WALLET" testid="wager-wallet"><div style={{ opacity: 0.8 }}>reading the vault…</div></Section>;
  const d = info.decimals, sym = info.symbol;
  const depAmt = parseAmount(dep, d), wdAmt = parseAmount(wd, d), sessAmt = parseAmount(sessPick, d);
  const toAddr = toOpen ? parseAddress(to) : null;
  const nowS = Date.now() / 1000;
  const sessOn = s.session && s.sessionKey && checkSession(s.session, s.sessionKey, 0n, nowS, 0).ok;
  const busy = s.busy;
  return (
    <Section title="WALLET" testid="wager-wallet">
      {!s.chainOk && (
        <div style={{ marginBottom: 10 }}>
          <Notice kind="error" text={`your wallet is on another network`} />
          <button style={{ ...btn(true), marginTop: 6 }} onClick={() => void app.switchChain()} data-pad-default="" data-testid="wager-switch">SWITCH TO {s.dep.chainName.toUpperCase()}</button>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 14px", fontSize: 14 }} data-testid="wager-balances">
        <span style={label}>in the vault</span><span data-testid="wager-free"><Amount v={bal?.free ?? 0n} decimals={d} symbol={sym} strong /> free</span>
        <span style={label}>in matches</span><span data-testid="wager-locked"><Amount v={bal?.locked ?? 0n} decimals={d} symbol={sym} /> locked</span>
        <span style={label}>in your wallet</span><span data-testid="wager-walletbal"><Amount v={bal?.wallet ?? 0n} decimals={d} symbol={sym} /></span>
        <span style={label}>gas</span><span style={{ color: bal && bal.eth === 0n ? C.red : undefined }}>{bal ? `${formatAmount(bal.eth, 18, 5)} ETH` : "…"}</span>
      </div>

      <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
        <div>
          <div style={label}>deposit</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            <AmountInput value={dep} set={setDep} testid="wager-deposit-amount" onMax={() => bal && setDep(formatAmount(bal.wallet, d, d).replace(/,/g, ""))} />
            <button style={btn(true)} disabled={!!busy || !depAmt} onClick={() => depAmt && void app.deposit(depAmt).then(ok => ok && setDep(""))} data-testid="wager-deposit">
              {busy === "deposit" ? "DEPOSITING…" : "DEPOSIT"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 3 }}>approves the vault for exactly this amount, then deposits it</div>
        </div>
        <div>
          <div style={label}>withdraw</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            <AmountInput value={wd} set={setWd} testid="wager-withdraw-amount" onMax={() => bal && setWd(formatAmount(bal.free, d, d).replace(/,/g, ""))} />
            <button style={btn(false)} disabled={!!busy || !wdAmt || (toOpen && !toAddr)} onClick={() => wdAmt && void app.withdraw(wdAmt, toAddr ?? undefined).then(ok => ok && setWd(""))} data-testid="wager-withdraw">
              {busy === "withdraw" ? "WITHDRAWING…" : "WITHDRAW"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 3 }}>
            straight from the contract to your wallet, any time.{" "}
            <button style={{ ...small(false), padding: "1px 6px", fontSize: 10 }} onClick={() => setToOpen(!toOpen)} data-testid="wager-withdraw-to-toggle">{toOpen ? "to my wallet" : "to another address"}</button>
          </div>
          {toOpen && <input value={to} onChange={e => setTo(e.target.value.trim())} placeholder="0x… address" style={{ ...input, width: "100%", marginTop: 4, fontSize: 13, borderColor: to && !toAddr ? C.red : undefined }} data-testid="wager-withdraw-to" />}
        </div>
        {s.dep.testnet && config.faucet && (
          <div>
            <button style={small(false)} disabled={!!busy} onClick={() => void app.faucet()} data-testid="wager-faucet">{busy === "faucet" ? "SENDING…" : "GET TEST TOKENS"}</button>
            <span style={{ fontSize: 11, color: C.dim, marginLeft: 8 }}>test {sym} and a little test ETH, once a day</span>
          </div>
        )}
      </div>

      <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${C.line}` }} data-testid="wager-session">
        <div style={label}>play without popups</div>
        {sessOn && s.session ? (
          <div style={{ fontSize: 13, marginTop: 4, lineHeight: 1.6 }}>
            <span style={{ color: C.green, fontWeight: 900 }}>session key on</span> · up to <Amount v={s.session.maxStake} decimals={d} symbol={sym} /> a match ·
            used <Amount v={s.session.used} decimals={d} symbol={sym} /> of <Amount v={s.session.cap} decimals={d} symbol={sym} /> · expires {relTime(Number(s.session.expiry), nowS)}
            <div style={{ marginTop: 4 }}>
              <button style={small(false)} disabled={!!busy} onClick={() => void app.revoke()} data-testid="wager-revoke">{busy === "revoke" ? "REVOKING…" : "REVOKE"}</button>
              <span style={{ fontSize: 11, color: C.dim, marginLeft: 8 }}>it can only enter matches within these limits; it can never withdraw</span>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, marginTop: 4 }}>
            <div style={{ color: C.dim, marginBottom: 6 }}>one wallet signature lets this browser enter matches for you (no gas, no popup per match). It can never withdraw or send your tokens.</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <AmountInput value={sessPick} set={setSessPick} testid="wager-session-max" placeholder="max stake" onMax={() => setSessPick(formatAmount(BigInt(config.maxStake), d, d).replace(/,/g, ""))} />
              <button style={btn(true)} disabled={!!busy || !sessAmt} onClick={() => sessAmt && void app.authorise(sessAmt)} data-testid="wager-authorise">{busy === "session" ? "SIGNING…" : "AUTHORISE"}</button>
            </div>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 3 }}>largest stake per match (up to {formatAmount(BigInt(config.maxStake), d)}); the total is 3× that; it expires in 12 hours (small, because anything that copies the key can spend what is left of it)</div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
        <div style={label}>lobby name</div>
        <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
          <input value={name} onChange={e => setName(e.target.value.slice(0, 16))} placeholder={s.you?.name ?? "name"} maxLength={16} style={{ ...input, width: 170 }} data-testid="wager-name"
            data-pad-chars="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-." />
          <button style={small(false)} disabled={name.length < 3} onClick={() => { app.setProfile({ name: cleanName(name) }); setName(""); }} data-testid="wager-name-save">SAVE</button>
        </div>
      </div>
      {s.you?.holder && <Cosmetics app={app} />}
      <TxList txs={s.txs} dep={s.dep} />
    </Section>
  );
}

const TRAILS: TrailStyle[] = ["none", "spark", "ribbon", "comet"];

/** Radbro holders: web colour and trail (render only: they never touch the game). */
function Cosmetics({ app }: { app: WagerApp }) {
  const you = useWager(s => s.you);
  const cur = you?.cosmetic ?? { web: "classic" as WebColor, trail: "none" as TrailStyle };
  const set = (p: Partial<typeof cur>) => app.setProfile({ cosmetic: { ...cur, ...p } });
  return (
    <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${C.line}` }} data-testid="wager-cosmetics">
      <div style={label}><span style={{ color: C.gold }}>◆</span> holder looks · web colour and trail (looks only)</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
        {(Object.keys(WEB_COLORS) as WebColor[]).map(w => (
          <button key={w} onClick={() => set({ web: w })} title={w} aria-label={`web ${w}`} style={{ width: 30, height: 30, borderRadius: 15, cursor: "pointer", background: WEB_COLORS[w], border: cur.web === w ? `3px solid ${C.pink}` : "2px solid rgba(255,255,255,0.4)" }} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
        {TRAILS.map(t => <button key={t} onClick={() => set({ trail: t })} style={{ ...small(cur.trail === t) }}>{t}</button>)}
      </div>
    </div>
  );
}
