// The wager lobby (docs/WAGER.md §4.2-§4.8), independent of the runtime: the WagerLobby Durable Object (a singleton,
// hibernatable sockets) and the Node stand-in drive it. It owns logins, the open offers and pairing, the player
// records and ratings, the Radbro cache, and the only relayer queue (so the relayer's nonces never collide), plus the
// faucet on test networks.
//
// Offers are signed Entries held off-chain: creating one costs nothing, and every check a lock would make (terms,
// signatures, session limits, balances, caps) is made before any transaction. The creator's open Entry (opponent 0) is
// never handed to anyone: whoever held it could pair it with an account the lobby never vetted. A join asks the
// creator's page to sign a named Entry for the vetted joiner (`sign` / `signed`), the relayer simulates and sends
// lock() with the two named Entries, and the series room is initialised on the receipt. Records change only when a
// settle or void is confirmed on-chain.
import { hashTypedData, recoverAddress, type Address, type Hex } from "viem";
import { cleanName } from "../../../src/net/wire.ts";
import {
  capturedFees, entryDigest, entryFromJson, matchIdCreator, sessionAuthFromJson, sessionAuthTypedData, type Entry, type EntryJson, type SessionAuthJson,
} from "../../../src/wager/eip712.ts";
import type { SeriesOutcome } from "../../../src/wager/log.ts";
import {
  WAGER_LIMITS, WAGER_PROTOCOL, type Cosmetic, type FaucetReply, type LobbyClientMsg, type LobbyServerMsg, type MatchStatus, type Offer, type PlayerCard,
  type RecentMatch, type RelayConfig, type SignedEntry, type TxKind, type WagerErrorCode,
} from "../../../src/wager/protocol.ts";
import { checkLogin, newChallenge, type Challenge } from "./auth.ts";
import { MS_CANCELLED, MS_LOCKED, MS_NONE, MS_SETTLED, MS_VOIDED } from "./abi.ts";
import { ZERO, addr, errMsg, idTag, isHex32, isSig, normId, sameAddr, shortAddr, spend, type Clock, type Logger, type Sql } from "./base.ts";
import { erc20Transfer, vaultCall, type Call, type ChainMatch, type VaultChain } from "./chain.ts";
import type { RadbroReader } from "./radbro.ts";
import { RELAYER_GAS, type Relayer, type TxHandle } from "./relayer.ts";
import type { RoomInit, SeriesUpdate, SettleRequest } from "./room.ts";
import { regionBlocked, type WagerSettings } from "./settings.ts";
import type { Sims } from "./sims.ts";

/** A lobby socket's state: serialisable (the Durable Object keeps it as the hibernating socket's attachment). */
export type LobbyConnState = {
  id: string;
  ip: string;
  relay: string;
  hello: boolean;
  ch: Challenge | null;
  player: Address | null;
  credit: number;
  creditAt: number;
};

export type LobbyConn = {
  state: LobbyConnState;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Persist state changes (hibernation). */
  save(): void;
};

/** The rooms as the lobby reaches them (WagerRoom DOs over internal requests, or direct calls in Node). */
export type RoomLink = {
  init(matchId: Hex, o: RoomInit): Promise<void>;
  settled(matchId: Hex, o: { tx: Hex | null; state: "settled" | "voided" }): Promise<void>;
  status(matchId: Hex): Promise<Pick<MatchStatus, "series" | "outcome" | "settlement" | "settleTx" | "lockTx"> | null>;
  /** Ask a room to check the chain (someone else closed its match). */
  sync(matchId: Hex): Promise<void>;
};

export type LobbyDeps = {
  clock: Clock;
  sql: Sql;
  settings: WagerSettings;
  chain: VaultChain;
  sims: Sims;
  radbro: RadbroReader;
  /** REFEREE_KEY's address (null: no key). Offers are refused unless it is the vault's referee: nobody else can settle. */
  referee: Address | null;
  /** RELAYER_KEY's queue (null: no relayer; players submit their own transactions). */
  relayer: Relayer | null;
  /** FAUCET_KEY's queue (test networks only). */
  faucet: Relayer | null;
  rooms: RoomLink;
  /** Every open lobby socket (the Durable Object's getWebSockets()). */
  connections(): LobbyConn[];
  log?: Logger;
};

type OfferRec = { offer: Offer; sig: Hex };
type MatchRow = {
  match_id: string; state: string; a: string; b: string; stake: string; lock_tx: string | null; settle_tx: string | null; ended_at: number | null; json: string;
};
type MatchJson = {
  entries?: [SignedEntry, SignedEntry];
  /** The IPs of both players' lobby sockets when they were paired (the room compares its logins with them). */
  ips?: [string[], string[]];
  outcome?: SeriesOutcome;
  heldCounted?: boolean;
  recorded?: boolean;
  lockedAt?: number;
  settleBy?: number;
};
type PlayerRow = {
  address: string; name: string | null; rating: number; wins: number; losses: number; forfeits: number; voids: number; held: number;
  first_seen: number; last_seen: number; cosmetic: string | null;
};

const MAX_JSON = 4096;
/** A socket with more messages than this still waiting is closed (a client sends one at a time). */
const MAX_QUEUED = 16;
const DAY = 86_400_000;
const WEB: readonly Cosmetic["web"][] = ["classic", "gold", "ice", "toxic", "violet", "rose"];
const TRAIL: readonly Cosmetic["trail"][] = ["none", "spark", "ribbon", "comet"];
/** Series states that keep a player busy (no second series until it is settled). */
const BUSY = ["locking", "locked", "playing", "held", "signed"];
/** Relay-submitted openSession transactions per IP per day (gas griefing bound). */
const SESSION_TX_PER_IP = 20;
/** A join needs this much of both Entries' deadlines left (the lock must mine before them). */
const LOCK_MARGIN_S = 20;

export const ELO = { start: 1200, k: 32 } as const;

/** What the lobby knows of a match it paired (the room only seats a match the lobby paired: docs/WAGER.md §4.4). */
export type Paired = { players: [Address, Address]; ips: [string[], string[]] };

export function elo(winner: number, loser: number, k: number = ELO.k): [number, number] {
  const ew = 1 / (1 + 10 ** ((loser - winner) / 400));
  return [winner + k * (1 - ew), loser - k * (1 - ew)];
}

/** An Entry from the wire, strictly (null if anything is off). */
export function parseEntry(j: unknown): Entry | null {
  const e = j as EntryJson;
  if (!e || typeof e !== "object") return null;
  const player = addr(e.player), opponent = addr(e.opponent);
  if (!isHex32(e.matchId) || !player || !opponent || !isHex32(e.rules)) return null;
  if (typeof e.stake !== "string" || !/^\d{1,39}$/.test(e.stake)) return null;
  const stake = BigInt(e.stake);
  if (stake <= 0n || stake >= 2n ** 128n) return null;
  for (const [v, max] of [[e.feeCapBps, 65_535], [e.roundSeconds, 65_535], [e.deadline, 2 ** 53 - 1]] as const) if (!Number.isInteger(v) || v < 0 || v > max) return null;
  return entryFromJson({ matchId: normId(e.matchId), player, opponent, stake: e.stake, feeCapBps: e.feeCapBps, roundSeconds: e.roundSeconds, rules: e.rules.toLowerCase() as Hex, deadline: e.deadline });
}

