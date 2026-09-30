// Fakes for the wager relay tests: a fake clock with timers, an in-memory GameVault that follows the frozen interface's
// rules (sessions, lock, settle, refundExpired, ERC-1271 wallets, nonces per sender) behind the relay's VaultChain /
// TxRpc interfaces, and fake sockets. No network, no keys on disk (player keys are generated per test run).
import {
  decodeFunctionData, keccak256, parseTransaction, recoverAddress, recoverTransactionAddress, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { VAULT_ABI, ERC20_ABI } from "../relay/wager/src/abi.ts";
import type { Clock } from "../relay/wager/src/base.ts";
import type { Call, ChainMatch, ChainSession, Receipt, TxRpc, VaultChain, VaultInfo } from "../relay/wager/src/chain.ts";
import { entryDigest, resultDigest, sessionAuthDigest, type Entry, type Result, type SessionAuth } from "../src/wager/eip712.ts";

export const newAccount = () => privateKeyToAccount(generatePrivateKey());

export class FakeClock implements Clock {
  t: number;
  private seq = 0;
  private timers: { at: number; seq: number; fn: () => void; dead: boolean }[] = [];
  constructor(t = 1_900_000_000_000) {
    this.t = t;
  }
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const h = { at: this.t + Math.max(0, ms), seq: this.seq++, fn, dead: false };
    this.timers.push(h);
    return h;
  };
  clearTimeout = (h: unknown) => {
    if (h) (h as { dead: boolean }).dead = true;
  };
  /** Advance, firing every timer due on the way (in time order). */
  tick(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers = this.timers.filter(x => !x.dead);
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const x = this.timers[0];
      if (!x || x.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, x.at);
      x.fn();
    }
    this.t = end;
  }
}

/** Let pending promise chains (the fake chain's async answers) run. */
export async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Wait until cond holds, ticking the fake clock and giving real time to work that is truly asynchronous (the log's
 * gzip runs on the thread pool).
 */
export async function eventually(cond: () => unknown, clock?: FakeClock, maxRealMs = 10_000, tickMs = 100): Promise<void> {
  const end = Date.now() + maxRealMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("eventually: timed out");
    clock?.tick(tickMs);
    await flush(4);
    await sleep(1);
  }
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const k = (a: string) => a.toLowerCase();

export class FakeVault implements VaultChain, TxRpc {
  chainId = 31337;
  vault: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  token: Address = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
  owner: Address;
  referee: Address = ZERO;
  houseFeeBps = 300;
  holderFeeBps = 150;
  maxStake = 10n ** 21n;
  maxBalance = 10n ** 24n;
  settleWindow = 86_400;
  paused = false;
  readonly free = new Map<string, bigint>();
  readonly locked = new Map<string, bigint>();
  houseAccrued = 0n;
  readonly sessions = new Map<string, ChainSession>();
  readonly sessionNonces = new Map<string, number>();
  readonly matches = new Map<string, ChainMatch>();
  readonly wallets1271 = new Map<string, (digest: Hex, sig: Hex) => boolean>();
  readonly txs = new Map<Hex, { status: "success" | "reverted"; from: Address; fn: string; matchId: Hex | null }>();
  readonly acctNonce = new Map<string, number>();
  readonly eth = new Map<string, bigint>();
  readonly tokenOut: { to: Address; amount: bigint }[] = [];
  readonly sent: string[] = [];
  /** The next this-many sendRaw calls fail (a flaky RPC). */
  failSends = 0;
  /** Receipts appear only once released (tests of pending transactions). */
  holdReceipts = false;
  readonly nowS: () => number;

  constructor(nowS: () => number, owner: Address = newAccount().address) {
    this.nowS = nowS;
    this.owner = owner;
  }

  deposit(p: Address, amount: bigint): void {
    this.free.set(k(p), (this.free.get(k(p)) ?? 0n) + amount);
  }
  freeOfSync = (p: Address) => this.free.get(k(p)) ?? 0n;
  lockedOfSync = (p: Address) => this.locked.get(k(p)) ?? 0n;

