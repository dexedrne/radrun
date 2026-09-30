// Test fakes for the ?wager client (docs/WAGER.md §9.3): a chain and a wager relay that speak the real protocols, so
// the client's code runs unchanged against them in unit tests (in process) and in headless browsers (HTTP + WS).
//
// FakeChain: an in-memory JSON-RPC node with one ERC-20 and one GameVault implementing the rules of §3 (exact
// deposits, withdrawals, session keys, lock checks, referee settles, refunds after settleBy, events). It is a model
// for testing the client, not the contract: the contracts lane's Solidity is the real thing.
// FakeRelay: the lobby (login, offers, pairing, the relayer, the faucet) and FakeRoom, a series room with sealed
// release, relay-clock deadlines with FILLs, a canonical-sim referee, best of 3, forfeits, the log and its hash, and
// a referee-signed Result. Its timing runs on an injected clock, so tests can run a series on a fake one.
import http from "node:http";
import {
  decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData, encodeFunctionResult, getAbiItem, getAddress, keccak256, numberToHex,
  parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, toHex, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WebSocketServer, type WebSocket } from "ws";
import { ERC20_ABI, GAME_VAULT_ABI } from "../src/wager/abi.ts";
import {
  OUTCOME_VOID, OUTCOME_WIN, VOID_MUTUAL, VOID_REFEREE, VOID_TIMEOUT, ZERO_ADDRESS, capturedFees, entryDigest, entryFromJson, entryToJson, entryTypedData,
  loginTypedData, makeRules, matchIdCreator, payout, random32, resultDigest, resultTypedData, reviewTypedData, rulesHash, sessionAuthDigest, sessionAuthFromJson, sessionAuthTypedData, type Entry, type Result,
  type SessionAuth, type SimCompat,
} from "../src/wager/eip712.ts";
import {
  MSG_PROBE, MSG_PROBE_ECHO, WAGER_PROTOCOL, WAGER_TIMING, decodeProbe, encodeProbe, type LobbyClientMsg, type LobbyServerMsg, type MatchStatus, type Offer,
  type PlayerCard, type RadbroPick, type RelayConfig, type RoomClientMsg, type RoomServerMsg, type SeriesPhase, type SeriesState, type Settlement,
  type WagerStartMsg,
} from "../src/wager/protocol.ts";
import {
  deriveSeed, scoreRounds, seedCommit, seriesLogHash, slotOfAFor, wordsToBase64, type Flag, type RoundLog, type SeriesLog, type SeriesOutcome, type Side,
} from "../src/wager/log.ts";
import { endStepFor, roundMatch, roundResult, simCompat, type SimAssets } from "../src/wager/replay.ts";
import type { TagMatch } from "../src/game/tagMatch.ts";
import {
  MSG_INPUT, MSG_PING, NET_VERSION, cleanName, decodeInput, decodePing, encodeFill, encodePong, encodeRelayInput, predictWord, type Compat,
} from "../src/net/wire.ts";
import { inputDelayFor } from "../relay/src/room.ts";
import type { WagerNetId } from "../src/wager/config.ts";

/** anvil's public test keys (also the dev wallet's): #0 deployer / faucet, #7 house, #8 referee, #9 relayer. */
export const ANVIL = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const satisfies readonly Hex[];
export const acct = (i: number) => privateKeyToAccount(ANVIL[i]);

const E18 = 10n ** 18n;

class Revert extends Error {
  data: Hex;
  constructor(name: string, args: unknown[] = [], abi: Abi = GAME_VAULT_ABI as unknown as Abi) {
    super(`execution reverted: ${name}`);
    this.data = encodeErrorResult({ abi, errorName: name, args } as never);
  }
}

type Log = { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; transactionHash: Hex; logIndex: number };
type Receipt = { hash: Hex; from: Address; to: Address; block: bigint; status: 1 | 0; logs: Log[] };

export type VaultMatch = {
  playerA: Address; playerB: Address; stake: bigint; feeBps: number; holderFeeBps: number; roundSeconds: number; state: 0 | 1 | 2 | 3 | 4; lockedAt: bigint; settleBy: bigint; rules: Hex;
  /** The referee it locked under, and the players who took their stake back after settleBy. */
  referee?: Address; reclaimed?: string[];
};

/** One chain: a token, a vault, blocks, receipts and logs. */
export class FakeChain {
  readonly chainId: number;
  readonly token: Address = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
  readonly vault: Address = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
  readonly symbol = "tSPIDERTAG";
  readonly decimals = 18;
  block = 1n;
  /** Chain time (unix s); tests move it. */
  time = Math.floor(Date.now() / 1000);
  readonly eth = new Map<string, bigint>();
  readonly nonces = new Map<string, number>();
  readonly bal = new Map<string, bigint>();
  readonly allow = new Map<string, bigint>();
  // vault
  readonly free = new Map<string, bigint>();
  readonly locked = new Map<string, bigint>();
  readonly sessions = new Map<string, { key: Address; expiry: bigint; maxStake: bigint; cap: bigint; used: bigint }>();
  readonly sessionNonce = new Map<string, bigint>();
  readonly matches = new Map<string, VaultMatch>();
  houseAccrued = 0n;
  totalLiabilities = 0n;
  houseFeeBps = 300;
  holderFeeBps = 150;
  maxStake = 1000n * E18;
  maxBalance = 100_000n * E18;
  settleWindow = 86_400;
  paused = false;
  owner: Address = acct(0).address;
  house: Address = acct(7).address;
  referee: Address = acct(8).address;
  readonly logs: Log[] = [];
  readonly receipts = new Map<string, Receipt>();
  private seq = 0;

  constructor(chainId = 31337) {
    this.chainId = chainId;
    this.bal.set(acct(0).address.toLowerCase(), 1_000_000_000n * E18);
    for (let i = 0; i < 10; i++) this.eth.set(acct(i).address.toLowerCase(), 10_000n * E18);
  }

