// SPIDER-TAG wager client: the session key (docs/WAGER.md §1 step 2, §3.4). The page makes a key in the browser, the
// wallet signs one SessionAuth for it (the largest stake per match, a total cap, an expiry), and from then on the key
// signs match Entries and relay logins with no wallet popup. It can never withdraw or send funds anywhere. The key
// lives in this browser's local storage, one per (chain, vault, player); losing it just means authorising a new one.
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { MAX_SESSION_TTL_S, ZERO_ADDRESS, type SessionAuth } from "./eip712.ts";
import { sameAddress } from "./units.ts";

/** Client defaults: cap = 10 x the largest stake, 3 days. */
export const SESSION_DEFAULTS = { capTimes: 10n, ttlS: 3 * 86_400 } as const;

/** vault.sessionOf(player). */
export type OnchainSession = { key: Address; expiry: bigint; maxStake: bigint; cap: bigint; used: bigint };

/** Where the page keeps keys (local storage in the browser, a Map in tests). Every access may throw (private mode). */
export type KeyStore = { get(k: string): string | null; set(k: string, v: string): void; del(k: string): void };

export const browserStore: KeyStore = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: the key lives for this page only */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export const memoryStore = (): KeyStore => {
  const m = new Map<string, string>();
  return { get: k => m.get(k) ?? null, set: (k, v) => void m.set(k, v), del: k => void m.delete(k) };
};

const storeKey = (chainId: number, vault: Address, player: Address) => `radrun.wager.key.${chainId}.${vault.toLowerCase()}.${player.toLowerCase()}`;

/** This browser's session key for the player on this vault, if it has one. */
export function loadSessionKey(store: KeyStore, chainId: number, vault: Address, player: Address): PrivateKeyAccount | null {
  const raw = store.get(storeKey(chainId, vault, player));
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { key?: Hex };
    return j.key && /^0x[0-9a-fA-F]{64}$/.test(j.key) ? privateKeyToAccount(j.key) : null;
  } catch {
    return null;
  }
}

/**
 * A fresh session key. It is kept only once `save()` is called (after the wallet signed its SessionAuth), so a
 * cancelled authorisation never replaces a key that still works.
 */
export function newSessionKey(store: KeyStore, chainId: number, vault: Address, player: Address): { account: PrivateKeyAccount; save(): void } {
  const key = generatePrivateKey();
  return { account: privateKeyToAccount(key), save: () => store.set(storeKey(chainId, vault, player), JSON.stringify({ v: 1, key, at: Date.now() })) };
}

export function dropSessionKey(store: KeyStore, chainId: number, vault: Address, player: Address): void {
  store.del(storeKey(chainId, vault, player));
}

export type SessionTerms = { maxStake: bigint; cap: bigint; expiry: bigint };

/**
 * The limits the page proposes: the stake the player picked (at most the vault's maxStake), 10 x that in total, three
 * days (never past the vault's 30-day limit).
 */
export function sessionTerms(pick: bigint, vaultMaxStake: bigint, nowS: number, o: { capTimes?: bigint; ttlS?: number } = {}): SessionTerms {
  const maxStake = pick < vaultMaxStake ? pick : vaultMaxStake;
  if (maxStake <= 0n) throw new Error("pick a stake above zero");
  const ttl = Math.min(o.ttlS ?? SESSION_DEFAULTS.ttlS, MAX_SESSION_TTL_S - 120);
  return { maxStake, cap: maxStake * (o.capTimes ?? SESSION_DEFAULTS.capTimes), expiry: BigInt(Math.floor(nowS) + ttl) };
}

export const sessionAuth = (player: Address, sessionKey: Address, t: SessionTerms, nonce: bigint): SessionAuth =>
  ({ player, sessionKey, maxStake: t.maxStake, cap: t.cap, expiry: t.expiry, nonce });

export type SessionWhy = "none" | "other-key" | "expired" | "max-stake" | "cap";
export type SessionCheck = { ok: true } | { ok: false; why: SessionWhy; text: string };

/**
 * Whether this browser's key can sign an Entry for `stake` now (the vault's lock checks the same: the key registered,
 * unexpired at the lock, stake <= maxStake, used + stake <= cap). `marginS` keeps a lock that lands a little later valid.
 */
export function checkSession(on: OnchainSession | null, local: Address | null, stake: bigint, nowS: number, marginS = 120): SessionCheck {
  if (!on || sameAddress(on.key, ZERO_ADDRESS)) return { ok: false, why: "none", text: "no session key yet: authorise one to play without popups" };
  if (!local || !sameAddress(on.key, local)) return { ok: false, why: "other-key", text: "this browser doesn't hold your session key (another device, or cleared storage): authorise a new one" };
  if (on.expiry <= BigInt(Math.floor(nowS) + marginS)) return { ok: false, why: "expired", text: "your session key has expired: authorise a new one" };
  if (stake > on.maxStake) return { ok: false, why: "max-stake", text: "that stake is above your session key's limit per match" };
  if (on.used + stake > on.cap) return { ok: false, why: "cap", text: "your session key has used up its total: authorise a new one" };
  return { ok: true };
}

/** A session registered for this browser's key and not expired (it can sign relay logins). */
export const liveSession = (on: OnchainSession | null, local: Address | null, nowS: number): boolean =>
  !!on && !!local && sameAddress(on.key, local) && !sameAddress(on.key, ZERO_ADDRESS) && on.expiry > BigInt(Math.floor(nowS) + 30);
