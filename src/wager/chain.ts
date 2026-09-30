// SPIDER-TAG wager client: the GameVault and its token on the deployment's chain (docs/WAGER.md §3, §7). Reads go
// through a public client (a fallback over the deployment's RPCs); the player's own transactions (approve exactly the
// amount, deposit, withdraw, revoke, and the "submit it yourself" lock / settle / refund) are simulated first, so a
// revert shows as a plain sentence before any wallet popup, then sent by the wallet. History comes from the vault's
// events (§3.9). Pure TS over viem; no DOM.
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, custom, fallback, getAbiItem, http, numberToHex, pad, parseEventLogs,
  toEventSelector, type Address, type Chain, type Hex, type Log, type PublicClient, type TransactionReceipt, type WalletClient,
} from "viem";
import { ERC20_ABI, GAME_VAULT_ABI, VAULT_CALL_ABI } from "./abi.ts";
import type { Entry, Result, SessionAuth } from "./eip712.ts";
import type { OnchainSession } from "./sessionKey.ts";
import { wagerError } from "./errors.ts";
import type { Eip1193 } from "./wallet.ts";

export type VaultInfo = {
  token: Address; symbol: string; decimals: number; houseFeeBps: number; holderFeeBps: number; maxStake: bigint; maxBalance: bigint; settleWindow: number;
  paused: boolean; referee: Address;
};
export type Balances = { wallet: bigint; allowance: bigint; free: bigint; locked: bigint; eth: bigint };
export type MatchState = "none" | "locked" | "settled" | "voided" | "cancelled";
export type MatchView = {
  playerA: Address; playerB: Address; stake: bigint; feeBps: number; holderFeeBps: number; roundSeconds: number; state: MatchState; lockedAt: number; settleBy: number; rules: Hex;
};
export type HistoryRow = {
  matchId: Hex; opponent: Address; stake: bigint; feeBps: number; lockedAt: number; settleBy: number;
  state: "locked" | "won" | "lost" | "void" | "reclaimed"; payout: bigint; fee: bigint; logHash: Hex | null; lockTx: Hex; endTx: Hex | null; voidReason: number | null;
};
export type MatchEnd =
  | { kind: "settled"; winner: Address; loser: Address; payout: bigint; fee: bigint; feeBps: number; logHash: Hex; mutual: boolean; tx: Hex }
  | { kind: "voided"; reason: number; logHash: Hex; tx: Hex };

const STATES: MatchState[] = ["none", "locked", "settled", "voided", "cancelled"];

const SEL = {
  locked: toEventSelector(getAbiItem({ abi: GAME_VAULT_ABI, name: "MatchLocked" })),
  settled: toEventSelector(getAbiItem({ abi: GAME_VAULT_ABI, name: "MatchSettled" })),
  voided: toEventSelector(getAbiItem({ abi: GAME_VAULT_ABI, name: "MatchVoided" })),
  reclaimed: toEventSelector(getAbiItem({ abi: GAME_VAULT_ABI, name: "StakeReclaimed" })),
};
type Topics = (Hex | Hex[] | null)[];

/** A public client over several RPCs (viem fallback: the next one on an error). */
export function publicClientFor(chain: Chain, rpc: string[]): PublicClient {
  const t = rpc.length > 1 ? fallback(rpc.map(u => http(u, { timeout: 12_000, retryCount: 1 }))) : http(rpc[0], { timeout: 12_000, retryCount: 1 });
  return createPublicClient({ chain, transport: t, pollingInterval: 1000 }) as PublicClient;
}

export function walletClientFor(chain: Chain, provider: Eip1193, account: Address): WalletClient {
  return createWalletClient({ chain, transport: custom(provider as Parameters<typeof custom>[0]), account });
}

export class VaultChain {
  readonly pub: PublicClient;
  readonly vault: Address;
  token: Address | null = null;
  readonly fromBlock: bigint;

