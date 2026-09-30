// SPIDER-TAG wager client: the page's state and actions (docs/WAGER.md §7), outside React so tests drive it with a
// fake chain and relay. One store: the deployment and relay config, the wallet, balances, the session key, the lobby
// socket's offers and player card, the transactions in flight, and the match being paired. Every action says what
// went wrong in one plain sentence (errors.ts) and never leaves a button stuck.
import { create } from "zustand";
import { getAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Deployment } from "./config.ts";
import {
  entryFromJson, entryToJson, entryTypedData, makeRules, newMatchId, resultTypedData, rulesHash, sessionAuthToJson, sessionAuthTypedData, ZERO_ADDRESS,
  type Entry, type Result, type SimCompat,
} from "./eip712.ts";
import { WAGER_TIMING, type Cosmetic, type LobbyServerMsg, type Offer, type PlayerCard, type RelayConfig, type SignedEntry } from "./protocol.ts";
import { VaultChain, publicClientFor, walletClientFor, type Balances, type VaultInfo } from "./chain.ts";
import { LobbyClient, relayApi, type LobbyState, type LoginSigner, type RelayApi, type WsFactory } from "./relay.ts";
import { browserStore, checkSession, liveSession, loadSessionKey, newSessionKey, sessionAuth, sessionTerms, type KeyStore, type OnchainSession } from "./sessionKey.ts";
import { classifyError, wagerError, type WagerError } from "./errors.ts";
import { connectWallet, ensureChain, sharedAccount, viemChain, walletChainId, type Eip1193, type WalletOption } from "./wallet.ts";
import { sameSim } from "./assets.ts";
import { sameAddress } from "./units.ts";

export type TxStatus = "wallet" | "sent" | "confirmed" | "failed";
export type TxRow = { id: number; label: string; hash: Hex | null; status: TxStatus; error?: string; at: number };

/** A match being paired: the signed entries once matched, the lock transaction once locked. */
export type Pairing = { matchId: Hex; district: string; a: SignedEntry | null; b: SignedEntry | null; lockTx: Hex | null; since: number; failed: string | null };

export type WagerState = {
  dep: Deployment | null;
  base: string | null;
  off: string | null;
  config: RelayConfig | null;
  info: VaultInfo | null;
  /** Page-level problem (relay down, region, wrong vault...). */
  fatal: WagerError | null;
  /** The last action's problem or news, shown near the action. */
  notice: { kind: "error" | "info" | "ok"; text: string; at: number } | null;
  wallets: WalletOption[];
  wallet: WalletOption | null;
  address: Address | null;
  chainOk: boolean;
  bal: Balances | null;
  session: OnchainSession | null;
  sessionKey: Address | null;
  lobby: LobbyState;
  you: PlayerCard | null;
  offers: Offer[];
  txs: TxRow[];
  pairing: Pairing | null;
  /** This page's sim for its district equals the referee's (null = not known yet). */
  simOk: boolean | null;
  busy: string | null;
};

const initial = (): WagerState => ({
  dep: null, base: null, off: null, config: null, info: null, fatal: null, notice: null, wallets: [], wallet: null, address: null, chainOk: false, bal: null,
  session: null, sessionKey: null, lobby: "off", you: null, offers: [], txs: [], pairing: null, simOk: null, busy: null,
});

export const useWager = create<WagerState>(initial);

export type AppDeps = {
  dep: Deployment;
  base: string;
  rpc: string[];
  /** The page's district and its sim (for rules and the reload check). */
  district: string;
  simFor: (district: string) => Promise<SimCompat>;
  keys?: KeyStore;
  pub?: PublicClient;
  ws?: WsFactory;
  now?: () => number;
  /** Relay-supplied vault only for dev / local deployments (a production page trusts its deployments.json). */
  trustRelayVault?: boolean;
};

let txSeq = 0;

