// SPIDER-TAG wager: the wager relay's HTTP routes and socket messages, shared by relay/wager (Worker + Node stand-in),
// the ?wager client and the tests (docs/WAGER.md §4-§6). The in-match input stream reuses the online wire format
// (src/net/wire.ts: INPUT, INPUT_OUT, FILL, ACK, PING/PONG) unchanged; this adds the relay's latency probe and the
// JSON messages of the lobby socket and the room socket. Pure TS; no DOM.
import type { Address, Hex } from "viem";
import type { Compat, StartMsg } from "../net/wire.ts";
import type { EntryJson, ResultJson, SessionAuthJson, SimCompat } from "./eip712.ts";
import type { Flag, RoundResult, SeriesOutcome, Side } from "./log.ts";
import type { WagerNetId } from "./config.ts";

/** Bumped on any change below; the relay refuses other versions ("reload to update"). */
export const WAGER_PROTOCOL = 2;

// ---- HTTP routes of the wager relay (relay/wager: Worker "radrun-wager-relay", or node relay/wager/dev.ts) ----------

export const WAGER_ROUTES = {
  /** GET -> "ok" */
  health: "/health",
  /** GET -> RelayConfig */
  config: "/config",
  /** GET, WebSocket upgrade: the lobby socket (LobbyClientMsg / LobbyServerMsg). */
  lobby: "/lobby",
  /**
   * GET ?room=<matchId>, WebSocket upgrade: the series room (RoomClientMsg / RoomServerMsg + wire.ts binary). The same
   * path and query as the live relay's rooms, so net/transport.ts Transport.connect(base, matchId) opens it unchanged.
   */
  room: "/ws",
  /** GET /match/<matchId> -> MatchStatus (public: open offers by id for invite links, live and finished series). */
  match: "/match/",
  /** GET /log/<matchId> -> SeriesLog (public, once the series is over). */
  log: "/log/",
  /** GET /player/<address> -> PlayerCard */
  player: "/player/",
  /** GET ?limit=N -> RecentMatch[] (settled and voided series, newest first). */
  recent: "/recent",
  /** POST FaucetRequest -> FaucetReply (test networks only; 404 on a mainnet deployment). */
  faucet: "/faucet",
  /** POST ReviewRequest -> MatchStatus (the vault owner's decision on a held series). */
  review: "/review",
} as const;

// ---- binary: the relay's own latency probe (everything else is net/wire.ts) ----------------------------------------

/** PROBE relay -> client: u8 type · u32 probe id. The client echoes it at once (PROBE_ECHO); the relay times the round trip. */
export const MSG_PROBE = 0x87;
/** PROBE_ECHO client -> relay: u8 type · u32 probe id. */
export const MSG_PROBE_ECHO = 0x07;

export function encodeProbe(type: typeof MSG_PROBE | typeof MSG_PROBE_ECHO, id: number): Uint8Array {
  const b = new Uint8Array(5);
  new DataView(b.buffer).setUint32(1, id >>> 0, true);
  b[0] = type;
  return b;
}

export function decodeProbe(b: Uint8Array): { type: number; id: number } | null {
  if (b.length !== 5 || (b[0] !== MSG_PROBE && b[0] !== MSG_PROBE_ECHO)) return null;
  return { type: b[0], id: new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(1, true) };
}

// ---- timing and limits (defaults; the relay's config may tighten them, the client reads them from RelayConfig) ----

export const WAGER_TIMING = {
  /** A word for step s must reach the relay by startAtMs + s x 8.33 ms + lateMs + min(one-way, maxOneWayAllowMs). */
  lateMs: 100,
  maxOneWayAllowMs: 150,
  /** A series does not start while either player's relay-measured round trip is above this. */
  maxRttMs: 300,
  /** Latency probes before each round (the minimum round trip counts). */
  probes: 5,
  /** After the lock, both players must be in the room and ready within this, or the match is void (no-show). */
  joinGraceMs: 60_000,
  /** A player whose socket closes mid-series has this long to come back (their inputs are filled meanwhile). */
  reconnectGraceMs: 20_000,
  /** Between rounds: both READY starts the next round at once; otherwise it starts when this runs out. */
  betweenRoundsMs: 15_000,
  /** Relay time from `start` to step 0 of a round (models load meanwhile). */
  startDelayMs: 3_000,
  /** A login challenge is good for this long. */
  challengeTtlMs: 60_000,
  /** Default Entry deadlines: listed offers and invite links. */
  offerTtlS: 1_800,
  inviteTtlS: 86_400,
  /** The deadline of the named Entry a creator signs for a vetted joiner (`sign`): the lock must land before it. */
  namedTtlS: 300,
  /** How long the lobby waits for the creator's `signed` (a wallet-only creator gets a popup). */
  signWaitMs: 45_000,
} as const;

