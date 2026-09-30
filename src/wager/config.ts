// SPIDER-TAG wager: the deployments (chain, vault, token, relay) and every environment / config name the site, the
// wager relay and the tools use (docs/WAGER.md §8). A deployment is data in deployments.json (public addresses,
// filled in by `npm run wager:deploy`); which ones a site build offers is the VITE_WAGER_NETS env, so moving the beta
// to the owner's own coin on Robinhood Chain mainnet is a config change plus a rebuild. Pure TS; no DOM.
import type { Address } from "viem";
import table from "./deployments.json" with { type: "json" };

export type WagerNetId = "local" | "rh-testnet" | "rh-mainnet";
export const WAGER_NETS: readonly WagerNetId[] = ["local", "rh-testnet", "rh-mainnet"];
export const isWagerNet = (s: unknown): s is WagerNetId => typeof s === "string" && (WAGER_NETS as readonly string[]).includes(s);

export type Deployment = {
  net: WagerNetId;
  /** The banner: "BETA · TESTNET" on the test network, "BETA" on mainnet during the private beta. */
  label: string;
  chainId: number;
  /** Say "Robinhood Chain" in full (brand rules): never shorthand. */
  chainName: string;
  testnet: boolean;
  /** Public RPCs, tried in order (viem fallback). */
  rpc: string[];
  explorer: string | null;
  /** The wager relay's base URL (https; wss is derived). */
  relay: string | null;
  /** Filled in by the deploy tool; null = not deployed yet (the page says so). */
  vault: Address | null;
  /** The vault's token (also readable from vault.token()). */
  token: Address | null;
  /** The vault's deploy block (event scans start here). */
  deployBlock: number | null;
};

export const DEPLOYMENTS: Record<WagerNetId, Deployment> = Object.fromEntries(
  WAGER_NETS.map(net => [net, { net, ...(table as Record<WagerNetId, Omit<Deployment, "net">>)[net] }]),
) as Record<WagerNetId, Deployment>;

/** Radbro ownership (holder perks) is read from Ethereum mainnet with public RPCs and no keys. */
export const RADBRO = {
  chainId: 1,
  rpc: ["https://eth.drpc.org", "https://cloudflare-eth.com", "https://1rpc.io/eth", "https://ethereum.publicnode.com"],
  /** "Radbro Webring V2" (RADBROS): ERC-721 + ERC721A queries (tokensOfOwner), EIP-1967 proxy, 5000 supply. */
  v2: "0xABCDB5710B88f456fED1e99025379e2969F29610" as Address,
  /** "Radbro Webring" (RADBRO), the legacy collection: a V1 balance also counts as a holder. */
  v1: "0xE83C9F09B0992e4a34fAf125ed4FEdD3407c4a23" as Address,
  /** Ownership reads are cached this long (ms) per address. */
  cacheMs: 10 * 60_000,
} as const;

/** Chains that must never get a faucet, whatever the config says. */
export const MAINNET_CHAIN_IDS: readonly number[] = [1, 4663];

/**
 * Every environment name, in one place. The site's are Vite build-time env (baked into the lazy wager chunk); the
 * relay's are wrangler [vars] or secrets (`wrangler secret put`) in relay/wager/wrangler.toml; the tools' come from a
 * 0600 file under ~/.config/radrun-wager/ that never enters the repo.
 */
export const WAGER_ENV = {
  site: {
    /** Comma-separated deployments this build offers, the first being the default (unset: the page is off). */
    nets: "VITE_WAGER_NETS",
    /** Optional per-build overrides of the default deployment (dev and previews): relay URL and RPC list. */
    relay: "VITE_WAGER_RELAY_URL",
    rpc: "VITE_WAGER_RPC",
  },
  relay: {
    vars: {
      net: "WAGER_NET", // a WagerNetId: picks the chain id, vault and token from deployments.json
      allowedOrigins: "ALLOWED_ORIGINS", // e.g. https://radrun.vyvanse.beer
      dev: "DEV", // "1" only under wrangler dev / the Node stand-in: localhost origins, x-dev-country header
      rpcUrls: "RPC_URLS", // comma list for the wager chain; overrides deployments.json
      ethRpcUrls: "ETH_RPC_URLS", // comma list for Ethereum mainnet (Radbro reads); overrides RADBRO.rpc
      regionBlock: "REGION_BLOCK", // comma list of ISO 3166-1 alpha-2 codes; empty = off (the default)
      roundSeconds: "ROUND_SECONDS", // allowed round lengths, e.g. "60,90,120"
      districts: "DISTRICTS", // allowed districts, e.g. "downtown,docks"
      newAccountMaxStake: "NEW_ACCOUNT_MAX_STAKE", // token base units
      newAccountSeries: "NEW_ACCOUNT_SERIES", // settled series before the full cap applies
      lateMs: "LATE_MS",
      reconnectGraceMs: "RECONNECT_GRACE_MS",
      joinGraceMs: "JOIN_GRACE_MS",
      holdOnFlags: "HOLD_ON_FLAGS", // "1": a flagged series waits for review instead of auto-signing
      faucet: "FAUCET", // "1" on test networks only (refused on MAINNET_CHAIN_IDS)
      faucetTokens: "FAUCET_TOKENS", // base units per claim
      faucetEth: "FAUCET_ETH", // wei per claim (sent only when the address has less)
    },
    secrets: {
      refereeKey: "REFEREE_KEY", // signs Results only; never holds funds
      refereeKeyPrev: "REFEREE_KEY_PREV", // after a referee rotation: the old key, for the matches locked under it
      relayerKey: "RELAYER_KEY", // pays gas for openSession / lock / settle; holds only gas ETH
      faucetKey: "FAUCET_KEY", // test networks only: holds test ETH + test tokens
      rpcUrlPrivate: "RPC_URL_PRIVATE", // optional keyed RPC (e.g. Alchemy) used before the public list
    },
  },
  tools: {
    /** ~/.config/radrun-wager/<net>.env (0600): read by tools/wager-deploy.ts; nothing here is ever printed. */
    file: "~/.config/radrun-wager/<net>.env",
    keys: ["DEPLOYER_KEY", "REFEREE_KEY", "RELAYER_KEY", "FAUCET_KEY"],
    addresses: ["WAGER_OWNER", "WAGER_HOUSE"],
    settings: ["WAGER_TOKEN", "WAGER_FEE_BPS", "WAGER_HOLDER_FEE_BPS", "WAGER_MAX_STAKE", "WAGER_MAX_BALANCE", "WAGER_SETTLE_WINDOW", "RPC_URL_PRIVATE"],
  },
} as const;

/** The deployments a site build offers, from VITE_WAGER_NETS (unknown or undeployed names are dropped). */
export function siteDeployments(nets: string | undefined): Deployment[] {
  return (nets ?? "").split(",").map(s => s.trim()).filter(isWagerNet).map(n => DEPLOYMENTS[n]);
}
