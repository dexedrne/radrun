// SPIDER-TAG wager client: a locked series (docs/WAGER.md §4.4, §7.3). Before round 1: both players' cards, the
// Radbro pick (the roster, plus your own Radbros as a holder), READY and the join timer. Each round runs on the
// existing SPIDER-TAG scene and HUD through the online session (the HUD gets the series line: "ROUND 2 · 1-0" and the
// opponent's connection). Between rounds: the referee's round result. At the end: the winner, the payout and fee,
// the settle state (signing → settled, with the transaction), "held for review" with the refund time, the "submit it
// yourself" and refund fallbacks, and the verify link. The referee decides; this page only shows what it says.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import type { TagGame } from "../game/tagGame.ts";
import { RADBROS, isRadbroId, type RadbroId } from "../game/radbros.ts";
import { loadRadbros, useTag } from "../app/TagPage.tsx";
import { requestLock } from "../radbro/bridge.ts";
import { useUi } from "../ui/store.ts";
import type { SlotLook } from "../app/TagActors.tsx";
import { useWager, type WagerApp } from "./app.ts";
import { payout } from "./eip712.ts";
import { sideOfSlot, type Side } from "./log.ts";
import type { OnlineSession } from "../net/session.ts";
import type { MatchView } from "./chain.ts";
import type { MatchStatus, OutcomeMsg, RadbroPick, RoundMsg, SeriesState, Settlement, WagerStartMsg } from "./protocol.ts";
import { SeriesClient, type RoomConn } from "./series.ts";
import { roomCompat } from "./assets.ts";
import { Amount, C, Card, Holder, Notice, Portrait, Section, TxLink, WEB_COLORS, btn, label, small, useNow } from "./ui.tsx";
import { bpsText, clockText, dateText, relTime, roundText, shortAddress } from "./units.ts";
import { keepParams } from "./site.ts";
import { ConnectWallet } from "./WalletPanel.tsx";
import { MutualPanel } from "./MutualPanel.tsx";

const VOID_TEXT: Record<string, string> = {
  noshow: "a player didn't arrive before round 1, so the series is void: nobody pays, both stakes are back",
  draws: "three drawn rounds: the series is void and both stakes are back",
  review: "voided on review: both stakes are back",
  error: "the relay couldn't finish the series (its own fault), so it's void: both stakes are back",
  forfeit: "void",
  played: "void",
};

const FLAG_TEXT: Record<string, string> = {
  reaction: "reaction times faster than people manage",
  aim: "aim that's too exact",
  periodic: "machine-regular button timing",
  "late-inputs": "inputs held back to the deadline",
  desync: "a game state that didn't match the referee's",
  "result-mismatch": "both players' results differ from the referee's",
  rtt: "odd connection timing",
  "session-key": "a session-key sign-in from a new place (or both players on one connection) before a forfeit or idle play",
};

function lastPick(): RadbroId {
  try { const r = JSON.parse(localStorage.getItem("rugrun.tag") ?? "{}").radbro; return isRadbroId(r) ? r : "652"; } catch { return "652"; }
}