export const WAGER_LIMITS = {
  /** Same bucket as the live relay (a client sends ~32 messages a second in play). */
  maxMsgBytes: 1024,
  maxMsgsPerSec: 90,
  msgBurst: 180,
  /** Words may run at most this far ahead of the relay clock. */
  aheadSteps: 600,
  /** Open offers per creator, and in the whole lobby. */
  offersPerPlayer: 3,
  offersTotal: 200,
  /** Lobby sockets per IP. */
  socketsPerIp: 8,
  /** Faucet claims per address per day and per IP per day. */
  faucetPerAddressPerDay: 1,
  faucetPerIpPerDay: 3,
} as const;

export const ROUND_SECONDS = [60, 90, 120] as const;
export const DEFAULT_ROUND_SECONDS = 90;

// ---- shared shapes ------------------------------------------------------------------------------------------------------

export type WebColor = "classic" | "gold" | "ice" | "toxic" | "violet" | "rose";
export type TrailStyle = "none" | "spark" | "ribbon" | "comet";
/** Radbro-holder cosmetics (render only; the relay passes them on only for holders). */
export type Cosmetic = { web: WebColor; trail: TrailStyle };

export type PlayerCard = {
  address: Address;
  /** cleanName()d display name, or "0x1234…abcd". */
  name: string;
  /** Elo (start 1200, K 32) over settled wins and losses; forfeits count as losses. */
  rating: number;
  wins: number;
  losses: number;
  forfeits: number;
  voids: number;
  /** Series of this player held for review so far. */
  held: number;
  /** Unix ms of the first login. */
  firstSeen: number;
  /** Holds a Radbro (V2, or V1) on Ethereum mainnet, read by the relay for this proven address. */
  holder: boolean;
  /** Owned Radbro V2 token ids (the first 50), read by the relay. */
  radbros: number[];
  cosmetic: Cosmetic | null;
};

export type Offer = {
  matchId: Hex;
  creator: PlayerCard;
  /** Token base units, decimal string. */
  stake: string;
  roundSeconds: number;
  district: string;
  /** The fees a lock would capture now (the joiner's entry caps them again). */
  feeBps: number;
  holderFeeBps: number;
  /** In the open list, or only reachable by its invite link / id. */
  listed: boolean;
  /** Only this address may join (a named invite), or null. */
  opponent: Address | null;
  holdersOnly: boolean;
  /** Joiners need at least this many settled series. */
  minSeries: number;
  /** The creator's Entry deadline (unix s). */
  deadline: number;
  createdAt: number;
  /** The creator's Entry: the joiner signs the same matchId, stake, feeCap, roundSeconds, rules. */
  entry: EntryJson;
};

export type SignedEntry = { entry: EntryJson; sig: Hex };
export type Settlement = { result: ResultJson; sig: Hex };

export type RadbroPick = {
  /** The roster model the sim slot and renderer use. */
  radbro: string;
  /** The player's own Radbro V2 id, verified with ownerOf by the relay (badge, name, portrait), or null. */
  own: number | null;
};

export type SeriesPhase =
  | "waiting" // locked; waiting for both players (joinGraceMs)
  | "between" // before a round: probes, picks, seeds, READY
  | "playing" // a round is on
  | "deciding" // the last round ended; the referee is checking flags
  | "held" // flagged: waiting for the owner's review (settleBy still guarantees a refund)
  | "signed" // the referee signed the Result; waiting for the settle transaction
  | "settled"
  | "voided";

