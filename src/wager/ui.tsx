// SPIDER-TAG wager client: the shared UI pieces in the game's style (ui/screens.tsx panels and buttons, monospace,
// pad-friendly: plain DOM buttons that ui/padNav.ts moves between; [data-pad-default] and [data-pad-btn="EAST"] for
// back). The beta banner, player cards (rating, record, NEW, holder badge), amounts, notices and transaction rows.
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { btn, panel } from "../ui/screens.tsx";
import { safe } from "../ui/safe.ts";
import { RADBRO_COLOR } from "../ui/strings.ts";
import { isRadbroId } from "../game/radbros.ts";
import type { Deployment } from "./config.ts";
import type { PlayerCard, WebColor } from "./protocol.ts";
import type { TxRow } from "./app.ts";
import { formatAmount, shortAddress } from "./units.ts";
import { txUrl } from "./wallet.ts";

export { btn, panel };

export const C = {
  pink: "#ff3d7f", gold: "#ffd23f", ice: "#9fe6ff", green: "#8dff8a", red: "#ff8a8a", dim: "rgba(255,255,255,0.65)", line: "rgba(255,255,255,0.18)",
  card: "rgba(255,255,255,0.05)",
} as const;

export const WEB_COLORS: Record<WebColor, string> = { classic: "#f4f7ff", gold: "#ffd23f", ice: "#9fe6ff", toxic: "#8dff8a", violet: "#c79bff", rose: "#ff7eb3" };

export const small = (primary = false): React.CSSProperties => ({ ...btn(primary), fontSize: 12, padding: "6px 12px" });
export const input: React.CSSProperties = {
  font: "700 16px ui-monospace, monospace", padding: "8px 10px", borderRadius: 8, border: "2px solid rgba(159,230,255,0.7)", background: "rgba(0,0,0,0.35)",
  color: "#fff", minWidth: 0, boxSizing: "border-box",
};
export const label: React.CSSProperties = { fontSize: 11, opacity: 0.75, letterSpacing: 1, textTransform: "uppercase" };
export const h2: React.CSSProperties = { font: "900 16px ui-monospace, monospace", letterSpacing: 2, margin: "0 0 8px" };

/** Seconds ticking (re-render every `ms`). */
export function useNow(ms = 1000): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const iv = setInterval(() => setN(Date.now()), ms); return () => clearInterval(iv); }, [ms]);
  return n;
}

/** Viewport width class. */
export function useNarrow(px = 720): boolean {
  const [n, setN] = useState(() => innerWidth < px);
  useEffect(() => { const f = () => setN(innerWidth < px); addEventListener("resize", f); return () => removeEventListener("resize", f); }, [px]);
  return n;
}

/** The deployment label, always on show: "BETA · TESTNET · Robinhood Chain Testnet · 0x12…abcd". */
export function Banner({ dep, address, onWallet }: { dep: Deployment | null; address: Address | null; onWallet?: () => void }) {
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 30, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
      padding: `calc(6px + env(safe-area-inset-top, 0px)) ${safe("right", 12)} 6px ${safe("left", 12)}`, background: "rgb(12,14,32)",
      borderBottom: `2px solid ${C.gold}`, font: "700 12px ui-monospace, monospace", color: "#fff", boxSizing: "border-box",
    }} data-testid="wager-banner">
      <span style={{ background: C.gold, color: "#1a1a1a", padding: "2px 8px", borderRadius: 4, fontWeight: 900, letterSpacing: 1 }} data-testid="wager-label">{dep?.label ?? "BETA"}</span>
      <span style={{ opacity: 0.85 }}>{dep?.chainName ?? ""}</span>
      <span style={{ flex: 1 }} />
      {onWallet ? (
        <button onClick={onWallet} style={{ ...small(false), padding: "4px 10px" }} data-testid="wager-banner-wallet">{address ? shortAddress(address) : "connect wallet"}</button>
      ) : address && <span data-testid="wager-banner-address">{shortAddress(address)}</span>}
    </div>
  );
}

export function Notice({ kind, text, onClose }: { kind: "error" | "info" | "ok"; text: string; onClose?: () => void }) {
  const col = kind === "error" ? C.red : kind === "ok" ? C.green : C.ice;
  return (
    <div role={kind === "error" ? "alert" : "status"} style={{ border: `1px solid ${col}`, color: col, background: "rgba(0,0,0,0.35)", borderRadius: 8, padding: "6px 10px", fontSize: 13, display: "flex", gap: 8, alignItems: "center" }} data-testid={`wager-notice-${kind}`}>
      <span style={{ flex: 1 }}>{text}</span>
      {onClose && <button onClick={onClose} style={{ ...small(false), padding: "2px 8px" }} aria-label="dismiss" data-pad-skip="">×</button>}
    </div>
  );
}

