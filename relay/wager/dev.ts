// The wager relay's Node stand-in (docs/WAGER.md §4.1): both Durable Objects' logic on Node's http + ws +
// node:sqlite, for development and the local end-to-end (npm run wager:e2e) without any Cloudflare tooling or sign-in.
//
//   node relay/wager/dev.ts [--port 5402] [--net local] [--keys FILE | --anvil] [--db DIR]     (npm run wager:relay)
//
// Settings are the Worker's [vars] names, from the environment (docs/WAGER.md §8); DEV defaults to "1" here (localhost
// origins, the x-dev-country header, DEV_RADBRO_* mocks). The deployment comes from src/wager/deployments.json, read at
// startup, so a local deploy that just wrote it is picked up.
// Keys (REFEREE_KEY, RELAYER_KEY, FAUCET_KEY): --keys FILE (KEY=VALUE lines; refused unless its mode is 0600), else the
// same names in the environment, else --anvil (anvil's public dev accounts: referee #8, relayer #9, faucet #0; local
// anvil only). Keys are never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { Deployment, WagerNetId } from "../../src/wager/config.ts";
import { startNodeRelay } from "./src/node.ts";
import type { Keys } from "./src/services.ts";
import { parseSettings, type Vars } from "./src/settings.ts";

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(k);
const opt = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

/** KEY=VALUE lines of a 0600 file (the tools' env file format). */
export function readKeyFile(file: string): Record<string, string> {
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} must be mode 0600 (it holds keys)`);
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\s#]*)"?\s*(#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** anvil's well-known development accounts (public; never used anywhere but a local anvil). */
const anvilKey = (i: number): string => {
  const pk = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i }).getHdKey().privateKey;
  return toHex(pk!);
};

async function main() {
  const vars: Vars = { DEV: "1", ...process.env } as Vars;
  if (opt("--net")) vars.WAGER_NET = opt("--net");
  const net = (vars.WAGER_NET ?? "local") as WagerNetId;
  vars.WAGER_NET = net;
  const table = JSON.parse(fs.readFileSync(new URL("../../src/wager/deployments.json", import.meta.url), "utf8")) as Record<string, Partial<Deployment>>;
  const settings = parseSettings(vars, table[net]);
  let keys: Keys = { referee: vars.REFEREE_KEY, relayer: vars.RELAYER_KEY, faucet: vars.FAUCET_KEY };
  const keyFile = opt("--keys") ?? (fs.existsSync(path.join(os.homedir(), ".config/radrun-wager", `${net}.env`)) && !flag("--anvil") ? path.join(os.homedir(), ".config/radrun-wager", `${net}.env`) : undefined);
  if (keyFile) {
    const f = readKeyFile(keyFile);
    keys = { referee: f.REFEREE_KEY ?? keys.referee, relayer: f.RELAYER_KEY ?? keys.relayer, faucet: f.FAUCET_KEY ?? keys.faucet };
  } else if (flag("--anvil")) {
    if (settings.chainId !== 31337) throw new Error("--anvil keys are for the local anvil only");
    keys = { referee: anvilKey(8), relayer: anvilKey(9), faucet: anvilKey(0) };
  }
  const port = Number(opt("--port") ?? new URL(settings.deployment.relay ?? "http://127.0.0.1:5402").port ?? 5402);
  const r = await startNodeRelay({ port, settings, keys, dbDir: opt("--db") ?? null, log: m => console.log(m) });
  const sv = r.services;
  console.log(`[wager-relay] ${settings.net} (chain ${settings.chainId}, vault ${settings.vault ?? "not deployed"}) on ${r.url}`);
  console.log(`[wager-relay] referee ${sv.referee?.address ?? "none"}, relayer ${sv.relayer?.address ?? "none"}, faucet ${sv.faucet?.address ?? "off"}; self-test ${sv.sims.selfTestOk ? "ok" : "FAILED: refusing to referee"}`);
  const stop = () => { void r.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
