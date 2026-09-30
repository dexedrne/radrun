// SPIDER-TAG wager beta: the unlisted ?wager page (docs/WAGER.md §7), its own lazy chunk (viem and everything wager
// live only here). It is the SPIDER-TAG page (app/TagPage.tsx: one canvas, the scene, the HUD, the online session)
// with this overlay in place of the menu, the ONLINE lobby and the results. Sub-routes: ?wager (the lobby, the wallet,
// history), &join=<matchId> (an invite link), &match=<matchId> (a series), &verify=<matchId> (the public match page, no
// wallet needed; ?verify=<matchId> alone opens it too), &review=<matchId> (the vault owner). &net=<id> picks another
// deployment this build offers.
import { useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import TagPage, { useTag, type TagHost } from "../app/TagPage.tsx";
import type { TagGame } from "../game/tagGame.ts";
import { PAGE_DISTRICT, gotoDistrict } from "../app/district.ts";
import { isDistrictId } from "../world/districts.ts";
import { scroller } from "../ui/screens.tsx";
import { WagerApp, useWager } from "./app.ts";
import { mySim } from "./assets.ts";
import { siteChoice, keepParams } from "./site.ts";
import { watchWallets, type WalletHost } from "./wallet.ts";
import { Banner, C, Notice, Section, btn, useNarrow } from "./ui.tsx";
import { LobbyView, JoinView, keepObj } from "./LobbyView.tsx";
import { WalletPanel } from "./WalletPanel.tsx";
import { SeriesView } from "./SeriesView.tsx";
import { VerifyView } from "./VerifyView.tsx";
import { HistoryView } from "./HistoryView.tsx";
import { parseHex32 } from "./units.ts";

const DEV = import.meta.env.MODE !== "production";

type Route = { kind: "lobby" } | { kind: "join" | "match" | "verify" | "review"; id: Hex };

function readRoute(search = location.search): Route {
  const q = new URLSearchParams(search);
  for (const k of ["match", "join", "verify", "review"] as const) {
    const id = parseHex32(q.get(k));
    if (id) return { kind: k, id };
  }
  return { kind: "lobby" };
}

const routeUrl = (r: Route): string => {
  const map = PAGE_DISTRICT !== "downtown" ? `&map=${PAGE_DISTRICT}` : "";
  return `${location.pathname}?wager${r.kind === "lobby" ? "" : `&${r.kind}=${r.id}`}${map}${keepParams()}`;
};

const HOST: TagHost = { Overlay: WagerOverlay };

export default function WagerPage() {
  return <TagPage host={HOST} />;
}

function WagerOverlay({ game }: { game: TagGame }) {
  const choice = useMemo(() => {
    const c = siteChoice();
    // A production build learns the vault only from deployments.json: until the deploy tool fills it in, say so
    // plainly instead of opening a lobby that can't reach anything.
    if (c.dep && !c.off && !c.dep.vault && !DEV && c.dep.net !== "local") return { ...c, off: `wager matches on ${c.dep.chainName} open soon: the vault isn't deployed yet` };
    return c;
  }, []);
  const [app, setApp] = useState<WagerApp | null>(null);
  const [route, setRoute] = useState<Route>(readRoute);
  const [tab, setTab] = useState<"lobby" | "wallet" | "history">("lobby");
  const narrow = useNarrow(900);
  const screen = useTag(s => s.screen);
  const s = useWager();

  const go = (r: Route, district?: string) => {
    if (r.kind !== "lobby" && district && district !== PAGE_DISTRICT && isDistrictId(district)) {
      gotoDistrict(district, { wager: "", [r.kind]: r.id, ...keepObj() });
      return;
    }
    history.pushState(null, "", routeUrl(r));
    setRoute(r);
  };

  useEffect(() => {
    const f = () => setRoute(readRoute());
    addEventListener("popstate", f);
    return () => removeEventListener("popstate", f);
  }, []);

  useEffect(() => {
    const dep = choice.dep;
    if (!dep || choice.off || !choice.relay) return;
    const a = new WagerApp({
      dep, base: choice.relay, rpc: choice.rpc, district: PAGE_DISTRICT,
      simFor: d => mySim(d, game.tuning, { district: PAGE_DISTRICT, model: game.model }),
      trustRelayVault: DEV || dep.net === "local",
    });
    a.onLocked = (id, district) => go({ kind: "match", id }, district);
    setApp(a);
    void a.start();
    const stop = watchWallets(window as unknown as WalletHost, list => a.setWallets(list));
    const q = new URLSearchParams(location.search);
    if (import.meta.env.MODE !== "production" && q.has("devwallet")) {
      const n = Number(q.get("devwallet") || 1);
      void import("./devWallet.ts").then(m => {
        m.installDevWallet(n, { chainId: dep.chainId, name: dep.chainName, rpc: choice.rpc[0] });
        // Headless runs: connect straight away.
        setTimeout(() => { const w = useWager.getState().wallets.find(x => x.info.rdns === "local.devwallet"); if (w && !useWager.getState().address) void a.connect(w); }, 600);
      });
    }
    return () => { stop(); a.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playing = screen === "match" || screen === "loading";
  const badge = (
    <div style={{ position: "fixed", left: "calc(10px + env(safe-area-inset-left, 0px))", bottom: "calc(8px + env(safe-area-inset-bottom, 0px))", zIndex: 26, background: C.gold, color: "#1a1a1a", font: "900 11px ui-monospace, monospace", padding: "2px 8px", borderRadius: 4, letterSpacing: 1, pointerEvents: "none" }} data-testid="wager-badge">
      {choice.dep?.label ?? "BETA"}
    </div>
  );

  if (!choice.dep || choice.off) {
    return (
      <>
        <Banner dep={choice.dep} address={null} />
        <div style={{ ...scroller, paddingTop: 56 }}><Section style={{ margin: "auto", maxWidth: 520 }} testid="wager-off"><div>{choice.off ?? "wager matches aren't switched on for this build"}</div></Section></div>
      </>
    );
  }
  if (!app) return badge;

  const back = () => { go({ kind: "lobby" }); setTab("lobby"); };
  let body: React.ReactNode;
  if (route.kind === "match") body = <SeriesView key={route.id} app={app} game={game} matchId={route.id} onExit={back} />;
  else if (route.kind === "verify" || route.kind === "review") body = <VerifyView key={route.id} app={app} game={game} matchId={route.id} review={route.kind === "review"} onBack={back} />;
  if (route.kind === "join") body = (
    <div style={{ display: "grid", gap: 10, maxWidth: 760, margin: "0 auto" }}>
      <JoinView app={app} matchId={route.id} onBack={back} />
      <WalletPanel app={app} />
    </div>
  );
  else if (route.kind === "lobby") {
    const tabs: ("lobby" | "wallet" | "history")[] = narrow ? ["lobby", "wallet", "history"] : ["lobby", "history"];
    const cur = !narrow && tab === "wallet" ? "lobby" : tab;
    body = (
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "grid", gap: 10 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ font: `900 ${narrow ? 30 : 46}px/1 ui-monospace, monospace`, letterSpacing: narrow ? 3 : 6, color: "#fff", textShadow: "4px 4px 0 #ff3d7f, 8px 8px 0 rgba(0,0,0,0.35)" }}>SPIDER-TAG</div>
          <div style={{ marginTop: 6, fontSize: 13, textShadow: "0 1px 2px #000" }}>1v1 for tokens · best 2 of 3{choice.dep.testnet ? " · test tokens only, no real value" : ""}</div>
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "center" }} role="tablist">
          {tabs.map(t => (
            <button key={t} role="tab" aria-selected={cur === t} onClick={() => setTab(t)} style={{ ...btn(cur === t), padding: "7px 16px", fontSize: 13 }} data-testid={`wager-tab-${t}`}>{t.toUpperCase()}</button>
          ))}
        </div>
        {cur === "history" ? <HistoryView app={app} /> : narrow ? (cur === "wallet" ? <WalletPanel app={app} /> : <LobbyView app={app} />) : (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.35fr) minmax(0, 1fr)", gap: 10, alignItems: "start" }}>
            <LobbyView app={app} />
            <WalletPanel app={app} />
          </div>
        )}
      </div>
    );
  }

  // One tree whatever the screen: a round starting must never remount the series view (its socket lives there).
  // While a round plays, the layers have no box (display: contents), so nothing covers the canvas.
  return (
    <>
      {playing ? badge : <Banner dep={choice.dep} address={s.address} onWallet={() => { if (route.kind !== "lobby") back(); setTab("wallet"); }} />}
      <div style={playing ? { display: "contents" } : { ...scroller, background: "linear-gradient(180deg, rgba(10,12,30,0.35), rgba(10,12,30,0.72))", paddingTop: "calc(48px + env(safe-area-inset-top, 0px))" }} data-testid={playing ? undefined : "wager-page"}>
        <div style={playing ? { display: "contents" } : { width: "100%", padding: "8px 16px 24px", boxSizing: "border-box" }}>
          {!playing && s.fatal && <div style={{ maxWidth: 760, margin: "0 auto 10px" }}><Notice kind="error" text={s.fatal.message} /></div>}
          {!playing && s.notice && Date.now() - s.notice.at < 12_000 && route.kind !== "match" && (
            <div style={{ maxWidth: 760, margin: "0 auto 10px" }}><Notice kind={s.notice.kind} text={s.notice.text} onClose={() => useWager.setState({ notice: null })} /></div>
          )}
          {body}
        </div>
      </div>
    </>
  );
}
