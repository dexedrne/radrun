// SPIDER-TAG wager client: the public match page (?wager&verify=<matchId>, docs/WAGER.md §7.3) and the owner's review
// (?wager&review=<matchId>, §4.9). It fetches the series log from the relay and how the match ended from the chain,
// checks the log against the hash the vault stored, re-simulates every round in this browser with the same code the
// referee runs (src/wager/replay.ts: "view source is the audit") and shows the verdict, each round (the logged result
// against the replayed one), the seed commit and reveal and the flags. WATCH replays a round in the 3D view. No wallet
// needed, except the vault owner's for a review.
import { useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import type { TagGame } from "../game/tagGame.ts";
import { isRadbroId, type RadbroId } from "../game/radbros.ts";
import { loadRadbros, useTag } from "../app/TagPage.tsx";
import { PAGE_DISTRICT, gotoDistrict } from "../app/district.ts";
import { DISTRICTS, isDistrictId } from "../world/districts.ts";
import { useWager, type WagerApp } from "./app.ts";
import { REVIEW_SETTLE, REVIEW_VOID, reviewTypedData } from "./eip712.ts";
import { seedCommit, type SeriesLog, type Side } from "./log.ts";
import { verifySeries, type SeriesVerdict } from "./replay.ts";
import { simAssets } from "./assets.ts";
import type { MatchEnd } from "./chain.ts";
import type { MatchStatus } from "./protocol.ts";
import { ReplayLink } from "./replayLink.ts";
import { matchChecks, type Check } from "./verifyChecks.ts";
import { keepObj } from "./LobbyView.tsx";
import { ConnectWallet } from "./WalletPanel.tsx";
import { Amount, C, Notice, Section, TxLink, btn, label, small } from "./ui.tsx";
import { classifyError } from "./errors.ts";
import { bpsText, sameAddress, shortAddress } from "./units.ts";

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
const sec = (steps: number) => `${(steps / 120).toFixed(1)} s`;

export function VerifyView({ app, game, matchId, review, onBack }: { app: WagerApp; game: TagGame; matchId: Hex; review: boolean; onBack: () => void }) {
  const info = useWager(s => s.info);
  const dep = useWager(s => s.dep)!;
  const address = useWager(s => s.address);
  const screen = useTag(s => s.screen);
  const [log, setLog] = useState<SeriesLog | null>(null);
  const [status, setStatus] = useState<MatchStatus | null>(null);
  const [end, setEnd] = useState<MatchEnd | null | undefined>(undefined);
  const [verdict, setVerdict] = useState<SeriesVerdict | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  const [watching, setWatching] = useState<ReplayLink | null>(null);
  const logUrl = useMemo(() => (log ? URL.createObjectURL(new Blob([JSON.stringify(log, null, 1)], { type: "application/json" })) : null), [log]);
  useEffect(() => () => { if (logUrl) URL.revokeObjectURL(logUrl); }, [logUrl]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [st, lg] = await Promise.all([app.api.match(matchId).catch(() => null), app.api.log(matchId)]);
        if (!live) return;
        setStatus(st);
        setLog(lg);
        // Let the page paint "replaying…" before the replay (about a second for a whole series).
        await new Promise(r => setTimeout(r, 60));
        const assets = await simAssets(lg.rules.district, game.tuning, { district: PAGE_DISTRICT, model: game.model });
        if (!live) return;
        setVerdict(verifySeries(lg, assets));
      } catch (e) {
        if (live) setErr(classifyError(e).message === "not found on the relay" ? "no public log for this match yet (it's published when the series is over)" : classifyError(e).message);
      }
    })();
    return () => { live = false; };
  }, [app, matchId, game]);

  // How the match ended on chain, and the vault's owner (review): once the page's chain client is up.
  const settleTx = status?.settleTx ?? null;
  useEffect(() => {
    if (!info || !app.chain) return;
    let live = true;
    app.chain.matchEnd(matchId, settleTx).then(e => live && setEnd(e), () => live && setEnd(null));
    return () => { live = false; };
  }, [app, matchId, info, settleTx]);
  useEffect(() => {
    if (review && info && app.chain) app.chain.owner().then(setOwner, () => setOwner(null));
  }, [review, app, info]);

  // Watching: the overlay steps aside for the 3D view; back here at the end.
  useEffect(() => {
    if (!watching) return;
    if (screen === "results" || screen === "host") {
      const t = setTimeout(() => { if (game.link === watching) { game.toMenu(); useTag.setState({ screen: "host", hud: null, series: null }); } setWatching(null); }, screen === "results" ? 2500 : 0);
      return () => clearTimeout(t);
    }
  }, [screen, watching, game]);

  if (watching && (screen === "match" || screen === "loading")) {
    return (
      <div style={{ position: "fixed", bottom: "calc(12px + env(safe-area-inset-bottom, 0px))", left: "50%", transform: "translateX(-50%)", zIndex: 25, display: "flex", gap: 6, background: "rgba(14,16,30,0.82)", borderRadius: 10, padding: 6 }} data-testid="wager-watch-bar">
        {[1, 2, 4].map(x => <button key={x} style={small(watching.speed === x)} onClick={() => { watching.speed = x; setWatching(watching); useTag.setState({}); }}>{x}×</button>)}
        <button style={small(false)} onClick={() => { game.toMenu(); useTag.setState({ screen: "host", hud: null, series: null }); setWatching(null); }} data-pad-btn="EAST">STOP</button>
      </div>
    );
  }

  const watch = async (r: SeriesLog["rounds"][number], view: Side) => {
    if (!log) return;
    const ids = r.slotOfA === 0 ? [log.radbros[0], log.radbros[1]] : [log.radbros[1], log.radbros[0]];
    if (!ids.every(isRadbroId)) { setErr("this match used a Radbro this version doesn't have"); return; }
    useTag.setState({ screen: "loading", flash: null });
    if (!(await loadRadbros(ids as RadbroId[]))) return;
    const assets = await simAssets(log.rules.district, game.tuning, { district: PAGE_DISTRICT, model: game.model });
    const link = new ReplayLink(assets, log, r, view);
    link.onFresh = () => game.fresh();
    const names = [0, 1].map(slot => { const side = (slot === r.slotOfA ? 0 : 1) as Side; return `${side === 0 ? "A" : "B"} ${shortAddress(log.players[side])}`; });
    useTag.setState({ slots: ids as RadbroId[], names, series: { title: `REPLAY · ROUND ${r.round}`, sub: `watching player ${view === 0 ? "A" : "B"}` }, looks: [] });
    game.startOnline(link);
    useTag.setState({ screen: "match" });
    setWatching(link);
  };

  const checks: Check[] = log && verdict
    ? matchChecks({ log, verdict, end, held: status?.state === "held", page: { chainId: dep.chainId, vault: app.chain?.vault ?? null, matchId } })
    : [];
  const failed = checks.some(c => c.ok === false);
  const pending = !failed && checks.some(c => c.ok === null);
  const allOk = checks.length > 0 && !failed && !pending;
  const d = info?.decimals ?? 18, sym = info?.symbol ?? "";
  const district = log?.rules.district ?? "";
  const here = district === PAGE_DISTRICT;
  const isOwner = review && owner && sameAddress(owner, address);

  const doReview = async (decision: 1 | 2) => {
    if (!log) return;
    try {
      const w = await app.walletSigner();
      const sig = await w.sign(reviewTypedData(dep.chainId, app.chain!.vault, { matchId, decision, logHash: log.logHash }));
      const st = await app.api.review({ matchId, decision, logHash: log.logHash, sig });
      setStatus(st);
      setReviewMsg(decision === REVIEW_SETTLE ? "sent: the referee signs the replayed result" : "sent: the series is voided");
      setTimeout(() => void app.api.match(matchId).then(setStatus, () => undefined), 3000);
    } catch (e) {
      setReviewMsg(classifyError(e).message);
    }
  };

  return (
    <div style={{ display: "grid", gap: 10, maxWidth: 820, margin: "0 auto" }}>
      <Section testid="wager-verify">
        <div style={{ font: "900 22px ui-monospace, monospace", letterSpacing: 2 }}>{review ? "REVIEW" : "MATCH CHECK"}</div>
        <div style={{ fontSize: 11, color: C.dim, wordBreak: "break-all", marginTop: 2 }}>{matchId}</div>
        {err && <div style={{ marginTop: 8 }}><Notice kind="error" text={err} /></div>}
        {!err && !verdict && <div style={{ marginTop: 10 }}>{log ? "replaying every round in your browser…" : "fetching the match log…"}</div>}
        {log && verdict && (
          <>
            <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, border: `2px solid ${allOk ? C.green : pending ? C.ice : C.red}`, background: "rgba(0,0,0,0.3)" }} data-testid="wager-verdict" data-ok={allOk ? "1" : pending ? "" : "0"}>
              <div style={{ font: "900 20px ui-monospace, monospace", color: allOk ? C.green : pending ? C.ice : C.red }}>{allOk ? "VERIFIED" : failed ? "DOESN'T CHECK OUT" : end === undefined ? "CHECKING…" : "REPLAY CHECKS OUT · NOT SETTLED YET"}</div>
              {checks.map((c, i) => <div key={i} style={{ fontSize: 13, marginTop: 3 }}><span style={{ color: c.ok ? C.green : c.ok === null ? C.ice : C.red }}>{c.ok ? "✓" : c.ok === null ? "…" : "✗"}</span> {c.text}</div>)}
              {verdict.problems.map((p, i) => <div key={`p${i}`} style={{ fontSize: 12, color: C.red, marginTop: 2 }}>• {p}</div>)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", fontSize: 13, marginTop: 10 }}>
              <span style={label}>players</span><span>A {shortAddress(log.players[0])} · B {shortAddress(log.players[1])}</span>
              <span style={label}>stake</span><span><Amount v={log.stake} decimals={d} symbol={sym} /> each · fee {bpsText(log.feeBps)} (holder {bpsText(log.holderFeeBps)})</span>
              <span style={label}>result</span>
              <span data-testid="wager-verify-result">{log.outcome.kind === "win" ? `player ${log.outcome.winner === 0 ? "A" : "B"} wins ${log.outcome.score[0]}-${log.outcome.score[1]}${log.outcome.forfeit ? ` (forfeit by ${log.outcome.forfeit.by === 0 ? "A" : "B"})` : ""}` : `void (${log.outcome.reason})`}</span>
              <span style={label}>city</span><span>{isDistrictId(district) ? DISTRICTS[district].name : district} · {log.roundSeconds} s rounds · build {log.compat.build}</span>
              <span style={label}>seeds</span><span style={{ wordBreak: "break-all" }}>commit {log.seed.commit.slice(0, 18)}… {seedCommit(log.seed.relaySecret) === log.seed.commit ? <span style={{ color: C.green }}>= keccak(revealed secret) ✓</span> : <span style={{ color: C.red }}>≠ the revealed secret</span>}</span>
              {end && <><span style={label}>on chain</span><span>{end.kind === "settled" ? <>paid <Amount v={end.payout} decimals={d} symbol={sym} /> · fee <Amount v={end.fee} decimals={d} symbol={sym} /></> : "voided"} · <TxLink dep={dep} hash={end.tx} /></span></>}
            </div>
          </>
        )}
      </Section>
      {log && verdict && (
        <Section title="ROUNDS" testid="wager-verify-rounds">
          <div style={{ display: "grid", gap: 8 }}>
            {log.rounds.map((r, i) => {
              const rep = verdict.rounds.find(x => x.round === r.round);
              const same = !!rep?.result && !!r.result && rep.result.winner === r.result.winner && rep.result.hash === r.result.hash;
              const who = (w: Side | "draw" | undefined) => (w === undefined ? "–" : w === "draw" ? "draw" : w === 0 ? "A" : "B");
              return (
                <div key={i} style={{ padding: "8px 10px", borderRadius: 10, background: C.card, border: `1px solid ${r.result ? (same ? C.green : C.red) : C.line}`, fontSize: 12 }} data-testid="wager-verify-round">
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <b style={{ fontSize: 14 }}>ROUND {r.round}</b>
                    <span>logged: {who(r.result?.winner)} · replayed: {who(rep?.result?.winner)} {r.result ? (same ? <span style={{ color: C.green }}>✓</span> : <span style={{ color: C.red }}>✗</span>) : "(cut short)"}</span>
                    <span style={{ flex: 1 }} />
                    {here ? (
                      <>
                        <button style={small(false)} onClick={() => void watch(r, 0)} data-testid={`wager-watch-${r.round}`}>WATCH A</button>
                        <button style={small(false)} onClick={() => void watch(r, 1)}>WATCH B</button>
                      </>
                    ) : isDistrictId(district) && <button style={small(false)} onClick={() => gotoDistrict(district, { wager: "", verify: matchId, ...keepObj() })}>WATCH IN {DISTRICTS[district].name.toUpperCase()}</button>}
                  </div>
                  <div style={{ color: C.dim, marginTop: 3, lineHeight: 1.5 }}>
                    {r.result && <>bag A {sec(r.result.bag[0])} · B {sec(r.result.bag[1])} · tags {r.result.tags[0]}-{r.result.tags[1]} · falls {r.result.falls[0]}-{r.result.falls[1]} · </>}
                    seed {hex8(r.seed)} · A in slot {r.slotOfA} · delay {r.inputDelay} · {r.lastStep} steps · filled {r.fills[0]}/{r.fills[1]}
                    {rep && <> · final hash {hex8(rep.hash)}{r.result ? (rep.hash === r.result.hash ? " = logged" : ` ≠ logged ${hex8(r.result.hash)}`) : ""} · replayed in {Math.round(rep.ms)} ms</>}
                  </div>
                </div>
              );
            })}
            {log.rounds.length === 0 && <div style={{ opacity: 0.8 }}>no rounds were played</div>}
          </div>
          {log.flags.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12 }}>
              <div style={label}>flags</div>
              {log.flags.map((f, i) => <div key={i}>player {f.side === 0 ? "A" : "B"} · {f.kind} · round {f.round} · {f.value} (limit {f.limit}){f.note ? ` · ${f.note}` : ""}</div>)}
            </div>
          )}
          <div style={{ fontSize: 11, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
            Every round above was re-simulated in this browser from the relay's recorded inputs, with the same game code the referee runs.
            The log's hash is what the referee signed and the vault stored, so the log can't be changed after the fact.{" "}
            {logUrl && <a href={logUrl} download={`radrun-match-${matchId.slice(2)}.json`} style={{ color: C.ice }}>download the log</a>}
          </div>
        </Section>
      )}
      {review && log && (
        <Section title="OWNER REVIEW" testid="wager-review">
          {status?.state !== "held" ? <div style={{ fontSize: 13 }}>this series isn't held for review ({status?.state ?? "unknown"})</div> : !address ? <ConnectWallet app={app} /> : !isOwner ? (
            <div style={{ fontSize: 13 }}>only the vault's owner ({owner ? shortAddress(owner) : "…"}) can review; this wallet is {shortAddress(address)}</div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button style={btn(true)} onClick={() => void doReview(REVIEW_SETTLE)} data-testid="wager-review-settle">SETTLE AS REPLAYED</button>
              <button style={btn(false)} onClick={() => void doReview(REVIEW_VOID)} data-testid="wager-review-void">VOID (REFUND BOTH)</button>
            </div>
          )}
          {reviewMsg && <div style={{ marginTop: 8 }}><Notice kind="info" text={reviewMsg} /></div>}
        </Section>
      )}
      <div style={{ textAlign: "center" }}><button style={small(false)} onClick={onBack} data-pad-btn="EAST">← lobby</button></div>
    </div>
  );
}