export class WagerApp {
  readonly d: AppDeps;
  readonly api: RelayApi;
  chain: VaultChain | null = null;
  lobby: LobbyClient | null = null;
  private walletClient: WalletClient | null = null;
  private keyAcct: PrivateKeyAccount | null = null;
  private readonly keys: KeyStore;
  private readonly now: () => number;
  /** Chain time - this device's time (s): deadlines and expiries are checked against block time, not this clock. */
  private skew = 0;
  private refreshT: ReturnType<typeof setInterval> | null = null;
  private readonly timers = new Set<ReturnType<typeof setInterval>>();
  /** The wallet's accountsChanged / chainChanged listeners (removed before new ones go on). */
  private listening: { p: Eip1193; onAcc: (accs: string[]) => void; onChain: (id: string) => void } | null = null;
  /** Called when a match of ours locks (the page opens the series). */
  onLocked: ((matchId: Hex, district: string) => void) | null = null;
  /**
   * The Entries this page created (its open offers), by match id: when someone joins one, the lobby asks for a named
   * Entry, and the page signs only these exact terms (never what the relay says they are).
   */
  private readonly created = new Map<string, { e: Entry; district: string }>();

  constructor(d: AppDeps) {
    this.d = d;
    this.api = relayApi(d.base);
    this.keys = d.keys ?? browserStore;
    this.now = d.now ?? (() => Date.now() / 1000 + this.skew);
    useWager.setState({ ...initial(), dep: d.dep, base: d.base });
  }

  private get s() { return useWager.getState(); }
  private set(p: Partial<WagerState>) { useWager.setState(p); }
  note(kind: "error" | "info" | "ok", text: string) { this.set({ notice: { kind, text, at: Date.now() } }); }
  fail(e: unknown): WagerError {
    const w = classifyError(e);
    this.note("error", w.message);
    return w;
  }

  // ---- start: the relay's config, the vault on chain, the lobby (browsing works without a wallet) --------------------

  /**
   * The relay's config, the vault on chain, the lobby (browsing works without a wallet). With the relay down the
   * page still reads the vault it knows (the deployment's, or on dev / local deployments the one the relay named
   * last time), so a player can always withdraw and refund an expired match: neither needs the relay.
   */
  async start(): Promise<void> {
    let config: RelayConfig | null = null;
    try {
      config = await this.api.config();
    } catch (e) {
      this.set({ fatal: classifyError(e) });
    }
    const d = this.d.dep;
    if (config && config.chainId !== d.chainId) { this.set({ fatal: wagerError("relay", "the relay serves another network than this page: reload") }); return; }
    const cacheKey = `radrun.wager.vault.${d.net}.${d.chainId}`;
    const vault = d.vault ?? (this.d.trustRelayVault ? (config?.vault ?? this.keys.get(cacheKey)) : null);
    if (!vault) { if (config) this.set({ fatal: wagerError("relay", "this network's vault isn't deployed yet") }); return; }
    if (config && !sameAddress(vault, config.vault)) { this.set({ fatal: wagerError("relay", "the relay and this page disagree about the vault: reload") }); return; }
    if (config && this.d.trustRelayVault) this.keys.set(cacheKey, config.vault);
    if (config?.regionBlocked) this.set({ fatal: wagerError("region", "wager matches aren't available in your region. Your vault balance can always be withdrawn straight from the contract.") });
    const pub = this.d.pub ?? publicClientFor(viemChain(d, this.d.rpc), this.d.rpc);
    this.chain = new VaultChain(pub, getAddress(vault), d.deployBlock);
    this.set({ config });
    try {
      const [info] = await Promise.all([this.chain.info(), this.syncClock()]);
      if (d.token && !sameAddress(d.token, info.token)) { this.set({ fatal: wagerError("relay", "the vault's token isn't this page's token: reload") }); return; }
      this.set({ info });
    } catch (e) {
      this.set({ fatal: wagerError("network", `can't read the vault on ${d.chainName}: ${classifyError(e).message}`) });
      return;
    }
    this.refreshT = setInterval(() => void this.refresh(), 12_000);
    if (!config) {
      this.set({ fatal: wagerError("relay", "can't reach the wager relay right now: matches are off, but you can still withdraw, and refund a match whose settle window has closed") });
      return;
    }
    const mine = config.sims[this.d.district];
    if (mine) this.d.simFor(this.d.district).then(sim => this.set({ simOk: sameSim(sim, mine) }), () => this.set({ simOk: false }));
    if (!config.regionBlocked) this.openLobby();
  }

  stop(): void {
    this.unlisten();
    this.lobby?.close();
    this.lobby = null;
    if (this.refreshT) clearInterval(this.refreshT);
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
  }

  // ---- wallet -----------------------------------------------------------------------------------------------------

