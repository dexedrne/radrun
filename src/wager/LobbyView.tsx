// SPIDER-TAG wager client: the lobby (docs/WAGER.md §7.3). Open offers with the creator's card (rating, record,
// forfeits, NEW, holder badge), the terms (stake, round length, district, fee and the holder rate), JOIN; creating an
// offer (listed, invite link or a named opponent; holders only; minimum series); your own offers (cancel, copy the
// link); the pairing status and the "lock it yourself" fallback. An invite link (?wager&join=<id>) opens JoinView.
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { gotoDistrict, PAGE_DISTRICT } from "../app/district.ts";
import { DISTRICTS, isDistrictId } from "../world/districts.ts";
import { useWager, type WagerApp } from "./app.ts";
import { DEFAULT_ROUND_SECONDS, ROUND_SECONDS, type MatchStatus, type Offer } from "./protocol.ts";
import { keepParams } from "./site.ts";
import { Amount, C, Card, Notice, Section, btn, input, label, small, useNow } from "./ui.tsx";
import { bpsText, formatAmount, parseAddress, parseAmount, relTime, roundText, sameAddress } from "./units.ts";

const districtName = (d: string) => (isDistrictId(d) ? DISTRICTS[d].name : d);

/** "3% · 1.5% if you win holding a Radbro" */
export function FeeText({ feeBps, holderFeeBps }: { feeBps: number; holderFeeBps: number }) {
  return <span>fee {bpsText(feeBps)}{holderFeeBps < feeBps ? <span style={{ color: C.gold }}> · {bpsText(holderFeeBps)} if you win holding a Radbro</span> : null}</span>;
}

export const inviteLink = (matchId: Hex, district: string): string =>
  `${location.origin}/?wager&join=${matchId}${district !== "downtown" ? `&map=${district}` : ""}${keepParams()}`;

function OfferRow({ app, o, mine }: { app: WagerApp; o: Offer; mine: boolean }) {
  const info = useWager(s => s.info);
  const config = useWager(s => s.config);
  const busy = useWager(s => s.busy);
  const [copied, setCopied] = useState(false);
  if (!info || !config) return null;
  const here = o.district === PAGE_DISTRICT;
  const why = mine ? null : app.joinProblem(o);
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", borderRadius: 10, background: C.card, border: `1px solid ${mine ? C.gold : C.line}` }} data-testid="wager-offer" data-match={o.matchId}>
      <div style={{ flex: "1 1 190px", minWidth: 0 }}><Card p={o.creator} newSeries={config.newAccountSeries} you={mine} compact /></div>
      <div style={{ flex: "1 1 200px", fontSize: 13, lineHeight: 1.5 }}>
        <div><Amount v={o.stake} decimals={info.decimals} symbol={info.symbol} strong /> each · {roundText(o.roundSeconds)} · {districtName(o.district)}</div>
        <div style={{ fontSize: 11, color: C.dim }}>
          <FeeText feeBps={o.feeBps} holderFeeBps={o.holderFeeBps} />
          {o.holdersOnly && <span style={{ color: C.gold }}> · holders only</span>}
          {o.minSeries > 0 && <span> · {o.minSeries}+ series</span>}
          {o.opponent && <span> · invite</span>}
          {" · "}ends {relTime(o.deadline)}
        </div>
      </div>
      {mine ? (
        <div style={{ display: "flex", gap: 6 }}>
          <button style={small(false)} onClick={() => { void navigator.clipboard?.writeText(inviteLink(o.matchId, o.district)).then(() => setCopied(true), () => undefined); }} data-testid="wager-offer-copy">{copied ? "COPIED" : "COPY LINK"}</button>
          <button style={small(false)} onClick={() => app.cancel(o.matchId)} data-testid="wager-offer-cancel">CANCEL</button>
        </div>
      ) : here ? (
        <button style={{ ...btn(!why), opacity: why ? 0.55 : 1 }} disabled={!!why || !!busy} title={why ?? "join this match"} onClick={() => void app.join(o)} data-testid="wager-offer-join">
          {busy === "join" ? "JOINING…" : "JOIN"}
        </button>
      ) : (
        <button style={btn(false)} onClick={() => gotoDistrict(o.district as never, { wager: "", join: o.matchId, ...keepObj() })} title={`this match plays in ${districtName(o.district)}: the page reloads there`}>GO TO {districtName(o.district).toUpperCase()}</button>
      )}
      {!mine && why && here && <div style={{ flexBasis: "100%", fontSize: 11, color: C.dim, textAlign: "right" }}>{why}</div>}
    </div>
  );
}

/** The params keepParams() keeps, as an object (for gotoDistrict). */
export function keepObj(): Record<string, string> {
  const q = new URLSearchParams(keepParams().slice(1)), o: Record<string, string> = {};
  q.forEach((v, k) => { o[k] = v; });
  return o;
}

