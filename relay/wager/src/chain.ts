// The wager chain as the relay sees it: reads of the vault (never keys), signature checks (EOA recovery locally,
// ERC-1271 / ERC-6492 through an eth_call), eth_call simulations before any transaction, and the raw RPC calls the
// relayer queue needs. `ViemChain` implements it over JSON-RPC (RPC_URLS / RPC_URL_PRIVATE through viem's fallback);
// the tests use an in-memory fake with the same interface.
import {
  BaseError, createPublicClient, decodeErrorResult, encodeFunctionData, fallback, http, isAddressEqual, recoverAddress,
  type Address, type Hex, type PublicClient,
} from "viem";
import { ERC20_ABI, VAULT_ABI } from "./abi.ts";
import { errMsg } from "./base.ts";

export type VaultInfo = {
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  referee: Address;
  owner: Address;
  houseFeeBps: number;
  holderFeeBps: number;
  maxStake: bigint;
  maxBalance: bigint;
  settleWindow: number;
  paused: boolean;
};

/** IGameVault.Match */
export type ChainMatch = {
  playerA: Address;
  feeBps: number;
  holderFeeBps: number;
  roundSeconds: number;
  /** MatchState: 0 None, 1 Locked, 2 Settled, 3 Voided, 4 Cancelled. */
  state: number;
  playerB: Address;
  lockedAt: number;
  stake: bigint;
  settleBy: number;
  rules: Hex;
};

/** IGameVault.Session */
export type ChainSession = { key: Address; expiry: number; maxStake: bigint; cap: bigint; used: bigint };

export type Call = { to: Address; data: Hex; value?: bigint };

export interface VaultChain {
  readonly chainId: number;
  readonly vault: Address;
  /** Vault settings and its token's symbol / decimals (cached briefly). */
  info(fresh?: boolean): Promise<VaultInfo>;
  freeOf(player: Address): Promise<bigint>;
  sessionOf(player: Address): Promise<ChainSession>;
  matchOf(matchId: Hex): Promise<ChainMatch>;
  /** The referee a match locked under: the only one whose Result it takes (ZERO if it never locked). */
  refereeOf(matchId: Hex): Promise<Address>;
  /** Is `sig` the signature of `signer` over this EIP-712 digest (EOA, ERC-1271 or ERC-6492)? */
  verifyHash(signer: Address, digest: Hex, sig: Hex): Promise<boolean>;
  /** eth_call the transaction from `from`: null when it would succeed, else the revert reason. */
  simulate(from: Address, call: Call): Promise<string | null>;
  /** The transaction that settled or voided a match, when it can be found (someone else submitted it). */
  settleTxOf(matchId: Hex): Promise<Hex | null>;
  ethBalance(a: Address): Promise<bigint>;
}

export type Receipt = { status: "success" | "reverted" };

/** The raw calls the relayer queue (relayer.ts) sends through. */
export interface TxRpc {
  nonce(a: Address): Promise<number>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  estimateGas(from: Address, call: Call): Promise<bigint>;
  sendRaw(signed: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<Receipt | null>;
}

/** A readable revert reason from a viem error (the vault's custom errors decoded). */
export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    let data: Hex | undefined;
    e.walk(x => {
      const d = (x as { data?: unknown }).data;
      if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) { data = d as Hex; return true; }
      if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") { data = (d as { data: Hex }).data; return true; }
      return false;
    });
    if (data) {
      try {
        const r = decodeErrorResult({ abi: VAULT_ABI, data });
        return `${r.errorName}(${(r.args ?? []).map(a => String(a)).join(", ")})`;
      } catch { /* not a vault error */ }
    }
  }
  return errMsg(e);
}

export class ViemChain implements VaultChain, TxRpc {
  readonly chainId: number;
  readonly vault: Address;
  readonly client: PublicClient;
  private readonly deployBlock: bigint;
  private infoCache: { at: number; v: Promise<VaultInfo> } | null = null;

  constructor(o: { chainId: number; vault: Address; rpcUrls: string[]; deployBlock?: number | null; timeoutMs?: number }) {
    this.chainId = o.chainId;
    this.vault = o.vault;
    this.deployBlock = BigInt(o.deployBlock ?? 0);
    const t = o.rpcUrls.map(u => http(u, { timeout: o.timeoutMs ?? 8_000, retryCount: 1 }));
    this.client = createPublicClient({ transport: t.length === 1 ? t[0] : fallback(t) }) as PublicClient;
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.client.readContract({ address: this.vault, abi: VAULT_ABI, functionName: functionName as "token", args: args as [] }) as Promise<T>;
  }

