// SPIDER-TAG wager client: browser wallets (docs/WAGER.md §7.2). EIP-6963 discovery of every injected wallet (falling
// back to window.ethereum), connecting, and putting the wallet on the deployment's chain (switch, or add then switch
// on 4902). No WalletConnect in the beta. Pure TS over an EIP-1193 provider; the DOM is only the event target.
import { defineChain, getAddress, toHex, type Address, type Chain } from "viem";
import type { Deployment } from "./config.ts";
import { isUnknownChain, wagerError } from "./errors.ts";

export type Eip1193 = {
  request(a: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, fn: (...a: never[]) => void): void;
  removeListener?(event: string, fn: (...a: never[]) => void): void;
};
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type WalletOption = { info: WalletInfo; provider: Eip1193 };

/** The part of `window` discovery needs (a test passes an EventTarget). */
export type WalletHost = Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent"> & { ethereum?: unknown };

const isProvider = (p: unknown): p is Eip1193 => !!p && typeof (p as Eip1193).request === "function";

/**
 * Collect EIP-6963 announcements (wallets can announce late: the list grows), ask the wallets to announce, and call
 * `onChange` with the current list. With no announcement, an injected window.ethereum is offered as "Browser wallet".
 * Returns a stop function.
 */
export function watchWallets(host: WalletHost, onChange: (list: WalletOption[]) => void, fallbackAfterMs = 400): () => void {
  const byUuid = new Map<string, WalletOption>();
  const emit = () => onChange([...byUuid.values()]);
  const on = (ev: Event) => {
    const d = (ev as CustomEvent<{ info?: Partial<WalletInfo>; provider?: unknown }>).detail;
    if (!d?.info?.uuid || !isProvider(d.provider)) return;
    const info: WalletInfo = { uuid: String(d.info.uuid), name: String(d.info.name ?? "wallet").slice(0, 40), icon: String(d.info.icon ?? ""), rdns: String(d.info.rdns ?? "") };
    byUuid.delete("fallback");
    byUuid.set(info.uuid, { info, provider: d.provider });
    emit();
  };
  host.addEventListener("eip6963:announceProvider", on);
  host.dispatchEvent(new Event("eip6963:requestProvider"));
  const t = setTimeout(() => {
    if (byUuid.size === 0 && isProvider(host.ethereum)) {
      byUuid.set("fallback", { info: { uuid: "fallback", name: "Browser wallet", icon: "", rdns: "" }, provider: host.ethereum });
    }
    emit();
  }, fallbackAfterMs);
  return () => { clearTimeout(t); host.removeEventListener("eip6963:announceProvider", on); };
}

/** Discovery as a one-off: whatever announced within `ms`. */
export function discoverWallets(host: WalletHost, ms = 400): Promise<WalletOption[]> {
  return new Promise(resolve => {
    let last: WalletOption[] = [];
    const stop = watchWallets(host, l => { last = l; }, ms - 50);
    setTimeout(() => { stop(); resolve(last); }, ms);
  });
}

/** Ask the wallet for its accounts (a popup the first time); the first one plays. */
export async function connectWallet(p: Eip1193): Promise<Address> {
  const accs = (await p.request({ method: "eth_requestAccounts" })) as string[];
  if (!accs?.length) throw wagerError("no-wallet", "the wallet shared no account");
  return getAddress(accs[0]);
}

/** Accounts the wallet already shares with this page (no popup), for reconnecting after a reload. */
export async function sharedAccount(p: Eip1193): Promise<Address | null> {
  try {
    const accs = (await p.request({ method: "eth_accounts" })) as string[];
    return accs?.length ? getAddress(accs[0]) : null;
  } catch {
    return null;
  }
}

export async function walletChainId(p: Eip1193): Promise<number> {
  return Number.parseInt(String(await p.request({ method: "eth_chainId" })), 16);
}

type ChainLike = Pick<Deployment, "chainId" | "chainName" | "rpc" | "explorer">;

/** EIP-3085 parameters for the deployment's chain (always named in full: "Robinhood Chain Testnet"). */
export const addChainParams = (d: ChainLike) => ({
  chainId: toHex(d.chainId),
  chainName: d.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: d.rpc,
  ...(d.explorer ? { blockExplorerUrls: [d.explorer] } : {}),
});

/** Put the wallet on the deployment's chain: switch, or (4902: unknown to the wallet) add it and switch. */
export async function ensureChain(p: Eip1193, d: ChainLike): Promise<void> {
  if ((await walletChainId(p)) === d.chainId) return;
  const chainId = toHex(d.chainId);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    if (!isUnknownChain(e)) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [addChainParams(d)] });
    // Most wallets switch on add; some only add.
    if ((await walletChainId(p)) !== d.chainId) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  }
  if ((await walletChainId(p)) !== d.chainId) throw wagerError("wrong-chain", `your wallet is on another network: switch it to ${d.chainName}`);
}

/** The viem chain for a deployment (RPCs from the deployment or a dev override). */
export function viemChain(d: ChainLike, rpc = d.rpc): Chain {
  return defineChain({
    id: d.chainId,
    name: d.chainName,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpc } },
    ...(d.explorer ? { blockExplorers: { default: { name: "explorer", url: d.explorer } } } : {}),
  });
}

/** Explorer links (null when the deployment has no explorer, e.g. local anvil). */
export const txUrl = (d: Pick<Deployment, "explorer">, hash: string): string | null => (d.explorer ? `${d.explorer}/tx/${hash}` : null);
export const addressUrl = (d: Pick<Deployment, "explorer">, a: string): string | null => (d.explorer ? `${d.explorer}/address/${a}` : null);
