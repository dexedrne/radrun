// SPIDER-TAG wager client: which deployment this page talks to (docs/WAGER.md §8). A build offers the deployments in
// VITE_WAGER_NETS (the first is the default; unset = the page is off); `&net=<id>` picks another offered one. The
// default deployment's relay and RPCs can be overridden per build (VITE_WAGER_RELAY_URL, VITE_WAGER_RPC). Dev and
// test builds also take `&net=` for any deployment and `&relay=` / `&rpc=` overrides. Pure TS.
import { DEPLOYMENTS, isWagerNet, siteDeployments, type Deployment } from "./config.ts";

export type SiteChoice = {
  /** The deployment in use, or null when the page is off. */
  dep: Deployment | null;
  /** What this build offers (a network picker lists these). */
  offered: Deployment[];
  relay: string | null;
  rpc: string[];
  /** Why the page is off (null = on). */
  off: string | null;
};

export function chooseDeployment(o: { nets: string | undefined; relayEnv?: string; rpcEnv?: string; search: string; dev: boolean }): SiteChoice {
  const offered = siteDeployments(o.nets);
  const q = new URLSearchParams(o.search);
  const want = q.get("net");
  let dep: Deployment | null = null;
  if (want && isWagerNet(want)) {
    if (offered.some(d => d.net === want) || o.dev) dep = DEPLOYMENTS[want];
  }
  dep ??= offered[0] ?? null;
  if (!dep) return { dep: null, offered, relay: null, rpc: [], off: "wager matches aren't switched on for this build" };
  const isDefault = dep === offered[0];
  const devRelay = o.dev ? q.get("relay") : null;
  const devRpc = o.dev ? q.get("rpc") : null;
  const relay = (devRelay || (isDefault && o.relayEnv) || dep.relay || "").replace(/\/$/, "") || null;
  const rpcList = devRpc ? devRpc.split(",") : isDefault && o.rpcEnv ? o.rpcEnv.split(",") : dep.rpc;
  const rpc = rpcList.map(s => s.trim()).filter(Boolean);
  const off = !relay ? "this deployment has no wager relay yet" : !rpc.length ? "this deployment has no RPC" : null;
  return { dep, offered, relay, rpc, off };
}

/** This page's deployment, from the build's env and the address bar. */
export function siteChoice(): SiteChoice {
  const env = import.meta.env as Record<string, string | undefined>;
  return chooseDeployment({
    nets: env.VITE_WAGER_NETS, relayEnv: env.VITE_WAGER_RELAY_URL, rpcEnv: env.VITE_WAGER_RPC, search: location.search, dev: import.meta.env.MODE !== "production",
  });
}

/** Keep `&net=` (and the dev overrides) on links the page makes (invites, verify links, navigation). */
export function keepParams(search = location.search, dev = import.meta.env.MODE !== "production"): string {
  const q = new URLSearchParams(search), out = new URLSearchParams();
  const keys = dev ? ["net", "relay", "rpc", "devwallet", "bot", "badhash"] : ["net"];
  for (const k of keys) if (q.has(k)) out.set(k, q.get(k) ?? "");
  const s = out.toString().replace(/=(?=&|$)/g, "");
  return s ? `&${s}` : "";
}
