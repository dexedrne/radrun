// SPIDER-TAG wager client: the wager relay (docs/WAGER.md §4). Its public HTTP routes (config, match status, logs,
// player cards, recent matches, the test-network faucet, the owner's review) and the lobby socket: hello, the login
// challenge signed by the session key (no popup) or the wallet, then offers, pairing, locks and relayer transactions.
// Reconnects by itself with a backoff. Pure TS over fetch / WebSocket.
import type { Address, Hex } from "viem";
import { loginTypedData, type EntryJson, type SessionAuthJson } from "./eip712.ts";
import {
  WAGER_PROTOCOL, WAGER_ROUTES, type Cosmetic, type FaucetReply, type LobbyClientMsg, type LobbyServerMsg, type MatchStatus, type PlayerCard, type RecentMatch,
  type RelayConfig, type ReviewRequest,
} from "./protocol.ts";
import type { SeriesLog } from "./log.ts";
import type { WagerNetId } from "./config.ts";
import { wagerError, type WagerError } from "./errors.ts";
import { sameAddress } from "./units.ts";

// ---- HTTP -------------------------------------------------------------------------------------------------------------

export type RelayApi = ReturnType<typeof relayApi>;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch {
    throw wagerError("relay", "can't reach the wager relay right now");
  }
  if (r.status === 451 || r.status === 403) {
    const t = await r.text().catch(() => "");
    if (/region/i.test(t) || r.status === 451) throw wagerError("region", "wager matches aren't available in your region");
    throw wagerError("relay", t.slice(0, 160) || "the relay refused it");
  }
  if (r.status === 404) throw wagerError("relay", "not found on the relay");
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    let m = t;
    try { m = (JSON.parse(t) as { message?: string }).message ?? t; } catch { /* text */ }
    throw wagerError("relay", (m || `the relay said ${r.status}`).slice(0, 200));
  }
  return (await r.json()) as T;
}

export function relayApi(base: string) {
  const b = base.replace(/\/$/, "");
  const post = <T>(path: string, body: unknown) => call<T>(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    base: b,
    config: () => call<RelayConfig>(`${b}${WAGER_ROUTES.config}`),
    health: async () => { try { const r = await fetch(`${b}${WAGER_ROUTES.health}`); return r.ok; } catch { return false; } },
    match: (id: Hex) => call<MatchStatus>(`${b}${WAGER_ROUTES.match}${id}`),
    log: (id: Hex) => call<SeriesLog>(`${b}${WAGER_ROUTES.log}${id}`),
    player: (a: Address) => call<PlayerCard>(`${b}${WAGER_ROUTES.player}${a}`),
    recent: (limit = 20) => call<RecentMatch[]>(`${b}${WAGER_ROUTES.recent}?limit=${limit}`),
    faucet: (address: Address) => post<FaucetReply>(WAGER_ROUTES.faucet, { address }),
    review: (req: ReviewRequest) => post<MatchStatus>(WAGER_ROUTES.review, req),
  };
}

export const wsUrl = (base: string, path: string): string => `${base.replace(/\/$/, "").replace(/^http/, "ws")}${path}`;

// ---- login ------------------------------------------------------------------------------------------------------------

/** Signs relay logins: the session key (no popup) when it is registered and live, else the wallet. */
export type LoginSigner = {
  player: Address;
  by(): "session" | "wallet";
  signTyped(td: ReturnType<typeof loginTypedData>): Promise<Hex>;
};

export async function loginMsg(s: LoginSigner, chainId: number, vault: Address, ch: { challenge: Hex; expiry: number; relay: string }) {
  const by = s.by();
  const sig = await s.signTyped(loginTypedData(chainId, vault, { player: s.player, challenge: ch.challenge, expiry: BigInt(ch.expiry), relay: ch.relay }));
  return { t: "login" as const, player: s.player, expiry: ch.expiry, sig, by };
}

// ---- the lobby socket ---------------------------------------------------------------------------------------------------

export type LobbyState = "off" | "connecting" | "login" | "online" | "retrying" | "closed";

export type LobbyEvents = {
  state(s: LobbyState, why?: string): void;
  msg(m: LobbyServerMsg): void;
  error(e: WagerError): void;
};

type WsLike = { readyState: number; send(d: string): void; close(code?: number, reason?: string): void; onopen: unknown; onclose: unknown; onmessage: unknown; onerror: unknown };
export type WsFactory = (url: string) => WsLike;

const BACKOFF = [1000, 2000, 4000, 8000, 15000];

export class LobbyClient {
  private ws: WsLike | null = null;
  private tries = 0;
  private stopped = false;
  private pingT: ReturnType<typeof setInterval> | null = null;
  private retryT: ReturnType<typeof setTimeout> | null = null;
  state: LobbyState = "off";
  signer: LoginSigner | null;
  /** Refused logins on this socket: the relay never re-challenges by itself, so the client asks again (bounded). */
  private refused = 0;
  /** The player this socket is signed in as (null: browsing, or not signed in yet). */
  private loggedAs: Address | null = null;
  private readonly base: string;
  private readonly net: WagerNetId;
  private readonly chainId: number;
  private readonly vault: Address;
  private readonly on: LobbyEvents;
  private readonly mkWs: WsFactory;

