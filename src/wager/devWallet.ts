// SPIDER-TAG wager, DEV AND TEST BUILDS ONLY (docs/WAGER.md §7.5): an EIP-1193 wallet that signs with anvil's
// well-known public test keys, announced through EIP-6963 as "Dev wallet #n", so headless end-to-end runs can deposit,
// sign and play with no extension. WagerPage imports it only behind `import.meta.env.MODE !== "production"`, so a
// production build drops it (test/wager-client-bundle.test.ts checks dist/ has none of it). Never use these keys with
// anything real: everyone has them.
import { createWalletClient, getAddress, http, isHex, numberToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { viemChain } from "./wallet.ts";

/** anvil / hardhat's default mnemonic accounts 0-9 (public test keys). */
const ANVIL_KEYS: Hex[] = [
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
];

type Chain = { chainId: number; name: string; rpc: string };

export function devProvider(n: number, first: Chain) {
  const acct = privateKeyToAccount(ANVIL_KEYS[Math.max(0, Math.min(9, n))]);
  const chains = new Map<number, Chain>([[first.chainId, first]]);
  let cur = first.chainId;
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const emit = (ev: string, ...a: unknown[]) => listeners.get(ev)?.forEach(f => f(...a));
  const rpc = async (method: string, params: unknown) => {
    const c = chains.get(cur)!;
    const r = await fetch(c.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
    const j = (await r.json()) as { result?: unknown; error?: { code: number; message: string } };
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  };
  const wallet = () => {
    const c = chains.get(cur)!;
    return createWalletClient({ account: acct, chain: viemChain({ chainId: c.chainId, chainName: c.name, rpc: [c.rpc], explorer: null }), transport: http(c.rpc) });
  };
  return {
    isDevWallet: true,
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const p = (params ?? []) as unknown[];
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [acct.address];
        case "eth_chainId":
          return numberToHex(cur);
        case "net_version":
          return String(cur);
        case "wallet_switchEthereumChain": {
          const id = Number.parseInt(String((p[0] as { chainId: string }).chainId), 16);
          if (!chains.has(id)) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
          if (id !== cur) { cur = id; emit("chainChanged", numberToHex(id)); }
          return null;
        }
        case "wallet_addEthereumChain": {
          const q = p[0] as { chainId: string; chainName: string; rpcUrls: string[] };
          const id = Number.parseInt(q.chainId, 16);
          chains.set(id, { chainId: id, name: q.chainName, rpc: q.rpcUrls[0] });
          cur = id;
          emit("chainChanged", q.chainId);
          return null;
        }
        case "eth_signTypedData_v4": {
          if (getAddress(String(p[0])) !== acct.address) throw Object.assign(new Error("unknown account"), { code: 4100 });
          const td = typeof p[1] === "string" ? JSON.parse(p[1]) : p[1];
          const { EIP712Domain: _drop, ...types } = td.types;
          return acct.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
        }
        case "personal_sign": {
          const msg = String(p[0]);
          return acct.signMessage({ message: isHex(msg) ? { raw: msg } : msg });
        }
        case "eth_sendTransaction": {
          const tx = p[0] as { to?: Hex; data?: Hex; value?: Hex; gas?: Hex };
          return wallet().sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined } as never);
        }
        default:
          return rpc(method, p);
      }
    },
    on(ev: string, fn: (...a: unknown[]) => void) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(fn); },
    removeListener(ev: string, fn: (...a: unknown[]) => void) { listeners.get(ev)?.delete(fn); },
  };
}

/** Announce "Dev wallet #n" through EIP-6963 (and answer later requestProvider events). */
export function installDevWallet(n: number, chain: Chain): void {
  const provider = devProvider(n, chain);
  const info = { uuid: `dev-wallet-${n}`, name: `Dev wallet #${n}`, icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'><rect width='8' height='8' fill='%23ff3d7f'/></svg>", rdns: "local.devwallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}