export type SeriesState = {
  matchId: Hex;
  phase: SeriesPhase;
  players: [PlayerCard, PlayerCard];
  /** Your side, or null for a spectator (spectators get no inputs in the beta). */
  you: Side | null;
  connected: [boolean, boolean];
  ready: [boolean, boolean];
  picks: [RadbroPick | null, RadbroPick | null];
  stake: string;
  roundSeconds: number;
  district: string;
  feeBps: number;
  holderFeeBps: number;
  /** The round being played or next (1-based, draws included), the score and the draws so far. */
  round: number;
  score: [number, number];
  draws: number;
  seedCommit: Hex;
  /** Relay ms when the current wait (join, between rounds, reconnect) runs out, or null. */
  deadlineAt: number | null;
  /** The vault's settleBy (unix s): after it anyone can refund a series that never settled. */
  settleBy: number;
};

/** `start` for a wager round: the online StartMsg (so the existing OnlineSession runs it) plus the series fields. */
export type WagerStartMsg = StartMsg & {
  matchId: Hex;
  /** The sim slot of player A this round. */
  slotOfA: 0 | 1;
  score: [number, number];
  /** Relay-clock slack for this round's input deadlines (ms, per sim slot). */
  lateMs: [number, number];
};

export type RoundMsg = { t: "round"; round: number; result: RoundResult; score: [number, number]; draws: number };
export type OutcomeMsg = { t: "outcome"; outcome: SeriesOutcome; logHash: Hex; held: boolean; flags: Flag[] };

export type RelayConfig = {
  v: typeof WAGER_PROTOCOL;
  net: WagerNetId;
  chainId: number;
  vault: Address;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  referee: Address;
  relayer: Address;
  houseFeeBps: number;
  holderFeeBps: number;
  /** Decimal strings (token base units). */
  maxStake: string;
  maxBalance: string;
  /** Stake cap for players with fewer than newAccountSeries settled series. */
  newAccountMaxStake: string;
  newAccountSeries: number;
  roundSeconds: number[];
  districts: string[];
  /** The referee's sim per district (clients whose simCompat differs are told to reload). */
  sims: Record<string, SimCompat>;
  timing: typeof WAGER_TIMING;
  faucet: boolean;
  /** For the caller's request (CF-IPCountry against REGION_BLOCK). */
  regionBlocked: boolean;
  beta: boolean;
};

export type MatchStatus = {
  matchId: Hex;
  state: "open" | "locked" | "playing" | "held" | "signed" | "settled" | "voided" | "unknown";
  offer: Offer | null;
  series: SeriesState | null;
  outcome: SeriesOutcome | null;
  settlement: Settlement | null;
  lockTx: Hex | null;
  settleTx: Hex | null;
};

export type RecentMatch = {
  matchId: Hex;
  players: [PlayerCard, PlayerCard];
  stake: string;
  outcome: SeriesOutcome;
  settleTx: Hex | null;
  endedAt: number;
};

export type FaucetRequest = { address: Address };
export type FaucetReply = { tokenTx: Hex | null; ethTx: Hex | null; tokens: string; eth: string };

/** Signed by vault.owner() over RELAY_TYPES.Review (decision REVIEW_SETTLE: sign the replayed result; REVIEW_VOID). */
export type ReviewRequest = { matchId: Hex; decision: 1 | 2; logHash: Hex; sig: Hex };

export type WagerErrorCode =
  | "version" // protocol or sim mismatch: reload
  | "auth" // bad or expired login
  | "region" // REGION_BLOCK
  | "full" // not one of this match's players
  | "bad" // malformed
  | "rate"
  | "stake" // outside the caps
  | "balance" // not enough free balance in the vault
  | "session" // no live session key, or its limits
  | "terms" // entries that do not pair (stake, round length, rules, opponent, deadline)
  | "gone" // the offer or match no longer exists
  | "busy"
  | "chain" // a transaction failed
  | "forbidden"; // holders-only, min series, or a named invite for someone else

// ---- the lobby socket (GET /lobby) ---------------------------------------------------------------------------------