  readonly g = (m: Map<string, bigint>, k: string) => m.get(k.toLowerCase()) ?? 0n;
  private s = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k.toLowerCase(), v);

  // ---- token -----------------------------------------------------------------------------------------------------------
  transfer(from: Address, to: Address, v: bigint): void {
    const b = this.g(this.bal, from);
    if (b < v) throw new Revert("ERC20InsufficientBalance", [from, b, v], ERC20_ABI as unknown as Abi);
    this.s(this.bal, from, b - v);
    this.s(this.bal, to, this.g(this.bal, to) + v);
  }

  // ---- the vault's rules (docs/WAGER.md §3.2) --------------------------------------------------------------------------
  private emit(ev: string, args: Record<string, unknown>, out: Log[]): void {
    const item = getAbiItem({ abi: GAME_VAULT_ABI, name: ev } as never) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
    const topics = encodeEventTopics({ abi: GAME_VAULT_ABI, eventName: ev, args } as never) as Hex[];
    const non = item.inputs.filter(i => !i.indexed);
    const data = encodeAbiParameters(non as never, non.map(i => args[i.name]) as never);
    out.push({ address: this.vault, topics, data, blockNumber: 0n, transactionHash: "0x", logIndex: 0 });
  }

  private async checkEntry(e: Entry, sig: Hex): Promise<Address> {
    const signer = await recoverTypedDataAddress({ ...entryTypedData(this.chainId, this.vault, e), signature: sig }).catch(() => ZERO_ADDRESS);
    const sess = this.sessions.get(e.player.toLowerCase());
    if (sess && signer.toLowerCase() === sess.key.toLowerCase()) {
      if (BigInt(this.time) > sess.expiry || e.stake > sess.maxStake || sess.used + e.stake > sess.cap) throw new Revert("SessionLimit", [e.player]);
      sess.used += e.stake;
      return signer;
    }
    if (signer.toLowerCase() !== e.player.toLowerCase()) throw new Revert("BadSignature", [e.player]);
    return signer;
  }

  /** Apply one vault or token call from `from` (views return data; writes change state and emit logs). */
  async exec(from: Address, to: Address, data: Hex, write: boolean, out: Log[] = []): Promise<Hex> {
    const isVault = to.toLowerCase() === this.vault.toLowerCase();
    const abi = (isVault ? GAME_VAULT_ABI : ERC20_ABI) as unknown as Abi;
    if (!isVault && to.toLowerCase() !== this.token.toLowerCase()) return "0x";
    const { functionName: fn, args = [] } = decodeFunctionData({ abi, data }) as { functionName: string; args?: readonly unknown[] };
    const a = args as unknown[];
    const ret = (v: unknown) => encodeFunctionResult({ abi, functionName: fn, result: v } as never);
    const now = BigInt(this.time);
    if (!isVault) {
      switch (fn) {
        case "name": return ret("SPIDERTAG Test");
        case "symbol": return ret(this.symbol);
        case "decimals": return ret(this.decimals);
        case "balanceOf": return ret(this.g(this.bal, a[0] as string));
        case "allowance": return ret(this.allow.get(`${String(a[0]).toLowerCase()}:${String(a[1]).toLowerCase()}`) ?? 0n);
        case "approve": if (write) this.allow.set(`${from.toLowerCase()}:${String(a[0]).toLowerCase()}`, a[1] as bigint); return ret(true);
        case "transfer": if (write) this.transfer(from, a[0] as Address, a[1] as bigint); return ret(true);
      }
      throw new Error(`token: ${fn}`);
    }
    const need = (c: boolean, name: string, eargs: unknown[] = []) => { if (!c) throw new Revert(name, eargs); };
    switch (fn) {
      case "MAX_FEE_BPS": return ret(500);
      case "MAX_SESSION_TTL": return ret(30n * 86_400n);
      case "token": return ret(this.token);
      case "house": return ret(this.house);
      case "referee": return ret(this.referee);
      case "owner": return ret(this.owner);
      case "paused": return ret(this.paused);
      case "houseFeeBps": return ret(this.houseFeeBps);
      case "holderFeeBps": return ret(this.holderFeeBps);
      case "maxStake": return ret(this.maxStake);
      case "maxBalance": return ret(this.maxBalance);
      case "settleWindow": return ret(this.settleWindow);
      case "freeOf": return ret(this.g(this.free, a[0] as string));
      case "lockedOf": return ret(this.g(this.locked, a[0] as string));
      case "houseAccrued": return ret(this.houseAccrued);
      case "totalLiabilities": return ret(this.totalLiabilities);
      case "sessionNonce": return ret(this.sessionNonce.get(String(a[0]).toLowerCase()) ?? 0n);
      case "sessionOf": return ret(this.sessions.get(String(a[0]).toLowerCase()) ?? { key: ZERO_ADDRESS, expiry: 0n, maxStake: 0n, cap: 0n, used: 0n });
      case "refereeOf": return ret(this.matches.get(String(a[0]).toLowerCase())?.referee ?? ZERO_ADDRESS);
      case "matchOf": return ret(this.matches.get(String(a[0]).toLowerCase()) ?? { playerA: ZERO_ADDRESS, feeBps: 0, holderFeeBps: 0, roundSeconds: 0, state: 0, playerB: ZERO_ADDRESS, lockedAt: 0n, stake: 0n, settleBy: 0n, rules: `0x${"00".repeat(32)}` });
      case "hashEntry": return ret(entryDigest(this.chainId, this.vault, a[0] as Entry));
      case "hashResult": return ret(resultDigest(this.chainId, this.vault, a[0] as Result));
      case "hashSessionAuth": return ret(sessionAuthDigest(this.chainId, this.vault, a[0] as SessionAuth));
      case "deposit": case "depositFor": {
        const player = (fn === "deposit" ? from : a[0]) as Address, amount = (fn === "deposit" ? a[0] : a[1]) as bigint;
        need(!this.paused, "EnforcedPause");
        need(amount > 0n, "ZeroAmount");
        const key = `${from.toLowerCase()}:${this.vault.toLowerCase()}`, al = this.allow.get(key) ?? 0n;
        if (al < amount) throw new Revert("ERC20InsufficientAllowance", [this.vault, al, amount], ERC20_ABI as unknown as Abi);
        need(this.g(this.free, player) + this.g(this.locked, player) + amount <= this.maxBalance, "BalanceCapExceeded", [player, this.maxBalance]);
        if (!write) return ret(undefined);
        this.transfer(from, this.vault, amount);
        this.allow.set(key, al - amount);
        this.s(this.free, player, this.g(this.free, player) + amount);
        this.totalLiabilities += amount;
        this.emit("Deposited", { player, from, amount }, out);
        return "0x";
      }
      case "withdraw": case "withdrawTo": {
        const amount = a[0] as bigint, dest = (fn === "withdraw" ? from : a[1]) as Address;
        need(amount > 0n, "ZeroAmount");
        const f = this.g(this.free, from);
        need(f >= amount, "InsufficientFree", [from, f, amount]);
        if (!write) return "0x";
        this.s(this.free, from, f - amount);
        this.totalLiabilities -= amount;
        this.transfer(this.vault, dest, amount);
        this.emit("Withdrawn", { player: from, to: dest, amount }, out);
        return "0x";
      }
      case "openSession": {
        const auth = a[0] as SessionAuth, sig = a[1] as Hex;
        need(!this.paused, "EnforcedPause");
        const signer = await recoverTypedDataAddress({ ...sessionAuthTypedData(this.chainId, this.vault, auth), signature: sig }).catch(() => ZERO_ADDRESS);
        need(signer.toLowerCase() === auth.player.toLowerCase(), "BadSignature", [auth.player]);
        const n = this.sessionNonce.get(auth.player.toLowerCase()) ?? 0n;
        need(auth.nonce === n, "BadNonce", [n, auth.nonce]);
        need(auth.maxStake > 0n && auth.maxStake <= auth.cap && auth.expiry > now && auth.expiry <= now + 30n * 86_400n && auth.sessionKey !== ZERO_ADDRESS, "BadSession");
        if (!write) return "0x";
        this.sessions.set(auth.player.toLowerCase(), { key: auth.sessionKey, expiry: auth.expiry, maxStake: auth.maxStake, cap: auth.cap, used: 0n });
        this.sessionNonce.set(auth.player.toLowerCase(), n + 1n);
        this.emit("SessionOpened", { player: auth.player, sessionKey: auth.sessionKey, maxStake: auth.maxStake, cap: auth.cap, expiry: auth.expiry, nonce: n }, out);
        return "0x";
      }
      case "revokeSession": {
        if (!write) return "0x";
        const n = this.sessionNonce.get(from.toLowerCase()) ?? 0n;
        this.sessions.delete(from.toLowerCase());
        this.sessionNonce.set(from.toLowerCase(), n + 1n);
        this.emit("SessionRevoked", { player: from, nonce: n }, out);
        return "0x";
      }
      case "lock": {
        const [ea, sa, eb, sb] = a as [Entry, Hex, Entry, Hex];
        need(!this.paused, "EnforcedPause");
        need(ea.matchId === eb.matchId, "EntryMismatch");
        need(matchIdCreator(ea.matchId).toLowerCase() === ea.player.toLowerCase(), "BadMatchId", [ea.matchId]);
        need(!this.matches.has(ea.matchId.toLowerCase()), "MatchExists", [ea.matchId]);
        need(ea.player !== eb.player && ea.player !== ZERO_ADDRESS && eb.player !== ZERO_ADDRESS, "EntryMismatch");
        need((ea.opponent === ZERO_ADDRESS || ea.opponent === eb.player) && (eb.opponent === ZERO_ADDRESS || eb.opponent === ea.player), "EntryMismatch");
        need(ea.stake === eb.stake, "EntryMismatch");
        need(ea.stake > 0n && ea.stake <= this.maxStake, "StakeOutOfRange", [ea.stake, this.maxStake]);
        for (const e of [ea, eb]) need(e.feeCapBps >= this.houseFeeBps, "FeeAboveCap", [e.player, this.houseFeeBps, e.feeCapBps]);
        need(ea.roundSeconds === eb.roundSeconds && ea.rules === eb.rules, "EntryMismatch");
        need(now <= ea.deadline, "EntryExpired", [ea.player, ea.deadline]);
        need(now <= eb.deadline, "EntryExpired", [eb.player, eb.deadline]);
        const snap = [...this.sessions.entries()].map(([k, v]) => [k, { ...v }] as const);
        try {
          await this.checkEntry(ea, sa);
          await this.checkEntry(eb, sb);
          for (const p of [ea.player, eb.player]) need(this.g(this.free, p) >= ea.stake, "InsufficientFree", [p, this.g(this.free, p), ea.stake]);
        } catch (e) { for (const [k, v] of snap) this.sessions.set(k, v); throw e; }
        if (!write) { for (const [k, v] of snap) this.sessions.set(k, v); return "0x"; }
        const fees = capturedFees(this.houseFeeBps, this.holderFeeBps, this.houseFeeBps, this.houseFeeBps);
        for (const p of [ea.player, eb.player]) { this.s(this.free, p, this.g(this.free, p) - ea.stake); this.s(this.locked, p, this.g(this.locked, p) + ea.stake); }
        const m: VaultMatch = {
          playerA: ea.player, playerB: eb.player, stake: ea.stake, ...fees, roundSeconds: ea.roundSeconds, state: 1, lockedAt: now, settleBy: now + BigInt(this.settleWindow), rules: ea.rules,
          referee: this.referee, reclaimed: [],
        };
        this.matches.set(ea.matchId.toLowerCase(), m);
        this.emit("MatchLocked", { matchId: ea.matchId, playerA: ea.player, playerB: eb.player, stake: ea.stake, feeBps: m.feeBps, holderFeeBps: m.holderFeeBps, roundSeconds: m.roundSeconds, rules: m.rules, settleBy: m.settleBy }, out);
        return "0x";
      }
      case "settle": {
        const [r, sig] = a as [Result, Hex];
        const m = this.matches.get(r.matchId.toLowerCase());
        need(!!m && m.state === 1, "NotLocked", [r.matchId]);
        need(now <= m!.settleBy, "SettleWindowClosed", [r.matchId, m!.settleBy]);
        const signer = await recoverTypedDataAddress({ ...resultTypedData(this.chainId, this.vault, r), signature: sig }).catch(() => ZERO_ADDRESS);
        const ref = m!.referee ?? this.referee;
        need(signer.toLowerCase() === ref.toLowerCase(), "BadSignature", [ref]);
        if (r.outcome === OUTCOME_WIN) need((r.winner === m!.playerA || r.winner === m!.playerB) && (r.feeBps === m!.feeBps || r.feeBps === m!.holderFeeBps), "BadResult");
        else need(r.outcome === OUTCOME_VOID && r.winner === ZERO_ADDRESS && r.feeBps === 0, "BadResult");
        if (!write) return "0x";
        for (const p of [m!.playerA, m!.playerB]) this.s(this.locked, p, this.g(this.locked, p) - m!.stake);
        if (r.outcome === OUTCOME_WIN) {
          const pay = payout(m!.stake, r.feeBps);
          this.s(this.free, r.winner, this.g(this.free, r.winner) + pay.winner);
          this.houseAccrued += pay.fee;
          m!.state = 2;
          const loser = r.winner === m!.playerA ? m!.playerB : m!.playerA;
          this.emit("MatchSettled", { matchId: r.matchId, winner: r.winner, loser, payout: pay.winner, fee: pay.fee, feeBps: r.feeBps, logHash: r.logHash, mutual: false }, out);
        } else {
          for (const p of [m!.playerA, m!.playerB]) this.s(this.free, p, this.g(this.free, p) + m!.stake);
          m!.state = 3;
          this.emit("MatchVoided", { matchId: r.matchId, playerA: m!.playerA, playerB: m!.playerB, reason: VOID_REFEREE, logHash: r.logHash }, out);
        }
        return "0x";
      }
      case "cancel": {
        const id = a[0] as Hex;
        need(matchIdCreator(id).toLowerCase() === from.toLowerCase(), "BadMatchId", [id]);
        need(!this.matches.has(id.toLowerCase()), "MatchExists", [id]);
        if (!write) return "0x";
        this.matches.set(id.toLowerCase(), { playerA: ZERO_ADDRESS, playerB: ZERO_ADDRESS, stake: 0n, feeBps: 0, holderFeeBps: 0, roundSeconds: 0, state: 4, lockedAt: 0n, settleBy: 0n, rules: `0x${"00".repeat(32)}` });
        this.emit("MatchCancelled", { matchId: id, player: from }, out);
        return "0x";
      }
      case "reclaim": {
        const id = a[0] as Hex, m = this.matches.get(id.toLowerCase());
        need(!!m && m.state === 1, "NotLocked", [id]);
        need(now > m!.settleBy, "SettleWindowOpen", [id, m!.settleBy]);
        const me = from.toLowerCase();
        need((me === m!.playerA.toLowerCase() || me === m!.playerB.toLowerCase()) && !m!.reclaimed?.includes(me), "NothingToReclaim", [id, from]);
        if (!write) return "0x";
        this.s(this.locked, from, this.g(this.locked, from) - m!.stake);
        this.s(this.free, from, this.g(this.free, from) + m!.stake);
        (m!.reclaimed ??= []).push(me);
        if (m!.reclaimed.length === 2) m!.state = 3;
        this.emit("StakeReclaimed", { matchId: id, player: from, stake: m!.stake }, out);
        return "0x";
      }
      case "settleMutual": {
        const [r, sigA, sigB] = a as [Result, Hex, Hex];
        const m = this.matches.get(r.matchId.toLowerCase());
        need(!!m && m.state === 1, "NotLocked", [r.matchId]);
        need(now <= m!.settleBy, "SettleWindowClosed", [r.matchId, m!.settleBy]);
        for (const [p, sig] of [[m!.playerA, sigA], [m!.playerB, sigB]] as const) {
          const signer = await recoverTypedDataAddress({ ...resultTypedData(this.chainId, this.vault, r), signature: sig }).catch(() => ZERO_ADDRESS);
          need(signer.toLowerCase() === p.toLowerCase(), "BadSignature", [p]);
        }
        if (r.outcome === OUTCOME_WIN) need((r.winner === m!.playerA || r.winner === m!.playerB) && r.feeBps === m!.feeBps, "BadResult");
        else need(r.outcome === OUTCOME_VOID && r.winner === ZERO_ADDRESS && r.feeBps === 0, "BadResult");
        if (!write) return "0x";
        for (const p of [m!.playerA, m!.playerB]) this.s(this.locked, p, this.g(this.locked, p) - m!.stake);
        if (r.outcome === OUTCOME_WIN) {
          const pay = payout(m!.stake, r.feeBps);
          this.s(this.free, r.winner, this.g(this.free, r.winner) + pay.winner);
          this.houseAccrued += pay.fee;
          m!.state = 2;
          const loser = r.winner === m!.playerA ? m!.playerB : m!.playerA;
          this.emit("MatchSettled", { matchId: r.matchId, winner: r.winner, loser, payout: pay.winner, fee: pay.fee, feeBps: r.feeBps, logHash: r.logHash, mutual: true }, out);
        } else {
          for (const p of [m!.playerA, m!.playerB]) this.s(this.free, p, this.g(this.free, p) + m!.stake);
          m!.state = 3;
          this.emit("MatchVoided", { matchId: r.matchId, playerA: m!.playerA, playerB: m!.playerB, reason: VOID_MUTUAL, logHash: r.logHash }, out);
        }
        return "0x";
      }
      case "refundExpired": {
        const id = a[0] as Hex, m = this.matches.get(id.toLowerCase());
        need(!!m && m.state === 1, "NotLocked", [id]);
        need(now > m!.settleBy, "SettleWindowOpen", [id, m!.settleBy]);
        if (!write) return "0x";
        for (const p of [m!.playerA, m!.playerB]) {
          if (m!.reclaimed?.includes(p.toLowerCase())) continue;
          this.s(this.locked, p, this.g(this.locked, p) - m!.stake);
          this.s(this.free, p, this.g(this.free, p) + m!.stake);
        }
        m!.state = 3;
        this.emit("MatchVoided", { matchId: id, playerA: m!.playerA, playerB: m!.playerB, reason: VOID_TIMEOUT, logHash: `0x${"00".repeat(32)}` }, out);
        return "0x";
      }
    }
    throw new Error(`vault: ${fn} not in the fake`);
  }

  /** Mine one transaction (a revert still mines, status 0). */
  async mine(from: Address, to: Address, data: Hex, value = 0n): Promise<Hex> {
    const hash = keccak256(toHex(`fake-tx-${++this.seq}-${from}-${data.slice(0, 40)}`));
    const out: Log[] = [];
    let status: 1 | 0 = 1;
    this.nonces.set(from.toLowerCase(), (this.nonces.get(from.toLowerCase()) ?? 0) + 1);
    if (value > 0n) { const b = this.eth.get(from.toLowerCase()) ?? 0n; this.eth.set(from.toLowerCase(), b - value); this.eth.set(to.toLowerCase(), (this.eth.get(to.toLowerCase()) ?? 0n) + value); }
    try {
      if (data && data !== "0x") await this.exec(from, to, data, true, out);
    } catch (e) {
      if (!(e instanceof Revert)) throw e;
      status = 0;
      out.length = 0;
    }
    this.block++;
    this.time += 1;
    out.forEach((l, i) => { l.blockNumber = this.block; l.transactionHash = hash; l.logIndex = this.logs.length + i; });
    this.logs.push(...out);
    this.receipts.set(hash, { hash, from, to, block: this.block, status, logs: out });
    return hash;
  }

  /** JSON-RPC (what viem, the dev wallet and the page call). */
  async request(method: string, params: unknown[] = []): Promise<unknown> {
    const hx = (n: bigint | number) => numberToHex(n);
    switch (method) {
      case "eth_chainId": return hx(this.chainId);
      case "evm_increaseTime": this.time += Number(params[0]); return hx(Number(params[0]));
      case "evm_mine": this.block++; return "0x0";
      case "net_version": return String(this.chainId);
      case "eth_blockNumber": return hx(this.block);
      case "eth_gasPrice": return hx(1_000_000_000n);
      case "eth_maxPriorityFeePerGas": return "0x0";
      case "eth_estimateGas": return hx(300_000n);
      case "eth_getBalance": return hx(this.eth.get(String(params[0]).toLowerCase()) ?? 0n);
      case "eth_getTransactionCount": return hx(this.nonces.get(String(params[0]).toLowerCase()) ?? 0);
      case "eth_getCode": { const a = String(params[0]).toLowerCase(); return a === this.vault.toLowerCase() || a === this.token.toLowerCase() ? "0x6001" : "0x"; }
      case "eth_getBlockByNumber": case "eth_getBlockByHash": {
        const n = params[0] === "latest" || params[0] === "pending" || typeof params[0] !== "string" || !String(params[0]).startsWith("0x") ? this.block : BigInt(String(params[0]));
        return {
          number: hx(n), hash: keccak256(toHex(`block-${n}`)), parentHash: keccak256(toHex(`block-${n - 1n}`)), timestamp: hx(this.time), baseFeePerGas: hx(10_000_000n),
          gasLimit: hx(30_000_000n), gasUsed: "0x0", transactions: [], miner: ZERO_ADDRESS, difficulty: "0x0", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`,
          nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, size: "0x1", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, uncles: [], mixHash: `0x${"00".repeat(32)}`, totalDifficulty: "0x0",
        };
      }
      case "eth_call": {
        const c = params[0] as { from?: Address; to: Address; data: Hex };
        try {
          return await this.exec(getAddress(c.from ?? ZERO_ADDRESS), getAddress(c.to), c.data ?? "0x", false);
        } catch (e) {
          if (e instanceof Revert) throw Object.assign(new Error(e.message), { code: 3, data: e.data });
          throw e;
        }
      }
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        const tx = parseTransaction(raw);
        const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
        return this.mine(from, getAddress(tx.to!), tx.data ?? "0x", tx.value ?? 0n);
      }
      case "eth_getTransactionReceipt": {
        const r = this.receipts.get(String(params[0]));
        if (!r) return null;
        return {
          transactionHash: r.hash, blockNumber: hx(r.block), blockHash: keccak256(toHex(`block-${r.block}`)), status: r.status ? "0x1" : "0x0", from: r.from, to: r.to,
          contractAddress: null, gasUsed: hx(100_000n), cumulativeGasUsed: hx(100_000n), effectiveGasPrice: hx(10_000_000n), logsBloom: `0x${"00".repeat(256)}`, type: "0x2", transactionIndex: "0x0",
          logs: r.logs.map(l => this.rpcLog(l)),
        };
      }
      case "eth_getTransactionByHash": {
        const r = this.receipts.get(String(params[0]));
        return r ? { hash: r.hash, blockNumber: hx(r.block), blockHash: keccak256(toHex(`block-${r.block}`)), from: r.from, to: r.to, input: "0x", nonce: "0x0", value: "0x0", gas: hx(300_000n), gasPrice: hx(10_000_000n), type: "0x0", transactionIndex: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: hx(this.chainId) } : null;
      }
      case "eth_getLogs": {
        const f = params[0] as { address?: string; topics?: (Hex | Hex[] | null)[]; fromBlock?: string; toBlock?: string };
        const from = f.fromBlock && f.fromBlock.startsWith("0x") ? BigInt(f.fromBlock) : 0n, to = f.toBlock && f.toBlock.startsWith("0x") ? BigInt(f.toBlock) : this.block;
        return this.logs.filter(l => (!f.address || l.address.toLowerCase() === f.address.toLowerCase()) && l.blockNumber >= from && l.blockNumber <= to
          && (f.topics ?? []).every((t, i) => t === null || (Array.isArray(t) ? t.some(x => x.toLowerCase() === l.topics[i]?.toLowerCase()) : t.toLowerCase() === l.topics[i]?.toLowerCase())))
          .map(l => this.rpcLog(l));
      }
    }
    throw Object.assign(new Error(`fake chain: ${method} not supported`), { code: -32601 });
  }

  private rpcLog(l: Log) {
    return { address: l.address, topics: l.topics, data: l.data, blockNumber: numberToHex(l.blockNumber), transactionHash: l.transactionHash, transactionIndex: "0x0", blockHash: keccak256(toHex(`block-${l.blockNumber}`)), logIndex: numberToHex(l.logIndex), removed: false };
  }

  /** An EIP-1193-style request function (viem `custom` transport). */
  readonly eip1193 = { request: ({ method, params }: { method: string; params?: unknown }) => this.request(method, (params ?? []) as unknown[]) };

  /** Serve JSON-RPC over HTTP (for browsers). */
  serve(port: number, host = "127.0.0.1"): Promise<http.Server> {
    const srv = http.createServer((req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") { res.end(); return; }
      let body = "";
      req.on("data", c => (body += c));
      req.on("end", async () => {
        const one = async (q: { id: unknown; method: string; params?: unknown[] }) => {
          try { return { jsonrpc: "2.0", id: q.id, result: await this.request(q.method, q.params ?? []) }; } catch (e) {
            const x = e as { code?: number; message?: string; data?: Hex };
            return { jsonrpc: "2.0", id: q.id, error: { code: x.code ?? -32000, message: x.message ?? String(e), ...(x.data ? { data: x.data } : {}) } };
          }
        };
        try {
          const j = JSON.parse(body);
          const out = Array.isArray(j) ? await Promise.all(j.map(one)) : await one(j);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? numberToHex(v) : v)));
        } catch (e) { res.statusCode = 400; res.end(String(e)); }
      });
    });
    return new Promise(r => srv.listen(port, host, () => r(srv)));
  }
}

// ---- the series room ------------------------------------------------------------------------------------------------------

export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown };
export type Sock = { send(d: string | Uint8Array): void; close(code?: number, reason?: string): void };

const STEP_MS = 1000 / 120;

type Seat = { sock: Sock | null; connected: boolean; ready: boolean; pick: RadbroPick | null; share: Hex | null; rtt: number; probes: Map<number, number>; end: number | null; goneAt: number };
type Round = {
  n: number; seed: number; slotOfA: 0 | 1; inputDelay: number; startAtMs: number; endStep: number; match: TagMatch;
  words: [Float64Array, Float64Array]; upTo: [number, number]; sealed: number; fills: [number, number]; late: [number, number]; start: WagerStartMsg;
};

export type RoomInit = {
  matchId: Hex; chainId: number; vault: Address; players: [Address, Address]; cards: [PlayerCard, PlayerCard]; stake: bigint; feeBps: number; holderFeeBps: number;
  roundSeconds: number; district: string; assets: SimAssets; settleBy: number; clock: Clock; timing?: Partial<Record<keyof typeof WAGER_TIMING, number>>;
  /** Signs the Result (the referee key). */
  sign(r: Result): Promise<Hex>;
  /** Settles on chain (the relayer); resolves to the transaction. */
  submit(r: Result, sig: Hex): Promise<Hex | null>;
  /** Verifies a login (null = trust the address sent; tests). */
  verify?: (player: Address, sig: Hex, by: "session" | "wallet", challenge: Hex, expiry: number, relay: string) => Promise<boolean>;
  holder?: (a: Address) => boolean;
  holdOnFlags?: boolean;
  /** Tests: flag the winner as if the referee's metrics caught a script (the real relay computes these). */
  forceFlag?: boolean;
  onEnd?: (log: SeriesLog, outcome: SeriesOutcome) => void;
};

export class FakeRoom {
  readonly o: RoomInit;
  readonly t: typeof WAGER_TIMING;
  readonly seats: [Seat, Seat];
  phase: SeriesPhase = "waiting";
  readonly secret = random32();
  readonly rounds: RoundLog[] = [];
  readonly winners: (Side | "draw")[] = [];
  readonly flags: Flag[] = [];
  score: [number, number] = [0, 0];
  draws = 0;
  roundNo = 1;
  cur: Round | null = null;
  deadlineAt: number | null;
  outcome: SeriesOutcome | null = null;
  log: SeriesLog | null = null;
  settlement: Settlement | null = null;
  settleTx: Hex | null = null;
  private readonly sim: SimCompat;
  private timerGen = 0;
  private readonly challenges = new Map<Sock, { challenge: Hex; expiry: number }>();
  private probeSeq = 1;

  constructor(o: RoomInit) {
    this.o = o;
    this.t = { ...WAGER_TIMING, ...(o.timing ?? {}) } as typeof WAGER_TIMING;
    const seat = (): Seat => ({ sock: null, connected: false, ready: false, pick: null, share: null, rtt: 0, probes: new Map(), end: null, goneAt: 0 });
    this.seats = [seat(), seat()];
    this.sim = simCompat(o.assets);
    this.deadlineAt = o.clock.now() + this.t.joinGraceMs;
    const gen = this.timerGen;
    o.clock.setTimeout(() => { if (this.timerGen === gen && !this.cur && this.rounds.length === 0 && !this.outcome) void this.end({ kind: "void", winner: null, reason: "noshow", score: [0, 0] }); }, this.t.joinGraceMs);
    this.tick();
  }

  private now() { return this.o.clock.now(); }

  state(you: Side | null): SeriesState {
    return {
      matchId: this.o.matchId, phase: this.phase, players: this.o.cards, you, connected: [this.seats[0].connected, this.seats[1].connected], ready: [this.seats[0].ready, this.seats[1].ready],
      picks: [this.seats[0].pick, this.seats[1].pick], stake: this.o.stake.toString(), roundSeconds: this.o.roundSeconds, district: this.o.district, feeBps: this.o.feeBps,
      holderFeeBps: this.o.holderFeeBps, round: this.roundNo, score: [...this.score] as [number, number], draws: this.draws, seedCommit: seedCommit(this.secret),
      deadlineAt: this.deadlineAt, settleBy: this.o.settleBy,
    };
  }

  private json(sock: Sock | null, m: RoomServerMsg) { sock?.send(JSON.stringify(m)); }
  private all(m: RoomServerMsg) { for (const s of this.seats) this.json(s.sock, m); }
  private bin(b: Uint8Array) { for (const s of this.seats) s.sock?.send(b); }
  private pushState() { this.seats.forEach((s, i) => this.json(s.sock, { t: "series", state: this.state(i as Side) })); }

  /** A socket: hello, challenge, login, then the seat. */
  open(sock: Sock) {
    let side: Side | null = null;
    return {
      message: (d: string | Uint8Array) => {
        if (typeof d !== "string") { if (side !== null) this.binary(side, d); return; }
        let m: RoomClientMsg;
        try { m = JSON.parse(d); } catch { return; }
        if (m.t === "hello") {
          if (m.v !== WAGER_PROTOCOL || m.compat.v !== this.sim.v || m.compat.city !== this.sim.city || m.compat.tuning !== this.sim.tuning) { this.json(sock, { t: "error", code: "version", message: "reload to update" }); sock.close(4000, "version"); return; }
          const ch = { challenge: random32(), expiry: Math.floor(Date.now() / 1000) + 60 };
          this.challenges.set(sock, ch);
          this.json(sock, { t: "challenge", ...ch, relay: "fake" });
          return;
        }
        if (m.t === "login") {
          const ch = this.challenges.get(sock);
          this.challenges.delete(sock);
          const idx = this.o.players.findIndex(p => p.toLowerCase() === m.player.toLowerCase());
          if (!ch || idx < 0) { this.json(sock, { t: "error", code: idx < 0 ? "full" : "auth", message: idx < 0 ? "not a player of this match" : "no challenge" }); sock.close(4001, idx < 0 ? "full" : "auth"); return; }
          const ok = this.o.verify ? this.o.verify(m.player, m.sig, m.by, ch.challenge, ch.expiry, "fake") : Promise.resolve(true);
          void ok.then(good => {
            if (!good) { this.json(sock, { t: "error", code: "auth", message: "bad login" }); sock.close(4001, "auth"); return; }
            side = idx as Side;
            this.seat(side, sock);
          });
          return;
        }
        if (side !== null) this.control(side, m);
      },
      close: () => { if (side !== null && this.seats[side].sock === sock) this.gone(side); },
    };
  }

  /** Tests: a socket seated as `side` with no login handshake; returns its message handler. */
  attach(side: Side, sock: Sock) {
    this.seat(side, sock);
    return {
      message: (d: string | Uint8Array) => { if (typeof d === "string") this.control(side, JSON.parse(d) as RoomClientMsg); else this.binary(side, d); },
      close: () => { if (this.seats[side].sock === sock) this.gone(side); },
    };
  }

  /** Seat a logged-in player (tests call it directly). */
  seat(side: Side, sock: Sock): void {
    const s = this.seats[side];
    const back = s.goneAt > 0;
    s.sock = sock;
    s.connected = true;
    s.goneAt = 0;
    this.pushState();
    if (back && this.cur && !this.outcome) {
      this.all({ t: "back", side });
      // The current start again and every sealed word so far (both slots): the client catches up from step 0.
      const r = this.cur;
      this.json(sock, r.start);
      for (let slot = 0; slot < 2; slot++) {
        for (let first = r.inputDelay + 1; first <= r.sealed; first += 128) {
          const n = Math.min(128, r.sealed - first + 1);
          sock.send(encodeRelayInput(slot, first, r.words[slot].subarray(first, first + n)));
        }
      }
    }
    if (this.outcome) {
      this.json(sock, { t: "outcome", outcome: this.outcome, logHash: this.log!.logHash, held: this.phase === "held", flags: this.flags });
      if (this.settlement) this.json(sock, { t: "settlement", settlement: this.settlement });
      if (this.settleTx) this.json(sock, { t: this.outcome.kind === "void" ? "voided" : "settled", tx: this.settleTx } as RoomServerMsg);
    }
  }

  private gone(side: Side): void {
    const s = this.seats[side];
    s.sock = null;
    s.connected = false;
    if (this.outcome) return;
    s.goneAt = this.now();
    if (!this.cur && this.rounds.length === 0) { s.ready = false; this.pushState(); return; }
    this.all({ t: "drop", side, graceMs: this.t.reconnectGraceMs });
    this.pushState();
    const at = s.goneAt;
    this.o.clock.setTimeout(() => {
      if (this.outcome || s.goneAt !== at || s.connected) return;
      const other = (1 - side) as Side;
      if (!this.seats[other].connected) { void this.end({ kind: "void", winner: null, reason: "error", score: this.score }); return; }
      const step = this.cur ? this.cur.sealed : 0;
      this.cutRound();
      void this.end({ kind: "win", winner: other, reason: "forfeit", score: this.score, forfeit: { by: side, round: this.roundNo, step, why: "disconnect" } });
    }, this.t.reconnectGraceMs);
  }

  private control(side: Side, m: RoomClientMsg): void {
    const s = this.seats[side];
    if (m.t === "pick" && this.rounds.length === 0 && !this.cur) { s.pick = { radbro: m.radbro, own: m.own }; s.ready = false; this.pushState(); return; }
    if (m.t === "seed" && !s.share) { s.share = m.share; return; }
    if (m.t === "ready") {
      if (this.phase !== "waiting" && this.phase !== "between") return;
      s.ready = true;
      this.pushState();
      if (this.seats.every(x => x.ready && x.connected && x.pick && x.share)) this.probeThenStart();
      return;
    }
    if (m.t === "end" && this.cur === null && this.rounds.length) {
      const last = this.rounds[this.rounds.length - 1];
      if (last.result && (m.hash >>> 0) !== last.result.hash) this.flags.push({ side, kind: "desync", round: last.round, value: m.hash >>> 0, limit: last.result.hash });
    }
  }

  private probeThenStart(): void {
    if (this.cur) return;
    this.phase = "between";
    for (const s of this.seats) s.probes.clear();
    const gen = ++this.timerGen;
    for (let k = 0; k < this.t.probes; k++) {
      this.o.clock.setTimeout(() => {
        if (gen !== this.timerGen) return;
        for (const s of this.seats) { const id = this.probeSeq++; s.probes.set(id, this.now()); s.sock?.send(encodeProbe(MSG_PROBE, id)); }
      }, k * 20);
    }
    this.o.clock.setTimeout(() => { if (gen === this.timerGen) this.startRound(); }, this.t.probes * 20 + 250);
  }

  private startRound(): void {
    const n = this.roundNo;
    const shares = [this.seats[0].share!, this.seats[1].share!] as [Hex, Hex];
    const seed = deriveSeed(this.secret, shares, n);
    const seed1 = this.rounds[0]?.seed ?? seed;
    const slotOfA = slotOfAFor(n, seed, seed1);
    const rtt = Math.max(1, this.seats[0].rtt || 60) + Math.max(1, this.seats[1].rtt || 60);
    const inputDelay = inputDelayFor(rtt);
    const bySide = [this.seats[0].pick!.radbro, this.seats[1].pick!.radbro];
    const bySlot: [string, string] = slotOfA === 0 ? [bySide[0], bySide[1]] : [bySide[1], bySide[0]];
    const match = roundMatch(this.o.assets, seed, this.o.roundSeconds, bySlot);
    const endStep = endStepFor(this.o.roundSeconds);
    const startAtMs = this.now() + this.t.startDelayMs;
    const late: [number, number] = [0, 0];
    for (let slot = 0; slot < 2; slot++) {
      const side = slot === slotOfA ? 0 : 1;
      late[slot] = this.t.lateMs + Math.min(this.seats[side].rtt / 2, this.t.maxOneWayAllowMs);
    }
    const start: WagerStartMsg = {
      t: "start", seed, startAtMs, round: n, inputDelay,
      slots: bySlot.map((radbro, slot) => ({ slot, name: this.o.cards[slot === slotOfA ? 0 : 1].name, radbro, touch: false, easy: false })),
      config: { district: this.o.district, mode: "tag", seconds: this.o.roundSeconds, maxPlayers: 2 },
      matchId: this.o.matchId, slotOfA, score: [...this.score] as [number, number], lateMs: late,
    };
    const words: [Float64Array, Float64Array] = [new Float64Array(endStep + 1), new Float64Array(endStep + 1)];
    this.cur = { n, seed, slotOfA, inputDelay, startAtMs, endStep, match, words, upTo: [inputDelay, inputDelay], sealed: 0, fills: [0, 0], late, start };
    // Steps 1..inputDelay are empty and sealed at once.
    for (let s = 1; s <= inputDelay; s++) match.stepWords([0, 0]);
    this.cur.sealed = inputDelay;
    for (const s of this.seats) { s.ready = false; s.end = null; }
    this.phase = "playing";
    this.deadlineAt = null;
    this.all(start);
    this.pushState();
  }

  /** The relay clock's tick: fills past deadlines, sealed release. */
  /** Stop the room's clock (the relay is shutting down). */
  dispose(): void { this.disposed = true; }
  private disposed = false;

  private tick(): void {
    if (this.outcome || this.disposed) return;
    if (this.cur) this.pump();
    this.o.clock.setTimeout(() => this.tick(), 4);
  }

  private deadline(slot: number, s: number): number {
    return this.cur!.startAtMs + s * STEP_MS + this.cur!.late[slot];
  }

  private binary(side: Side, b: Uint8Array): void {
    const s = this.seats[side];
    if (b[0] === MSG_PING) { const c = decodePing(b); if (c !== null) s.sock?.send(encodePong(c, this.now())); return; }
    if (b[0] === MSG_PROBE_ECHO) {
      const p = decodeProbe(b);
      const at = p ? s.probes.get(p.id) : undefined;
      if (p && at !== undefined) { const rtt = this.now() - at; s.rtt = s.rtt && s.probes.size < this.t.probes ? Math.min(s.rtt, rtt) : rtt; s.probes.delete(p.id); }
      return;
    }
    if (b[0] !== MSG_INPUT || !this.cur) return;
    const m = decodeInput(b);
    const r = this.cur;
    if (!m) return;
    const slot = side === 0 ? r.slotOfA : 1 - r.slotOfA;
    for (let k = 0; k < m.words.length; k++) {
      const st = m.firstStep + k;
      if (st <= r.upTo[slot]) continue; // filled or repeated: dropped
      if (st !== r.upTo[slot] + 1 || st > r.endStep) { s.sock?.close(4002, "bad steps"); return; }
      r.words[slot][st] = m.words[k];
      r.upTo[slot] = st;
    }
    this.pump();
  }

  private pump(): void {
    const r = this.cur!;
    const now = this.now();
    for (let slot = 0; slot < 2; slot++) {
      let first = -1, count = 0, word = 0;
      while (r.upTo[slot] < r.endStep && this.deadline(slot, r.upTo[slot] + 1) <= now) {
        const st = r.upTo[slot] + 1;
        const w = predictWord(r.words[slot][st - 1]);
        if (first < 0 || w !== word) {
          if (first >= 0) this.bin(encodeFill(slot, first, count, word));
          first = st; count = 0; word = w;
        }
        r.words[slot][st] = w;
        r.upTo[slot] = st;
        r.fills[slot]++;
        count++;
      }
      if (first >= 0) this.bin(encodeFill(slot, first, count, word));
    }
    const top = Math.min(r.upTo[0], r.upTo[1]);
    if (top <= r.sealed) return;
    const pair = [0, 0];
    for (let st = r.sealed + 1; st <= top; st++) { pair[0] = r.words[0][st]; pair[1] = r.words[1][st]; r.match.stepWords(pair); }
    for (let side = 0; side < 2; side++) {
      const sock = this.seats[side].sock;
      if (!sock) continue;
      const otherSlot = side === 0 ? 1 - r.slotOfA : r.slotOfA;
      for (let f = r.sealed + 1; f <= top; f += 128) sock.send(encodeRelayInput(otherSlot, f, r.words[otherSlot].subarray(f, Math.min(top, f + 127) + 1)));
    }
    r.sealed = top;
    if (r.sealed >= r.endStep) this.finishRound();
  }

  private roundLog(r: Round, lastStep: number): RoundLog {
    return {
      round: r.n, seed: r.seed, slotOfA: r.slotOfA, inputDelay: r.inputDelay, endStep: r.endStep, lastStep,
      words: [wordsToBase64(r.words[0].subarray(1, lastStep + 1)), wordsToBase64(r.words[1].subarray(1, lastStep + 1))], result: null, fills: [...r.fills] as [number, number],
    };
  }

  private finishRound(): void {
    const r = this.cur!;
    const res = roundResult(r.match, r.slotOfA);
    this.rounds.push({ ...this.roundLog(r, r.endStep), result: res });
    this.winners.push(res.winner);
    const sc = scoreRounds(this.winners);
    this.score = sc.score;
    this.draws = sc.draws;
    this.cur = null;
    this.all({ t: "round", round: r.n, result: res, score: this.score, draws: this.draws });
    if (sc.done) {
      void this.end(sc.void ? { kind: "void", winner: null, reason: "draws", score: this.score } : { kind: "win", winner: sc.winner, reason: "played", score: this.score });
      return;
    }
    this.roundNo++;
    this.phase = "between";
    this.deadlineAt = this.now() + this.t.betweenRoundsMs;
    const gen = ++this.timerGen;
    this.o.clock.setTimeout(() => { if (gen === this.timerGen && !this.cur && !this.outcome) this.probeThenStart(); }, this.t.betweenRoundsMs);
    this.pushState();
  }

  private cutRound(): void {
    const r = this.cur;
    if (!r) return;
    this.rounds.push(this.roundLog(r, r.sealed));
    this.cur = null;
  }

  private async end(outcome: SeriesOutcome): Promise<void> {
    if (this.outcome) return;
    this.outcome = outcome;
    this.timerGen++;
    this.phase = "deciding";
    const o = this.o;
    if (o.forceFlag && outcome.kind === "win" && outcome.winner !== null) this.flags.push({ side: outcome.winner, kind: "reaction", round: Math.max(1, this.rounds.length), value: 9, limit: 18, note: "forced by the test relay" });
    const rules = makeRules(o.district, this.sim);
    const shares: [Hex, Hex] = [this.seats[0].share ?? `0x${"00".repeat(32)}`, this.seats[1].share ?? `0x${"00".repeat(32)}`];
    const log: SeriesLog = {
      format: "radrun-wager-log/1", chainId: o.chainId, vault: o.vault, matchId: o.matchId, players: o.players, stake: o.stake.toString(), feeBps: o.feeBps, holderFeeBps: o.holderFeeBps,
      roundSeconds: o.roundSeconds, rules, rulesHash: rulesHash(rules), compat: { ...this.sim, build: "test" },
      radbros: [this.seats[0].pick?.radbro ?? "652", this.seats[1].pick?.radbro ?? "652"], seed: { commit: seedCommit(this.secret), relaySecret: this.secret, shares },
      rounds: this.rounds, outcome, flags: this.flags, logHash: "0x",
    };
    log.logHash = seriesLogHash(log);
    this.log = log;
    const held = !!o.holdOnFlags && outcome.kind === "win" && this.flags.some(f => f.side === outcome.winner || f.kind === "result-mismatch");
    this.phase = held ? "held" : "signed";
    this.all({ t: "outcome", outcome, logHash: log.logHash, held, flags: this.flags });
    o.onEnd?.(log, outcome);
    if (held) { this.pushState(); return; }
    await this.signAndSubmit(outcome.kind === "win" ? outcome.winner : null);
  }

  /** The owner's review of a held series: settle as replayed, or void. */
  async review(decision: 1 | 2): Promise<void> {
    if (this.phase !== "held" || !this.outcome || !this.log) throw new Error("not held");
    if (decision === 2) {
      this.outcome = { kind: "void", winner: null, reason: "review", score: this.outcome.score };
      this.log.outcome = this.outcome;
      this.all({ t: "outcome", outcome: this.outcome, logHash: this.log.logHash, held: false, flags: this.flags });
      await this.signAndSubmit(null);
    } else {
      this.all({ t: "outcome", outcome: this.outcome, logHash: this.log.logHash, held: false, flags: this.flags });
      await this.signAndSubmit(this.outcome.winner);
    }
  }

  /** Sign the Result (the holder rate for a holder winner) and submit it. */
  async signAndSubmit(winner: Side | null): Promise<void> {
    const o = this.o, log = this.log!;
    const w = winner === null ? ZERO_ADDRESS : o.players[winner];
    const result: Result = winner === null
      ? { matchId: o.matchId, outcome: OUTCOME_VOID, winner: ZERO_ADDRESS, feeBps: 0, logHash: log.logHash }
      : { matchId: o.matchId, outcome: OUTCOME_WIN, winner: w, feeBps: o.holder?.(w) ? o.holderFeeBps : o.feeBps, logHash: log.logHash };
    const sig = await o.sign(result);
    this.settlement = { result, sig };
    this.phase = "signed";
    this.all({ t: "settlement", settlement: this.settlement });
    const tx = await o.submit(result, sig);
    this.settleTx = tx;
    this.phase = winner === null ? "voided" : "settled";
    if (tx) this.all(winner === null ? { t: "voided", tx } : { t: "settled", tx });
    this.pushState();
  }
}

// ---- the relay: lobby, relayer, HTTP, sockets ------------------------------------------------------------------------------

export type RelayOpts = {
  chain: FakeChain; net: WagerNetId; assets: Record<string, SimAssets>; clock?: Clock; roundSeconds?: number[]; timing?: Partial<Record<keyof typeof WAGER_TIMING, number>>;
  holders?: Set<string>; radbros?: Record<string, number[]>; newAccountSeries?: number; newAccountMaxStake?: bigint; holdOnFlags?: boolean; regionBlocked?: boolean;
  forceFlag?: boolean;
};

type LobbyConn = { sock: Sock; player: Address | null; challenge: { challenge: Hex; expiry: number } | null };

export class FakeRelay {
  readonly o: RelayOpts;
  readonly clock: Clock;
  readonly offers = new Map<string, { offer: Offer; sig: Hex; conn: LobbyConn }>();
  /** Joins waiting for the creator's named Entry (`sign` sent). */
  private readonly signing = new Map<string, (sig: Hex | null) => void>();
  readonly rooms = new Map<string, FakeRoom>();
  readonly cards = new Map<string, PlayerCard>();
  readonly status = new Map<string, MatchStatus>();
  readonly conns = new Set<LobbyConn>();
  readonly referee = acct(8);
  readonly relayer = acct(9);
  readonly faucet = acct(0);
  base = "http://127.0.0.1:0";
  private srv: http.Server | null = null;
  private readonly sockets = new Set<WebSocket>();

  constructor(o: RelayOpts) {
    this.o = o;
    // Real time by default; the relay's timers never keep a test process alive.
    this.clock = o.clock ?? { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
  }

  config(): RelayConfig {
    const c = this.o.chain;
    const sims: Record<string, SimCompat> = {};
    for (const [d, a] of Object.entries(this.o.assets)) sims[d] = simCompat(a);
    return {
      v: WAGER_PROTOCOL, net: this.o.net, chainId: c.chainId, vault: c.vault, token: c.token, tokenSymbol: c.symbol, tokenDecimals: c.decimals, referee: this.referee.address,
      relayer: this.relayer.address, houseFeeBps: c.houseFeeBps, holderFeeBps: c.holderFeeBps, maxStake: c.maxStake.toString(), maxBalance: c.maxBalance.toString(),
      newAccountMaxStake: (this.o.newAccountMaxStake ?? c.maxStake).toString(), newAccountSeries: this.o.newAccountSeries ?? 0,
      roundSeconds: this.o.roundSeconds ?? [60, 90, 120], districts: Object.keys(this.o.assets), sims, timing: { ...WAGER_TIMING, ...(this.o.timing ?? {}) } as typeof WAGER_TIMING,
      faucet: true, regionBlocked: !!this.o.regionBlocked, beta: true,
    };
  }

  card(a: Address): PlayerCard {
    const k = a.toLowerCase();
    let c = this.cards.get(k);
    if (!c) {
      c = { address: getAddress(a), name: `${a.slice(0, 6)}…${a.slice(-4)}`, rating: 1200, wins: 0, losses: 0, forfeits: 0, voids: 0, held: 0, firstSeen: Date.now(), holder: !!this.o.holders?.has(k), radbros: this.o.radbros?.[k] ?? [], cosmetic: null };
      this.cards.set(k, c);
    }
    return c;
  }

  private send(sock: Sock, m: LobbyServerMsg) { sock.send(JSON.stringify(m)); }
  private offerList(): Offer[] { return [...this.offers.values()].map(x => x.offer); }
  private broadcast(m: LobbyServerMsg) { for (const c of this.conns) this.send(c.sock, m); }

  /** Send a relayer transaction (no signature needed on the fake chain). */
  async relay(data: Hex): Promise<{ hash: Hex; ok: boolean }> {
    const c = this.o.chain;
    const hash = await c.mine(this.relayer.address, c.vault, data);
    return { hash, ok: c.receipts.get(hash)!.status === 1 };
  }

  private async verifyLogin(player: Address, sig: Hex, by: "session" | "wallet", challenge: Hex, expiry: number, relay: string): Promise<boolean> {
    const c = this.o.chain;
    const signer = await recoverTypedDataAddress({ ...loginTypedData(c.chainId, c.vault, { player, challenge, expiry: BigInt(expiry), relay }), signature: sig }).catch(() => ZERO_ADDRESS);
    if (by === "wallet") return signer.toLowerCase() === player.toLowerCase();
    const s = c.sessions.get(player.toLowerCase());
    return !!s && s.key.toLowerCase() === signer.toLowerCase() && s.expiry > BigInt(c.time);
  }

  openLobby(sock: Sock) {
    const conn: LobbyConn = { sock, player: null, challenge: null };
    this.conns.add(conn);
    return {
      message: (d: string | Uint8Array) => { if (typeof d === "string") void this.lobbyMsg(conn, d); },
      close: () => {
        this.conns.delete(conn);
        for (const [id, x] of this.offers) if (x.conn === conn) { this.offers.delete(id); this.broadcast({ t: "unoffer", matchId: id as Hex, reason: "creator-left" }); }
      },
    };
  }

  private async lobbyMsg(conn: LobbyConn, d: string): Promise<void> {
    let m: LobbyClientMsg;
    try { m = JSON.parse(d); } catch { return; }
    const c = this.o.chain, sock = conn.sock;
    const err = (code: string, message: string) => this.send(sock, { t: "error", code: code as never, message });
    switch (m.t) {
      case "hello":
        conn.challenge = { challenge: random32(), expiry: Math.floor(Date.now() / 1000) + 60 };
        this.send(sock, { t: "challenge", ...conn.challenge, relay: this.base });
        this.send(sock, { t: "offers", offers: this.offerList().filter(o => o.listed) });
        return;
      case "login": {
        const ch = conn.challenge;
        conn.challenge = null;
        if (!ch || !(await this.verifyLogin(m.player, m.sig, m.by, ch.challenge, m.expiry, this.base))) { err("auth", "login refused"); return; }
        conn.player = getAddress(m.player);
        this.send(sock, { t: "welcome", you: this.card(conn.player), config: this.config() });
        this.send(sock, { t: "offers", offers: this.offerList().filter(o => o.listed || o.creator.address === conn.player) });
        return;
      }
      case "ping": this.send(sock, { t: "pong" }); return;
    }
    if (!conn.player) { err("auth", "log in first"); return; }
    const me = conn.player;
    switch (m.t) {
      case "session": {
        const auth = sessionAuthFromJson(m.auth);
        const data = encodeFunctionData({ abi: GAME_VAULT_ABI, functionName: "openSession", args: [auth, m.sig] });
        this.send(sock, { t: "tx", kind: "session", matchId: null, hash: null, status: "sent" });
        const r = await this.relay(data);
        this.send(sock, { t: "tx", kind: "session", matchId: null, hash: r.hash, status: r.ok ? "confirmed" : "failed", ...(r.ok ? {} : { error: "reverted" }) });
        return;
      }
      case "profile": {
        const card = this.card(me);
        if (m.name) card.name = cleanName(m.name);
        if (m.cosmetic !== undefined && card.holder) card.cosmetic = m.cosmetic;
        this.send(sock, { t: "card", card });
        return;
      }
      case "create": {
        const e = entryFromJson(m.entry);
        if (e.player.toLowerCase() !== me.toLowerCase()) { err("bad", "not your entry"); return; }
        if (c.g(c.free, me) < e.stake) { err("balance", "not enough free balance"); return; }
        const district = Object.keys(this.o.assets).find(dd => rulesHash(makeRules(dd, simCompat(this.o.assets[dd]))) === e.rules);
        if (!district) { err("terms", "unknown rules"); return; }
        const fees = capturedFees(c.houseFeeBps, c.holderFeeBps, e.feeCapBps, 500);
        const offer: Offer = {
          matchId: e.matchId, creator: this.card(me), stake: e.stake.toString(), roundSeconds: e.roundSeconds, district, ...fees, listed: m.listed, opponent: e.opponent === ZERO_ADDRESS ? null : e.opponent,
          holdersOnly: !!m.holdersOnly, minSeries: m.minSeries ?? 0, deadline: Number(e.deadline), createdAt: Date.now(), entry: m.entry,
        };
        this.offers.set(e.matchId.toLowerCase(), { offer, sig: m.sig, conn });
        this.status.set(e.matchId.toLowerCase(), { matchId: e.matchId, state: "open", offer, series: null, outcome: null, settlement: null, lockTx: null, settleTx: null });
        if (offer.listed) this.broadcast({ t: "offer", offer }); else this.send(sock, { t: "offer", offer });
        return;
      }
      case "signed": {
        const done = this.signing.get(m.matchId.toLowerCase());
        if (done) done(m.sig);
        return;
      }
      case "cancel": {
        const x = this.offers.get(m.matchId.toLowerCase());
        if (x && x.conn === conn) { this.offers.delete(m.matchId.toLowerCase()); this.broadcast({ t: "unoffer", matchId: m.matchId, reason: "cancelled" }); }
        return;
      }
      case "join": {
        const x = this.offers.get(m.entry.matchId.toLowerCase());
        if (!x) { err("gone", "that offer is gone"); return; }
        const a = entryFromJson(x.offer.entry), b = entryFromJson(m.entry);
        if (b.player.toLowerCase() !== me.toLowerCase() || b.opponent.toLowerCase() !== a.player.toLowerCase() || b.stake !== a.stake || b.rules !== a.rules || b.roundSeconds !== a.roundSeconds) { err("terms", "entries don't pair"); return; }
        if (x.offer.opponent && x.offer.opponent.toLowerCase() !== me.toLowerCase()) { err("forbidden", "invite for someone else"); return; }
        this.offers.delete(a.matchId.toLowerCase());
        this.broadcast({ t: "unoffer", matchId: a.matchId, reason: "matched" });
        // An open offer's signature never leaves the relay: the creator's page signs a named Entry for this joiner.
        let sa = { entry: x.offer.entry, sig: x.sig };
        if (a.opponent === ZERO_ADDRESS) {
          const named: Entry = { ...a, opponent: me, deadline: BigInt(Math.min(Number(a.deadline), c.time + WAGER_TIMING.namedTtlS)) };
          const sig = await new Promise<Hex | null>(res => {
            const id = a.matchId.toLowerCase();
            const t = setTimeout(() => { this.signing.delete(id); res(null); }, 10_000);
            t.unref?.();
            this.signing.set(id, v => { clearTimeout(t); this.signing.delete(id); res(v); });
            this.send(x.conn.sock, { t: "sign", matchId: a.matchId, entry: entryToJson(named), joiner: this.card(me) });
          });
          if (!sig) { err("gone", "the creator's page didn't confirm the match: the offer is withdrawn"); return; }
          sa = { entry: entryToJson(named), sig };
        }
        const sb = { entry: m.entry, sig: m.sig };
        for (const s of [x.conn.sock, sock]) this.send(s, { t: "matched", matchId: a.matchId, a: sa, b: sb });
        const data = encodeFunctionData({ abi: GAME_VAULT_ABI, functionName: "lock", args: [entryFromJson(sa.entry), sa.sig, b, m.sig] });
        const r = await this.relay(data);
        if (!r.ok) { for (const s of [x.conn.sock, sock]) this.send(s, { t: "tx", kind: "lock", matchId: a.matchId, hash: r.hash, status: "failed", error: "lock reverted" }); return; }
        this.initRoom(a, b, x.offer.district);
        const st = this.status.get(a.matchId.toLowerCase())!;
        st.state = "locked";
        st.lockTx = r.hash;
        for (const s of [x.conn.sock, sock]) this.send(s, { t: "locked", matchId: a.matchId, tx: r.hash });
        return;
      }
    }
  }

  initRoom(a: Entry, b: Entry, district: string): FakeRoom {
    const c = this.o.chain;
    const m = c.matches.get(a.matchId.toLowerCase())!;
    const room = new FakeRoom({
      matchId: a.matchId, chainId: c.chainId, vault: c.vault, players: [m.playerA, m.playerB], cards: [this.card(m.playerA), this.card(m.playerB)], stake: m.stake,
      feeBps: m.feeBps, holderFeeBps: m.holderFeeBps, roundSeconds: m.roundSeconds, district, assets: this.o.assets[district], settleBy: Number(m.settleBy), clock: this.clock,
      timing: this.o.timing, holdOnFlags: this.o.holdOnFlags, forceFlag: this.o.forceFlag,
      sign: r => this.referee.signTypedData(resultTypedData(c.chainId, c.vault, r)),
      submit: async (r, sig) => {
        const res = await this.relay(encodeFunctionData({ abi: GAME_VAULT_ABI, functionName: "settle", args: [r, sig] }));
        const st = this.status.get(a.matchId.toLowerCase())!;
        st.settleTx = res.hash;
        st.state = r.outcome === OUTCOME_WIN ? "settled" : "voided";
        st.settlement = { result: r, sig };
        this.record(room);
        return res.ok ? res.hash : null;
      },
      verify: (p, sig, by, ch, exp, relay) => this.verifyLogin(p, sig, by, ch, exp, relay === "fake" ? "fake" : relay),
      holder: addr => !!this.o.holders?.has(addr.toLowerCase()),
      onEnd: (_log, outcome) => { const st = this.status.get(a.matchId.toLowerCase())!; st.outcome = outcome; if (room.phase === "held") st.state = "held"; },
    });
    this.rooms.set(a.matchId.toLowerCase(), room);
    return room;
  }

  private record(room: FakeRoom): void {
    const o = room.outcome!;
    const [ca, cb] = room.o.cards;
    if (o.kind === "win") {
      const w = o.winner === 0 ? ca : cb, l = o.winner === 0 ? cb : ca;
      const ea = 1 / (1 + 10 ** ((l.rating - w.rating) / 400));
      w.rating += 32 * (1 - ea); l.rating -= 32 * (1 - ea);
      w.wins++; l.losses++;
      if (o.reason === "forfeit") l.forfeits++;
    } else { ca.voids++; cb.voids++; }
  }

  /** HTTP routes. */
  async http(path: string, method: string, body: string): Promise<{ status: number; json?: unknown; text?: string }> {
    const c = this.o.chain;
    if (path === "/health") return { status: 200, text: "ok" };
    if (path === "/config") return { status: 200, json: this.config() };
    if (path.startsWith("/match/")) {
      const id = path.slice(7).toLowerCase();
      const st = this.status.get(id);
      if (!st) return { status: 200, json: { matchId: id, state: "unknown", offer: null, series: null, outcome: null, settlement: null, lockTx: null, settleTx: null } };
      const room = this.rooms.get(id);
      return { status: 200, json: { ...st, offer: this.offers.get(id)?.offer ?? st.offer, series: room ? room.state(null) : null } };
    }
    if (path.startsWith("/log/")) {
      const room = this.rooms.get(path.slice(5).toLowerCase());
      return room?.log ? { status: 200, json: room.log } : { status: 404, text: "not found" };
    }
    if (path.startsWith("/player/")) return { status: 200, json: this.card(getAddress(path.slice(8))) };
    if (path.startsWith("/recent")) return { status: 200, json: [] };
    if (path === "/faucet" && method === "POST") {
      const { address } = JSON.parse(body) as { address: Address };
      const { encodeFunctionData } = await import("viem");
      const tokenTx = await c.mine(this.faucet.address, c.token, encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [address, 10_000n * E18] }));
      const ethTx = await c.mine(this.faucet.address, address, "0x", E18 / 100n);
      return { status: 200, json: { tokenTx, ethTx, tokens: (10_000n * E18).toString(), eth: (E18 / 100n).toString() } };
    }
    if (path === "/review" && method === "POST") {
      const q = JSON.parse(body) as { matchId: Hex; decision: 1 | 2; logHash: Hex; sig: Hex };
      const room = this.rooms.get(q.matchId.toLowerCase());
      if (!room?.log || room.log.logHash !== q.logHash) return { status: 400, text: "unknown match or log" };
      const signer = await recoverTypedDataAddress({ ...reviewTypedData(c.chainId, c.vault, { matchId: q.matchId, decision: q.decision, logHash: q.logHash }), signature: q.sig }).catch(() => ZERO_ADDRESS);
      if (signer.toLowerCase() !== c.owner.toLowerCase()) return { status: 403, text: "only the vault owner reviews" };
      await room.review(q.decision);
      const st = this.status.get(q.matchId.toLowerCase())!;
      return { status: 200, json: { ...st, series: room.state(null) } };
    }
    return { status: 404, text: "not found" };
  }

  /** Serve HTTP + both sockets. */
  serve(port: number, host = "127.0.0.1"): Promise<http.Server> {
    this.base = `http://${host}:${port}`;
    const srv = http.createServer((req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") { res.end(); return; }
      let body = "";
      req.on("data", ch => (body += ch));
      req.on("end", async () => {
        const u = new URL(req.url ?? "/", this.base);
        const r = await this.http(u.pathname + (u.pathname === "/recent" ? u.search : ""), req.method ?? "GET", body);
        res.statusCode = r.status;
        if (r.json !== undefined) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(r.json)); } else res.end(r.text ?? "");
      });
    });
    const wss = new WebSocketServer({ noServer: true });
    this.srv = srv;
    srv.on("upgrade", (req, sock, head) => {
      const u = new URL(req.url ?? "/", this.base);
      wss.handleUpgrade(req, sock, head, (ws: WebSocket) => {
        this.sockets.add(ws);
        ws.on("close", () => this.sockets.delete(ws));
        const s: Sock = { send: d => { try { ws.send(d); } catch { /* closed */ } }, close: (code, reason) => ws.close(code ?? 1000, reason) };
        let h: { message(d: string | Uint8Array): void; close(): void } | null = null;
        if (u.pathname === "/lobby") h = this.openLobby(s);
        else if (u.pathname === "/ws") {
          const room = this.rooms.get((u.searchParams.get("room") ?? "").toLowerCase());
          if (!room) { ws.close(4004, "gone"); return; }
          h = room.open(s);
        } else { ws.close(4004, "no route"); return; }
        ws.on("message", (d, isBin) => h!.message(isBin ? new Uint8Array(d as Buffer) : String(d)));
        ws.on("close", () => h!.close());
      });
    });
    return new Promise(r => srv.listen(port, host, () => r(srv)));
  }

  /** Stop serving: every socket dropped (as a crashed relay would), the rooms' clocks stopped. */
  async stop(): Promise<void> {
    for (const r of this.rooms.values()) r.dispose();
    for (const ws of this.sockets) (ws as unknown as { terminate(): void }).terminate();
    this.sockets.clear();
    const s = this.srv;
    this.srv = null;
    if (s) { s.closeAllConnections(); await new Promise(r => s.close(() => r(null))); }
  }
}

export { NET_VERSION, type Compat };