  constructor(pub: PublicClient, vault: Address, deployBlock: number | null) {
    this.pub = pub;
    this.vault = vault;
    this.fromBlock = BigInt(deployBlock ?? 0);
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.vault, abi: GAME_VAULT_ABI, functionName, args } as never) as Promise<T>;
  }
  private readToken<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.token!, abi: ERC20_ABI, functionName, args } as never) as Promise<T>;
  }

  /** The vault's settings and its token's symbol and decimals (never hard-coded). */
  async info(): Promise<VaultInfo> {
    const token = await this.read<Address>("token");
    this.token = token;
    const [symbol, decimals, houseFeeBps, holderFeeBps, maxStake, maxBalance, settleWindow, paused, referee] = await Promise.all([
      this.readToken<string>("symbol"), this.readToken<number>("decimals"), this.read<number>("houseFeeBps"), this.read<number>("holderFeeBps"),
      this.read<bigint>("maxStake"), this.read<bigint>("maxBalance"), this.read<number>("settleWindow"), this.read<boolean>("paused").catch(() => false),
      this.read<Address>("referee"),
    ]);
    return { token, symbol, decimals: Number(decimals), houseFeeBps: Number(houseFeeBps), holderFeeBps: Number(holderFeeBps), maxStake, maxBalance, settleWindow: Number(settleWindow), paused, referee };
  }

  async balances(player: Address): Promise<Balances> {
    if (!this.token) await this.info();
    const [wallet, allowance, free, locked, eth] = await Promise.all([
      this.readToken<bigint>("balanceOf", [player]), this.readToken<bigint>("allowance", [player, this.vault]),
      this.read<bigint>("freeOf", [player]), this.read<bigint>("lockedOf", [player]), this.pub.getBalance({ address: player }),
    ]);
    return { wallet, allowance, free, locked, eth };
  }

  async session(player: Address): Promise<OnchainSession> {
    const s = await this.read<{ key: Address; expiry: bigint; maxStake: bigint; cap: bigint; used: bigint }>("sessionOf", [player]);
    return { key: s.key, expiry: BigInt(s.expiry), maxStake: s.maxStake, cap: s.cap, used: s.used };
  }

  nonce(player: Address): Promise<bigint> {
    return this.read<bigint>("sessionNonce", [player]).then(BigInt);
  }

  owner(): Promise<Address> {
    return this.read<Address>("owner");
  }

  /** The referee a match locked under (the only one whose Result it takes). */
  refereeOf(matchId: Hex): Promise<Address> {
    return this.read<Address>("refereeOf", [matchId]);
  }

  async matchOf(matchId: Hex): Promise<MatchView> {
    const m = await this.read<{
      playerA: Address; feeBps: number; holderFeeBps: number; roundSeconds: number; state: number; playerB: Address; lockedAt: bigint; stake: bigint; settleBy: bigint; rules: Hex;
    }>("matchOf", [matchId]);
    return {
      playerA: m.playerA, playerB: m.playerB, stake: m.stake, feeBps: Number(m.feeBps), holderFeeBps: Number(m.holderFeeBps), roundSeconds: Number(m.roundSeconds),
      state: STATES[Number(m.state)] ?? "none", lockedAt: Number(m.lockedAt), settleBy: Number(m.settleBy), rules: m.rules,
    };
  }

  /** The chain's latest block time (unix s): deadlines and settleBy compare against it, not the viewer's clock. */
  async chainNow(): Promise<number> {
    const b = await this.pub.getBlock({ blockTag: "latest" });
    return Number(b.timestamp);
  }

  // ---- the player's own transactions (the wallet sends them) ----------------------------------------------------

  /** Simulate, then send from the wallet; resolves with the hash as soon as it is sent. */
  private async send(w: WalletClient, target: "vault" | "token", functionName: string, args: unknown[]): Promise<Hex> {
    const account = w.account!;
    const address = target === "vault" ? this.vault : this.token!;
    const abi = target === "vault" ? VAULT_CALL_ABI : ERC20_ABI;
    const { request } = await this.pub.simulateContract({ address, abi, functionName, args, account } as never);
    return w.writeContract({ ...(request as object), account, chain: w.chain } as never);
  }

  /** Wait for a transaction; a revert throws. */
  async wait(hash: Hex): Promise<TransactionReceipt> {
    const r = await this.pub.waitForTransactionReceipt({ hash, pollingInterval: 700, timeout: 120_000 });
    if (r.status !== "success") throw wagerError("contract", "the transaction reverted");
    return r;
  }

  /** Approve the vault for exactly `amount` (never unlimited). */
  approve(w: WalletClient, amount: bigint): Promise<Hex> {
    return this.send(w, "token", "approve", [this.vault, amount]);
  }
  deposit(w: WalletClient, amount: bigint): Promise<Hex> {
    return this.send(w, "vault", "deposit", [amount]);
  }
  withdraw(w: WalletClient, amount: bigint): Promise<Hex> {
    return this.send(w, "vault", "withdraw", [amount]);
  }

  /**
   * The most of `amount` (a whole free balance, say) that `from` can take out in one withdraw. A token that taxes the
   * vault as the sender has the tax billed to the withdrawer's own free balance (docs/WAGER.md §3.6), so "everything"
   * can't go out whole: a simulated withdraw that reverts TransferMismatch(asked, moved) gives the rate, and the amount
   * shrinks to fit (a few tries). Anything else returns what the last try asked (the real send reports its own error).
   */
  async withdrawable(from: Address, amount: bigint, to?: Address): Promise<bigint> {
    let a = amount;
    for (let i = 0; i < 5 && a > 0n; i++) {
      try {
        await this.pub.simulateContract({
          address: this.vault, abi: VAULT_CALL_ABI, account: from, functionName: to ? "withdrawTo" : "withdraw", args: to ? [a, to] : [a],
        } as never);
        return a;
      } catch (e) {
        const rev = e instanceof BaseError ? (e.walk(x => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;
        if (rev?.data?.errorName !== "TransferMismatch") return a;
        const [asked, moved] = rev.data.args as readonly [bigint, bigint];
        if (!(moved > asked && asked > 0n)) return a;
        // Taking out `a` costs a * moved / asked of the free balance: scale to fit `amount`, and always step down.
        const fit = (amount * asked) / moved;
        a = fit < a ? fit : a - 1n;
      }
    }
    return a > 0n ? a : 0n;
  }
  withdrawTo(w: WalletClient, amount: bigint, to: Address): Promise<Hex> {
    return this.send(w, "vault", "withdrawTo", [amount, to]);
  }
  openSession(w: WalletClient, auth: SessionAuth, walletSig: Hex): Promise<Hex> {
    return this.send(w, "vault", "openSession", [auth, walletSig]);
  }
  revokeSession(w: WalletClient): Promise<Hex> {
    return this.send(w, "vault", "revokeSession", []);
  }
  lock(w: WalletClient, a: Entry, sigA: Hex, b: Entry, sigB: Hex): Promise<Hex> {
    return this.send(w, "vault", "lock", [a, sigA, b, sigB]);
  }
  settle(w: WalletClient, r: Result, sig: Hex): Promise<Hex> {
    return this.send(w, "vault", "settle", [r, sig]);
  }
  refundExpired(w: WalletClient, matchId: Hex): Promise<Hex> {
    return this.send(w, "vault", "refundExpired", [matchId]);
  }
  /** After settleBy: take back only your own stake (a transaction that names nobody else). */
  reclaim(w: WalletClient, matchId: Hex): Promise<Hex> {
    return this.send(w, "vault", "reclaim", [matchId]);
  }
  /** Kill one of your own match ids that hasn't locked: no Entry for it can ever lock. */
  cancel(w: WalletClient, matchId: Hex): Promise<Hex> {
    return this.send(w, "vault", "cancel", [matchId]);
  }
  /** Both players' wallets signed the same Result (the referee is gone). */
  settleMutual(w: WalletClient, r: Result, sigA: Hex, sigB: Hex): Promise<Hex> {
    return this.send(w, "vault", "settleMutual", [r, sigA, sigB]);
  }

  // ---- events ---------------------------------------------------------------------------------------------------

  /** How a match ended, from the settle / void transaction the relay names (one receipt), else from the event logs. */
  async matchEnd(matchId: Hex, tx: Hex | null): Promise<MatchEnd | null> {
    if (tx) {
      try {
        const r = await this.pub.getTransactionReceipt({ hash: tx });
        const end = this.endFromLogs(matchId, r.logs.filter(l => l.address.toLowerCase() === this.vault.toLowerCase()), tx);
        if (end) return end;
      } catch { /* fall back to the scan */ }
    }
    const { logs } = await this.scan([[SEL.settled, SEL.voided], matchId]);
    const last = logs.at(-1);
    return last ? this.endFromLogs(matchId, [last], last.transactionHash as Hex) : null;
  }

  private endFromLogs(matchId: Hex, logs: Log[], tx: Hex): MatchEnd | null {
    const parsed = parseEventLogs({ abi: GAME_VAULT_ABI, logs, eventName: ["MatchSettled", "MatchVoided"] });
    for (const p of parsed) {
      const a = p.args as Record<string, unknown>;
      if (String(a.matchId).toLowerCase() !== matchId.toLowerCase()) continue;
      if (p.eventName === "MatchSettled") {
        return { kind: "settled", winner: a.winner as Address, loser: a.loser as Address, payout: a.payout as bigint, fee: a.fee as bigint, feeBps: Number(a.feeBps), logHash: a.logHash as Hex, mutual: !!a.mutual, tx };
      }
      return { kind: "voided", reason: Number(a.reason), logHash: a.logHash as Hex, tx };
    }
    return null;
  }

  /** The player's matches, newest first: MatchLocked as A or B, then how each ended (§3.9). */
  async history(player: Address, maxMatches = 50): Promise<{ rows: HistoryRow[]; partial: boolean }> {
    let partial = false;
    const me = pad(player.toLowerCase() as Hex);
    const raw: Log[] = [];
    for (const topics of [[SEL.locked, null, me], [SEL.locked, null, null, me]] as Topics[]) {
      const r = await this.scan(topics);
      partial ||= r.partial;
      raw.push(...r.logs);
    }
    const locks = parseEventLogs({ abi: GAME_VAULT_ABI, logs: raw, eventName: "MatchLocked" });
    locks.sort((x, y) => Number((y.blockNumber ?? 0n) - (x.blockNumber ?? 0n)));
    const mine = locks.slice(0, maxMatches);
    const ids = mine.map(l => l.args.matchId);
    const ends = new Map<string, MatchEnd>();
    /** Matches this player took their own stake back from (after settleBy, a StakeReclaimed naming only them). */
    const reclaims = new Map<string, Hex>();
    if (ids.length) {
      const r = await this.scan([[SEL.settled, SEL.voided, SEL.reclaimed], ids]);
      partial ||= r.partial;
      for (const l of r.logs) {
        const id = String(l.topics[1]).toLowerCase() as Hex;
        if (l.topics[0] === SEL.reclaimed) {
          if (String(l.topics[2]).toLowerCase() === me) reclaims.set(id, l.transactionHash as Hex);
          continue;
        }
        const e = this.endFromLogs(id, [l], l.transactionHash as Hex);
        if (e) ends.set(id, e);
      }
    }
    const rows: HistoryRow[] = mine.map(l => {
      const a = l.args;
      const end = ends.get(a.matchId.toLowerCase());
      const opponent = a.playerA.toLowerCase() === player.toLowerCase() ? a.playerB : a.playerA;
      const settleBy = Number(a.settleBy);
      const base = { matchId: a.matchId, opponent, stake: a.stake, feeBps: Number(a.feeBps), settleBy, lockedAt: 0, lockTx: l.transactionHash as Hex };
      const back = reclaims.get(a.matchId.toLowerCase());
      if (!end && back) return { ...base, state: "reclaimed", payout: 0n, fee: 0n, logHash: null, endTx: back, voidReason: null };
      if (!end) return { ...base, state: "locked", payout: 0n, fee: 0n, logHash: null, endTx: null, voidReason: null };
      if (end.kind === "voided") return { ...base, state: "void", payout: 0n, fee: 0n, logHash: end.logHash, endTx: end.tx, voidReason: end.reason };
      const won = end.winner.toLowerCase() === player.toLowerCase();
      return { ...base, state: won ? "won" : "lost", payout: won ? end.payout : 0n, fee: end.fee, logHash: end.logHash, endTx: end.tx, voidReason: null };
    });
    return { rows, partial };
  }

  /** Lock times for history rows (settleBy - settleWindow). */
  static withLockTimes(rows: HistoryRow[], settleWindow: number): HistoryRow[] {
    return rows.map(r => ({ ...r, lockedAt: r.settleBy - settleWindow }));
  }

  // ---- log scans: public RPCs cap eth_getLogs ranges, so a refused range is split in two (newest half first) and the
  // scan stops after `budget` calls (the page then says older history wasn't loaded) ---------------------------------

  private async scan(topics: Topics, budget = 48): Promise<{ logs: Log[]; partial: boolean }> {
    // Never viem's cached block number: a match that ended a moment ago must be in the scan.
    const latest = await this.pub.getBlockNumber({ cacheTime: 0 });
    const out: Log[] = [];
    let calls = 0, partial = false;
    const stack: { from: bigint; to: bigint }[] = [{ from: this.fromBlock, to: latest }];
    while (stack.length) {
      const r = stack.pop()!;
      if (calls >= budget) { partial = true; break; }
      calls++;
      try {
        const logs = (await this.pub.request({
          method: "eth_getLogs",
          params: [{ address: this.vault, topics, fromBlock: numberToHex(r.from), toBlock: numberToHex(r.to) }],
        } as never)) as Log[];
        out.push(...logs.map(l => ({ ...l, blockNumber: l.blockNumber === null ? null : BigInt(l.blockNumber) })));
      } catch (e) {
        if (r.to - r.from < 16n) throw e;
        const mid = (r.from + r.to) / 2n;
        stack.push({ from: r.from, to: mid }, { from: mid + 1n, to: r.to });
      }
    }
    out.sort((x, y) => Number((x.blockNumber ?? 0n) - (y.blockNumber ?? 0n)));
    return { logs: out, partial };
  }
}