const toJson = (e: Entry): EntryJson => ({ ...e, stake: e.stake.toString(), deadline: Number(e.deadline) });

export class LobbyError extends Error {
  readonly code: WagerErrorCode;
  constructor(code: WagerErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (code: WagerErrorCode, message: string): never => { throw new LobbyError(code, message); };

export class WagerLobbyCore {
  private readonly d: LobbyDeps;
  private readonly offers = new Map<string, OfferRec>();
  private readonly chains = new Map<string, Promise<void>>();
  /** Messages each socket has waiting (bounded: most wait on the chain, and the RPC's limits are everyone's). */
  private readonly depth = new Map<string, number>();
  private readonly settling = new Set<string>();
  /** Joins waiting for their creator's named Entry (`sign` sent, `signed` not back yet), by match id. */
  private readonly signing = new Map<string, { creator: Address; done: (sig: Hex | null, why?: string) => void }>();

  constructor(d: LobbyDeps) {
    this.d = d;
    const q = (s: string) => d.sql.exec(s);
    q("CREATE TABLE IF NOT EXISTS players (address TEXT PRIMARY KEY, name TEXT, rating REAL NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL, forfeits INTEGER NOT NULL, voids INTEGER NOT NULL, held INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, cosmetic TEXT)");
    q("CREATE TABLE IF NOT EXISTS offers (match_id TEXT PRIMARY KEY, json TEXT NOT NULL, deadline INTEGER NOT NULL)");
    q("CREATE TABLE IF NOT EXISTS matches (match_id TEXT PRIMARY KEY, state TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, stake TEXT NOT NULL, lock_tx TEXT, settle_tx TEXT, ended_at INTEGER, json TEXT NOT NULL)");
    q("CREATE INDEX IF NOT EXISTS matches_ended ON matches (ended_at)");
    q("CREATE TABLE IF NOT EXISTS faucet (address TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    q("CREATE TABLE IF NOT EXISTS ip_counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL, day INTEGER NOT NULL)");
    // Offers survive hibernation (their creators' sockets are still open); after a restart they are dropped.
    const live = new Set(d.connections().map(c => c.state.player?.toLowerCase()).filter(Boolean));
    for (const r of d.sql.exec("SELECT match_id, json FROM offers")) {
      const rec = JSON.parse(String(r.json)) as OfferRec;
      if (live.has(rec.offer.creator.address.toLowerCase())) this.offers.set(String(r.match_id), rec);
      else d.sql.exec("DELETE FROM offers WHERE match_id = ?", String(r.match_id));
    }
  }

  private log(m: string): void {
    this.d.log?.(`[lobby] ${m}`);
  }

  private get now(): number {
    return this.d.clock.now();
  }

  // ---- sockets ------------------------------------------------------------------------------------------------------

  /** A new lobby socket (the Worker has checked its origin and region). False: refused (too many from this IP). */
  open(c: LobbyConn): boolean {
    const n = this.d.connections().filter(x => x.state.ip === c.state.ip && x.state.id !== c.state.id).length;
    if (c.state.ip && n >= WAGER_LIMITS.socketsPerIp) {
      this.sendTo(c, { t: "error", code: "rate", message: "too many lobby connections from here" });
      c.close(1008, "rate");
      return false;
    }
    return true;
  }

  private sendTo(c: LobbyConn, m: LobbyServerMsg): void {
    try { c.send(JSON.stringify(m)); } catch { /* closed */ }
  }

  private conns(player?: Address | null): LobbyConn[] {
    const all = this.d.connections();
    return player === undefined ? all.filter(c => c.state.hello) : all.filter(c => sameAddr(c.state.player, player));
  }

  private toPlayer(p: Address, m: LobbyServerMsg): void {
    for (const c of this.conns(p)) this.sendTo(c, m);
  }

  /** A socket's message; resolves once it is handled (messages of one socket are handled in order). */
  message(c: LobbyConn, data: string | ArrayBuffer | Uint8Array): Promise<void> {
    if (typeof data !== "string") return Promise.resolve();
    if (data.length > MAX_JSON) { c.close(1009, "too big"); return Promise.resolve(); }
    const b = { credit: c.state.credit, at: c.state.creditAt };
    const ok = spend(b, this.now, WAGER_LIMITS.maxMsgsPerSec, WAGER_LIMITS.msgBurst);
    c.state.credit = b.credit;
    c.state.creditAt = b.at;
    c.save();
    if (!ok) { c.close(1008, "rate"); return Promise.resolve(); }
    let m: LobbyClientMsg;
    try { m = JSON.parse(data) as LobbyClientMsg; } catch { c.close(1003, "bad json"); return Promise.resolve(); }
    if (!m || typeof m !== "object") return Promise.resolve();
    // One message at a time per socket (logins and joins wait on the chain).
    const id = c.state.id;
    const depth = (this.depth.get(id) ?? 0) + 1;
    if (depth > MAX_QUEUED) { c.close(1008, "rate"); return Promise.resolve(); }
    this.depth.set(id, depth);
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(() => this.handle(c, m)).catch(e => {
      if (e instanceof LobbyError) this.sendTo(c, { t: "error", code: e.code, message: e.message });
      else { this.log(`error: ${errMsg(e)}`); this.sendTo(c, { t: "error", code: "busy", message: "the relay could not do that right now: try again" }); }
    });
    this.chains.set(id, next);
    return next.finally(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
      const n = (this.depth.get(id) ?? 1) - 1;
      if (n > 0) this.depth.set(id, n); else this.depth.delete(id);
    });
  }

  /** Wait for a socket's queued messages (tests). */
  idle(): Promise<unknown> {
    return Promise.all([...this.chains.values()]);
  }

  private async handle(c: LobbyConn, m: LobbyClientMsg): Promise<void> {
    const s = c.state;
    if (!s.hello || (m.t === "hello" && !s.player)) {
      // hello again before logging in (after a refused login): a fresh challenge.
      if (m.t !== "hello") { c.close(1008, "hello first"); return; }
      if (m.v !== WAGER_PROTOCOL) fail("version", "the game changed: reload to update");
      if (m.net !== this.d.settings.net) fail("version", `this relay runs ${this.d.settings.net}, not ${String(m.net)}`);
      s.hello = true;
      s.ch = newChallenge(this.now, s.relay, this.d.settings.timing.challengeTtlMs);
      c.save();
      this.sendTo(c, { t: "challenge", ...s.ch });
      this.sendTo(c, { t: "offers", offers: this.offersFor(null) });
      return;
    }
    switch (m.t) {
      case "login": return this.login(c, m);
      case "ping": this.sendTo(c, { t: "pong" }); return;
      case "session": return this.session(c, m.auth, m.sig);
      case "profile": return this.profile(c, m);
      case "create": return this.create(c, m);
      case "cancel": return this.cancel(c, m.matchId);
      case "join": return this.join(c, m.entry, m.sig);
      case "signed": return this.signed(c, m);
      case "hello": return;
      default: fail("bad", "unknown message");
    }
  }

  /** A lobby socket closed: a creator with no socket left withdraws their offers. */
  close(c: LobbyConn): void {
    const p = c.state.player;
    this.chains.delete(c.state.id);
    if (!p) return;
    if (this.d.connections().some(x => x !== c && x.state.id !== c.state.id && sameAddr(x.state.player, p))) return;
    for (const [id, rec] of this.offers) if (sameAddr(rec.offer.creator.address, p)) this.removeOffer(id, "creator-left");
    for (const w of [...this.signing.values()]) if (sameAddr(w.creator, p)) w.done(null, "the creator left");
  }

  // ---- login and profile --------------------------------------------------------------------------------------------

  private async login(c: LobbyConn, m: Extract<LobbyClientMsg, { t: "login" }>): Promise<void> {
    const ch = c.state.ch;
    c.state.ch = null; // single use
    c.save();
    const r = await checkLogin(this.d.chain, ch, m, this.now);
    if (!r.ok) {
      // No new challenge by itself (a client that signs every challenge would loop): hello again for one.
      this.sendTo(c, { t: "error", code: "auth", message: r.why });
      return;
    }
    c.state.player = r.player;
    c.save();
    this.touch(r.player);
    const [you, config] = await Promise.all([this.card(r.player), this.config(null)]);
    this.sendTo(c, { t: "welcome", you, config });
    this.sendTo(c, { t: "offers", offers: this.offersFor(r.player) });
  }

  private touch(p: Address): void {
    const k = p.toLowerCase(), now = this.now;
    if (this.row(k)) this.d.sql.exec("UPDATE players SET last_seen = ? WHERE address = ?", now, k);
    else this.d.sql.exec("INSERT INTO players (address, name, rating, wins, losses, forfeits, voids, held, first_seen, last_seen, cosmetic) VALUES (?, NULL, ?, 0, 0, 0, 0, 0, ?, ?, NULL)", k, ELO.start, now, now);
  }

  private row(k: string): PlayerRow | null {
    return (this.d.sql.exec("SELECT * FROM players WHERE address = ?", k.toLowerCase())[0] as unknown as PlayerRow | undefined) ?? null;
  }

  private settledCount(p: Address): number {
    const r = this.row(p);
    return r ? r.wins + r.losses : 0;
  }

  /**
   * A player's public card: record, rating, account age, Radbro holdings (the relay's own Ethereum reads). Only an
   * address that has logged in gets the Ethereum reads: GET /player/<any address> must not turn the relay into a free
   * proxy for public RPCs (or fill its cache).
   */
  async card(a: Address): Promise<PlayerCard> {
    const r = this.row(a);
    const h = r ? await this.d.radbro.holder(a) : { holder: false, ids: [] };
    let cosmetic: Cosmetic | null = null;
    try { cosmetic = r?.cosmetic ? (JSON.parse(r.cosmetic) as Cosmetic) : null; } catch { /* ignore */ }
    return {
      address: a, name: r?.name || shortAddr(a), rating: Math.round(r?.rating ?? ELO.start), wins: r?.wins ?? 0, losses: r?.losses ?? 0,
      forfeits: r?.forfeits ?? 0, voids: r?.voids ?? 0, held: r?.held ?? 0, firstSeen: r?.first_seen ?? 0, holder: h.holder, radbros: h.ids,
      cosmetic: h.holder ? cosmetic : null,
    };
  }

  private async profile(c: LobbyConn, m: Extract<LobbyClientMsg, { t: "profile" }>): Promise<void> {
    const p = c.state.player ?? fail("auth", "log in first");
    if (m.name !== undefined) {
      if (typeof m.name !== "string") fail("bad", "bad name");
      this.d.sql.exec("UPDATE players SET name = ? WHERE address = ?", cleanName(m.name), p.toLowerCase());
    }
    if (m.cosmetic !== undefined) {
      const x = m.cosmetic;
      if (x !== null && (!x || !WEB.includes(x.web) || !TRAIL.includes(x.trail))) fail("bad", "bad cosmetic");
      if (x !== null && !(await this.d.radbro.holder(p)).holder) fail("forbidden", "web colours and trails are for Radbro holders");
      this.d.sql.exec("UPDATE players SET cosmetic = ? WHERE address = ?", x ? JSON.stringify({ web: x.web, trail: x.trail }) : null, p.toLowerCase());
    }
    this.toPlayer(p, { t: "card", card: await this.card(p) });
  }

  // ---- the relay config ---------------------------------------------------------------------------------------------

  async config(country: string | null): Promise<RelayConfig> {
    const s = this.d.settings;
    if (!s.vault) fail("gone", `the ${s.net} vault is not deployed yet`);
    const i = await this.d.chain.info();
    const nam = s.newAccountMaxStake === null || s.newAccountMaxStake > i.maxStake ? i.maxStake : s.newAccountMaxStake;
    return {
      v: WAGER_PROTOCOL, net: s.net, chainId: s.chainId, vault: s.vault!, token: i.token, tokenSymbol: i.tokenSymbol, tokenDecimals: i.tokenDecimals,
      referee: i.referee, relayer: this.d.relayer?.address ?? ZERO, houseFeeBps: i.houseFeeBps, holderFeeBps: i.holderFeeBps, maxStake: i.maxStake.toString(),
      maxBalance: i.maxBalance.toString(), newAccountMaxStake: nam.toString(), newAccountSeries: s.newAccountSeries, roundSeconds: s.roundSeconds,
      districts: s.districts, sims: await this.d.sims.compats(), timing: s.timing as unknown as RelayConfig["timing"], faucet: s.faucet && !!this.d.faucet,
      regionBlocked: regionBlocked(country, s), beta: true,
    };
  }

  // ---- session keys (gasless openSession) ---------------------------------------------------------------------------

  private async session(c: LobbyConn, authJ: SessionAuthJson, sig: Hex): Promise<void> {
    const relayer = this.d.relayer ?? fail("chain", "no relayer here: submit openSession yourself");
    if (!authJ || typeof authJ !== "object" || !isSig(sig)) fail("bad", "bad session request");
    const player = addr(authJ.player), key = addr(authJ.sessionKey);
    if (!player || !key || key === ZERO || !/^\d{1,39}$/.test(String(authJ.maxStake)) || !/^\d{1,39}$/.test(String(authJ.cap))) fail("bad", "bad session request");
    if (!Number.isInteger(authJ.expiry) || !Number.isInteger(authJ.nonce)) fail("bad", "bad session request");
    const auth = sessionAuthFromJson({ ...authJ, player: player!, sessionKey: key! });
    // The wallet's signature is checked here too (no gas for a bad one), then the vault checks it all again.
    const digest = hashTypedData(sessionAuthTypedData(this.d.chain.chainId, this.d.chain.vault, auth));
    if (!(await this.d.chain.verifyHash(player!, digest, sig))) fail("auth", "that session was not signed by the wallet");
    this.ipCount(c.state.ip, "session", SESSION_TX_PER_IP) || fail("rate", "too many session requests from here today");
    const call = vaultCall(this.d.chain.vault, "openSession", [auth, sig]);
    const why = await this.d.chain.simulate(relayer.address, call);
    if (why) fail("chain", `openSession would fail: ${why}`);
    const notify = (m: LobbyServerMsg) => { this.sendTo(c, m); for (const x of this.conns(player!)) if (x.state.id !== c.state.id) this.sendTo(x, m); };
    await this.track("session", null, relayer, call, notify);
  }

  /** Send through a relayer queue and report sent / confirmed / failed. Resolves once it is sent. */
  private async track(kind: TxKind, matchId: Hex | null, q: Relayer, call: Call, notify: (m: LobbyServerMsg) => void,
    then?: (ok: boolean, h: TxHandle | null, why: string) => Promise<void> | void): Promise<TxHandle | null> {
    let h: TxHandle;
    try {
      h = await q.submit(call, RELAYER_GAS[kind]);
    } catch (e) {
      const why = errMsg(e);
      notify({ t: "tx", kind, matchId, hash: null, status: "failed", error: why });
      await then?.(false, null, why);
      return null;
    }
    notify({ t: "tx", kind, matchId, hash: h.hash, status: "sent" });
    void h.done.then(async r => {
      const ok = r.status === "success";
      notify({ t: "tx", kind, matchId, hash: h.hash, status: ok ? "confirmed" : "failed", ...(ok ? {} : { error: r.status }) });
      await then?.(ok, h, r.status);
    }).catch(e => this.log(`${kind} follow-up failed: ${errMsg(e)}`));
    return h;
  }

  private ipCount(ip: string, kind: string, max: number): boolean {
    if (!ip) return true;
    const day = Math.floor(this.now / DAY), key = `${kind}:${ip}`;
    const r = this.d.sql.exec("SELECT n, day FROM ip_counters WHERE key = ?", key)[0];
    const n = r && Number(r.day) === day ? Number(r.n) : 0;
    if (n >= max) return false;
    this.d.sql.exec("INSERT OR REPLACE INTO ip_counters (key, n, day) VALUES (?, ?, ?)", key, n + 1, day);
    return true;
  }

  // ---- offers -------------------------------------------------------------------------------------------------------

  /** Listed offers, plus the player's own and the named invites to them. */
  private offersFor(p: Address | null): Offer[] {
    return [...this.offers.values()]
      .map(r => r.offer)
      .filter(o => o.listed || (p && (sameAddr(o.creator.address, p) || sameAddr(o.opponent, p))))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private broadcastOffer(o: Offer): void {
    for (const c of this.conns()) {
      const p = c.state.player;
      if (o.listed || (p && (sameAddr(o.creator.address, p) || sameAddr(o.opponent, p)))) this.sendTo(c, { t: "offer", offer: o });
    }
  }

  private removeOffer(id: string, reason: "cancelled" | "matched" | "expired" | "creator-left"): OfferRec | null {
    const rec = this.offers.get(id);
    if (!rec) return null;
    this.offers.delete(id);
    this.d.sql.exec("DELETE FROM offers WHERE match_id = ?", id);
    for (const c of this.conns()) this.sendTo(c, { t: "unoffer", matchId: rec.offer.matchId, reason });
    return rec;
  }

  private busy(p: Address): boolean {
    const k = p.toLowerCase();
    return this.d.sql.exec(`SELECT 1 FROM matches WHERE (a = ? OR b = ?) AND state IN (${BUSY.map(() => "?").join(",")}) LIMIT 1`, k, k, ...BUSY).length > 0;
  }

  /**
   * An Entry's signature as the vault checks it: ECDSA recovery first (the player's live session key, within its limits,
   * or the wallet itself), else ERC-1271 / ERC-6492 for the player.
   */
  private async entrySig(e: Entry, sig: Hex): Promise<"session" | "wallet"> {
    if (!isSig(sig)) fail("bad", "bad signature");
    const digest = entryDigest(this.d.chain.chainId, this.d.chain.vault, e);
    if (sig.length === 132) {
      let signer: Address | null = null;
      try { signer = await recoverAddress({ hash: digest, signature: sig }); } catch { /* not ECDSA */ }
      if (signer) {
        const s = await this.d.chain.sessionOf(e.player);
        if (s.key !== ZERO && sameAddr(s.key, signer)) {
          if (s.expiry <= this.now / 1000) fail("session", "your session key expired: authorise a new one");
          if (e.stake > s.maxStake) fail("session", "the stake is above your session key's limit per match");
          if (s.used + e.stake > s.cap) fail("session", "your session key's total cap is used up: authorise a new one");
          return "session";
        }
        if (sameAddr(signer, e.player)) return "wallet";
      }
    }
    if (await this.d.chain.verifyHash(e.player, digest, sig)) return "wallet";
    return fail("session", "the entry is not signed by your session key or wallet");
  }

  private async stakeOk(p: Address, stake: bigint): Promise<void> {
    const i = await this.d.chain.info();
    if (stake <= 0n || stake > i.maxStake) fail("stake", `the stake must be between 1 and ${i.maxStake} base units`);
    const nam = this.d.settings.newAccountMaxStake;
    if (nam !== null && stake > nam && this.settledCount(p) < this.d.settings.newAccountSeries) {
      fail("stake", `new accounts can stake at most ${nam} base units until they have ${this.d.settings.newAccountSeries} settled series`);
    }
    if ((await this.d.chain.freeOf(p)) < stake) fail("balance", "not enough free balance in the vault: deposit first");
  }

  /**
   * The relay refuses what the vault would refuse or what it could not settle. The vault reverts a lock while either
   * Entry's fee cap is under its house fee (FeeAboveCap), so every Entry must cover the vault's fee now. And only the
   * vault's referee can sign a Result: with another key (or none) every stake would sit locked until the settle window
   * refunds it.
   */
  private async termsOk(e: Entry): Promise<void> {
    const i = await this.d.chain.info();
    if (i.paused) fail("busy", "the vault is paused: no new matches right now");
    if (!this.d.referee || !sameAddr(this.d.referee, i.referee)) fail("busy", "the relay can't referee matches right now: try later");
    if (e.feeCapBps < i.houseFeeBps) fail("terms", `the entry's fee cap (${e.feeCapBps} bps) is below the vault's fee (${i.houseFeeBps} bps): reload to update`);
  }

  private async create(c: LobbyConn, m: Extract<LobbyClientMsg, { t: "create" }>): Promise<void> {
    const me = c.state.player ?? fail("auth", "log in first");
    const s = this.d.settings;
    if (!s.vault) fail("gone", "the vault is not deployed yet");
    if (!this.d.sims.selfTestOk) fail("busy", "the relay's sim failed its self-test, so it does not referee: try later");
    const e = parseEntry(m.entry) ?? fail("bad", "bad entry");
    if (!sameAddr(e.player, me)) fail("terms", "the entry is for another player");
    if (!sameAddr(matchIdCreator(e.matchId), me)) fail("terms", "a match id starts with its creator's address: reload to update");
    if (sameAddr(e.opponent, me)) fail("terms", "you can't play yourself");
    if (!s.roundSeconds.includes(e.roundSeconds)) fail("terms", `rounds are ${s.roundSeconds.join(" / ")} s here`);
    const sim = (await this.d.sims.byRules(e.rules)) ?? fail("terms", "the rules don't match a district this relay referees on this sim: reload to update");
    if (Number(e.deadline) < this.now / 1000 + 60) fail("terms", "the entry's deadline must be at least a minute away");
    const minSeries = m.minSeries === undefined ? 0 : m.minSeries;
    if (!Number.isInteger(minSeries) || minSeries < 0 || minSeries > 1000) fail("bad", "bad minimum series");
    const id = e.matchId;
    if (this.offers.has(id) || this.d.sql.exec("SELECT 1 FROM matches WHERE match_id = ?", id).length) fail("terms", "that match id is taken");
    const mine = [...this.offers.values()].filter(r => sameAddr(r.offer.creator.address, me)).length;
    if (mine >= WAGER_LIMITS.offersPerPlayer) fail("rate", `at most ${WAGER_LIMITS.offersPerPlayer} open offers each`);
    if (this.offers.size >= WAGER_LIMITS.offersTotal) fail("busy", "the lobby is full: try again soon");
    await this.termsOk(e);
    await this.stakeOk(me, e.stake);
    await this.entrySig(e, m.sig);
    if ((await this.d.chain.matchOf(id)).state !== MS_NONE) fail("terms", "that match id is taken");
    const i = await this.d.chain.info();
    const fees = capturedFees(i.houseFeeBps, i.holderFeeBps, e.feeCapBps, e.feeCapBps);
    const offer: Offer = {
      matchId: id, creator: await this.card(me), stake: e.stake.toString(), roundSeconds: e.roundSeconds, district: sim.district, feeBps: fees.feeBps,
      holderFeeBps: fees.holderFeeBps, listed: m.listed === true, opponent: e.opponent === ZERO ? null : e.opponent, holdersOnly: m.holdersOnly === true,
      minSeries, deadline: Number(e.deadline), createdAt: this.now, entry: toJson(e),
    };
    if (this.offers.has(id)) fail("terms", "that match id is taken");
    this.offers.set(id, { offer, sig: m.sig });
    this.d.sql.exec("INSERT OR REPLACE INTO offers (match_id, json, deadline) VALUES (?, ?, ?)", id, JSON.stringify({ offer, sig: m.sig }), offer.deadline);
    this.broadcastOffer(offer);
    if (!offer.listed) this.toPlayer(me, { t: "offer", offer });
  }

  private cancel(c: LobbyConn, matchId: unknown): void {
    const me = c.state.player ?? fail("auth", "log in first");
    if (typeof matchId !== "string") fail("bad", "bad match id");
    const rec = this.offers.get(normId(matchId as string)) ?? fail("gone", "no such offer");
    if (!sameAddr(rec.offer.creator.address, me)) fail("forbidden", "not your offer");
    this.removeOffer(rec.offer.matchId, "cancelled");
  }

  // ---- joining and the lock -----------------------------------------------------------------------------------------

  private async join(c: LobbyConn, entryJ: EntryJson, sig: Hex): Promise<void> {
    const me = c.state.player ?? fail("auth", "log in first");
    const b = parseEntry(entryJ) ?? fail("bad", "bad entry");
    if (!sameAddr(b.player, me)) fail("terms", "the entry is for another player");
    const rec = this.offers.get(b.matchId) ?? fail("gone", "that offer is gone");
    const o = rec.offer, a = entryFromJson(o.entry);
    if (sameAddr(a.player, me)) fail("terms", "you can't join your own offer");
    if (o.opponent && !sameAddr(o.opponent, me)) fail("forbidden", "this invite is for someone else");
    if (!sameAddr(b.opponent, a.player)) fail("terms", "your entry must name the creator as the opponent");
    if (b.stake !== a.stake || b.roundSeconds !== a.roundSeconds || b.rules !== a.rules) fail("terms", "your entry's stake, round length or rules differ from the offer");
    const now = this.now / 1000;
    if (Number(a.deadline) < now + LOCK_MARGIN_S) { this.removeOffer(o.matchId, "expired"); fail("gone", "that offer expired"); }
    if (Number(b.deadline) < now + LOCK_MARGIN_S) fail("terms", "your entry's deadline is too close");
    if (o.holdersOnly && !(await this.d.radbro.holder(me)).holder) fail("forbidden", "this table is for Radbro holders");
    if (this.settledCount(me) < o.minSeries) fail("forbidden", `this offer wants players with ${o.minSeries}+ settled series`);
    if (!this.conns(a.player).length) { this.removeOffer(o.matchId, "creator-left"); fail("gone", "the creator left"); }
    if (this.busy(me) || this.busy(a.player)) fail("busy", "one of you is still in an unsettled series");
    await this.termsOk(b);
    // The vault's fee may have gone up since the offer: then the creator's Entry can't lock any more.
    if (a.feeCapBps < (await this.d.chain.info()).houseFeeBps) { this.removeOffer(o.matchId, "cancelled"); fail("gone", "that offer was made under an older fee: it's withdrawn"); }
    await this.stakeOk(me, b.stake);
    await this.entrySig(b, sig);
    if ((await this.d.chain.freeOf(a.player)) < a.stake) { this.removeOffer(o.matchId, "cancelled"); fail("balance", "the creator no longer has the stake free"); }
    // The creator's session key may have been used up (another of their offers locked), revoked or replaced since the
    // offer went up: then lock() would revert every time, so the offer goes now.
    const creatorOk = await this.entrySig(a, rec.sig).then(() => true, () => false);
    if (!creatorOk) { this.removeOffer(o.matchId, "cancelled"); fail("gone", "that offer can't be played any more: its creator's session key no longer covers it"); }
    // Taken: from here the offer is this pair's (a second joiner finds it gone). The checks above waited on the chain,
    // so another join may have paired either player meanwhile: check again with no await before taking it.
    if (!this.offers.has(o.matchId)) fail("gone", "that offer is gone");
    if (this.busy(me) || this.busy(a.player)) fail("busy", "one of you is still in an unsettled series");
    this.removeOffer(o.matchId, "matched");
    const ips: [string[], string[]] = [this.ipsOf(a.player), this.ipsOf(me)];
    // The row keeps both players busy while the creator signs and the lock runs.
    this.d.sql.exec("INSERT OR REPLACE INTO matches (match_id, state, a, b, stake, lock_tx, settle_tx, ended_at, json) VALUES (?, 'locking', ?, ?, ?, NULL, NULL, NULL, ?)",
      o.matchId, a.player.toLowerCase(), me.toLowerCase(), a.stake.toString(), JSON.stringify({ ips } satisfies MatchJson));
    let sa: SignedEntry;
    try {
      // A named invite already names this joiner; an open offer (a listed one, or an invite link) gets a named Entry.
      sa = a.opponent === ZERO ? await this.named(o, a, me) : { entry: o.entry, sig: rec.sig };
    } catch (e) {
      this.d.sql.exec("DELETE FROM matches WHERE match_id = ? AND state = 'locking'", o.matchId);
      this.toPlayer(a.player, { t: "error", code: "gone", message: "a player joined your offer but it fell through, so it's withdrawn: make a new one" });
      throw e;
    }
    const sb: SignedEntry = { entry: toJson(b), sig };
    this.d.sql.exec("UPDATE matches SET json = ? WHERE match_id = ?", JSON.stringify({ entries: [sa, sb], ips } satisfies MatchJson), o.matchId);
    const matched: LobbyServerMsg = { t: "matched", matchId: o.matchId, a: sa, b: sb };
    this.toPlayer(a.player, matched);
    this.toPlayer(me, matched);
    await this.lock(o, rec, entryFromJson(sa.entry), sa.sig, b, sig);
  }

  /** The IPs of a player's open lobby sockets. */
  private ipsOf(p: Address): string[] {
    return [...new Set(this.conns(p).map(c => c.state.ip).filter(Boolean))].slice(0, 8);
  }

  /**
   * The creator's page signs the offer's terms naming the vetted joiner, with a deadline a few minutes away (its session
   * key: no popup). Its answer is checked as lock() would check it; no answer in time, a refusal or a bad signature
   * withdraw the offer.
   */
  private async named(o: Offer, a: Entry, joiner: Address): Promise<SignedEntry> {
    const id = o.matchId, T = this.d.settings.timing;
    const deadline = Math.min(Number(a.deadline), Math.floor(this.now / 1000) + T.namedTtlS);
    const e: Entry = { ...a, opponent: joiner, deadline: BigInt(deadline) };
    const joinerCard = await this.card(joiner);
    const answer = await new Promise<{ sig: Hex | null; why?: string }>(resolve => {
      const t = this.d.clock.setTimeout(() => w.done(null, "timeout"), T.signWaitMs);
      const w = {
        creator: a.player,
        done: (sig: Hex | null, why?: string) => {
          if (this.signing.get(id) !== w) return;
          this.signing.delete(id);
          this.d.clock.clearTimeout(t);
          resolve({ sig, why });
        },
      };
      this.signing.get(id)?.done(null, "replaced");
      this.signing.set(id, w);
      this.toPlayer(a.player, { t: "sign", matchId: id, entry: toJson(e), joiner: joinerCard });
    });
    if (!answer.sig) {
      this.log(`sign ${idTag(id)}: no named entry (${answer.why ?? "refused"})`);
      fail("gone", answer.why === "timeout" ? "the creator's page didn't confirm the match in time: the offer is withdrawn"
        : answer.why === "the creator left" ? "the creator left" : "the creator's page didn't confirm the match: the offer is withdrawn");
    }
    const ok = await this.entrySig(e, answer.sig!).then(() => true, () => false);
    if (!ok) fail("gone", "the creator's confirmation didn't check out: the offer is withdrawn");
    return { entry: toJson(e), sig: answer.sig! };
  }

  /** The creator's answer to `sign`. */
  private signed(c: LobbyConn, m: Extract<LobbyClientMsg, { t: "signed" }>): void {
    const me = c.state.player ?? fail("auth", "log in first");
    if (!isHex32(m.matchId)) fail("bad", "bad match id");
    const w = this.signing.get(normId(m.matchId));
    if (!w || !sameAddr(w.creator, me)) return; // late, or not theirs: nothing waits for it
    if (m.sig !== null && !isSig(m.sig)) fail("bad", "bad signature");
    w.done(m.sig, typeof m.why === "string" ? m.why.slice(0, 120) : undefined);
  }

  private async lock(o: Offer, rec: OfferRec, a: Entry, sigA: Hex, b: Entry, sigB: Hex): Promise<void> {
    const id = o.matchId, players: [Address, Address] = [a.player, b.player];
    const notify = (m: LobbyServerMsg) => { for (const p of players) this.toPlayer(p, m); };
    const failed = async (why: string) => {
      this.log(`lock ${idTag(id)} failed: ${why}`);
      const m = await this.d.chain.matchOf(id).catch(() => null);
      // It locked after all, with these two players (one of them submitted it): the room takes over. MatchExists with
      // anyone else (or a cancelled id) is a failed lock.
      if (m && m.state !== MS_NONE && m.state !== MS_CANCELLED && sameAddr(m.playerA, a.player) && sameAddr(m.playerB, b.player)) return;
      this.d.sql.exec("DELETE FROM matches WHERE match_id = ? AND state = 'locking'", id);
      notify({ t: "error", code: "chain", message: `the lock failed: ${why}` });
      // A named invite goes back up if its creator is still here and it still has time (its Entry names only that
      // player). An open offer doesn't: a named Entry for this joiner is out, so the creator makes a new offer.
      if (o.opponent && this.conns(a.player).length && Number(o.deadline) > this.now / 1000 + 60 && !this.offers.has(id) && (!m || m.state === MS_NONE)) {
        this.offers.set(id, rec);
        this.d.sql.exec("INSERT OR REPLACE INTO offers (match_id, json, deadline) VALUES (?, ?, ?)", id, JSON.stringify(rec), o.deadline);
        this.broadcastOffer(o);
      }
    };
    const relayer = this.d.relayer;
    if (!relayer) return; // no relayer: the players submit lock() themselves, the room initialises from the chain
    const call = vaultCall(this.d.chain.vault, "lock", [a, sigA, b, sigB]);
    const why = await this.d.chain.simulate(relayer.address, call);
    if (why) { await failed(why); return; }
    await this.track("lock", id, relayer, call, notify, async (ok, h, err) => {
      if (!ok && h && err === "timeout") {
        // No receipt yet is not a failure: the lock may still land. The sweep takes it from here (it initialises the
        // room if it lands, which tells both players, and drops it after the deadlines if not); the offer stays taken.
        this.d.sql.exec("UPDATE matches SET lock_tx = ? WHERE match_id = ? AND state = 'locking'", h.hash, id);
        return;
      }
      if (!ok || !h) { await failed(err); return; }
      const m = await this.d.chain.matchOf(id);
      if (m.state !== MS_LOCKED || !sameAddr(m.playerA, a.player) || !sameAddr(m.playerB, b.player)) { await failed("the match is not locked"); return; }
      this.d.sql.exec("UPDATE matches SET state = 'locked', lock_tx = ? WHERE match_id = ?", h.hash, id);
      const cards = (await Promise.all(players.map(p => this.card(p)))) as [PlayerCard, PlayerCard];
      await this.d.rooms.init(id, { match: m, lockTx: h.hash, cards, ips: this.match(id)?.j.ips }).catch(e => this.log(`room init failed: ${errMsg(e)}`));
      notify({ t: "locked", matchId: id, tx: h.hash });
    });
  }

  /** The players the lobby paired for a match (and their lobby IPs then); null if it never paired it. */
  paired(idIn: string): Paired | null {
    const r = this.match(normId(idIn));
    const pa = r ? addr(r.a) : null, pb = r ? addr(r.b) : null;
    return pa && pb ? { players: [pa, pb], ips: r!.j.ips ?? [[], []] } : null;
  }

  // ---- series progress, settles and records -------------------------------------------------------------------------

  private match(id: string): (MatchRow & { j: MatchJson }) | null {
    const r = this.d.sql.exec("SELECT * FROM matches WHERE match_id = ?", id)[0] as unknown as MatchRow | undefined;
    return r ? { ...r, j: JSON.parse(r.json) as MatchJson } : null;
  }

  private putJson(id: string, j: MatchJson): void {
    this.d.sql.exec("UPDATE matches SET json = ? WHERE match_id = ?", JSON.stringify(j), id);
  }

  /** A room's progress (from the room). */
  async update(u: SeriesUpdate): Promise<void> {
    const id = normId(u.matchId);
    const state = u.phase === "waiting" ? "locked" : u.phase === "between" || u.phase === "playing" || u.phase === "deciding" ? "playing" : u.phase;
    let r = this.match(id);
    if (!r) {
      this.d.sql.exec("INSERT INTO matches (match_id, state, a, b, stake, lock_tx, settle_tx, ended_at, json) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, '{}')",
        id, state, u.players[0].toLowerCase(), u.players[1].toLowerCase(), u.stake, u.lockTx);
      r = this.match(id)!;
    } else if (r.state !== "settled" && r.state !== "voided") {
      // The room's players are the chain's (matchOf): records follow them.
      this.d.sql.exec("UPDATE matches SET state = ?, a = ?, b = ? WHERE match_id = ?", state, u.players[0].toLowerCase(), u.players[1].toLowerCase(), id);
      // A lock whose receipt came late: the room has it now.
      if (r.state === "locking" && r.lock_tx) for (const p of u.players) this.toPlayer(p, { t: "locked", matchId: id, tx: r.lock_tx as Hex });
    }
    if (u.outcome) r.j.outcome = u.outcome;
    if (u.held && !r.j.heldCounted) {
      r.j.heldCounted = true;
      for (const s of u.heldSides) this.d.sql.exec("UPDATE players SET held = held + 1 WHERE address = ?", u.players[s].toLowerCase());
    }
    this.putJson(id, r.j);
  }

  /** A room's signed Result: submit settle() (idempotent; the room repeats this until it hears back). */
  async settle(req: SettleRequest): Promise<void> {
    const id = normId(req.matchId);
    await this.update({ matchId: id, players: req.players, stake: req.stake, phase: "signed", outcome: req.outcome, held: false, heldSides: [], lockTx: null });
    if (this.settling.has(id)) return;
    const r = this.match(id);
    if (r && (r.state === "settled" || r.state === "voided")) { await this.d.rooms.settled(id, { tx: r.settle_tx as Hex | null, state: r.state }); return; }
    const relayer = this.d.relayer;
    const { result, sig } = req.settlement;
    const call = vaultCall(this.d.chain.vault, "settle", [result, sig]);
    const state = result.outcome === 1 ? "settled" : "voided";
    const notify = (m: LobbyServerMsg) => { for (const p of req.players) this.toPlayer(p, m); };
    // In flight from here (a repeated request while this one simulates must not send it twice).
    this.settling.add(id);
    try {
      const why = relayer ? await this.d.chain.simulate(relayer.address, call) : "no relayer";
      if (why) {
        this.settling.delete(id);
        const m = await this.d.chain.matchOf(id);
        if (m.state === MS_SETTLED || m.state === MS_VOIDED) await this.finish(id, await this.d.chain.settleTxOf(id), m.state === MS_SETTLED ? "settled" : "voided");
        else if (relayer) this.log(`settle ${idTag(id)} would fail: ${why}`);
        return;
      }
      await this.track("settle", id, relayer!, call, notify, async (ok, h) => {
        this.settling.delete(id);
        if (ok && h) await this.finish(id, h.hash, state);
      });
    } catch (e) {
      this.settling.delete(id);
      throw e;
    }
  }

  /** A settle or void is confirmed on-chain: records, ratings, the room. */
  private async finish(id: Hex, tx: Hex | null, state: "settled" | "voided"): Promise<void> {
    const r = this.match(id);
    if (!r) return;
    if (!r.j.recorded) {
      r.j.recorded = true;
      const o = r.j.outcome;
      const a = r.a, b = r.b;
      if (state === "settled" && o && o.kind === "win" && o.winner !== null) {
        const w = o.winner === 0 ? a : b, l = o.winner === 0 ? b : a;
        const rw = this.row(w)?.rating ?? ELO.start, rl = this.row(l)?.rating ?? ELO.start;
        const [nw, nl] = elo(rw, rl);
        this.ensureRow(w);
        this.ensureRow(l);
        this.d.sql.exec("UPDATE players SET wins = wins + 1, rating = ? WHERE address = ?", nw, w);
        this.d.sql.exec(`UPDATE players SET losses = losses + 1, rating = ?${o.reason === "forfeit" ? ", forfeits = forfeits + 1" : ""} WHERE address = ?`, nl, l);
      } else if (state === "voided") {
        for (const p of [a, b]) { this.ensureRow(p); this.d.sql.exec("UPDATE players SET voids = voids + 1 WHERE address = ?", p); }
      }
    }
    this.d.sql.exec("UPDATE matches SET state = ?, settle_tx = ?, ended_at = ?, json = ? WHERE match_id = ?", state, tx, this.now, JSON.stringify(r.j), id);
    await this.d.rooms.settled(id, { tx, state }).catch(e => this.log(`room settled failed: ${errMsg(e)}`));
    for (const p of [r.a, r.b]) {
      const a = addr(p)!;
      if (this.conns(a).length) this.toPlayer(a, { t: "card", card: await this.card(a) });
    }
  }

  private ensureRow(k: string): void {
    if (!this.row(k)) this.d.sql.exec("INSERT INTO players (address, name, rating, wins, losses, forfeits, voids, held, first_seen, last_seen, cosmetic) VALUES (?, NULL, ?, 0, 0, 0, 0, 0, ?, ?, NULL)", k.toLowerCase(), ELO.start, this.now, this.now);
  }

  // ---- public reads -------------------------------------------------------------------------------------------------

  async matchStatus(idIn: string): Promise<MatchStatus> {
    const id = normId(idIn);
    const off = this.offers.get(id);
    if (off) return { matchId: id, state: "open", offer: off.offer, series: null, outcome: null, settlement: null, lockTx: null, settleTx: null };
    const r = this.match(id);
    // Only a match the lobby knows has a room (a room that initialised itself from the chain has told the lobby): an
    // unknown id never wakes a room.
    const rs = r ? await this.d.rooms.status(id).catch(() => null) : null;
    if (!r && !rs) return { matchId: id, state: "unknown", offer: null, series: null, outcome: null, settlement: null, lockTx: null, settleTx: null };
    const ph = rs?.series?.phase;
    const state: MatchStatus["state"] = r?.state === "settled" || r?.state === "voided" ? r.state
      : ph ? (ph === "waiting" ? "locked" : ph === "between" || ph === "playing" || ph === "deciding" ? "playing" : ph)
      : r?.state === "locking" || r?.state === "locked" ? "locked" : "unknown";
    return {
      matchId: id, state, offer: null, series: rs?.series ?? null, outcome: rs?.outcome ?? r?.j.outcome ?? null, settlement: rs?.settlement ?? null,
      lockTx: (rs?.lockTx ?? r?.lock_tx ?? null) as Hex | null, settleTx: (r?.settle_tx ?? rs?.settleTx ?? null) as Hex | null,
    };
  }

  async recent(limit: number): Promise<RecentMatch[]> {
    const n = Math.max(1, Math.min(100, Math.floor(limit) || 20));
    const rows = this.d.sql.exec("SELECT * FROM matches WHERE state IN ('settled', 'voided') ORDER BY ended_at DESC LIMIT ?", n) as unknown as MatchRow[];
    const out: RecentMatch[] = [];
    for (const r of rows) {
      const j = JSON.parse(r.json) as MatchJson;
      out.push({
        matchId: r.match_id as Hex, players: [await this.card(addr(r.a)!), await this.card(addr(r.b)!)], stake: r.stake,
        outcome: j.outcome ?? { kind: "void", winner: null, reason: "error", score: [0, 0] }, settleTx: r.settle_tx as Hex | null, endedAt: r.ended_at ?? 0,
      });
    }
    return out;
  }

  /** Series that are being played (the deploy tool refuses to redeploy the relay while any are). */
  live(): number {
    return Number(this.d.sql.exec("SELECT COUNT(*) AS n FROM matches WHERE state IN ('locking', 'locked', 'playing')")[0]?.n ?? 0);
  }

  private gasRead: { at: number; wei: [bigint | null, bigint | null] } | null = null;

  /**
   * The relayer's and the faucet's gas balances (wei; null where there is none), for /health: the owner watches them
   * (every gasless call and faucet claim spends them). Read from the chain at most once a minute, so /health (which
   * the rate limiter lets through) never turns into an RPC call per request.
   */
  async gasBalances(): Promise<[bigint | null, bigint | null]> {
    const now = this.now;
    if (this.gasRead && now - this.gasRead.at < 60_000) return this.gasRead.wei;
    const prev = this.gasRead?.wei ?? [null, null];
    this.gasRead = { at: now, wei: prev };
    const read = (q: Relayer | null, i: 0 | 1) => (q ? this.d.chain.ethBalance(q.address).catch(() => prev[i]) : Promise.resolve(null));
    const wei = await Promise.all([read(this.d.relayer, 0), read(this.d.faucet, 1)]) as [bigint | null, bigint | null];
    this.gasRead = { at: now, wei };
    return wei;
  }

  /** Anything the sweep still has to watch: open offers, and matches not yet settled or voided on-chain. */
  pending(): number {
    return this.offers.size + Number(this.d.sql.exec("SELECT COUNT(*) AS n FROM matches WHERE state NOT IN ('settled', 'voided')")[0]?.n ?? 0);
  }

  // ---- faucet (test networks only) ----------------------------------------------------------------------------------

  async faucetClaim(body: unknown, ip: string, country: string | null): Promise<{ status: number; body: FaucetReply | { error: string; message: string; code: WagerErrorCode } }> {
    const s = this.d.settings, q = this.d.faucet;
    if (!s.faucet || !q || !s.vault) return { status: 404, body: { error: "no faucet here", message: "no faucet here", code: "gone" } };
    if (regionBlocked(country, s)) return { status: 403, body: { error: "not available in your region", message: "not available in your region", code: "region" } };
    const a = addr((body as { address?: unknown } | null)?.address);
    if (!a || a === ZERO) return { status: 400, body: { error: "send {address}", message: "send {address}", code: "bad" } };
    const k = a.toLowerCase(), now = this.now;
    const last = this.d.sql.exec("SELECT at FROM faucet WHERE address = ?", k)[0];
    if (last && now - Number(last.at) < DAY) return { status: 429, body: { error: "this address already claimed today", message: "this address already claimed today", code: "rate" } };
    if (!this.ipCount(ip, "faucet", WAGER_LIMITS.faucetPerIpPerDay)) return { status: 429, body: { error: "too many claims from here today", message: "too many claims from here today", code: "rate" } };
    this.d.sql.exec("INSERT OR REPLACE INTO faucet (address, at) VALUES (?, ?)", k, now);
    const i = await this.d.chain.info();
    let tokenTx: Hex | null = null, ethTx: Hex | null = null, eth = 0n;
    try {
      tokenTx = (await q.submit(erc20Transfer(i.token, a, s.faucetTokens), RELAYER_GAS.faucet)).hash;
      if ((await this.d.chain.ethBalance(a)) < s.faucetEth) {
        ethTx = (await q.submit({ to: a, data: "0x", value: s.faucetEth }, RELAYER_GAS.faucet)).hash;
        eth = s.faucetEth;
      }
    } catch (e) {
      if (!tokenTx) this.d.sql.exec("DELETE FROM faucet WHERE address = ?", k);
      return { status: 502, body: { error: `the faucet failed: ${errMsg(e)}`, message: `the faucet failed: ${errMsg(e)}`, code: "chain" } };
    }
    return { status: 200, body: { tokenTx, ethTx, tokens: s.faucetTokens.toString(), eth: eth.toString() } };
  }

  // ---- housekeeping (the Durable Object's alarm; a timer in Node) -----------------------------------------------------

  /** Expire offers, and catch matches closed without us (a player's own settle, refundExpired). Returns the next due time. */
  async sweep(): Promise<number | null> {
    const now = this.now;
    for (const [id, r] of this.offers) if (r.offer.deadline * 1000 < now + LOCK_MARGIN_S * 1000) this.removeOffer(id, "expired");
    const open = this.d.sql.exec("SELECT match_id, state FROM matches WHERE state NOT IN ('settled', 'voided')") as unknown as { match_id: Hex; state: string }[];
    for (const r of open) {
      try {
        const m = await this.d.chain.matchOf(r.match_id);
        if (m.state === MS_SETTLED || m.state === MS_VOIDED) await this.finish(r.match_id, await this.d.chain.settleTxOf(r.match_id), m.state === MS_SETTLED ? "settled" : "voided");
        else if (m.state === MS_LOCKED) await this.d.rooms.sync(r.match_id).catch(() => {});
        else if ((m.state === MS_NONE || m.state === MS_CANCELLED) && r.state === "locking" && !this.settling.has(r.match_id) && !this.signing.has(r.match_id)) {
          // A lock that never landed (the relay restarted mid-flight).
          const j = this.match(r.match_id)?.j;
          const dl = j?.entries ? Math.min(j.entries[0].entry.deadline, j.entries[1].entry.deadline) : 0;
          if (dl * 1000 < now) this.d.sql.exec("DELETE FROM matches WHERE match_id = ?", r.match_id);
        }
      } catch (e) {
        this.log(`sweep ${idTag(r.match_id)}: ${errMsg(e)}`);
      }
    }
    return this.offers.size || open.length ? now + 60_000 : null;
  }

  /** For the tests and the Node stand-in's logs. */
  offerCount(): number {
    return this.offers.size;
  }

  /** The chain's match, re-read (the lobby passes it to the room at init). */
  matchOf(id: Hex): Promise<ChainMatch> {
    return this.d.chain.matchOf(id);
  }
}