  info(fresh = false): Promise<VaultInfo> {
    const now = Date.now();
    if (!fresh && this.infoCache && now - this.infoCache.at < 30_000) return this.infoCache.v;
    const v = (async (): Promise<VaultInfo> => {
      const [token, referee, owner, houseFeeBps, holderFeeBps, maxStake, maxBalance, settleWindow, paused] = await Promise.all([
        this.read<Address>("token"), this.read<Address>("referee"), this.read<Address>("owner"), this.read<number>("houseFeeBps"),
        this.read<number>("holderFeeBps"), this.read<bigint>("maxStake"), this.read<bigint>("maxBalance"), this.read<number>("settleWindow"),
        this.read<boolean>("paused").catch(() => false),
      ]);
      const [tokenSymbol, tokenDecimals] = await Promise.all([
        this.client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
        this.client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
      ]);
      return { token, tokenSymbol, tokenDecimals: Number(tokenDecimals), referee, owner, houseFeeBps: Number(houseFeeBps), holderFeeBps: Number(holderFeeBps), maxStake, maxBalance, settleWindow: Number(settleWindow), paused };
    })();
    v.catch(() => { if (this.infoCache?.v === v) this.infoCache = null; });
    this.infoCache = { at: now, v };
    return v;
  }

  freeOf(player: Address): Promise<bigint> {
    return this.read<bigint>("freeOf", [player]);
  }

  async sessionOf(player: Address): Promise<ChainSession> {
    const s = await this.read<{ key: Address; expiry: bigint; maxStake: bigint; cap: bigint; used: bigint }>("sessionOf", [player]);
    return { key: s.key, expiry: Number(s.expiry), maxStake: s.maxStake, cap: s.cap, used: s.used };
  }

  async matchOf(matchId: Hex): Promise<ChainMatch> {
    const m = await this.read<{
      playerA: Address; feeBps: number; holderFeeBps: number; roundSeconds: number; state: number; playerB: Address; lockedAt: bigint;
      stake: bigint; settleBy: bigint; rules: Hex;
    }>("matchOf", [matchId]);
    return { ...m, feeBps: Number(m.feeBps), holderFeeBps: Number(m.holderFeeBps), roundSeconds: Number(m.roundSeconds), state: Number(m.state), lockedAt: Number(m.lockedAt), settleBy: Number(m.settleBy) };
  }

  refereeOf(matchId: Hex): Promise<Address> {
    return this.read<Address>("refereeOf", [matchId]);
  }

  async verifyHash(signer: Address, digest: Hex, sig: Hex): Promise<boolean> {
    if (sig.length === 132) {
      try { if (isAddressEqual(await recoverAddress({ hash: digest, signature: sig }), signer)) return true; } catch { /* not ECDSA */ }
    }
    try {
      return await this.client.verifyHash({ address: signer, hash: digest, signature: sig });
    } catch {
      return false;
    }
  }

  async simulate(from: Address, call: Call): Promise<string | null> {
    try {
      await this.client.call({ account: from, to: call.to, data: call.data, value: call.value });
      return null;
    } catch (e) {
      return revertReason(e);
    }
  }

  async settleTxOf(matchId: Hex): Promise<Hex | null> {
    try {
      for (const eventName of ["MatchSettled", "MatchVoided"] as const) {
        const logs = await this.client.getContractEvents({ address: this.vault, abi: VAULT_ABI, eventName, args: { matchId }, fromBlock: this.deployBlock });
        if (logs.length) return logs[logs.length - 1].transactionHash;
      }
    } catch { /* range limits on public RPCs */ }
    return null;
  }

  ethBalance(a: Address): Promise<bigint> {
    return this.client.getBalance({ address: a });
  }

  // ---- TxRpc ----

  nonce(a: Address): Promise<number> {
    return this.client.getTransactionCount({ address: a, blockTag: "pending" });
  }

  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const b = await this.client.getBlock({ blockTag: "latest" });
    const base = b.baseFeePerGas ?? (await this.client.getGasPrice());
    let prio = 0n;
    try { prio = await this.client.estimateMaxPriorityFeePerGas(); } catch { /* Arbitrum ignores the tip anyway */ }
    if (prio > base) prio = base;
    // docs/WAGER.md §4.3: EIP-1559 fees of 2 x the base fee.
    return { maxFeePerGas: 2n * base + prio, maxPriorityFeePerGas: prio };
  }

  estimateGas(from: Address, call: Call): Promise<bigint> {
    return this.client.estimateGas({ account: from, to: call.to, data: call.data, value: call.value });
  }

  sendRaw(signed: Hex): Promise<Hex> {
    return this.client.sendRawTransaction({ serializedTransaction: signed });
  }

  async receipt(hash: Hex): Promise<Receipt | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash });
      return { status: r.status };
    } catch {
      return null;
    }
  }
}

// ---- calldata ---------------------------------------------------------------------------------------------------------

export const vaultCall = (vault: Address, functionName: "openSession" | "lock" | "settle" | "refundExpired", args: readonly unknown[]): Call =>
  ({ to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName, args: args as never }) });

export const erc20Transfer = (token: Address, to: Address, amount: bigint): Call =>
  ({ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] }) });