function CreateForm({ app, onDone }: { app: WagerApp; onDone: () => void }) {
  const info = useWager(s => s.info)!;
  const config = useWager(s => s.config)!;
  const you = useWager(s => s.you);
  const busy = useWager(s => s.busy);
  const [stake, setStake] = useState("");
  const [secs, setSecs] = useState(config.roundSeconds.includes(DEFAULT_ROUND_SECONDS) ? DEFAULT_ROUND_SECONDS : config.roundSeconds[0] ?? 90);
  const [mode, setMode] = useState<"listed" | "link" | "named">("listed");
  const [opp, setOpp] = useState("");
  const [holders, setHolders] = useState(false);
  const [minSeries, setMinSeries] = useState(0);
  const amt = parseAmount(stake, info.decimals);
  const oppAddr = mode === "named" ? parseAddress(opp) : null;
  const problem = amt === null ? (stake ? "that's not an amount" : null) : app.stakeProblem(amt);
  const districts = config.districts.length ? config.districts : [PAGE_DISTRICT];
  const secsList = config.roundSeconds.length ? config.roundSeconds : [...ROUND_SECONDS];
  const pick = (on: boolean): React.CSSProperties => ({ ...small(false), background: on ? "rgba(255,210,63,0.28)" : "rgba(255,255,255,0.06)", borderColor: on ? C.gold : "rgba(255,255,255,0.35)" });
  const submit = async () => {
    if (!amt) return;
    const id = await app.create({ stake: amt, roundSeconds: secs, district: PAGE_DISTRICT, listed: mode === "listed", opponent: oppAddr, holdersOnly: holders, minSeries });
    if (id) onDone();
  };
  return (
    <div style={{ display: "grid", gap: 10 }} data-testid="wager-create">
      <div>
        <div style={label}>stake (each player)</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
          <input value={stake} onChange={e => setStake(e.target.value.replace(/[^\d.,]/g, "").slice(0, 32))} inputMode="decimal" placeholder="100" data-pad-chars="0123456789." style={{ ...input, width: 140 }} data-testid="wager-create-stake" />
          <span style={{ fontSize: 13 }}>{info.symbol}</span>
          <span style={{ fontSize: 11, color: C.dim }}>max {formatAmount(BigInt(you && you.wins + you.losses < config.newAccountSeries ? config.newAccountMaxStake : config.maxStake), info.decimals)}</span>
        </div>
        {amt !== null && amt > 0n && <div style={{ fontSize: 11, color: C.dim, marginTop: 3 }}>pot {formatAmount(amt * 2n, info.decimals)} · the winner gets {formatAmount(amt * 2n - (amt * 2n * BigInt(config.houseFeeBps)) / 10_000n, info.decimals)} ({bpsText(config.houseFeeBps)} fee{config.holderFeeBps < config.houseFeeBps ? `, ${bpsText(config.holderFeeBps)} for a Radbro holder` : ""})</div>}
      </div>
      <div>
        <div style={label}>rounds · best of 3</div>
        <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
          {secsList.map(s => <button key={s} style={pick(secs === s)} onClick={() => setSecs(s)} data-testid={`wager-create-secs-${s}`}>{s} s</button>)}
        </div>
      </div>
      <div>
        <div style={label}>city</div>
        <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
          {districts.map(d => (
            <button key={d} style={pick(d === PAGE_DISTRICT)} onClick={() => d !== PAGE_DISTRICT && isDistrictId(d) && gotoDistrict(d, { wager: "", ...keepObj() })} title={d === PAGE_DISTRICT ? "" : "the page reloads in that city"}>{districtName(d)}</button>
          ))}
        </div>
      </div>
      <div>
        <div style={label}>who can join</div>
        <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
          <button style={pick(mode === "listed")} onClick={() => setMode("listed")} data-testid="wager-create-listed">open lobby</button>
          <button style={pick(mode === "link")} onClick={() => setMode("link")} data-testid="wager-create-link">invite link</button>
          <button style={pick(mode === "named")} onClick={() => setMode("named")} data-testid="wager-create-named">one address</button>
        </div>
        {mode === "named" && <input value={opp} onChange={e => setOpp(e.target.value.trim())} placeholder="0x… their wallet" style={{ ...input, width: "100%", marginTop: 6, fontSize: 13, borderColor: opp && !oppAddr ? C.red : undefined }} data-testid="wager-create-opponent" />}
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
          <button style={pick(holders)} onClick={() => setHolders(!holders)} data-testid="wager-create-holders">◆ holders only</button>
          <span style={{ fontSize: 11, color: C.dim }}>min series</span>
          {[0, 3, 10].map(n => <button key={n} style={pick(minSeries === n)} onClick={() => setMinSeries(n)}>{n === 0 ? "any" : `${n}+`}</button>)}
        </div>
      </div>
      {problem && <div style={{ fontSize: 12, color: C.red }} data-testid="wager-create-problem">{problem}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button style={btn(true)} disabled={!amt || !!problem || !!busy || (mode === "named" && !oppAddr)} onClick={() => void submit()} data-testid="wager-create-submit" data-pad-default="">
          {busy === "create" ? "SIGNING…" : "CREATE MATCH"}
        </button>
        <button style={btn(false)} onClick={onDone} data-pad-btn="EAST">CANCEL</button>
      </div>
    </div>
  );
}

/** The pairing banner: matched → locking; the relayer slow or failed → lock it yourself. */
export function PairingStatus({ app }: { app: WagerApp }) {
  const p = useWager(s => s.pairing);
  const busy = useWager(s => s.busy);
  const now = useNow(1000);
  if (!p || p.lockTx) return null;
  const slow = p.a && p.b && (p.failed || now - p.since > 20_000);
  return (
    <div style={{ marginBottom: 10 }} data-testid="wager-pairing">
      <Notice kind="info" text={p.a ? "matched: locking both stakes…" : "waiting for the relay to pair you…"} />
      {slow && (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          the relayer is slow: <button style={small(true)} disabled={!!busy} onClick={() => void app.lockYourself()} data-testid="wager-lock-yourself">LOCK IT YOURSELF</button> (your wallet pays the gas)
        </div>
      )}
    </div>
  );
}

export function LobbyView({ app }: { app: WagerApp }) {
  const s = useWager();
  const [creating, setCreating] = useState(false);
  if (!s.config || !s.info) return <Section testid="wager-lobby"><div>{s.fatal ? s.fatal.message : "connecting to the lobby…"}</div></Section>;
  const mine = s.offers.filter(o => sameAddress(o.creator.address, s.address));
  const open = s.offers.filter(o => !sameAddress(o.creator.address, s.address));
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <PairingStatus app={app} />
      <Section title="PLAY FOR TOKENS" testid="wager-lobby">
        <div style={{ fontSize: 13, color: C.dim, marginBottom: 8, lineHeight: 1.5 }}>
          1v1 SPIDER-TAG, best 2 of 3. Both players put up the same stake; the winner takes the pot minus the fee. The referee replays every input, so the result is the game's, not a client's.
        </div>
        {s.simOk === false && <div style={{ marginBottom: 8 }}><Notice kind="error" text="this page is out of date: reload to update before you play" /></div>}
        {!s.address ? <div style={{ fontSize: 13, color: C.ice }}>connect a wallet to create or join a match</div> : creating ? (
          <CreateForm app={app} onDone={() => setCreating(false)} />
        ) : (
          <button style={{ ...btn(true), fontSize: 17, padding: "10px 26px" }} onClick={() => setCreating(true)} disabled={s.simOk === false} data-testid="wager-new" data-pad-default="">NEW MATCH</button>
        )}
      </Section>
      {mine.length > 0 && (
        <Section title="YOUR OFFERS" testid="wager-mine">
          <div style={{ display: "grid", gap: 6 }}>{mine.map(o => <OfferRow key={o.matchId} app={app} o={o} mine />)}</div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 6 }}>an offer stays up while this page is open</div>
        </Section>
      )}
      <Section title={`OPEN MATCHES · ${open.length}`} testid="wager-offers">
        {s.lobby !== "online" && <div style={{ fontSize: 12, color: C.gold, marginBottom: 6 }}>{s.lobby === "retrying" ? "the lobby connection dropped: reconnecting…" : s.lobby === "login" ? "signing in…" : s.lobby === "closed" ? "not connected" : "connecting…"}</div>}
        {open.length === 0 ? <div style={{ fontSize: 13, opacity: 0.8 }}>no open matches right now: create one, or send an invite link</div> : (
          <div style={{ display: "grid", gap: 6 }}>{[...open].sort((a, b) => b.createdAt - a.createdAt).map(o => <OfferRow key={o.matchId} app={app} o={o} mine={false} />)}</div>
        )}
      </Section>
    </div>
  );
}