  /** Register a session directly (as openSession would). */
  setSession(p: Address, key: Address, maxStake: bigint, cap: bigint, expiry: number): void {
    this.sessions.set(k(p), { key, expiry, maxStake, cap, used: 0n });
    this.sessionNonces.set(k(p), (this.sessionNonces.get(k(p)) ?? 0) + 1);
  }

  /** A Locked match without signatures (room tests). */
  forceLock(o: { matchId: Hex; a: Address; b: Address; stake: bigint; rules: Hex; roundSeconds: number; feeCapBps?: number }): ChainMatch {
    for (const p of [o.a, o.b]) {
      this.free.set(k(p), this.freeOfSync(p) - o.stake);
      this.locked.set(k(p), this.lockedOfSync(p) + o.stake);
    }
    const feeBps = Math.min(this.houseFeeBps, o.feeCapBps ?? 500), now = this.nowS();
    const m: ChainMatch = {
      playerA: o.a, playerB: o.b, feeBps, holderFeeBps: Math.min(this.holderFeeBps, feeBps), roundSeconds: o.roundSeconds, state: 1, lockedAt: now,
      stake: o.stake, settleBy: now + this.settleWindow, rules: o.rules,
    };
    this.matches.set(k(o.matchId), m);
    return m;
  }

  // ---- VaultChain ----

  async info(): Promise<VaultInfo> {
    return {
      token: this.token, tokenSymbol: "tSPIDERTAG", tokenDecimals: 18, referee: this.referee, owner: this.owner, houseFeeBps: this.houseFeeBps,
      holderFeeBps: this.holderFeeBps, maxStake: this.maxStake, maxBalance: this.maxBalance, settleWindow: this.settleWindow, paused: this.paused,
    };
  }
  async freeOf(p: Address) { return this.freeOfSync(p); }
  async sessionOf(p: Address): Promise<ChainSession> {
    return this.sessions.get(k(p)) ?? { key: ZERO, expiry: 0, maxStake: 0n, cap: 0n, used: 0n };
  }
  async matchOf(id: Hex): Promise<ChainMatch> {
    return this.matches.get(k(id)) ?? { playerA: ZERO, playerB: ZERO, feeBps: 0, holderFeeBps: 0, roundSeconds: 0, state: 0, lockedAt: 0, stake: 0n, settleBy: 0, rules: `0x${"00".repeat(32)}` };
  }
  async verifyHash(signer: Address, digest: Hex, sig: Hex): Promise<boolean> {
    await this.prep(digest, sig);
    return this.sigOk(signer, digest, sig);
  }
  private sigOk(signer: Address, digest: Hex, sig: Hex): boolean {
    const w = this.wallets1271.get(k(signer));
    if (w) return w(digest, sig);
    return this.recover(digest, sig) === k(signer);
  }
  private recoverSync = new Map<string, string>();
  private recover(digest: Hex, sig: Hex): string | null {
    return this.recoverSync.get(`${digest}${sig}`) ?? null;
  }
  /** viem's recoverAddress is async: pre-recover every signature a call carries. */
  private async prep(digest: Hex, sig: Hex): Promise<void> {
    try { this.recoverSync.set(`${digest}${sig}`, k(await recoverAddress({ hash: digest, signature: sig }))); } catch { /* not ECDSA */ }
  }
  async simulate(from: Address, call: Call): Promise<string | null> {
    await this.prepCall(call);
    return this.apply(from, call, true);
  }
  /** Run a call for real, as a mined transaction from `from` would (tests submitting on a player's behalf). */
  async exec(from: Address, call: Call): Promise<string | null> {
    await this.prepCall(call);
    return this.apply(from, call, false);
  }
  async settleTxOf(id: Hex): Promise<Hex | null> {
    for (const [h, t] of this.txs) if (t.matchId && k(t.matchId) === k(id) && (t.fn === "settle" || t.fn === "refundExpired") && t.status === "success") return h;
    return null;
  }
  async ethBalance(a: Address) { return this.eth.get(k(a)) ?? 0n; }