export type LoginMsg = {
  t: "login";
  player: Address;
  /** The challenge's expiry (unix s) as signed in the Login message. */
  expiry: number;
  sig: Hex;
  /** Which key signed: the player's vault session key, or the wallet itself (ECDSA or ERC-1271). */
  by: "session" | "wallet";
};

export type LobbyClientMsg =
  | { t: "hello"; v: number; net: WagerNetId }
  | LoginMsg
  /** Ask the relayer to submit openSession (gasless). */
  | { t: "session"; auth: SessionAuthJson; sig: Hex }
  | { t: "profile"; name?: string; cosmetic?: Cosmetic | null }
  | { t: "create"; entry: EntryJson; sig: Hex; listed: boolean; holdersOnly?: boolean; minSeries?: number }
  | { t: "cancel"; matchId: Hex }
  | { t: "join"; entry: EntryJson; sig: Hex }
  /**
   * The creator's answer to `sign`: its signature over exactly that Entry (session key, or the wallet), or null with a
   * reason when the page won't sign it (the terms aren't its offer's, the offer is gone).
   */
  | { t: "signed"; matchId: Hex; sig: Hex | null; why?: string }
  | { t: "ping" };

export type TxKind = "session" | "lock" | "settle" | "faucet";

export type LobbyServerMsg =
  | { t: "challenge"; challenge: Hex; expiry: number; relay: string }
  | { t: "welcome"; you: PlayerCard; config: RelayConfig }
  /** The open list (listed offers, plus your own), replaced wholesale. */
  | { t: "offers"; offers: Offer[] }
  | { t: "offer"; offer: Offer }
  | { t: "unoffer"; matchId: Hex; reason: "cancelled" | "matched" | "expired" | "creator-left" }
  /**
   * To the creator of an open offer (opponent 0) that a vetted player just joined: sign this named Entry (the offer's
   * terms with `opponent` = the joiner and a deadline `namedTtlS` away) and answer `signed` within `signWaitMs`. The
   * lobby never hands out an open Entry's signature (anyone holding it could pair it with any account).
   */
  | { t: "sign"; matchId: Hex; entry: EntryJson; joiner: PlayerCard }
  /** Both signed, named entries (either player may submit lock itself if the relayer is slow). */
  | { t: "matched"; matchId: Hex; a: SignedEntry; b: SignedEntry }
  | { t: "locked"; matchId: Hex; tx: Hex }
  | { t: "tx"; kind: TxKind; matchId: Hex | null; hash: Hex | null; status: "sent" | "confirmed" | "failed"; error?: string }
  | { t: "card"; card: PlayerCard }
  | { t: "error"; code: WagerErrorCode; message: string }
  | { t: "pong" };

// ---- the room socket (GET /ws?room=<matchId>) ---------------------------------------------------------------------

export type RoomClientMsg =
  | { t: "hello"; v: number; matchId: Hex; compat: Compat }
  | LoginMsg
  /** Before round 1 only. `own` must be owned by the player on Ethereum mainnet (the relay checks). */
  | { t: "pick"; radbro: string; own: number | null }
  /** 32 random bytes, once per series, after `series` shows the relay's seed commit. */
  | { t: "seed"; share: Hex }
  | { t: "ready" }
  /**
   * The client's own final state hash for the current round (informational: the referee decides; a mismatch is a
   * flag). OnlineSession's `end` ({t, step, hash, bag}) is accepted as is; `bag` is ignored.
   */
  | { t: "end"; step: number; hash: number; bag?: number[]; round?: number };

export type RoomServerMsg =
  | { t: "challenge"; challenge: Hex; expiry: number; relay: string }
  | { t: "series"; state: SeriesState }
  | WagerStartMsg
  | RoundMsg
  | { t: "drop"; side: Side; graceMs: number }
  | { t: "back"; side: Side }
  | OutcomeMsg
  /** The referee-signed Result: anyone may submit settle(result, sig). */
  | { t: "settlement"; settlement: Settlement }
  | { t: "settled"; tx: Hex }
  | { t: "voided"; tx: Hex | null }
  | { t: "error"; code: WagerErrorCode; message: string };
