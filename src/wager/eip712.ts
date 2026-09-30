// SPIDER-TAG wager: the EIP-712 domains, types and helpers shared by the client, the wager relay and the tests
// (docs/WAGER.md §3.3, §4.2). The vault types must match contracts/src/interfaces/IGameVault.sol exactly;
// test/wager-shared.test.ts compares the type strings. Pure TS on viem's encoders: no DOM, no chain access.
import { encodeAbiParameters, hashTypedData, keccak256, toBytes, toHex, type Address, type Hex } from "viem";

export const VAULT_DOMAIN_NAME = "RadRun GameVault";
export const RELAY_DOMAIN_NAME = "RadRun Wager Relay";
export const DOMAIN_VERSION = "1";

/** Vault messages (SessionAuth, Entry, Result) are signed under the vault's own domain. */
export const vaultDomain = (chainId: number, vault: Address) =>
  ({ name: VAULT_DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: vault }) as const;
/** Relay-only messages (Login, Review) use a second domain name so they can never be valid vault messages. */
export const relayDomain = (chainId: number, vault: Address) =>
  ({ name: RELAY_DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: vault }) as const;

export const VAULT_TYPES = {
  SessionAuth: [
    { name: "player", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "maxStake", type: "uint128" },
    { name: "cap", type: "uint128" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
  Entry: [
    { name: "matchId", type: "bytes32" },
    { name: "player", type: "address" },
    { name: "opponent", type: "address" },
    { name: "stake", type: "uint128" },
    { name: "feeCapBps", type: "uint16" },
    { name: "roundSeconds", type: "uint16" },
    { name: "rules", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
  Result: [
    { name: "matchId", type: "bytes32" },
    { name: "outcome", type: "uint8" },
    { name: "winner", type: "address" },
    { name: "feeBps", type: "uint16" },
    { name: "logHash", type: "bytes32" },
  ],
} as const;

export const RELAY_TYPES = {
  /** Proves an address to the relay (lobby and room sockets): signed by the player's session key or wallet. */
  Login: [
    { name: "player", type: "address" },
    { name: "challenge", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "relay", type: "string" },
  ],
  /** The vault owner's decision on a series held for review (docs/WAGER.md §6.3). */
  Review: [
    { name: "matchId", type: "bytes32" },
    { name: "decision", type: "uint8" },
    { name: "logHash", type: "bytes32" },
  ],
} as const;

/** The canonical EIP-712 type strings (keccak256 of each = the typehash). */
export const TYPE_STRINGS = {
  SessionAuth: "SessionAuth(address player,address sessionKey,uint128 maxStake,uint128 cap,uint64 expiry,uint64 nonce)",
  Entry: "Entry(bytes32 matchId,address player,address opponent,uint128 stake,uint16 feeCapBps,uint16 roundSeconds,bytes32 rules,uint64 deadline)",
  Result: "Result(bytes32 matchId,uint8 outcome,address winner,uint16 feeBps,bytes32 logHash)",
  Login: "Login(address player,bytes32 challenge,uint64 expiry,string relay)",
  Review: "Review(bytes32 matchId,uint8 decision,bytes32 logHash)",
} as const;

export const TYPEHASHES = {
  SessionAuth: "0xd1d5ccb7ccc0909f77f484701036251c5e6cabd5176750b6559b41c3ec12cb91",
  Entry: "0x97ada63af3d17c4bc608f40b5c8c4c5372ae59704832fc8b489002f3876e462c",
  Result: "0x0a893589f21454ee3400d410b77ab46b3ce91ef1ae45452b4bae84c112271b29",
  Login: "0x5c1bcfbd9fcbb7857daf07143b3a7df63ac6340e4efd3b3e3bc0db54c85cd4aa",
  Review: "0xda36c9b7e755d245bf3b27931ceb6308d649251e978deaaa27eb4d5e9054e59a",
} as const satisfies Record<keyof typeof TYPE_STRINGS, Hex>;

// ---- message shapes (bigint fields as in viem; *Json twins carry them as decimal strings over the wire) ---------

export type SessionAuth = { player: Address; sessionKey: Address; maxStake: bigint; cap: bigint; expiry: bigint; nonce: bigint };
export type Entry = {
  matchId: Hex; player: Address; opponent: Address; stake: bigint; feeCapBps: number; roundSeconds: number; rules: Hex; deadline: bigint;
};
export type Result = { matchId: Hex; outcome: number; winner: Address; feeBps: number; logHash: Hex };
export type Login = { player: Address; challenge: Hex; expiry: bigint; relay: string };
export type Review = { matchId: Hex; decision: number; logHash: Hex };

export type SessionAuthJson = { player: Address; sessionKey: Address; maxStake: string; cap: string; expiry: number; nonce: number };
export type EntryJson = {
  matchId: Hex; player: Address; opponent: Address; stake: string; feeCapBps: number; roundSeconds: number; rules: Hex; deadline: number;
};
export type ResultJson = Result;

export const sessionAuthToJson = (a: SessionAuth): SessionAuthJson =>
  ({ ...a, maxStake: a.maxStake.toString(), cap: a.cap.toString(), expiry: Number(a.expiry), nonce: Number(a.nonce) });
export const sessionAuthFromJson = (a: SessionAuthJson): SessionAuth =>
  ({ ...a, maxStake: BigInt(a.maxStake), cap: BigInt(a.cap), expiry: BigInt(a.expiry), nonce: BigInt(a.nonce) });
export const entryToJson = (e: Entry): EntryJson => ({ ...e, stake: e.stake.toString(), deadline: Number(e.deadline) });
export const entryFromJson = (e: EntryJson): Entry => ({ ...e, stake: BigInt(e.stake), deadline: BigInt(e.deadline) });

// ---- constants shared with the contract --------------------------------------------------------------------------

export const OUTCOME_WIN = 1;
export const OUTCOME_VOID = 2;
export const VOID_REFEREE = 1;
export const VOID_MUTUAL = 2;
export const VOID_TIMEOUT = 3;
export const REVIEW_SETTLE = 1;
export const REVIEW_VOID = 2;
export const MAX_FEE_BPS = 500;
export const DEFAULT_FEE_BPS = 300;
export const DEFAULT_HOLDER_FEE_BPS = 150;
export const MAX_SESSION_TTL_S = 30 * 86_400;
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const ZERO_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ---- typed-data builders (for viem signTypedData / verifyTypedData / hashTypedData) -------------------------------

export const sessionAuthTypedData = (chainId: number, vault: Address, message: SessionAuth) =>
  ({ domain: vaultDomain(chainId, vault), types: { SessionAuth: VAULT_TYPES.SessionAuth }, primaryType: "SessionAuth", message }) as const;
export const entryTypedData = (chainId: number, vault: Address, message: Entry) =>
  ({ domain: vaultDomain(chainId, vault), types: { Entry: VAULT_TYPES.Entry }, primaryType: "Entry", message }) as const;
export const resultTypedData = (chainId: number, vault: Address, message: Result) =>
  ({ domain: vaultDomain(chainId, vault), types: { Result: VAULT_TYPES.Result }, primaryType: "Result", message }) as const;
export const loginTypedData = (chainId: number, vault: Address, message: Login) =>
  ({ domain: relayDomain(chainId, vault), types: { Login: RELAY_TYPES.Login }, primaryType: "Login", message }) as const;
export const reviewTypedData = (chainId: number, vault: Address, message: Review) =>
  ({ domain: relayDomain(chainId, vault), types: { Review: RELAY_TYPES.Review }, primaryType: "Review", message }) as const;

/** The digests the vault computes (hashEntry / hashResult / hashSessionAuth). */
export const entryDigest = (chainId: number, vault: Address, e: Entry): Hex => hashTypedData(entryTypedData(chainId, vault, e));
export const resultDigest = (chainId: number, vault: Address, r: Result): Hex => hashTypedData(resultTypedData(chainId, vault, r));
export const sessionAuthDigest = (chainId: number, vault: Address, a: SessionAuth): Hex => hashTypedData(sessionAuthTypedData(chainId, vault, a));

// ---- match terms ----------------------------------------------------------------------------------------------------

/** What both Entries' `rules` commit to (roundSeconds and the stake are Entry fields of their own). */
export type Rules = {
  game: "radrun-spidertag";
  version: 1;
  district: string;
  bestOf: 3;
  /** Drawn rounds replayed before the series is void. */
  tiebreaks: 2;
  /** 0 = no aim assists for either slot (touch / easy grab off in the sim). */
  assist: 0;
  /** simId(): the canonical sim the referee replays with. */
  simId: Hex;
};

/** The sim a match is played and refereed on: any difference means "reload to update" (docs/WAGER.md §5.2). */
export type SimCompat = { v: number; selftest: number; tuning: string; city: string };

export const simId = (c: SimCompat): Hex => keccak256(toBytes(`radrun-sim:${c.v}:${c.selftest >>> 0}:${c.tuning}:${c.city}`));

export function rulesHash(r: Rules): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint8" }, { type: "string" }, { type: "uint8" }, { type: "uint8" }, { type: "uint8" }, { type: "bytes32" }],
      [r.game, r.version, r.district, r.bestOf, r.tiebreaks, r.assist, r.simId],
    ),
  );
}

export const makeRules = (district: string, sim: SimCompat): Rules =>
  ({ game: "radrun-spidertag", version: 1, district, bestOf: 3, tiebreaks: 2, assist: 0, simId: simId(sim) });

/** 32 random bytes (crypto.getRandomValues: browsers, Workers, Node). */
export function random32(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}
/** A fresh match id (the creator's client picks it; the vault refuses a reused one). */
export const newMatchId = random32;

// ---- fee maths (identical to the vault; docs/WAGER.md §3.5) ---------------------------------------------------------

/** The fees a lock captures from the vault's current settings and both players' caps. */
export function capturedFees(houseFeeBps: number, holderFeeBps: number, capA: number, capB: number): { feeBps: number; holderFeeBps: number } {
  const feeBps = Math.min(houseFeeBps, capA, capB);
  return { feeBps, holderFeeBps: Math.min(holderFeeBps, feeBps) };
}

/** Settling a win: pot = 2 x stake, fee rounded down, the winner gets the rest. */
export function payout(stake: bigint, feeBps: number): { pot: bigint; fee: bigint; winner: bigint } {
  const pot = 2n * stake;
  const fee = (pot * BigInt(feeBps)) / 10_000n;
  return { pot, fee, winner: pot - fee };
}
