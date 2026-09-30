// The wager relay's settings: wrangler [vars] (or the Node stand-in's env / flags) parsed once, over the deployment
// table (src/wager/deployments.json). Every name is in src/wager/config.ts WAGER_ENV; the DEV_* ones below exist only
// under DEV=1 (local tests and the local end-to-end). docs/WAGER.md §8.
import type { Address } from "viem";
import { DEPLOYMENTS, MAINNET_CHAIN_IDS, RADBRO, isWagerNet, type Deployment, type WagerNetId } from "../../../src/wager/config.ts";
import { ROUND_SECONDS, WAGER_TIMING } from "../../../src/wager/protocol.ts";
import { addr } from "./base.ts";

/** The districts the relay can referee (their city models are bundled); DISTRICTS picks which are offered. */
export const KNOWN_DISTRICTS = ["downtown", "market", "docks", "towers", "vertigo"] as const;

export type Vars = Record<string, string | undefined>;

export type WagerSettings = {
  net: WagerNetId;
  deployment: Deployment;
  chainId: number;
  vault: Address | null;
  token: Address | null;
  testnet: boolean;
  dev: boolean;
  allowedOrigins: string[];
  /** Wager chain RPCs, the keyed one (RPC_URL_PRIVATE) first. */
  rpcUrls: string[];
  /** Ethereum mainnet RPCs for the Radbro reads. */
  ethRpcUrls: string[];
  regionBlock: string[];
  roundSeconds: number[];
  districts: string[];
  /** null = no extra cap for new accounts. */
  newAccountMaxStake: bigint | null;
  newAccountSeries: number;
  timing: { -readonly [K in keyof typeof WAGER_TIMING]: number };
  holdOnFlags: boolean;
  faucet: boolean;
  faucetTokens: bigint;
  faucetEth: bigint;
  radbro: { v2: Address; v1: Address; cacheMs: number; mock: Map<string, number[]> | null };
};

const list = (s: string | undefined): string[] => (s ?? "").split(",").map(x => x.trim()).filter(Boolean);
const int = (s: string | undefined, d: number, lo: number, hi: number): number => {
  const n = Number(s);
  return s !== undefined && s.trim() !== "" && Number.isInteger(n) && n >= lo && n <= hi ? n : d;
};
const big = (s: string | undefined, d: bigint | null): bigint | null => {
  if (!s || !/^\d+$/.test(s.trim())) return d;
  return BigInt(s.trim());
};

/**
 * `deployment` overrides the table's entry (the Node stand-in reads deployments.json from disk, so a local deploy that
 * just wrote it is picked up without a rebuild).
 */
export function parseSettings(vars: Vars, deployment?: Partial<Deployment>): WagerSettings {
  const net: WagerNetId = isWagerNet(vars.WAGER_NET) ? vars.WAGER_NET : "local";
  const d: Deployment = { ...DEPLOYMENTS[net], ...deployment, net };
  const dev = vars.DEV === "1";
  const rpc = list(vars.RPC_URLS);
  const priv = (vars.RPC_URL_PRIVATE ?? "").trim();
  const rounds = list(vars.ROUND_SECONDS).map(Number).filter(n => Number.isInteger(n) && n >= 10 && n <= 600);
  const districts = list(vars.DISTRICTS).filter(x => (KNOWN_DISTRICTS as readonly string[]).includes(x));
  const timing = { ...WAGER_TIMING } as WagerSettings["timing"];
  timing.lateMs = int(vars.LATE_MS, WAGER_TIMING.lateMs, 20, 500);
  timing.reconnectGraceMs = int(vars.RECONNECT_GRACE_MS, WAGER_TIMING.reconnectGraceMs, 2_000, 120_000);
  timing.joinGraceMs = int(vars.JOIN_GRACE_MS, WAGER_TIMING.joinGraceMs, 5_000, 600_000);
  let mock: Map<string, number[]> | null = null;
  if (dev && vars.DEV_RADBRO_HOLDERS) {
    // DEV only: "0xaddr=652,4764;0xother=" - a mock Radbro collection for local tests (no Ethereum reads at all).
    mock = new Map();
    for (const part of vars.DEV_RADBRO_HOLDERS.split(";")) {
      const [a, ids] = part.split("=");
      const k = addr(a?.trim());
      if (k) mock.set(k.toLowerCase(), list(ids).map(Number).filter(n => Number.isInteger(n) && n >= 0));
    }
  }
  return {
    net,
    deployment: d,
    chainId: d.chainId,
    vault: d.vault,
    token: d.token,
    testnet: d.testnet && !MAINNET_CHAIN_IDS.includes(d.chainId),
    dev,
    allowedOrigins: list(vars.ALLOWED_ORIGINS),
    rpcUrls: [...(priv ? [priv] : []), ...(rpc.length ? rpc : d.rpc)],
    ethRpcUrls: list(vars.ETH_RPC_URLS).length ? list(vars.ETH_RPC_URLS) : [...RADBRO.rpc],
    regionBlock: list(vars.REGION_BLOCK).map(c => c.toUpperCase()).filter(c => /^[A-Z]{2}$/.test(c)),
    roundSeconds: rounds.length ? [...new Set(rounds)].sort((a, b) => a - b) : [...ROUND_SECONDS],
    districts: districts.length ? [...new Set(districts)] : [...KNOWN_DISTRICTS],
    newAccountMaxStake: big(vars.NEW_ACCOUNT_MAX_STAKE, null),
    newAccountSeries: int(vars.NEW_ACCOUNT_SERIES, 3, 0, 1000),
    timing,
    holdOnFlags: (vars.HOLD_ON_FLAGS ?? "1") !== "0",
    // Never on a mainnet chain id, whatever the config says (config.ts MAINNET_CHAIN_IDS).
    faucet: vars.FAUCET === "1" && !MAINNET_CHAIN_IDS.includes(d.chainId),
    faucetTokens: big(vars.FAUCET_TOKENS, 1_000n * 10n ** 18n)!,
    faucetEth: big(vars.FAUCET_ETH, 5n * 10n ** 14n)!,
    radbro: {
      v2: (dev && addr(vars.DEV_RADBRO_V2)) || RADBRO.v2,
      v1: (dev && addr(vars.DEV_RADBRO_V1)) || RADBRO.v1,
      cacheMs: RADBRO.cacheMs,
      mock,
    },
  };
}

/** Is this Origin allowed (browsers only; a script can send any Origin, which is why logins are signatures)? */
export function originOk(origin: string | null, s: Pick<WagerSettings, "dev" | "allowedOrigins">): boolean {
  if (!origin) return s.dev;
  if (s.dev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return s.allowedOrigins.includes(origin);
}

/** REGION_BLOCK against the caller's country (request.cf.country; the Node stand-in's x-dev-country under DEV=1). */
export const regionBlocked = (country: string | null | undefined, s: Pick<WagerSettings, "regionBlock">): boolean =>
  !!country && s.regionBlock.includes(country.toUpperCase());