  setWallets(list: WalletOption[]): void {
    this.set({ wallets: list });
    // Reconnect quietly to a wallet that already shares an account with this page (no popup).
    const last = (() => { try { return localStorage.getItem("radrun.wager.wallet"); } catch { return null; } })();
    if (!this.s.wallet && last) {
      const w = list.find(x => x.info.uuid === last || x.info.rdns === last);
      if (w) void sharedAccount(w.provider).then(a => { if (a && !this.s.wallet) void this.useWallet(w, a); });
    }
  }

  /** Connect a wallet (a popup the first time), then the chain, balances, session, lobby login. */
  async connect(w: WalletOption): Promise<void> {
    this.set({ busy: "connecting your wallet…" });
    try {
      const a = await connectWallet(w.provider);
      await this.useWallet(w, a);
      try { localStorage.setItem("radrun.wager.wallet", w.info.rdns || w.info.uuid); } catch { /* private mode */ }
    } catch (e) {
      this.fail(e);
    } finally {
      this.set({ busy: null });
    }
  }

  private async useWallet(w: WalletOption, address: Address): Promise<void> {
    const d = this.d.dep;
    this.walletClient = walletClientFor(viemChain(d, this.d.rpc), w.provider, address);
    this.set({ wallet: w, address, chainOk: (await walletChainId(w.provider).catch(() => 0)) === d.chainId });
    // One pair of listeners at a time: an account switch calls this again, and a stale pair would switch twice.
    this.unlisten();
    const onAcc = (accs: string[]) => { const a = accs?.[0]; if (!a) this.disconnect(); else if (!sameAddress(a, this.s.address)) void this.useWallet(w, getAddress(a)); };
    const onChain = (id: string) => this.set({ chainOk: Number.parseInt(id, 16) === d.chainId });
    w.provider.on?.("accountsChanged", onAcc as never);
    w.provider.on?.("chainChanged", onChain as never);
    this.listening = { p: w.provider, onAcc, onChain };
    this.keyAcct = this.chain ? loadSessionKey(this.keys, d.chainId, this.chain.vault, address) : null;
    this.set({ sessionKey: this.keyAcct?.address ?? null });
    await this.refresh();
    this.lobby?.relogin(this.signer());
  }

  private unlisten(): void {
    const l = this.listening;
    this.listening = null;
    if (!l) return;
    l.p.removeListener?.("accountsChanged", l.onAcc as never);
    l.p.removeListener?.("chainChanged", l.onChain as never);
  }

  disconnect(): void {
    this.unlisten();
    this.walletClient = null;
    this.keyAcct = null;
    this.set({ wallet: null, address: null, bal: null, session: null, sessionKey: null, you: null, chainOk: false });
    try { localStorage.removeItem("radrun.wager.wallet"); } catch { /* private mode */ }
    this.lobby?.relogin(null);
  }

