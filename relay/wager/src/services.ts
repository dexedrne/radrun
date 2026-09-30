// Builds what the cores run on from the settings and the three keys (docs/WAGER.md §2 "Keys"): the vault chain, the
// referee's sims, the Radbro source, the relayer and faucet queues and the referee signer. Keys come in as values
// (Worker secrets, or the Node stand-in's 0600 file / env) and are never logged, printed or stored.
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Logger } from "./base.ts";
import { ViemChain, type TxRpc, type VaultChain } from "./chain.ts";
import { MockRadbroSource, ViemRadbroSource, type RadbroSource } from "./radbro.ts";
import { Relayer } from "./relayer.ts";
import type { RefereeSigner } from "./room.ts";
import type { WagerSettings } from "./settings.ts";
import { Sims, type LevelFiles } from "./sims.ts";

export type Keys = { referee?: string; relayer?: string; faucet?: string; refereePrev?: string };

export type Services = {
  settings: WagerSettings;
  chain: VaultChain & TxRpc;
  sims: Sims;
  radbroSrc: RadbroSource;
  relayer: Relayer | null;
  faucet: Relayer | null;
  referee: RefereeSigner | null;
  /** The previous referee's key after a rotation (REFEREE_KEY_PREV), for the matches that locked under it. */
  refereePrev: RefereeSigner | null;
};

const KEY = /^0x[0-9a-fA-F]{64}$/;

function account(k: string | undefined, name: string, log?: Logger) {
  if (!k) return null;
  const v = k.trim();
  if (!KEY.test(v)) { log?.(`${name} is set but is not a 32-byte hex key: ignored`); return null; }
  return privateKeyToAccount(v as Hex);
}

export function makeServices(o: {
  settings: WagerSettings;
  levels: LevelFiles;
  keys: Keys;
  /** Tests / local: another chain implementation. */
  chain?: VaultChain & TxRpc;
  radbroSrc?: RadbroSource;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}): Services {
  const s = o.settings;
  const chain = o.chain ?? new ViemChain({ chainId: s.chainId, vault: s.vault ?? "0x0000000000000000000000000000000000000000", rpcUrls: s.rpcUrls, deployBlock: s.deployment.deployBlock });
  const radbroSrc = o.radbroSrc ?? (s.radbro.mock ? new MockRadbroSource(s.radbro.mock) : new ViemRadbroSource({ rpcUrls: s.ethRpcUrls, v2: s.radbro.v2, v1: s.radbro.v1 }));
  const rel = account(o.keys.relayer, "RELAYER_KEY", o.log);
  const fau = s.faucet ? account(o.keys.faucet, "FAUCET_KEY", o.log) : null;
  const ref = account(o.keys.referee, "REFEREE_KEY", o.log);
  const prev = account(o.keys.refereePrev, "REFEREE_KEY_PREV", o.log);
  return {
    settings: s,
    chain,
    sims: new Sims(o.levels, s.districts),
    radbroSrc,
    relayer: rel ? new Relayer({ rpc: chain, signer: rel, chainId: s.chainId, sleep: o.sleep }) : null,
    faucet: fau ? new Relayer({ rpc: chain, signer: fau, chainId: s.chainId, sleep: o.sleep }) : null,
    referee: ref ? { address: ref.address, signTypedData: td => ref.signTypedData(td) } : null,
    refereePrev: prev ? { address: prev.address, signTypedData: td => prev.signTypedData(td) } : null,
  };
}