  // ---- TxRpc ----

  async nonce(a: Address) { return this.acctNonce.get(k(a)) ?? 0; }
  async fees() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 0n }; }
  async estimateGas(from: Address, call: Call): Promise<bigint> {
    const why = await this.simulate(from, call);
    if (why) throw new Error(why);
    return 100_000n;
  }
  async sendRaw(signed: Hex): Promise<Hex> {
    if (this.failSends > 0) { this.failSends--; throw new Error("rpc: connection reset"); }
    const tx = parseTransaction(signed);
    const from = await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` });
    const want = this.acctNonce.get(k(from)) ?? 0;
    if (tx.nonce !== want) throw new Error(`nonce too ${tx.nonce! < want ? "low" : "high"}: got ${tx.nonce}, want ${want}`);
    this.acctNonce.set(k(from), want + 1);
    const call: Call = { to: tx.to!, data: tx.data ?? "0x", value: tx.value };
    await this.prepCall(call);
    const why = this.apply(from, call, false);
    const hash = keccak256(signed);
    let fn = "transfer", matchId: Hex | null = null;
    try {
      const d = decodeFunctionData({ abi: VAULT_ABI, data: call.data });
      fn = d.functionName;
      const a0 = d.args?.[0] as { matchId?: Hex } | Hex | undefined;
      matchId = typeof a0 === "string" ? a0 : (a0?.matchId ?? null);
    } catch { /* token or value transfer */ }
    this.sent.push(fn);
    this.txs.set(hash, { status: why ? "reverted" : "success", from, fn, matchId });
    return hash;
  }
  async receipt(hash: Hex): Promise<Receipt | null> {
    if (this.holdReceipts) return null;
    const t = this.txs.get(hash);
    return t ? { status: t.status } : null;
  }

  // ---- the vault's rules ----

  private async prepCall(call: Call): Promise<void> {
    if (k(call.to) !== k(this.vault)) return;
    let d: ReturnType<typeof decodeFunctionData<typeof VAULT_ABI>>;
    try { d = decodeFunctionData({ abi: VAULT_ABI, data: call.data }); } catch { return; }
    const a = d.args as unknown as unknown[];
    if (d.functionName === "lock") {
      await this.prep(entryDigest(this.chainId, this.vault, a[0] as Entry), a[1] as Hex);
      await this.prep(entryDigest(this.chainId, this.vault, a[2] as Entry), a[3] as Hex);
    } else if (d.functionName === "settle") {
      await this.prep(resultDigest(this.chainId, this.vault, a[0] as Result), a[1] as Hex);
    } else if (d.functionName === "openSession") {
      await this.prep(sessionAuthDigest(this.chainId, this.vault, a[0] as SessionAuth), a[1] as Hex);
    }
  }

  /** Run a call against the vault's rules; null = success. `dry` = no effects. */
  apply(from: Address, call: Call, dry: boolean): string | null {
    if (k(call.to) === k(this.token)) {
      try {
        const d = decodeFunctionData({ abi: ERC20_ABI, data: call.data });
        if (d.functionName === "transfer" && !dry) this.tokenOut.push({ to: d.args[0] as Address, amount: d.args[1] as bigint });
        return null;
      } catch { return "token call"; }
    }
    if (k(call.to) !== k(this.vault)) {
      if (!dry) this.eth.set(k(call.to), (this.eth.get(k(call.to)) ?? 0n) + (call.value ?? 0n));
      return null;
    }
    let d: ReturnType<typeof decodeFunctionData<typeof VAULT_ABI>>;
    try { d = decodeFunctionData({ abi: VAULT_ABI, data: call.data }); } catch { return "unknown function"; }
    const now = this.nowS(), a = d.args as unknown as unknown[];
    if (d.functionName === "openSession") {
      if (this.paused) return "EnforcedPause()";
      const auth = a[0] as SessionAuth, sig = a[1] as Hex;
      if (!this.sigOk(auth.player, sessionAuthDigest(this.chainId, this.vault, auth), sig)) return "BadSignature";
      if (Number(auth.nonce) !== (this.sessionNonces.get(k(auth.player)) ?? 0)) return "BadNonce";
      if (auth.maxStake === 0n || auth.maxStake > auth.cap || Number(auth.expiry) <= now || Number(auth.expiry) > now + 30 * 86_400 || auth.sessionKey === ZERO) return "BadSession()";
      if (!dry) this.setSession(auth.player, auth.sessionKey, auth.maxStake, auth.cap, Number(auth.expiry));
      return null;
    }
    if (d.functionName === "lock") {
      if (this.paused) return "EnforcedPause()";
      const ea = a[0] as Entry, sa = a[1] as Hex, eb = a[2] as Entry, sb = a[3] as Hex;
      if (k(ea.matchId) !== k(eb.matchId) || (this.matches.get(k(ea.matchId))?.state ?? 0) !== 0) return "MatchExists";
      if (ea.player === ZERO || eb.player === ZERO || k(ea.player) === k(eb.player)) return "EntryMismatch()";
      if ((ea.opponent !== ZERO && k(ea.opponent) !== k(eb.player)) || (eb.opponent !== ZERO && k(eb.opponent) !== k(ea.player))) return "EntryMismatch()";
      if (ea.stake !== eb.stake || ea.stake === 0n) return "EntryMismatch()";
      if (ea.stake > this.maxStake) return "StakeOutOfRange";
      if (ea.roundSeconds !== eb.roundSeconds || k(ea.rules) !== k(eb.rules)) return "EntryMismatch()";
      if (Number(ea.deadline) < now || Number(eb.deadline) < now) return "EntryExpired";
      const uses: [string, bigint][] = [];
      for (const [e, s] of [[ea, sa], [eb, sb]] as const) {
        const digest = entryDigest(this.chainId, this.vault, e);
        const signer = this.recover(digest, s);
        const ses = this.sessions.get(k(e.player));
        if (signer && ses && k(ses.key) === signer) {
          if (ses.expiry <= now || e.stake > ses.maxStake || ses.used + e.stake > ses.cap) return `SessionLimit(${e.player})`;
          uses.push([k(e.player), e.stake]);
        } else if (!this.sigOk(e.player, digest, s)) return `BadSignature(${e.player})`;
      }
      for (const e of [ea, eb]) if (this.freeOfSync(e.player) < e.stake) return `InsufficientFree(${e.player})`;
      if (dry) return null;
      for (const [p, st] of uses) this.sessions.get(p)!.used += st;
      this.forceLock({ matchId: ea.matchId, a: ea.player, b: eb.player, stake: ea.stake, rules: ea.rules, roundSeconds: ea.roundSeconds, feeCapBps: Math.min(ea.feeCapBps, eb.feeCapBps) });
      return null;
    }
    if (d.functionName === "settle") {
      const r = a[0] as Result, sig = a[1] as Hex;
      const m = this.matches.get(k(r.matchId));
      if (!m || m.state !== 1) return `NotLocked(${r.matchId})`;
      if (now > m.settleBy) return "SettleWindowClosed";
      if (this.recover(resultDigest(this.chainId, this.vault, r), sig) !== k(this.referee)) return `BadSignature(${this.referee})`;
      if (r.outcome === 1) {
        const w = k(r.winner);
        if ((w !== k(m.playerA) && w !== k(m.playerB)) || (r.feeBps !== m.feeBps && r.feeBps !== m.holderFeeBps)) return "BadResult()";
        if (dry) return null;
        const pot = 2n * m.stake, fee = (pot * BigInt(r.feeBps)) / 10_000n;
        for (const p of [m.playerA, m.playerB]) this.locked.set(k(p), this.lockedOfSync(p) - m.stake);
        this.free.set(w, (this.free.get(w) ?? 0n) + pot - fee);
        this.houseAccrued += fee;
        m.state = 2;
        return null;
      }
      if (r.outcome === 2) {
        if (r.winner !== ZERO || r.feeBps !== 0) return "BadResult()";
        if (dry) return null;
        for (const p of [m.playerA, m.playerB]) { this.locked.set(k(p), this.lockedOfSync(p) - m.stake); this.deposit(p, m.stake); }
        m.state = 3;
        return null;
      }
      return "BadResult()";
    }
    if (d.functionName === "refundExpired") {
      const m = this.matches.get(k(a[0] as Hex));
      if (!m || m.state !== 1) return "NotLocked";
      if (now <= m.settleBy) return "SettleWindowOpen";
      if (dry) return null;
      for (const p of [m.playerA, m.playerB]) { this.locked.set(k(p), this.lockedOfSync(p) - m.stake); this.deposit(p, m.stake); }
      m.state = 3;
      return null;
    }
    return `unsupported ${d.functionName}`;
  }
}

// ---- a room on the fakes -----------------------------------------------------------------------------------------------

import { hashTypedData, type LocalAccount } from "viem";
import { MSG_PROBE, MSG_PROBE_ECHO, WAGER_PROTOCOL, decodeProbe, encodeProbe, type PlayerCard, type RoomClientMsg, type RoomServerMsg } from "../src/wager/protocol.ts";
import { NET_VERSION, type Compat } from "../src/net/wire.ts";
import { loginTypedData, random32 } from "../src/wager/eip712.ts";
import { nodeSql } from "../relay/wager/src/node.ts";
import { fsLevels } from "../relay/wager/src/fsLevels.ts";
import { Sims, type DistrictSim } from "../relay/wager/src/sims.ts";
import { MockRadbroSource, RadbroReader, type RadbroSource } from "../relay/wager/src/radbro.ts";
import { WagerRoomCore, type LobbyLink, type SeriesUpdate, type SettleRequest } from "../relay/wager/src/room.ts";
import { parseSettings, type Vars, type WagerSettings } from "../relay/wager/src/settings.ts";
import { vaultCall } from "../relay/wager/src/chain.ts";
import type { RoundReferee } from "../relay/wager/src/referee.ts";
import type { RoundResult } from "../src/wager/log.ts";

/** One Sims per test process (the level files are read once). */
export const SIMS = new Sims(fsLevels, ["downtown", "docks"]);

export const card = (p: Address): PlayerCard =>
  ({ address: p, name: `${p.slice(0, 6)}…${p.slice(-4)}`, rating: 1200, wins: 0, losses: 0, forfeits: 0, voids: 0, held: 0, firstSeen: 0, holder: false, radbros: [], cosmetic: null });

export class FailingRadbro implements RadbroSource {
  calls = 0;
  async balance(): Promise<{ v2: bigint; v1: bigint }> { this.calls++; throw new Error("429"); }
  async tokensOfOwner(): Promise<number[]> { throw new Error("429"); }
  async ownerOf(): Promise<Address | null> { throw new Error("429"); }
}

export type RoomHarness = Awaited<ReturnType<typeof roomHarness>>;

export async function roomHarness(o: {
  vars?: Vars; judge?: (r: RoundReferee) => RoundResult; radbro?: RadbroSource | ((a: Address, b: Address) => RadbroSource); roundSeconds?: number;
  stake?: bigint; district?: string;
  /** A fixed relay secret (a deterministic series; the tests' players pick fixed shares too). */
  secret?: Hex;
} = {}) {
  const clock = new FakeClock();
  const fv = new FakeVault(() => Math.floor(clock.now() / 1000));
  const referee = newAccount();
  fv.referee = referee.address;
  const settings: WagerSettings = parseSettings({ DEV: "1", WAGER_NET: "local", ROUND_SECONDS: "20,60,90,120", DISTRICTS: "downtown,docks", ...o.vars }, { vault: fv.vault, token: fv.token });
  const a = newAccount(), b = newAccount();
  const stake = o.stake ?? 10n ** 20n;
  fv.deposit(a.address, 10n * stake);
  fv.deposit(b.address, 10n * stake);
  const sim = (await SIMS.district(o.district ?? "downtown"))!;
  const matchId = random32();
  const m = fv.forceLock({ matchId, a: a.address, b: b.address, stake, rules: sim.rulesHash, roundSeconds: o.roundSeconds ?? 20 });
  const calls = { updates: [] as SeriesUpdate[], settles: [] as SettleRequest[], settleErrors: [] as string[] };
  const relayerAddr = newAccount().address;
  let room: WagerRoomCore | null = null;
  const lobby: LobbyLink = {
    card: async p => card(p),
    update: async u => { calls.updates.push(u); },
    settle: async s => {
      calls.settles.push(s);
      const why = await fv.exec(relayerAddr, vaultCall(fv.vault, "settle", [s.settlement.result, s.settlement.sig]));
      if (why) calls.settleErrors.push(why);
      else room!.settled({ tx: `0x${"ab".repeat(32)}`, state: s.settlement.result.outcome === 1 ? "settled" : "voided" });
    },
  };
  const src = typeof o.radbro === "function" ? o.radbro(a.address, b.address) : (o.radbro ?? new MockRadbroSource(new Map()));
  const radbro = new RadbroReader({ src, now: () => clock.now(), cacheMs: 600_000 });
  const mk = () => new WagerRoomCore({
    matchId, clock, sql, settings, chain: fv, sims: SIMS, radbro, referee, lobby, build: "test", judge: o.judge, ...(o.secret ? { random32: () => o.secret! } : {}),
  });
  const sql = nodeSql();
  room = mk();
  await room.init({ match: m, lockTx: null, cards: [card(a.address), card(b.address)] });
  const h = {
    clock, fv, a, b, matchId, sim, settings, calls, referee, stake,
    get room() { return room!; },
    /** A new instance over the same storage (a Durable Object restart). */
    restart() { room = mk(); return room; },
    client: (leg = 10) => new RoomClient(room!, clock, sim, matchId, fv, leg),
  };
  return h;
}

/** A scripted room socket. PROBEs are echoed (after the leg delay each way) unless echo is off. */
export class RoomClient {
  readonly json: RoomServerMsg[] = [];
  readonly bin: Uint8Array[] = [];
  closed: string | null = null;
  echo = true;
  onJson: ((m: RoomServerMsg) => void) | null = null;
  onBinary: ((b: Uint8Array) => void) | null = null;
  readonly h: ReturnType<WagerRoomCore["open"]>;
  readonly clock: FakeClock;
  readonly sim: DistrictSim;
  readonly matchId: Hex;
  readonly fv: FakeVault;
  leg: number;
  /** Stop delivering (a dead connection that has not closed yet). */
  mute = false;

  constructor(room: WagerRoomCore, clock: FakeClock, sim: DistrictSim, matchId: Hex, fv: FakeVault, leg: number) {
    this.clock = clock;
    this.sim = sim;
    this.matchId = matchId;
    this.fv = fv;
    this.leg = leg;
    this.h = room.open({
      send: d => this.later(() => this.deliver(d)),
      // A close from the relay arrives after what it sent before it.
      close: (_c, r) => this.later(() => { if (!this.closed) { this.closed = r ?? "closed"; this.h.close(); } }),
    }, "http://relay.test");
  }

  private later(fn: () => void): void {
    if (this.leg > 0) this.clock.setTimeout(fn, this.leg); else fn();
  }

  private deliver(d: string | Uint8Array): void {
    if (this.closed || this.mute) return;
    if (typeof d === "string") {
      const m = JSON.parse(d) as RoomServerMsg;
      this.json.push(m);
      this.onJson?.(m);
      return;
    }
    this.bin.push(d);
    if (d[0] === MSG_PROBE && this.echo) { const p = decodeProbe(d)!; this.sendBin(encodeProbe(MSG_PROBE_ECHO, p.id)); return; }
    this.onBinary?.(d);
  }

  sendJson(m: RoomClientMsg | Record<string, unknown>): void {
    const s = JSON.stringify(m);
    this.later(() => { if (!this.closed) this.h.message(s); });
  }
  sendBin(b: Uint8Array): void {
    this.later(() => { if (!this.closed) this.h.message(b); });
  }
  close(): void {
    if (this.closed) return;
    this.closed = "client";
    this.h.close();
  }

  last<T extends RoomServerMsg["t"]>(t: T): Extract<RoomServerMsg, { t: T }> | undefined {
    return [...this.json].reverse().find(m => m.t === t) as Extract<RoomServerMsg, { t: T }> | undefined;
  }
  all<T extends RoomServerMsg["t"]>(t: T): Extract<RoomServerMsg, { t: T }>[] {
    return this.json.filter(m => m.t === t) as Extract<RoomServerMsg, { t: T }>[];
  }

  compat(over: Partial<Compat> = {}): Compat {
    return { v: NET_VERSION, build: "test", link: 0, city: this.sim.compat.city, tuning: this.sim.compat.tuning, ...over };
  }

  /** Wait (ticking the fake clock) until cond holds. */
  async until(cond: () => unknown, maxMs = 5_000, step = 5): Promise<void> {
    for (let t = 0, i = 0; t <= maxMs; t += step, i++) {
      if (cond()) return;
      this.clock.tick(step);
      await flush(4);
      if (i % 25 === 0) await sleep(1);
    }
    if (!cond()) throw new Error(`timed out; last messages ${JSON.stringify(this.json.slice(-3).map(m => m.t))}`);
  }

  async hello(over: Partial<{ v: number; matchId: Hex; compat: Compat }> = {}): Promise<void> {
    this.sendJson({ t: "hello", v: WAGER_PROTOCOL, matchId: this.matchId, compat: this.compat(), ...over });
    await this.until(() => this.last("challenge") || this.last("error") || this.closed);
  }

  /** Sign the Login for the last challenge (as `signer`, claiming `player`). */
  async loginMsg(player: Address, signer: LocalAccount, by: "session" | "wallet" = "wallet", ch = this.last("challenge")!) {
    const sig = await signer.signTypedData(loginTypedData(this.fv.chainId, this.fv.vault, { player, challenge: ch.challenge, expiry: BigInt(ch.expiry), relay: ch.relay }));
    return { t: "login" as const, player, expiry: ch.expiry, sig, by };
  }

  async login(acct: LocalAccount, by: "session" | "wallet" = "wallet", signer: LocalAccount = acct): Promise<void> {
    await this.hello();
    if (!this.last("challenge")) return;
    this.sendJson(await this.loginMsg(acct.address, signer, by));
    await this.until(() => this.last("series") || this.last("error") || this.closed);
  }
}

export const digestOf = hashTypedData;

// ---- a human-like input proxy ------------------------------------------------------------------------------------

import { mulberry32 } from "../src/sim/math.ts";

/**
 * Bot input made human-like, for calibrating the flags (docs/WAGER.md §6.2) until real human sessions are recorded:
 * every word comes `delay` steps late (a reaction time: presses included) and the aim wobbles smoothly (an AR(1) yaw
 * error of about `wobble` units, 1/1024 turn), as a hand on a mouse or stick does.
 */
export class Humanize {
  private readonly q: number[] = [];
  private e = 0;
  private readonly r: () => number;
  readonly delay: number;
  readonly wobble: number;
  constructor(seed: number, delay = 24, wobble = 8) {
    this.r = mulberry32(seed);
    this.delay = delay;
    this.wobble = wobble;
  }
  word(w: number): number {
    this.q.push(w);
    const out = this.q.length > this.delay ? this.q.shift()! : 0;
    this.e = 0.97 * this.e + (this.r() - 0.5) * this.wobble * 0.84;
    const lo = out % 4294967296, hi = out - lo;
    const yaw = ((lo & 0x3ff) + Math.round(this.e) + 4096) & 0x3ff;
    return hi + ((lo - (lo & 0x3ff)) + yaw);
  }
}