  /** Put the wallet on this deployment's chain (switch, or add it). */
  async switchChain(): Promise<boolean> {
    const w = this.s.wallet;
    if (!w) { this.note("error", "connect a wallet first"); return false; }
    try {
      await ensureChain(w.provider, { ...this.d.dep, rpc: this.d.rpc.filter(u => /^https:|^http:\/\/(127\.0\.0\.1|localhost)/.test(u)) });
      this.set({ chainOk: true });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  private async needWallet(): Promise<WalletClient> {
    if (!this.walletClient || !this.s.address) throw wagerError("no-wallet", "connect a wallet first");
    if (!this.s.chainOk && !(await this.switchChain())) throw wagerError("wrong-chain", `switch your wallet to ${this.d.dep.chainName} first`);
    return this.walletClient;
  }

  /** Track the chain's clock (a device clock that is off must never make Entries that expire before the lock). */
  private async syncClock(): Promise<void> {
    if (!this.chain || this.d.now) return;
    try { this.skew = (await this.chain.chainNow()) - Date.now() / 1000; } catch { /* keep the last */ }
  }

  /** Balances and the session key, re-read from the chain. */
  async refresh(): Promise<void> {
    void this.syncClock();
    const a = this.s.address, c = this.chain;
    if (!a || !c) return;
    try {
      const [bal, session] = await Promise.all([c.balances(a), c.session(a)]);
      if (sameAddress(a, this.s.address)) this.set({ bal, session });
    } catch { /* keep the last reading; the next refresh tries again */ }
  }

  // ---- the lobby ----------------------------------------------------------------------------------------------------

  /** Logins: the session key when it is registered and live (no popup), else the wallet. */
  signer(): LoginSigner | null {
    const a = this.s.address;
    if (!a) return null;
    return {
      player: a,
      by: () => (this.keyAcct && liveSession(this.s.session, this.keyAcct.address, this.now()) ? "session" : "wallet"),
      signTyped: async td => {
        if (this.keyAcct && liveSession(this.s.session, this.keyAcct.address, this.now())) return this.keyAcct.signTypedData(td);
        const w = await this.needWallet();
        return w.signTypedData({ ...td, account: a } as never);
      },
    };
  }

  private openLobby(): void {
    const c = this.s.config!;
    this.lobby = new LobbyClient(this.d.base, this.d.dep.net, c.chainId, this.chain!.vault, this.signer(), {
      state: st => this.set({ lobby: st }),
      msg: m => this.onLobby(m),
      error: e => this.note("error", e.message),
    }, this.d.ws);
    this.lobby.connect();
  }

  private onLobby(m: LobbyServerMsg): void {
    const s = this.s;
    switch (m.t) {
      case "welcome": this.set({ you: m.you, config: m.config }); return;
      case "offers": this.set({ offers: m.offers }); return;
      case "offer": this.set({ offers: [...s.offers.filter(o => o.matchId !== m.offer.matchId), m.offer] }); return;
      case "unoffer": {
        this.set({ offers: s.offers.filter(o => o.matchId !== m.matchId) });
        const mine = s.offers.find(o => o.matchId === m.matchId && sameAddress(o.creator.address, s.address));
        if (mine && m.reason !== "matched") this.note("info", m.reason === "expired" ? "your offer expired" : m.reason === "creator-left" ? "your offer was withdrawn when you left the lobby" : "offer cancelled");
        return;
      }
      case "sign": void this.signNamed(m); return;
      case "matched": {
        const district = s.offers.find(o => o.matchId === m.matchId)?.district ?? s.pairing?.district ?? this.d.district;
        this.set({ pairing: { matchId: m.matchId, district, a: m.a, b: m.b, lockTx: null, since: Date.now(), failed: null } });
        this.note("info", "matched: locking both stakes…");
        return;
      }
      case "locked": {
        const p = s.pairing?.matchId === m.matchId ? s.pairing : { matchId: m.matchId, district: this.d.district, a: null, b: null, lockTx: null, since: Date.now(), failed: null };
        this.set({ pairing: { ...p, lockTx: m.tx } });
        void this.refresh();
        this.onLocked?.(m.matchId, p.district);
        return;
      }
      case "tx": {
        if (m.status === "failed") {
          this.note("error", `the relayer's ${m.kind} transaction failed${m.error ? `: ${m.error}` : ""}${m.kind === "lock" || m.kind === "settle" ? " (you can submit it yourself)" : ""}`);
          if (m.kind === "lock" && s.pairing?.matchId === m.matchId) this.set({ pairing: { ...s.pairing, failed: m.error ?? "failed" } });
        }
        if (m.status === "confirmed") {
          if (m.kind === "session") { this.note("ok", "session key on: no more wallet popups for matches"); this.lobby?.relogin(this.signer()); }
          if (m.kind === "faucet") this.note("ok", "test tokens sent to your wallet");
          void this.refresh();
        }
        return;
      }
      case "card": if (sameAddress(m.card.address, s.address)) this.set({ you: m.card }); return;
      case "error":
        if (m.code === "region") this.set({ fatal: wagerError("region", "wager matches aren't available in your region. Your vault balance can always be withdrawn straight from the contract.") });
        else if (m.code === "version") this.set({ fatal: wagerError("version", "this page is out of date: reload to update") });
        else {
          // A pairing that fell through before anything was signed on both sides: nothing to wait for any more.
          if (m.code === "gone" && s.pairing && !s.pairing.a && !s.pairing.lockTx) this.set({ pairing: null });
          this.note("error", m.message);
        }
        return;
      default: return;
    }
  }

  /**
   * Someone joined one of this page's open offers: the lobby asks for a named Entry for them (docs/WAGER.md §4.3). The
   * page signs its own offer's exact terms naming that player, with a deadline a few minutes away, and nothing else.
   * The lobby never hands out the open Entry's signature, so this named one is what locks.
   */
  private async signNamed(m: Extract<LobbyServerMsg, { t: "sign" }>): Promise<void> {
    const mine = this.created.get(m.matchId.toLowerCase());
    const refuse = (why: string) => { this.lobby?.signed(m.matchId, null, why); };
    let e: Entry;
    try { e = entryFromJson(m.entry); } catch { refuse("bad entry"); return; }
    if (!mine) { refuse("this page has no such offer"); return; }
    const o = mine.e, a = o.player, nowS = this.now();
    const same = e.matchId.toLowerCase() === o.matchId.toLowerCase() && sameAddress(e.player, a) && sameAddress(o.player, a) && sameAddress(o.opponent, ZERO_ADDRESS)
      && e.stake === o.stake && e.feeCapBps === o.feeCapBps && e.roundSeconds === o.roundSeconds && e.rules === o.rules;
    const who = sameAddress(e.opponent, m.joiner.address) && !sameAddress(e.opponent, ZERO_ADDRESS) && !sameAddress(e.opponent, a);
    const soon = Number(e.deadline) <= Math.min(Number(o.deadline), nowS + WAGER_TIMING.namedTtlS + 120) && Number(e.deadline) > nowS + 20;
    if (!same || !who || !soon) { refuse("those aren't this offer's terms"); return; }
    try {
      const sig = await this.signEntry(e);
      if (!this.lobby?.signed(m.matchId, sig)) throw wagerError("relay", "the lobby connection dropped: the offer is withdrawn");
      this.created.delete(m.matchId.toLowerCase());
      this.set({ pairing: { matchId: m.matchId, district: mine.district, a: null, b: null, lockTx: null, since: Date.now(), failed: null } });
      this.note("info", `${m.joiner.name} joined: locking both stakes…`);
    } catch (err) {
      refuse("the page couldn't sign");
      this.fail(err);
    }
  }

  // ---- funds --------------------------------------------------------------------------------------------------------

  private async tx(label: string, send: () => Promise<Hex>): Promise<Hex> {
    const id = ++txSeq;
    const row: TxRow = { id, label, hash: null, status: "wallet", at: Date.now() };
    const upd = (p: Partial<TxRow>) => this.set({ txs: this.s.txs.map(t => (t.id === id ? { ...t, ...p } : t)) });
    this.set({ txs: [row, ...this.s.txs].slice(0, 8) });
    try {
      const hash = await send();
      upd({ hash, status: "sent" });
      await this.chain!.wait(hash);
      upd({ status: "confirmed" });
      return hash;
    } catch (e) {
      upd({ status: "failed", error: classifyError(e).message });
      throw e;
    }
  }

  /** Approve exactly the amount (when the allowance is short), then deposit it. */
  async deposit(amount: bigint): Promise<boolean> {
    const c = this.chain, info = this.s.info;
    if (!c || !info) return false;
    this.set({ busy: "deposit" });
    try {
      const w = await this.needWallet();
      await this.refresh();
      const bal = this.s.bal!;
      if (amount <= 0n) throw wagerError("funds", "enter an amount above zero");
      if (bal.wallet < amount) throw wagerError("funds", `not enough ${info.symbol} in your wallet${this.d.dep.testnet ? " (the faucet sends test tokens)" : ""}`);
      if (bal.eth === 0n) throw wagerError("gas", `your wallet has no ETH on ${this.d.dep.chainName} for the network fee${this.d.dep.testnet ? " (the faucet sends a little)" : ""}`);
      if (bal.free + bal.locked + amount > info.maxBalance) throw wagerError("funds", "that would take your vault balance past the beta cap");
      if (bal.allowance < amount) await this.tx(`approve ${info.symbol}`, () => c.approve(w, amount));
      await this.tx("deposit", () => c.deposit(w, amount));
      this.note("ok", "deposited");
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    } finally {
      this.set({ busy: null });
      await this.refresh();
    }
  }

  /** Withdraw free balance straight to the wallet (or another address, when the token blocks this one). */
  async withdraw(amount: bigint, to?: Address): Promise<boolean> {
    const c = this.chain;
    if (!c) return false;
    this.set({ busy: "withdraw" });
    try {
      const w = await this.needWallet();
      await this.refresh();
      if (amount <= 0n) throw wagerError("funds", "enter an amount above zero");
      if (amount > this.s.bal!.free) throw wagerError("funds", "that's more than your free balance");
      await this.tx("withdraw", () => (to && !sameAddress(to, this.s.address) ? c.withdrawTo(w, amount, to) : c.withdraw(w, amount)));
      this.note("ok", "withdrawn to your wallet");
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    } finally {
      this.set({ busy: null });
      await this.refresh();
    }
  }

  /** Test networks: tokens and a little ETH from the relay's faucet. */
  async faucet(): Promise<void> {
    const a = this.s.address;
    if (!a) { this.note("error", "connect a wallet first"); return; }
    this.set({ busy: "faucet" });
    try {
      const r = await this.api.faucet(a);
      this.note("ok", "test tokens on the way");
      for (const h of [r.tokenTx, r.ethTx]) if (h) await this.chain!.wait(h).catch(() => undefined);
      await this.refresh();
    } catch (e) {
      this.fail(e);
    } finally {
      this.set({ busy: null });
    }
  }

  // ---- the session key ------------------------------------------------------------------------------------------

  /** One wallet signature authorises a browser key for matches up to `maxStake` (the relayer submits it: no gas). */
  async authorise(maxStake: bigint): Promise<boolean> {
    const c = this.chain, a = this.s.address, config = this.s.config;
    if (!c || !a || !config) return false;
    this.set({ busy: "session" });
    try {
      await this.syncClock();
      const w = await this.needWallet();
      const terms = sessionTerms(maxStake, BigInt(config.maxStake), this.now());
      const nonce = await c.nonce(a);
      const key = newSessionKey(this.keys, this.d.dep.chainId, c.vault, a);
      const auth = sessionAuth(a, key.account.address, terms, nonce);
      const sig = await w.signTypedData({ ...sessionAuthTypedData(this.d.dep.chainId, c.vault, auth), account: a } as never);
      key.save();
      this.keyAcct = key.account;
      this.set({ sessionKey: key.account.address });
      if (!this.lobby?.openSession(sessionAuthToJson(auth), sig)) {
        // No lobby: submit it from the wallet (costs gas).
        await this.tx("session key", () => c.openSession(w, auth, sig));
        await this.refresh();
      } else {
        this.note("info", "session key signed: the relayer is submitting it…");
        this.pollSession(key.account.address);
      }
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    } finally {
      this.set({ busy: null });
    }
  }

  /** The relayer confirms over the lobby socket; poll the chain too, in case that message is missed. */
  private pollSession(key: Address): void {
    let n = 0;
    const iv = setInterval(async () => {
      n++;
      await this.refresh();
      if (sameAddress(this.s.session?.key, key) || n > 30) {
        clearInterval(iv);
        this.timers.delete(iv);
        if (sameAddress(this.s.session?.key, key)) this.lobby?.relogin(this.signer());
      }
    }, 1500);
    this.timers.add(iv);
  }

  async revoke(): Promise<void> {
    const c = this.chain;
    if (!c) return;
    this.set({ busy: "revoke" });
    try {
      const w = await this.needWallet();
      await this.tx("revoke session key", () => c.revokeSession(w));
      this.note("ok", "session key revoked");
      await this.refresh();
    } catch (e) {
      this.fail(e);
    } finally {
      this.set({ busy: null });
    }
  }

  // ---- offers ---------------------------------------------------------------------------------------------------------

  /** Sign an Entry: the session key (no popup) when it covers the stake (read fresh from the vault), else the wallet. */
  private async signEntry(e: Entry): Promise<Hex> {
    const c = this.chain!;
    const td = entryTypedData(this.d.dep.chainId, c.vault, e);
    const on = await c.session(e.player).catch(() => this.s.session);
    const chk = checkSession(on, this.keyAcct?.address ?? null, e.stake, this.now());
    if (chk.ok && this.keyAcct) return this.keyAcct.signTypedData(td);
    const w = await this.needWallet();
    return w.signTypedData({ ...td, account: e.player } as never);
  }

  /** The checks the relay and the vault make, said before anything is signed. */
  stakeProblem(stake: bigint): string | null {
    const { config, bal, you, info } = this.s;
    if (!config || !info) return "not connected to the relay yet";
    if (!this.s.address) return "connect a wallet first";
    if (stake <= 0n) return "pick a stake above zero";
    if (stake > BigInt(config.maxStake)) return "that's above the beta's largest stake";
    const newbie = !you || you.wins + you.losses < config.newAccountSeries;
    if (newbie && stake > BigInt(config.newAccountMaxStake)) return `new accounts can stake at most the new-account limit until ${config.newAccountSeries} series are settled`;
    if (!bal || bal.free < stake) return "not enough free balance in the vault: deposit first";
    return null;
  }

  async create(o: { stake: bigint; roundSeconds: number; district: string; listed: boolean; opponent: Address | null; holdersOnly: boolean; minSeries: number }): Promise<Hex | null> {
    const c = this.chain, a = this.s.address, config = this.s.config;
    if (!c || !a || !config) return null;
    const p = this.stakeProblem(o.stake);
    if (p) { this.note("error", p); return null; }
    if (o.opponent && sameAddress(o.opponent, a)) { this.note("error", "you can't invite yourself"); return null; }
    this.set({ busy: "create" });
    try {
      await this.syncClock();
      const sim = await this.d.simFor(o.district);
      if (!config.sims[o.district]) throw wagerError("version", "wager matches aren't played in this city: pick another one");
      if (!sameSim(sim, config.sims[o.district])) throw wagerError("version", "this page's game differs from the referee's: reload to update");
      const listed = o.listed && !o.opponent;
      const e: Entry = {
        matchId: newMatchId(a), player: a, opponent: o.opponent ?? ZERO_ADDRESS, stake: o.stake, feeCapBps: config.houseFeeBps, roundSeconds: o.roundSeconds,
        rules: rulesHash(makeRules(o.district, sim)), deadline: BigInt(Math.floor(this.now()) + (listed ? WAGER_TIMING.offerTtlS : WAGER_TIMING.inviteTtlS)),
      };
      const sig = await this.signEntry(e);
      if (!this.lobby?.create(entryToJson(e), sig, { listed, holdersOnly: o.holdersOnly, minSeries: o.minSeries })) throw wagerError("relay", "the lobby isn't connected: try again in a moment");
      this.created.set(e.matchId.toLowerCase(), { e, district: o.district });
      this.set({ pairing: null });
      this.note("ok", listed ? "offer listed" : "invite ready: send the link");
      return e.matchId;
    } catch (e) {
      this.fail(e);
      return null;
    } finally {
      this.set({ busy: null });
    }
  }

  cancel(matchId: Hex): void {
    this.created.delete(matchId.toLowerCase());
    if (!this.lobby?.cancel(matchId)) this.note("error", "the lobby isn't connected");
  }

  /**
   * Cancel one of your match ids on chain as well (your wallet pays the gas): no Entry for it can ever lock afterwards,
   * whoever holds a signature for it. The lobby never hands out an open offer's signature, so this is for peace of mind
   * (a wallet-signed Entry, a leaked key).
   */
  async cancelOnChain(matchId: Hex): Promise<Hex | null> {
    const c = this.chain;
    if (!c) return null;
    this.set({ busy: "cancel" });
    try {
      const w = await this.needWallet();
      this.cancel(matchId);
      const h = await this.tx("cancel the match id", () => c.cancel(w, matchId));
      this.note("ok", "cancelled on chain: that match can never lock");
      return h;
    } catch (e) {
      this.fail(e);
      return null;
    } finally {
      this.set({ busy: null });
    }
  }

  /** Why this player can't join the offer (null = can). */
  joinProblem(o: Offer): string | null {
    const s = this.s;
    if (!s.address) return "connect a wallet to join";
    if (sameAddress(o.creator.address, s.address)) return "that's your own offer";
    if (o.opponent && !sameAddress(o.opponent, s.address)) return "this invite is for another player";
    if (o.holdersOnly && !s.you?.holder) return "Radbro holders only";
    if (o.minSeries > 0 && (s.you ? s.you.wins + s.you.losses : 0) < o.minSeries) return `needs ${o.minSeries} settled series`;
    if (o.deadline <= this.now() + 60) return "this offer has expired";
    return this.stakeProblem(BigInt(o.stake));
  }

  async join(o: Offer): Promise<boolean> {
    const c = this.chain, a = this.s.address, config = this.s.config;
    if (!c || !a || !config) return false;
    const p = this.joinProblem(o);
    if (p) { this.note("error", p); return false; }
    this.set({ busy: "join" });
    try {
      await this.syncClock();
      const sim = await this.d.simFor(o.district);
      if (!config.sims[o.district]) throw wagerError("version", "wager matches aren't played in this city: pick another one");
      if (!sameSim(sim, config.sims[o.district])) throw wagerError("version", "this page's game differs from the referee's: reload to update");
      const theirs = entryFromJson(o.entry);
      if (theirs.rules !== rulesHash(makeRules(o.district, sim))) throw wagerError("version", "this match was made on another version of the game");
      if (!sameAddress(theirs.player, o.creator.address) || theirs.matchId !== o.matchId || BigInt(o.stake) !== theirs.stake) throw wagerError("relay", "the offer's terms don't add up");
      const e: Entry = {
        matchId: o.matchId, player: a, opponent: theirs.player, stake: theirs.stake, feeCapBps: config.houseFeeBps, roundSeconds: theirs.roundSeconds,
        rules: theirs.rules, deadline: BigInt(Math.floor(this.now()) + 600),
      };
      const sig = await this.signEntry(e);
      this.set({ pairing: { matchId: o.matchId, district: o.district, a: null, b: null, lockTx: null, since: Date.now(), failed: null } });
      if (!this.lobby?.join(entryToJson(e), sig)) throw wagerError("relay", "the lobby isn't connected: try again in a moment");
      this.note("info", "joining…");
      return true;
    } catch (e) {
      this.set({ pairing: null });
      this.fail(e);
      return false;
    } finally {
      this.set({ busy: null });
    }
  }

  /** The relayer didn't lock: send lock(a, sigA, b, sigB) from the wallet with the two signed entries. */
  async lockYourself(): Promise<void> {
    const p = this.s.pairing, c = this.chain;
    if (!p?.a || !p.b || !c) return;
    this.set({ busy: "lock" });
    try {
      const w = await this.needWallet();
      const tx = await this.tx("lock the match", () => c.lock(w, entryFromJson(p.a!.entry), p.a!.sig, entryFromJson(p.b!.entry), p.b!.sig));
      this.set({ pairing: { ...p, lockTx: tx } });
      this.onLocked?.(p.matchId, p.district);
    } catch (e) {
      this.fail(e);
    } finally {
      this.set({ busy: null });
    }
  }

  /** The referee signed but nobody submitted: settle(result, sig) from the wallet. */
  async settleYourself(r: Result, sig: Hex): Promise<Hex | null> {
    const c = this.chain;
    if (!c) return null;
    try {
      const w = await this.needWallet();
      return await this.tx("settle", () => c.settle(w, r, sig));
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  /** After settleBy, a player takes back their own stake alone (the transaction names nobody else). */
  async reclaim(matchId: Hex): Promise<Hex | null> {
    const c = this.chain;
    if (!c) return null;
    try {
      const w = await this.needWallet();
      const h = await this.tx("take your stake back", () => c.reclaim(w, matchId));
      await this.refresh();
      return h;
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  /**
   * Settle between yourselves (the referee is gone): this wallet signs a Result for the match. The vault takes it only
   * with the other player's wallet signature over the same Result (settleMutual).
   */
  async signResult(r: Result): Promise<Hex | null> {
    try {
      const w = await this.needWallet();
      return await w.signTypedData({ ...resultTypedData(this.d.dep.chainId, this.chain!.vault, r), account: this.s.address! } as never);
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  /** Submit a Result both players' wallets signed (sigA is player A's). */
  async settleMutual(r: Result, sigA: Hex, sigB: Hex): Promise<Hex | null> {
    const c = this.chain;
    if (!c) return null;
    try {
      const w = await this.needWallet();
      const h = await this.tx("settle between you", () => c.settleMutual(w, r, sigA, sigB));
      await this.refresh();
      return h;
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  /** After settleBy, anyone can refund a match that never settled. */
  async refund(matchId: Hex): Promise<Hex | null> {
    const c = this.chain;
    if (!c) return null;
    try {
      const w = await this.needWallet();
      const h = await this.tx("refund", () => c.refundExpired(w, matchId));
      await this.refresh();
      return h;
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  setProfile(p: { name?: string; cosmetic?: Cosmetic | null }): void {
    if (!this.lobby?.profile(p)) this.note("error", "the lobby isn't connected");
  }

  /** The wallet (for owner-only signing on the review page). */
  async walletSigner(): Promise<{ address: Address; sign: (td: object) => Promise<Hex> }> {
    const w = await this.needWallet();
    const address = this.s.address!;
    return { address, sign: td => w.signTypedData({ ...td, account: address } as never) };
  }

  /** The login signer for a series room. */
  roomSigner(): LoginSigner | null {
    return this.signer();
  }

  /** The wallet as an EIP-1193 provider (the dev wallet and tests). */
  get provider(): Eip1193 | null {
    return this.s.wallet?.provider ?? null;
  }
}