export function SeriesView({ app, game, matchId, onExit }: { app: WagerApp; game: TagGame; matchId: Hex; onExit: () => void }) {
  const dep = useWager(s => s.dep)!;
  const info = useWager(s => s.info);
  const config = useWager(s => s.config);
  const you = useWager(s => s.you);
  const screen = useTag(s => s.screen);
  const touch = useUi(s => s.touch);
  const [conn, setConn] = useState<RoomConn>("connecting");
  const [connWhy, setConnWhy] = useState("");
  const [st, setSt] = useState<SeriesState | null>(null);
  const [rounds, setRounds] = useState<RoundMsg[]>([]);
  const [outcome, setOutcome] = useState<OutcomeMsg | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [settledTx, setSettledTx] = useState<Hex | null>(null);
  const [voidedTx, setVoidedTx] = useState<Hex | null | undefined>(undefined);
  const [drop, setDrop] = useState<{ side: Side; until: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<MatchStatus | null>(null);
  const [onChain, setOnChain] = useState<MatchView | null>(null);
  /** The chain's clock (settleBy is compared with it, never with this device's). */
  const [chainTime, setChainTime] = useState(0);
  const [pick, setPick] = useState<RadbroPick>(() => ({ radbro: lastPick(), own: null }));
  const [readyRound, setReadyRound] = useState(0);
  const [settledAt, setSettledAt] = useState(0);
  const clientRef = useRef<SeriesClient | null>(null);
  const startRef = useRef<WagerStartMsg | null>(null);
  const now = useNow(500);

  // The relay's view of a finished series (a reload after the end) and the chain's match (settleBy, stake).
  useEffect(() => {
    let live = true;
    app.api.match(matchId).then(m => live && setStatus(m), () => undefined);
    const read = () => {
      app.chain?.matchOf(matchId).then(m => live && setOnChain(m), () => undefined);
      app.chain?.chainNow().then(t => live && setChainTime(t), () => undefined);
    };
    read();
    const iv = setInterval(read, 10_000);
    return () => { live = false; clearInterval(iv); };
  }, [app, matchId, settledTx, voidedTx, !!app.chain]);

  const signer = app.roomSigner();
  useEffect(() => {
    if (!signer || !config || !app.chain) return;
    const c = new SeriesClient({
      base: app.d.base, matchId, chainId: dep.chainId, vault: app.chain.vault, signer, compat: roomCompat(game.model, game.tuning),
      sim: { model: game.model, index: game.index, tuning: game.tuning },
      tamperEndHash: import.meta.env.MODE !== "production" && new URLSearchParams(location.search).has("badhash"),
      ev: {
        conn: (x, why) => { setConn(x); setConnWhy(why ?? ""); },
        series: s => setSt(s),
        start: (m, session) => void begin(c, m, session),
        round: m => setRounds(r => [...r.filter(x => x.round !== m.round), m]),
        drop: (side, graceMs) => setDrop({ side, until: Date.now() + graceMs }),
        back: () => setDrop(null),
        outcome: m => setOutcome(m),
        settlement: x => { setSettlement(x); setSettledAt(Date.now()); },
        settled: tx => { setSettledTx(tx); void app.refresh(); },
        voided: tx => { setVoidedTx(tx); void app.refresh(); },
        error: (code, message) => setErr(code === "full" ? "you're not one of this match's players (check the wallet you connected)" : code === "version" ? "this page is out of date: reload to update" : message),
      },
    });
    clientRef.current = c;
    void c.connect();
    return () => {
      c.close();
      clientRef.current = null;
      if (game.link) game.toMenu();
      useTag.setState({ series: null, looks: [], screen: "host", hud: null });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, matchId, !!signer, !!config]);

  /** A round starts: load both Radbros, then hand the session to the game. */
  async function begin(c: SeriesClient, m: WagerStartMsg, session: OnlineSession) {
    startRef.current = m;
    const ids = m.slots.map(p => p.radbro);
    if (!ids.every(isRadbroId)) { setErr("the other player picked a Radbro this version doesn't know: reload"); return; }
    if (useTag.getState().screen !== "match") useTag.setState({ screen: "loading", flash: null, agreed: null });
    if (!(await loadRadbros(ids as RadbroId[]))) { setErr("couldn't load the Radbros"); return; }
    if (c.session !== session) return;
    session.rb.onFresh = () => game.fresh();
    game.startOnline(session);
    useTag.setState({ screen: "match", slots: ids as RadbroId[] });
    if (!touch && !game.autoLevel) requestLock(document.querySelector("canvas"));
  }

  // The HUD's names, cosmetics and series line follow the room's state.
  const me: Side | null = st?.you ?? null;
  const other: Side | null = me === null ? null : ((1 - me) as Side);
  useEffect(() => {
    const m = startRef.current;
    if (!st || !m || me === null) return;
    const names: string[] = [], looks: (SlotLook | null)[] = [];
    for (let slot = 0; slot < 2; slot++) {
      const side = sideOfSlot(slot, m.slotOfA);
      const p = st.players[side], pk = st.picks[side];
      names[slot] = side === me ? "YOU" : pk?.own != null ? `#${pk.own}` : p.name;
      const cos = p.holder ? p.cosmetic : null;
      looks[slot] = cos ? { web: WEB_COLORS[cos.web] ?? null, trail: cos.trail } : null;
    }
    const dropped = drop && drop.side === other ? Math.max(0, Math.ceil((drop.until - Date.now()) / 1000)) : 0;
    useTag.setState({
      names, looks,
      series: {
        title: `ROUND ${st.round} · ${st.score[me]}-${st.score[other!]}`,
        sub: conn === "reconnecting" ? "your connection dropped: reconnecting…" : dropped ? `opponent disconnected · ${dropped} s to come back` : !st.connected[other!] ? "opponent offline" : `vs ${st.players[other!].name}`,
        warn: conn === "reconnecting" || !!dropped || !st.connected[other!],
      },
    });
  }, [st, me, other, drop, conn, now, screen]);

  // Between rounds and at the end, the round panel replaces the HUD (the scene keeps orbiting the round's winner).
  useEffect(() => { if (screen === "results") useTag.setState({ screen: "host" }); }, [screen]);
  // The referee ended the round but this client still waits on inputs: go to the round screen anyway.
  const lastRound = rounds.at(-1) ?? null;
  useEffect(() => {
    if (!lastRound || screen !== "match") return;
    const t = setTimeout(() => { if (useTag.getState().screen === "match") { document.exitPointerLock?.(); useTag.setState({ screen: "results" }); } }, 4000);
    return () => clearTimeout(t);
  }, [lastRound, screen]);
  // The series is over: leave the match view for the result panel.
  useEffect(() => {
    if (!outcome) return;
    const t = setTimeout(() => { document.exitPointerLock?.(); if (useTag.getState().screen === "match") useTag.setState({ screen: "results" }); }, 2500);
    return () => clearTimeout(t);
  }, [outcome]);

  // Dev / test builds: a probe for headless runs (round, lag behind the relay clock, relay fills, frame rate).
  useEffect(() => {
    if (import.meta.env.MODE === "production") return;
    let frames = 0, raf = 0;
    const count = () => { frames++; raf = requestAnimationFrame(count); };
    raf = requestAnimationFrame(count);
    const iv = setInterval(() => {
      const c = clientRef.current, s = c?.session;
      (window as unknown as { __wager?: unknown }).__wager = {
        conn: c?.conn, phase: c?.state?.phase, round: c?.state?.round, score: c?.state?.score, step: s?.match.step ?? 0, behind: s?.behind ?? 0,
        filled: s?.filled ?? 0, inputs: s?.inputsSent ?? 0, waitMs: Math.round(s?.waitMs ?? 0), fps: frames * 2, over: c?.over ?? false,
      };
      frames = 0;
    }, 500);
    return () => { clearInterval(iv); cancelAnimationFrame(raf); };
  }, []);

  // Preload both picked Radbros while waiting, so a round's start only builds the match (a slow first load would
  // make the first steps late, and the relay fills them).
  const pickKey = st ? st.picks.map(p => p?.radbro ?? "").join(",") : "";
  useEffect(() => {
    const ids = pickKey.split(",").filter(isRadbroId);
    if (ids.length && (screen === "host" || screen === "results")) void loadRadbros(ids as RadbroId[]);
  }, [pickKey]);

  // Send the pick while picking (before round 1).
  useEffect(() => {
    if (conn === "in" && st && st.round <= 1 && (st.phase === "waiting" || st.phase === "between") && me !== null) clientRef.current?.pick(pick.radbro, pick.own);
  }, [pick, conn, st?.phase, st?.round, me]);

  if (screen === "match" || screen === "loading") return null;
  if (!info) return <Section testid="wager-series"><div>connecting…</div></Section>;

  const d = info.decimals, sym = info.symbol;
  const oc = outcome?.outcome ?? status?.outcome ?? null;
  const sett = settlement ?? status?.settlement ?? null;
  // The relay's status keeps one transaction for how a match closed: a settle, or a void (review, no-show, refund).
  const closedVoid = status?.state === "voided" || onChain?.state === "voided";
  const settleTx = settledTx ?? (closedVoid ? null : status?.settleTx ?? null);
  const voided = voidedTx !== undefined ? voidedTx : closedVoid ? status?.settleTx ?? null : undefined;
  const stake = st ? BigInt(st.stake) : onChain ? onChain.stake : status?.offer ? BigInt(status.offer.stake) : 0n;
  const settleBy = st?.settleBy ?? onChain?.settleBy ?? 0;
  // The terms from the relay's series, or from the chain's match when the relay is out of reach.
  const secs = st?.roundSeconds ?? onChain?.roundSeconds ?? 0;
  const fees = st ?? (onChain && onChain.state !== "none" ? onChain : null);
  const relayLeft = (at: number | null | undefined) => (at && clientRef.current ? Math.max(0, (at - clientRef.current.relayNow()) / 1000) : null);
  const verify = `?wager&verify=${matchId}${keepParams()}`;
  const expired = onChain?.state === "locked" && settleBy > 0 && chainTime > settleBy;

  const header = (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 8 }}>
      <div style={{ font: "900 22px ui-monospace, monospace", letterSpacing: 2 }}>SERIES</div>
      <div style={{ fontSize: 13, color: C.dim }}>
        <Amount v={stake} decimals={d} symbol={sym} /> each{secs ? ` · ${roundText(secs)}` : ""} · best of 3{fees ? ` · fee ${bpsText(fees.feeBps)}${fees.holderFeeBps < fees.feeBps ? ` (${bpsText(fees.holderFeeBps)} for a Radbro-holder winner)` : ""}` : ""}
      </div>
    </div>
  );

  // ---- the end ----------------------------------------------------------------------------------------------------
  if (oc) {
    const winSide = oc.kind === "win" ? oc.winner : null;
    const iWon = winSide !== null && winSide === me;
    const held = outcome?.held ?? status?.state === "held";
    const flags = outcome?.flags ?? [];
    const res = sett?.result;
    const pay = res && res.outcome === 1 ? payout(stake, res.feeBps) : null;
    const wName = winSide === null ? "" : st ? (winSide === me ? "YOU" : st.players[winSide].name) : shortAddress(winSide === 0 ? onChain?.playerA ?? "" : onChain?.playerB ?? "");
    return (
      <Section testid="wager-series" style={{ maxWidth: 620, margin: "0 auto" }}>
        {header}
        <div style={{ textAlign: "center", margin: "6px 0 12px" }} data-testid="wager-outcome">
          {oc.kind === "win" ? (
            <>
              <div style={{ font: "900 34px ui-monospace, monospace", color: iWon ? C.green : C.gold, textShadow: "3px 3px 0 rgba(0,0,0,0.4)" }}>{iWon ? "YOU WIN THE SERIES" : `${wName} WINS`}</div>
              <div style={{ fontSize: 15, marginTop: 4 }}>{me === null ? `${oc.score[0]}-${oc.score[1]}` : `${oc.score[me]}-${oc.score[1 - me]}`}{oc.forfeit ? ` · ${oc.forfeit.by === me ? "you" : "the opponent"} ${oc.forfeit.why === "disconnect" ? "left and didn't come back" : "never got ready"}: a forfeit` : ""}</div>
            </>
          ) : (
            <>
              <div style={{ font: "900 30px ui-monospace, monospace", color: C.ice }}>SERIES VOID</div>
              <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>{VOID_TEXT[oc.reason] ?? "void: both stakes are back"}</div>
            </>
          )}
        </div>
        {held && !settleTx && voided === undefined && (
          <div style={{ marginBottom: 10 }} data-testid="wager-held">
            <Notice kind="info" text={`HELD FOR REVIEW: an anti-cheat check flagged this series, so it waits for a review instead of paying out. If nobody reviews it by ${settleBy ? dateText(settleBy) : "the settle deadline"}, anyone can refund both stakes.`} />
          </div>
        )}
        {flags.length > 0 && (
          <div style={{ fontSize: 12, marginBottom: 10 }}>
            <div style={label}>flags</div>
            {flags.map((f, i) => <div key={i}>{st ? (f.side === me ? "you" : st.players[f.side].name) : `player ${f.side === 0 ? "A" : "B"}`}: {FLAG_TEXT[f.kind] ?? f.kind} (round {f.round})</div>)}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 14px", fontSize: 14 }}>
          {pay && <><span style={label}>winner gets</span><span><Amount v={pay.winner} decimals={d} symbol={sym} strong /> (pot <Amount v={pay.pot} decimals={d} symbol={sym} />)</span></>}
          {pay && <><span style={label}>fee</span><span><Amount v={pay.fee} decimals={d} symbol={sym} /> · {bpsText(res!.feeBps)}{st && res!.feeBps < st.feeBps ? <> · holder rate <Holder /></> : null}</span></>}
          <span style={label}>settle</span>
          <span data-testid="wager-settle-state">
            {settleTx ? <span style={{ color: C.green }}>settled · credited to the vault · <TxLink dep={dep} hash={settleTx} /></span>
              : voided !== undefined ? <span style={{ color: C.green }}>refunded · <TxLink dep={dep} hash={voided} /></span>
              : held ? "waiting for the review"
              : sett ? "signed by the referee · submitting…"
              : "the referee is signing…"}
          </span>
        </div>
        {sett && !settleTx && voided === undefined && Date.now() - settledAt > 20_000 && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            not settled yet: <button style={small(true)} onClick={() => void app.settleYourself(sett.result, sett.sig).then(tx => tx && setSettledTx(tx))} data-testid="wager-settle-yourself">SUBMIT IT YOURSELF</button> (the referee's signature; your wallet pays the gas)
          </div>
        )}
        {expired && !settleTx && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            the settle window closed: <button style={small(true)} onClick={() => void app.refund(matchId).then(tx => tx && setVoidedTx(tx))} data-testid="wager-refund">REFUND BOTH STAKES</button>
            {" "}or <button style={small(false)} onClick={() => void app.reclaim(matchId).then(tx => tx && setVoidedTx(tx))} data-testid="wager-reclaim">TAKE BACK YOUR STAKE</button>
          </div>
        )}
        {!expired && onChain?.state === "locked" && !settleTx && voided === undefined && (held || (!sett && Date.now() - settledAt > 60_000)) && (
          <MutualPanel app={app} matchId={matchId} m={onChain} logHash={outcome?.logHash ?? null} onDone={tx => setSettledTx(tx)} />
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16, flexWrap: "wrap" }}>
          <a href={verify} style={{ ...btn(false), textDecoration: "none" }} data-testid="wager-verify-link">VERIFY THIS MATCH</a>
          <button style={btn(true)} onClick={() => { game.toMenu(); useTag.setState({ screen: "host", hud: null }); onExit(); }} data-pad-default="" data-pad-btn="EAST" data-testid="wager-series-back">BACK TO THE LOBBY</button>
        </div>
      </Section>
    );
  }

  // ---- connection problems (the relay down included: a refund never needs it) -----------------------------------------
  if (err || conn === "closed" || !config) {
    return (
      <Section testid="wager-series" style={{ maxWidth: 620, margin: "0 auto" }}>
        {header}
        <Notice kind="error" text={err ?? (!config ? "can't reach the wager relay" : `the match connection closed${connWhy ? ` (${connWhy})` : ""}`)} />
        {onChain && <div style={{ fontSize: 12, marginTop: 8 }} data-testid="wager-chain-state">on chain: {onChain.state === "locked" ? "both stakes locked" : onChain.state === "settled" ? "settled" : onChain.state === "voided" ? "refunded" : "not locked"}</div>}
        {expired && (
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={small(true)} onClick={() => void app.refund(matchId).then(tx => tx && setVoidedTx(tx))} data-testid="wager-refund">REFUND BOTH STAKES</button>
            <button style={small(false)} onClick={() => void app.reclaim(matchId).then(tx => tx && setVoidedTx(tx))} data-testid="wager-reclaim" title="a transaction that names only you">TAKE BACK YOUR STAKE</button>
          </div>
        )}
        {!expired && onChain?.state === "locked" && <MutualPanel app={app} matchId={matchId} m={onChain} logHash={null} onDone={tx => setSettledTx(tx)} />}
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button style={btn(true)} onClick={() => location.reload()} data-pad-default="">RECONNECT</button>
          <a href={verify} style={{ ...btn(false), textDecoration: "none" }}>MATCH PAGE</a>
          <button style={btn(false)} onClick={onExit} data-pad-btn="EAST">LOBBY</button>
        </div>
        {settleBy > 0 && <div style={{ fontSize: 11, color: C.dim, marginTop: 8 }}>if the series never settles, anyone can refund both stakes after {dateText(settleBy)} ({relTime(settleBy)})</div>}
      </Section>
    );
  }
  if (!st || me === null) {
    return (
      <Section testid="wager-series" style={{ maxWidth: 620, margin: "0 auto" }}>
        {header}
        {!signer ? (
          // No wallet yet (a new device, or one this page never connected): nothing can sign in to the room.
          <><div style={{ marginBottom: 8 }}>connect the wallet you play with to join this match</div><ConnectWallet app={app} /></>
        ) : <div>{conn === "login" ? "signing in to the match…" : conn === "reconnecting" ? "reconnecting…" : "joining the match…"}</div>}
      </Section>
    );
  }

  const opp = st.players[other!];
  const left = relayLeft(st.deadlineAt);
  const beforeRound1 = st.round <= 1 && (st.phase === "waiting" || st.phase === "between") && rounds.length === 0;
  const canReady = (st.phase === "between" || st.phase === "waiting") && readyRound !== st.round && !st.ready[me];
  const owned = (st.players[me].radbros ?? you?.radbros ?? []).slice(0, 24);

  const cards = (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {([me, other!] as Side[]).map(side => {
        const p = st.players[side], pk = st.picks[side];
        return (
          <div key={side} style={{ flex: "1 1 220px", padding: 10, borderRadius: 10, background: C.card, border: `2px solid ${st.ready[side] ? C.green : C.line}` }} data-testid={`wager-seat-${side === me ? "me" : "opp"}`}>
            <Card p={p} newSeries={config.newAccountSeries} you={side === me} />
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, fontSize: 12 }}>
              {pk && <Portrait id={pk.radbro} size={28} />}
              <span>{pk ? `#${pk.own ?? pk.radbro}` : "picking…"}{pk?.own != null && <> <Holder /></>}</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: !st.connected[side] ? C.red : st.ready[side] ? C.green : C.dim }}>{!st.connected[side] ? "offline" : st.ready[side] ? "READY" : "not ready"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );

  // ---- before round 1 / between rounds --------------------------------------------------------------------------------
  return (
    <Section testid="wager-series" style={{ maxWidth: 720, margin: "0 auto" }}>
      {header}
      {conn === "reconnecting" && <div style={{ marginBottom: 8 }}><Notice kind="error" text="your connection dropped: reconnecting…" /></div>}
      {drop && drop.side === other && <div style={{ marginBottom: 8 }}><Notice kind="info" text={`${opp.name} disconnected: ${Math.max(0, Math.ceil((drop.until - Date.now()) / 1000))} s to come back, or they forfeit`} /></div>}
      {!beforeRound1 && lastRound && (
        <div style={{ textAlign: "center", marginBottom: 12 }} data-testid="wager-round-result">
          <div style={{ font: "900 26px ui-monospace, monospace", color: lastRound.result.winner === me ? C.green : lastRound.result.winner === "draw" ? C.ice : C.gold }}>
            ROUND {lastRound.round}: {lastRound.result.winner === "draw" ? "DRAW (replayed)" : lastRound.result.winner === me ? "YOU WIN IT" : `${opp.name} WINS IT`}
          </div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            bag time: you {(lastRound.result.bag[me] / 120).toFixed(1)} s · {opp.name} {(lastRound.result.bag[other!] / 120).toFixed(1)} s
            {" · "}series <b>{lastRound.score[me]}-{lastRound.score[other!]}</b>{lastRound.draws ? ` · ${lastRound.draws} draw${lastRound.draws > 1 ? "s" : ""}` : ""}
          </div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>the referee's replay of both players' inputs</div>
        </div>
      )}
      {cards}
      {beforeRound1 && (
        <div style={{ marginTop: 12 }} data-testid="wager-pick">
          <div style={label}>your Radbro</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            {RADBROS.map(id => (
              <button key={id} onClick={() => setPick({ radbro: id, own: owned.includes(Number(id)) ? Number(id) : null })} style={{ ...small(pick.radbro === id), display: "flex", gap: 6, alignItems: "center" }} data-testid={`wager-pick-${id}`}>
                <Portrait id={id} size={24} />#{id}
              </button>
            ))}
          </div>
          {owned.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={label}><Holder /> play as one of yours (looks only)</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                {owned.map(n => (
                  <button key={n} onClick={() => setPick({ radbro: isRadbroId(String(n)) ? String(n) : pick.radbro, own: n })} style={small(pick.own === n)} data-testid={`wager-own-${n}`}>#{n}</button>
                ))}
              </div>
              {pick.own != null && !isRadbroId(String(pick.own)) && <div style={{ fontSize: 11, color: C.dim, marginTop: 3 }}>#{pick.own} plays on the #{pick.radbro} body with its number and your badge</div>}
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
        <button style={{ ...btn(true), fontSize: 18, padding: "10px 34px", opacity: canReady ? 1 : 0.55 }} disabled={!canReady} onClick={() => { clientRef.current?.ready(); setReadyRound(st.round); }} data-pad-default="" data-pad-btn="START" data-testid="wager-ready">
          {st.ready[me] || readyRound === st.round ? "READY ✓" : beforeRound1 ? "READY" : `READY FOR ROUND ${st.round}`}
        </button>
        {left !== null && <span style={{ fontSize: 13, color: C.gold }} data-testid="wager-timer">{beforeRound1 ? "starts or voids" : "next round"} in {clockText(left)}</span>}
      </div>
      <div style={{ fontSize: 11, color: C.dim, marginTop: 10, textAlign: "center", lineHeight: 1.5 }}>
        {beforeRound1 ? "both players must be here and READY before the timer runs out, or the series is void and nobody pays."
          : "leaving during the series forfeits it after a 20 s grace."}
        {" "}Assists are off for both players. <a href={verify} style={{ color: C.ice }} target="_blank" rel="noreferrer">match page ↗</a>
      </div>
    </Section>
  );
}