  constructor(base: string, net: WagerNetId, chainId: number, vault: Address, signer: LoginSigner | null, on: LobbyEvents, mkWs?: WsFactory) {
    this.base = base;
    this.net = net;
    this.chainId = chainId;
    this.vault = vault;
    this.signer = signer;
    this.on = on;
    this.mkWs = mkWs ?? (u => new WebSocket(u) as unknown as WsLike);
  }

  private set(s: LobbyState, why?: string) {
    this.state = s;
    this.on.state(s, why);
  }

  connect(): void {
    this.stopped = false;
    if (this.ws) return;
    this.set(this.tries ? "retrying" : "connecting");
    const ws = this.mkWs(wsUrl(this.base, WAGER_ROUTES.lobby));
    this.ws = ws;
    this.loggedAs = null;
    ws.onopen = () => {
      if (this.ws !== ws) { try { ws.close(1000, "bye"); } catch { /* closed */ } return; }
      this.refused = 0;
      this.send({ t: "hello", v: WAGER_PROTOCOL, net: this.net });
      this.pingT = setInterval(() => this.send({ t: "ping" }), 20_000);
    };
    ws.onmessage = (e: { data: unknown }) => {
      if (typeof e.data !== "string" || this.ws !== ws) return;
      let m: LobbyServerMsg;
      try { m = JSON.parse(e.data) as LobbyServerMsg; } catch { return; }
      void this.handle(m);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (e: { code?: number; reason?: string }) => {
      if (this.pingT) clearInterval(this.pingT);
      this.pingT = null;
      if (this.ws !== ws) return;
      this.ws = null;
      this.loggedAs = null;
      if (this.stopped) { this.set("closed"); return; }
      const why = e?.reason || "";
      if (/region|version/.test(why)) { this.set("closed", why); return; }
      const wait = BACKOFF[Math.min(this.tries, BACKOFF.length - 1)];
      this.tries++;
      this.set("retrying", why || "connection lost");
      this.retryT = setTimeout(() => this.connect(), wait);
    };
  }

  private async handle(m: LobbyServerMsg): Promise<void> {
    if (m.t === "challenge") {
      if (!this.signer) { this.set("online"); return; } // browsing only: offers without logging in
      this.set("login");
      try {
        this.send(await loginMsg(this.signer, this.chainId, this.vault, m));
      } catch (e) {
        this.on.error({ kind: "rejected", message: `couldn't sign in to the lobby: ${String((e as Error)?.message ?? e).split("\n")[0]}` });
      }
      return;
    }
    if (m.t === "welcome") { this.tries = 0; this.refused = 0; this.loggedAs = this.signer?.player ?? null; this.set("online"); }
    if (m.t === "error" && m.code === "auth" && this.state === "login") {
      // A refused login keeps the socket open (a session key the relay can't see yet, a stale challenge): ask for a
      // fresh challenge a couple of times, then browse without logging in.
      if (this.refused++ < 2) setTimeout(() => this.send({ t: "hello", v: WAGER_PROTOCOL, net: this.net }), 1500 * this.refused);
      else this.set("online", "not signed in");
    }
    if (m.t === "error" && (m.code === "region" || m.code === "version")) this.stopped = true;
    this.on.msg(m);
  }

  send(m: LobbyClientMsg): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(m));
    return true;
  }

  /**
   * Sign in again (the wallet just connected or changed account). A socket already signed in as the same player is
   * kept (a new session key changes nothing on it): closing it would make the relay withdraw that player's offers.
   */
  relogin(signer: LoginSigner | null): void {
    const keep = !!signer && sameAddress(signer.player, this.loggedAs) && this.ws?.readyState === 1;
    this.signer = signer;
    if (keep) return;
    this.close();
    this.tries = 0;
    this.connect();
  }

  openSession(auth: SessionAuthJson, sig: Hex) { return this.send({ t: "session", auth, sig }); }
  create(entry: EntryJson, sig: Hex, o: { listed: boolean; holdersOnly?: boolean; minSeries?: number }) { return this.send({ t: "create", entry, sig, ...o }); }
  cancel(matchId: Hex) { return this.send({ t: "cancel", matchId }); }
  join(entry: EntryJson, sig: Hex) { return this.send({ t: "join", entry, sig }); }
  profile(p: { name?: string; cosmetic?: Cosmetic | null }) { return this.send({ t: "profile", ...p }); }

  close(): void {
    this.stopped = true;
    if (this.retryT) clearTimeout(this.retryT);
    if (this.pingT) clearInterval(this.pingT);
    this.retryT = this.pingT = null;
    const ws = this.ws;
    this.ws = null;
    this.loggedAs = null;
    if (ws) { try { ws.close(1000, "bye"); } catch { /* closed */ } }
    this.set("closed");
  }
}