export function Amount({ v, decimals, symbol, strong }: { v: bigint | string; decimals: number; symbol: string; strong?: boolean }) {
  const n = typeof v === "string" ? BigInt(v) : v;
  return <span style={{ fontWeight: strong ? 900 : 700, whiteSpace: "nowrap" }}>{formatAmount(n, decimals)} <span style={{ opacity: 0.7, fontSize: "0.85em" }}>{symbol}</span></span>;
}

/** The holder badge. */
export const Holder = () => <span title="holds a Radbro" style={{ color: C.gold, fontWeight: 900 }} data-testid="holder-badge">◆</span>;

export function Portrait({ id, size = 44 }: { id: string; size?: number }) {
  const rid = isRadbroId(id) ? id : "652";
  return (
    <div style={{ width: size, height: size, borderRadius: 8, overflow: "hidden", flex: "none", background: `radial-gradient(circle at 50% 38%, ${RADBRO_COLOR[rid].body}66, ${RADBRO_COLOR[rid].accent}22 62%, rgba(0,0,0,0.25))` }}>
      <img src={`/ui/radbro${rid}.webp`} alt="" width={size} height={size} draggable={false} style={{ display: "block" }} />
    </div>
  );
}

/** A player's card: name, holder badge, rating, record, forfeits, account age / NEW (the lobby's smurf protection). */
export function Card({ p, newSeries, you, compact }: { p: PlayerCard; newSeries: number; you?: boolean; compact?: boolean }) {
  const settled = p.wins + p.losses;
  const isNew = settled < newSeries;
  const days = Math.max(0, Math.floor((Date.now() - p.firstSeen) / 86_400_000));
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }} data-testid="player-card">
      <Portrait id={p.radbros[0] !== undefined && isRadbroId(String(p.radbros[0])) ? String(p.radbros[0]) : "652"} size={compact ? 32 : 40} />
      <div style={{ minWidth: 0, lineHeight: 1.35 }}>
        <div style={{ fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {you ? "YOU" : p.name} {p.holder && <Holder />} {isNew && <span style={{ fontSize: 10, background: C.ice, color: "#111", borderRadius: 3, padding: "0 4px", marginLeft: 2 }} data-testid="new-tag">NEW</span>}
        </div>
        <div style={{ fontSize: 11, color: C.dim, whiteSpace: "nowrap" }}>
          ★ {Math.round(p.rating)} · {p.wins}-{p.losses}{p.forfeits ? ` · ${p.forfeits} forfeit${p.forfeits === 1 ? "" : "s"}` : ""}{p.held ? ` · ${p.held} held` : ""}{!compact ? ` · ${days ? `${days} d` : "today"}` : ""}
        </div>
      </div>
    </div>
  );
}

const TX_TEXT: Record<TxRow["status"], string> = { wallet: "confirm in your wallet…", sent: "sent, waiting…", confirmed: "done", failed: "failed" };

export function TxList({ txs, dep }: { txs: TxRow[]; dep: Deployment }) {
  const recent = txs.filter(t => Date.now() - t.at < 10 * 60_000).slice(0, 4);
  if (!recent.length) return null;
  return (
    <div style={{ marginTop: 8, fontSize: 12, display: "grid", gap: 3 }} data-testid="wager-txs">
      {recent.map(t => {
        const url = t.hash ? txUrl(dep, t.hash) : null;
        const col = t.status === "failed" ? C.red : t.status === "confirmed" ? C.green : C.ice;
        return (
          <div key={t.id} style={{ display: "flex", gap: 8 }}>
            <span style={{ flex: 1 }}>{t.label}</span>
            <span style={{ color: col }}>{t.status === "failed" && t.error ? t.error : TX_TEXT[t.status]}</span>
            {url && <a href={url} target="_blank" rel="noreferrer" style={{ color: C.ice }} data-pad-skip="">tx ↗</a>}
          </div>
        );
      })}
    </div>
  );
}

export function TxLink({ dep, hash, text = "transaction" }: { dep: Deployment; hash: string | null; text?: string }) {
  if (!hash) return null;
  const url = txUrl(dep, hash);
  return url ? <a href={url} target="_blank" rel="noreferrer" style={{ color: C.ice }}>{text} ↗</a> : <span style={{ opacity: 0.7 }} title={hash}>{shortAddress(hash)}</span>;
}

export const Section = ({ title, children, testid, style }: { title?: string; children: React.ReactNode; testid?: string; style?: React.CSSProperties }) => (
  <div style={{ ...panel, padding: "12px 14px", textAlign: "left", ...style }} data-testid={testid}>
    {title && <div style={h2}>{title}</div>}
    {children}
  </div>
);