/** An invite link: the offer by id, straight to JOIN. */
export function JoinView({ app, matchId, onBack }: { app: WagerApp; matchId: Hex; onBack: () => void }) {
  const offers = useWager(s => s.offers);
  const config = useWager(s => s.config);
  const address = useWager(s => s.address);
  const [st, setSt] = useState<MatchStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    app.api.match(matchId).then(m => live && setSt(m), e => live && setErr(String((e as { message?: string }).message ?? e)));
    return () => { live = false; };
  }, [app, matchId, address]);
  const offer = offers.find(o => o.matchId === matchId) ?? st?.offer ?? null;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <PairingStatus app={app} />
      <Section title="INVITE" testid="wager-join">
        {err && <Notice kind="error" text={err} />}
        {!offer && !err && <div>{st ? (st.state === "open" ? "loading…" : `this match is ${st.state === "unknown" ? "no longer open" : st.state}`) : "loading the invite…"}</div>}
        {offer && config && (
          <>
            <div style={{ fontSize: 13, marginBottom: 8 }}>you're invited to a best-of-3 SPIDER-TAG match:</div>
            <div style={{ display: "grid", gap: 6 }}><OfferRow app={app} o={offer} mine={sameAddress(offer.creator.address, address)} /></div>
            {!address && <div style={{ marginTop: 8, color: C.ice, fontSize: 13 }}>connect a wallet (top right) to join</div>}
          </>
        )}
        <div style={{ marginTop: 10 }}><button style={small(false)} onClick={onBack} data-pad-btn="EAST">← lobby</button></div>
      </Section>
    </div>
  );
}
