// SPIDER-TAG wager: deploys the GameVault (docs/WAGER.md §11) and everything around it. Run through npm:
//
//   npm run wager:deploy -- --net local [--rpc http://127.0.0.1:5401] [--smoke] [--out <file>]
//   npm run wager:deploy -- --net rh-testnet --init-keys        make ~/.config/radrun-wager/rh-testnet.env (0600)
//   npm run wager:deploy -- --net rh-testnet --fork-only        rehearse on an anvil fork; nothing is sent
//   npm run wager:deploy -- --net rh-testnet                    rehearse, then deploy TestSpiderTag + GameVault
//   npm run wager:deploy -- --net rh-mainnet --token 0x.. --house 0x.. --owner 0x.. [--max-stake N ...]
//                                                               dry run on a mainnet fork (probe + a full match)
//   npm run wager:deploy -- --net rh-mainnet ... --send-it      only after the owner's explicit "send it"
//   npm run wager:deploy -- --probe --net rh-mainnet --token 0x..   token probe on a fork
//   npm run wager:deploy -- --abi | --abi-check                 write / check src/wager/vaultAbi.ts from forge build
//
// Keys: the local network uses anvil's public dev keys. The test networks and mainnet read a 0600 env file outside
// the repo (~/.config/radrun-wager/<net>.env, names in src/wager/config.ts WAGER_ENV). Keys are never printed or put on
// a command line: forge gets the deployer's key through its environment, and the referee's and relayer's keys are
// only turned into addresses here. Fork rehearsals use anvil's dev keys and never touch a real key.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, erc20Abi, formatUnits, getAddress,
  http, isAddress, keccak256, parseUnits, toHex, type Abi, type Address, type Chain, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { DEPLOYMENTS, MAINNET_CHAIN_IDS, isWagerNet, type Deployment, type WagerNetId } from "../src/wager/config.ts";
import {
  DEFAULT_FEE_BPS, DEFAULT_HOLDER_FEE_BPS, MAX_FEE_BPS, OUTCOME_WIN, entryTypedData, payout, resultTypedData, sessionAuthTypedData,
  type Entry, type Result, type SessionAuth,
} from "../src/wager/eip712.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const CONTRACTS = path.join(ROOT, "contracts");
export const ABI_MODULE = path.join(ROOT, "src", "wager", "vaultAbi.ts");
export const DEPLOYMENTS_FILE = path.join(ROOT, "src", "wager", "deployments.json");
export const KEY_DIR = path.join(os.homedir(), ".config", "radrun-wager");

/** anvil's well-known dev accounts (public keys for local chains and forks only; never used anywhere real). */
export const ANVIL_KEYS: readonly Hex[] = [
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
/** Roles on the local network and in fork rehearsals (docs/WAGER.md §9.4: house #7, referee #8, relayer #9). */
export const ANVIL_ROLES = { deployer: 0, playerA: 1, playerB: 2, sessionA: 3, sessionB: 4, faucet: 6, house: 7, referee: 8, relayer: 9 } as const;

/** The gas targets of docs/WAGER.md §3.10 (L2 execution; the L1 data fee is extra on Robinhood Chain). */
export const GAS_TARGETS = { lock: 220_000n, settle: 90_000n, openSession: 90_000n, deposit: 90_000n } as const;

/** pons v2 launch factory on Robinhood Chain mainnet (a pons token's launchFactory() returns it). */
export const PONS_V2_FACTORY: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

const VERIFIERS: Partial<Record<WagerNetId, { kind: "blockscout" | "sourcify"; url?: string }[]>> = {
  "rh-testnet": [{ kind: "blockscout", url: "https://explorer.testnet.chain.robinhood.com/api/" }, { kind: "sourcify" }],
  // Mainnet Blockscout answers some networks with a bot check, so Sourcify (which supports 4663) goes first.
  "rh-mainnet": [{ kind: "sourcify" }, { kind: "blockscout", url: "https://robinhoodchain.blockscout.com/api/" }],
};

// ---- small helpers ------------------------------------------------------------------------------------------------

const log = (...a: unknown[]) => console.log(...a);
/** Thrown for every expected failure; main() prints it and exits 1 after the anvil forks are stopped. */
export class DeployError extends Error {}
function fail(msg: string): never {
  throw new DeployError(msg);
}

/** Every anvil this run starts, stopped by PID on the way out, whatever happens. */
const anvils = new Set<ChildProcess>();
function stopAnvils(): void {
  for (const p of anvils) {
    if (p.exitCode === null && p.pid !== undefined) {
      try {
        process.kill(p.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  anvils.clear();
}
process.on("exit", stopAnvils);

/** forge / cast / anvil: from PATH, else Foundry's default install directory. */
export function foundryBin(name: "forge" | "cast" | "anvil"): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, name);
    if (dir && fs.existsSync(p)) return p;
  }
  const p = path.join(os.homedir(), ".foundry", "bin", name);
  if (fs.existsSync(p)) return p;
  return fail(`${name} not found: install Foundry (https://getfoundry.sh) or add ~/.foundry/bin to PATH`);
}

type Args = Record<string, string | true>;
export function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`unexpected argument ${a}`);
    const [k, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) out[k] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}
const str = (a: Args, k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) {
    if (!opts.quiet) process.stderr.write(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    fail(`${path.basename(cmd)} ${args[0]} failed (exit ${r.status})`);
  }
  return r.stdout;
}

// ---- ABI module ---------------------------------------------------------------------------------------------------

export function forgeBuild(): void {
  run(foundryBin("forge"), ["build"], { cwd: CONTRACTS });
}

export function readArtifact(name: "GameVault" | "TestSpiderTag"): { abi: Abi; bytecode: Hex } {
  const f = path.join(CONTRACTS, "out", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(f)) fail(`${path.relative(ROOT, f)} is missing: run forge build in contracts/`);
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
}

/** The generated module: the vault's full ABI (functions, events and errors, inherited ones included). */
export function renderAbiModule(abi: Abi): string {
  const items = abi.map(item => `  ${JSON.stringify(item)},`).join("\n");
  return [
    "// GENERATED by `npm run wager:deploy -- --abi` from the forge build of contracts/src/GameVault.sol. Do not edit:",
    "// test/wager-contracts.test.ts and `--abi-check` compare it with the build. The client, the relay and the tools",
    "// import it (with viem) for every vault call, event and error.",
    "export const gameVaultAbi = [",
    items,
    "] as const;",
    "",
  ].join("\n");
}

function abiCommand(check: boolean): void {
  forgeBuild();
  const want = renderAbiModule(readArtifact("GameVault").abi);
  const have = fs.existsSync(ABI_MODULE) ? fs.readFileSync(ABI_MODULE, "utf8") : "";
  if (check) {
    if (want !== have) fail(`${path.relative(ROOT, ABI_MODULE)} does not match the build: run npm run wager:deploy -- --abi`);
    log(`${path.relative(ROOT, ABI_MODULE)} matches the build`);
    return;
  }
  if (want === have) return log(`${path.relative(ROOT, ABI_MODULE)} is up to date`);
  fs.writeFileSync(ABI_MODULE, want);
  log(`wrote ${path.relative(ROOT, ABI_MODULE)}`);
}

// ---- deployments.json ---------------------------------------------------------------------------------------------

type Table = Record<WagerNetId, Omit<Deployment, "net">>;

/** JSON with 2-space indents but arrays of plain values on one line (the file's existing style). */
export function formatDeployments(table: Table): string {
  const json = JSON.stringify(table, null, 2);
  return `${json.replace(/\[\n\s+([^\[\]{}]*?)\n\s+\]/g, (_m, inner: string) => `[${inner.split(/,\n\s+/).join(", ")}]`)}\n`;
}

export function withDeployment(table: Table, net: WagerNetId, d: { vault: Address; token: Address; deployBlock: number }): Table {
  return { ...table, [net]: { ...table[net], vault: getAddress(d.vault), token: getAddress(d.token), deployBlock: d.deployBlock } };
}

function writeDeployment(net: WagerNetId, d: { vault: Address; token: Address; deployBlock: number }, out?: string): void {
  const file = out ? path.resolve(out) : DEPLOYMENTS_FILE;
  const base = JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : DEPLOYMENTS_FILE, "utf8")) as Table;
  fs.writeFileSync(file, formatDeployments(withDeployment(base, net, d)));
  log(`wrote ${net} to ${path.relative(ROOT, file) || file}`);
}

// ---- keys and settings --------------------------------------------------------------------------------------------

export type Settings = {
  token: Address | null;
  house: Address;
  owner: Address;
  referee: Address;
  faucet: Address | null;
  feeBps: number;
  holderFeeBps: number;
  /** Whole tokens (converted with the token's decimals). */
  maxStake: string;
  maxBalance: string;
  settleWindow: number;
};

type Keys = { deployer: PrivateKeyAccount; deployerKey: Hex };

export const keyFile = (net: WagerNetId): string => path.join(KEY_DIR, `${net}.env`);

/** Reads a 0600 env file (KEY=value lines; # comments). Refuses a file others can read. */
export function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) fail(`${file} is missing: run with --init-keys first`);
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) fail(`${file} must be private (chmod 600), it is ${mode.toString(8)}`);
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const asKey = (v: string | undefined, name: string): Hex => {
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) fail(`${name} is missing or malformed in the env file`);
  return v as Hex;
};
const asAddress = (v: string | undefined, name: string): Address => {
  if (!v || !isAddress(v)) fail(`${name} must be an address (got ${v ? "something else" : "nothing"})`);
  return getAddress(v);
};

function localKeysAndSettings(args: Args): { keys: Keys; settings: Settings } {
  const k = (i: number) => privateKeyToAccount(ANVIL_KEYS[i]);
  return {
    keys: { deployer: k(ANVIL_ROLES.deployer), deployerKey: ANVIL_KEYS[ANVIL_ROLES.deployer] },
    settings: {
      token: str(args, "token") ? asAddress(str(args, "token"), "--token") : null,
      house: k(ANVIL_ROLES.house).address,
      owner: k(ANVIL_ROLES.deployer).address,
      referee: k(ANVIL_ROLES.referee).address,
      faucet: k(ANVIL_ROLES.faucet).address,
      feeBps: Number(str(args, "fee-bps") ?? DEFAULT_FEE_BPS),
      holderFeeBps: Number(str(args, "holder-fee-bps") ?? DEFAULT_HOLDER_FEE_BPS),
      maxStake: str(args, "max-stake") ?? "10000",
      maxBalance: str(args, "max-balance") ?? "1000000",
      settleWindow: Number(str(args, "settle-window") ?? 86_400),
    },
  };
}

function fileKeysAndSettings(net: WagerNetId, args: Args): { keys: Keys; settings: Settings; env: Record<string, string> } {
  const env = readEnvFile(str(args, "env-file") ?? keyFile(net));
  const deployerKey = asKey(env.DEPLOYER_KEY, "DEPLOYER_KEY");
  const referee = privateKeyToAccount(asKey(env.REFEREE_KEY, "REFEREE_KEY")).address;
  const faucet = env.FAUCET_KEY ? privateKeyToAccount(asKey(env.FAUCET_KEY, "FAUCET_KEY")).address : null;
  const pick = (flag: string, name: string) => str(args, flag) ?? env[name] ?? "";
  const tokenStr = pick("token", "WAGER_TOKEN");
  return {
    env,
    keys: { deployer: privateKeyToAccount(deployerKey), deployerKey },
    settings: {
      token: tokenStr ? asAddress(tokenStr, "the token") : null,
      house: asAddress(pick("house", "WAGER_HOUSE"), "the house address (--house or WAGER_HOUSE)"),
      owner: asAddress(pick("owner", "WAGER_OWNER"), "the owner address (--owner or WAGER_OWNER)"),
      referee,
      faucet,
      feeBps: Number(pick("fee-bps", "WAGER_FEE_BPS") || DEFAULT_FEE_BPS),
      holderFeeBps: Number(pick("holder-fee-bps", "WAGER_HOLDER_FEE_BPS") || DEFAULT_HOLDER_FEE_BPS),
      maxStake: pick("max-stake", "WAGER_MAX_STAKE") || fail("set the beta stake cap (--max-stake or WAGER_MAX_STAKE, whole tokens)"),
      maxBalance: pick("max-balance", "WAGER_MAX_BALANCE") || fail("set the balance cap (--max-balance or WAGER_MAX_BALANCE, whole tokens)"),
      settleWindow: Number(pick("settle-window", "WAGER_SETTLE_WINDOW") || 86_400),
    },
  };
}

export function checkSettings(s: Settings): void {
  for (const [k, v] of [["fee-bps", s.feeBps], ["holder-fee-bps", s.holderFeeBps]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_FEE_BPS) fail(`${k} must be 0..${MAX_FEE_BPS}`);
  }
  if (!Number.isInteger(s.settleWindow) || s.settleWindow < 3600 || s.settleWindow > 7 * 86_400) fail("settle-window must be 3600..604800 s");
  for (const [k, v] of [["max-stake", s.maxStake], ["max-balance", s.maxBalance]] as const) {
    if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) fail(`${k} must be a positive number of whole tokens`);
  }
}

/** --init-keys: a new 0600 env file with fresh keys from `cast wallet new` (only addresses are printed). */
function initKeys(net: WagerNetId): void {
  if (net === "local") fail("the local network uses anvil's dev keys; nothing to make");
  const file = keyFile(net);
  if (fs.existsSync(file)) fail(`${file} already exists; not overwriting it`);
  const names = net === "rh-mainnet" ? ["DEPLOYER_KEY", "REFEREE_KEY", "RELAYER_KEY"] : ["DEPLOYER_KEY", "REFEREE_KEY", "RELAYER_KEY", "FAUCET_KEY"];
  const made: { name: string; key: Hex; address: Address }[] = [];
  for (const name of names) {
    const out = JSON.parse(run(foundryBin("cast"), ["wallet", "new", "--json"], { quiet: true }));
    const w = Array.isArray(out.data) ? out.data[0] : out[0];
    made.push({ name, key: w.private_key as Hex, address: getAddress(w.address) });
  }
  const deployer = made[0].address;
  const lines = [
    `# RadRun wager keys and settings for ${net} (docs/WAGER.md §8). Private: never commit, print or paste these.`,
    `# Made ${new Date().toISOString()} by tools/wager-deploy.ts --init-keys.`,
    ...made.map(m => `${m.name}=${m.key}`),
    ...made.map(m => `# ${m.name.replace("_KEY", "").toLowerCase()} address: ${m.address}`),
    "",
    net === "rh-mainnet" ? "# The owner's own addresses (cold wallets), from MAINNET.md:" : "# The vault owner and house: the deployer by default; set your own wallet to review held series from it.",
    `WAGER_OWNER=${net === "rh-mainnet" ? "" : deployer}`,
    `WAGER_HOUSE=${net === "rh-mainnet" ? "" : deployer}`,
    "# The token: empty on a test network deploys TestSpiderTag; on mainnet, the owner's coin.",
    "WAGER_TOKEN=",
    `WAGER_FEE_BPS=${DEFAULT_FEE_BPS}`,
    `WAGER_HOLDER_FEE_BPS=${DEFAULT_HOLDER_FEE_BPS}`,
    "# Beta caps in whole tokens.",
    `WAGER_MAX_STAKE=${net === "rh-mainnet" ? "100000" : "10000"}`,
    `WAGER_MAX_BALANCE=${net === "rh-mainnet" ? "1000000" : "1000000"}`,
    "WAGER_SETTLE_WINDOW=86400",
    "# Optional keyed RPC (the public endpoint is rate-limited).",
    "RPC_URL_PRIVATE=",
    "",
  ];
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, lines.join("\n"), { mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
  log(`wrote ${file} (0600). Public addresses:`);
  for (const m of made) log(`  ${m.name.replace("_KEY", "").toLowerCase().padEnd(8)} ${m.address}`);
  if (net !== "rh-mainnet") log(`Next: claim test ETH by hand into the deployer ${deployer} (the official faucet has a browser check).`);
}

// ---- chains -------------------------------------------------------------------------------------------------------

export function chainOf(d: Deployment, rpc: string): Chain {
  return defineChain({
    id: d.chainId,
    name: d.chainName,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    testnet: d.testnet,
  });
}

function pickRpc(d: Deployment, args: Args, env?: Record<string, string>): string {
  const rpc = str(args, "rpc") ?? (env?.RPC_URL_PRIVATE || undefined) ?? d.rpc[0];
  if (!rpc) fail(`no RPC for ${d.net}`);
  return rpc;
}

/** Starts anvil (optionally forking `forkUrl`) on `port` and waits for it; stopped by PID in `stop`. */
async function startAnvil(port: number, forkUrl?: string): Promise<{ url: string; stop: () => void; proc: ChildProcess }> {
  const args = ["--port", String(port), "--quiet"];
  if (forkUrl) args.push("--fork-url", forkUrl, "--no-rate-limit");
  else args.push("--chain-id", "31337");
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ transport: http(url, { retryCount: 0 }) });
  if (await client.getChainId().then(() => true, () => false)) fail(`port ${port} is taken (another node answers there); pass --fork-port`);
  const proc = spawn(foundryBin("anvil"), args, { stdio: "ignore" });
  anvils.add(proc);
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) fail(`anvil exited (${proc.exitCode}); is port ${port} free?`);
    try {
      await client.getChainId();
      if (proc.exitCode !== null) fail(`anvil exited (${proc.exitCode}) on port ${port}`);
      return { url, proc, stop: () => stopOne(proc) };
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  stopOne(proc);
  return fail(`anvil did not start on ${url}`);
}

function stopOne(proc: ChildProcess): void {
  anvils.delete(proc);
  if (proc.exitCode === null && proc.pid !== undefined) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

// ---- forge script -------------------------------------------------------------------------------------------------

type Deployed = { token: Address; vault: Address; deployBlock: number; tokenDeployed: boolean; gas: bigint };

/** Runs contracts/script/Deploy.s.sol with --broadcast against `rpc`; the deployer's key goes through the env only. */
function forgeDeploy(rpc: string, chainId: number, deployerKey: Hex, s: Settings, units: { maxStake: bigint; maxBalance: bigint }, allowMainnet: boolean): Deployed {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEPLOYER_KEY: deployerKey,
    VAULT_TOKEN: s.token ?? "0x0000000000000000000000000000000000000000",
    TEST_TOKEN_HOLDER: s.faucet ?? "0x0000000000000000000000000000000000000000",
    VAULT_HOUSE: s.house,
    VAULT_REFEREE: s.referee,
    VAULT_OWNER: s.owner,
    VAULT_FEE_BPS: String(s.feeBps),
    VAULT_HOLDER_FEE_BPS: String(s.holderFeeBps),
    VAULT_MAX_STAKE: units.maxStake.toString(),
    VAULT_MAX_BALANCE: units.maxBalance.toString(),
    VAULT_SETTLE_WINDOW: String(s.settleWindow),
    ALLOW_MAINNET: allowMainnet ? "true" : "false",
    // Through the env, not argv: a keyed RPC URL is a credential too.
    FOUNDRY_ETH_RPC_URL: rpc,
  };
  if (!s.token && !s.faucet) fail("deploying the test token needs a faucet wallet (FAUCET_KEY)");
  const args = ["script", "script/Deploy.s.sol:Deploy", "--broadcast", "--slow"];
  // Robinhood Chain is an Arbitrum chain: its gas includes an L1 data part, so leave generous headroom.
  if (chainId !== 31337) args.push("--gas-estimate-multiplier", "200");
  run(foundryBin("forge"), args, { cwd: CONTRACTS, env });
  const f = path.join(CONTRACTS, "broadcast", "Deploy.s.sol", String(chainId), "run-latest.json");
  const b = JSON.parse(fs.readFileSync(f, "utf8"));
  const txs = b.transactions as { contractName: string; contractAddress: string; transactionType: string }[];
  const vaultTx = txs.find(t => t.contractName === "GameVault" && t.transactionType === "CREATE");
  const tokenTx = txs.find(t => t.contractName === "TestSpiderTag" && t.transactionType === "CREATE");
  if (!vaultTx) fail("the broadcast has no GameVault");
  const receipts = b.receipts as { blockNumber: string; gasUsed: string; contractAddress: string | null }[];
  const vaultReceipt = receipts.find(r => r.contractAddress && getAddress(r.contractAddress) === getAddress(vaultTx.contractAddress));
  return {
    vault: getAddress(vaultTx.contractAddress),
    token: tokenTx ? getAddress(tokenTx.contractAddress) : (s.token as Address),
    tokenDeployed: !!tokenTx,
    deployBlock: Number(BigInt(vaultReceipt?.blockNumber ?? receipts[receipts.length - 1].blockNumber)),
    gas: receipts.reduce((n, r) => n + BigInt(r.gasUsed), 0n),
  };
}

// ---- reading back and checking a vault ----------------------------------------------------------------------------

/** Reads every constructor value back from a deployed vault and fails on any difference. */
async function checkVault(pc: PublicClient, vault: Address, s: Settings, token: Address, units: { maxStake: bigint; maxBalance: bigint }): Promise<void> {
  const r = (functionName: string) => pc.readContract({ address: vault, abi: gameVaultAbiLoose(), functionName }) as Promise<unknown>;
  const got = {
    token: getAddress((await r("token")) as string), house: getAddress((await r("house")) as string), referee: getAddress((await r("referee")) as string),
    owner: getAddress((await r("owner")) as string), houseFeeBps: Number(await r("houseFeeBps")), holderFeeBps: Number(await r("holderFeeBps")),
    maxStake: (await r("maxStake")) as bigint, maxBalance: (await r("maxBalance")) as bigint, settleWindow: Number(await r("settleWindow")),
    paused: (await r("paused")) as boolean, totalLiabilities: (await r("totalLiabilities")) as bigint,
  };
  const want = {
    token: getAddress(token), house: s.house, referee: s.referee, owner: s.owner, houseFeeBps: s.feeBps, holderFeeBps: s.holderFeeBps,
    maxStake: units.maxStake, maxBalance: units.maxBalance, settleWindow: s.settleWindow, paused: false, totalLiabilities: 0n,
  };
  for (const k of Object.keys(want) as (keyof typeof want)[]) {
    if (got[k] !== want[k]) fail(`vault ${k} reads ${String(got[k])}, expected ${String(want[k])}`);
  }
}

let loadedAbi: Abi | null = null;
/** The vault ABI from the build (the generated module is checked against it separately). */
function gameVaultAbiLoose(): Abi {
  return (loadedAbi ??= readArtifact("GameVault").abi);
}

// ---- token probe --------------------------------------------------------------------------------------------------

export type TokenInfo = { name: string; symbol: string; decimals: number; totalSupply: bigint; pons: boolean };

async function tokenInfo(pc: PublicClient, token: Address): Promise<TokenInfo> {
  const code = await pc.getCode({ address: token });
  if (!code || code === "0x") fail(`no contract at ${token}`);
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    pc.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "?"),
    pc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    pc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    pc.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
  ]);
  const factory = await pc
    .readContract({ address: token, abi: [{ type: "function", name: "launchFactory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: "launchFactory" })
    .catch(() => null);
  return { name, symbol, decimals, totalSupply, pons: !!factory && getAddress(factory) === PONS_V2_FACTORY };
}

/** Gives `to` `amount` of `token` on a fork: from --holder by impersonation, else by writing its balance slot. */
async function fundOnFork(url: string, chain: Chain, token: Address, to: Address, amount: bigint, holder?: Address): Promise<void> {
  const pc = createPublicClient({ chain, transport: http(url) });
  const tc = createTestClient({ chain, mode: "anvil", transport: http(url) });
  if (holder) {
    await tc.impersonateAccount({ address: holder });
    await tc.setBalance({ address: holder, value: 10n ** 18n });
    const wc = createWalletClient({ chain, transport: http(url), account: holder });
    const hash = await wc.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount], account: holder, chain });
    await pc.waitForTransactionReceipt({ hash });
    await tc.stopImpersonatingAccount({ address: holder });
    return;
  }
  // Solidity mappings of address => uint256 at slots 0..20 (OpenZeppelin's _balances is slot 0).
  const before = await pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  for (let slot = 0; slot <= 20; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, BigInt(slot)]));
    const old = await pc.getStorageAt({ address: token, slot: key });
    await tc.setStorageAt({ address: token, index: key, value: toHex(before + amount, { size: 32 }) });
    const now = await pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [to] });
    if (now === before + amount) return;
    await tc.setStorageAt({ address: token, index: key, value: old ?? toHex(0n, { size: 32 }) });
  }
  fail(`could not find ${token}'s balance slot; pass --holder <an address holding the token>`);
}

type ProbeResult = { exactUnit: boolean; exactWhole: boolean; stable: boolean; notes: string[] };

/**
 * On a fork: a holder deposits and withdraws 1 base unit and 1 whole token through a freshly deployed vault (both must
 * be exact), then the vault's balance must stay put across blocks and a day of time (no rebasing).
 */
async function probeToken(url: string, chain: Chain, token: Address, info: TokenInfo, holder?: Address): Promise<ProbeResult> {
  const pc = createPublicClient({ chain, transport: http(url) });
  const tc = createTestClient({ chain, mode: "anvil", transport: http(url) });
  const dev = privateKeyToAccount(ANVIL_KEYS[ANVIL_ROLES.deployer]);
  const who = privateKeyToAccount(ANVIL_KEYS[5]);
  for (const a of [dev.address, who.address]) await tc.setBalance({ address: a, value: 10n ** 20n });
  const vault = await deployVaultDirect(url, chain, token, dev, {
    house: dev.address, owner: dev.address, referee: dev.address, feeBps: 0, holderFeeBps: 0,
    maxStake: 2n ** 128n - 1n, maxBalance: 2n ** 128n - 1n, settleWindow: 86_400,
  });
  const whole = 10n ** BigInt(info.decimals);
  await fundOnFork(url, chain, token, who.address, 2n * whole + 2n, holder);
  const wc = createWalletClient({ chain, transport: http(url), account: who });
  const send = async (fn: string, args: unknown[], to: Address = vault) => {
    const hash = await wc.writeContract({ address: to, abi: to === vault ? gameVaultAbiLoose() : erc20Abi, functionName: fn as never, args: args as never, account: who, chain });
    return pc.waitForTransactionReceipt({ hash });
  };
  const bal = (a: Address) => pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  const notes: string[] = [];
  const roundTrip = async (amount: bigint): Promise<boolean> => {
    await send("approve", [vault, amount], token);
    const r1 = await send("deposit", [amount]).catch((e: Error) => (notes.push(`deposit ${amount}: ${e.message.split("\n")[0]}`), null));
    if (!r1 || r1.status !== "success") return false;
    const before = await bal(who.address);
    const r2 = await send("withdraw", [amount]).catch((e: Error) => (notes.push(`withdraw ${amount}: ${e.message.split("\n")[0]}`), null));
    if (!r2 || r2.status !== "success") return false;
    const got = (await bal(who.address)) - before;
    if (got !== amount) notes.push(`withdrawing ${amount} delivered ${got}`);
    return got === amount;
  };
  const exactUnit = await roundTrip(1n);
  const exactWhole = await roundTrip(whole);
  // Park a balance in the vault and watch it across blocks and time.
  await send("approve", [vault, whole], token);
  await send("deposit", [whole]).catch(() => notes.push("could not park a balance for the rebase check"));
  const parked = await bal(vault);
  await tc.mine({ blocks: 5 });
  await tc.increaseTime({ seconds: 86_400 });
  await tc.mine({ blocks: 1 });
  const later = await bal(vault);
  const stable = parked > 0n && later === parked;
  if (parked > 0n && later !== parked) notes.push(`the vault's balance moved from ${parked} to ${later} with no transfer (rebasing)`);
  return { exactUnit, exactWhole, stable, notes };
}

/** Deploys a vault straight from the build (forks only: probes and dry runs that don't need the forge script). */
async function deployVaultDirect(
  url: string, chain: Chain, token: Address, from: PrivateKeyAccount,
  c: { house: Address; owner: Address; referee: Address; feeBps: number; holderFeeBps: number; maxStake: bigint; maxBalance: bigint; settleWindow: number },
): Promise<Address> {
  const { abi, bytecode } = readArtifact("GameVault");
  const wc = createWalletClient({ chain, transport: http(url), account: from });
  const pc = createPublicClient({ chain, transport: http(url) });
  const hash = await wc.deployContract({
    abi, bytecode, account: from, chain,
    args: [token, c.house, c.referee, c.owner, c.feeBps, c.holderFeeBps, c.maxStake, c.maxBalance, c.settleWindow],
  });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) fail("vault deployment failed on the fork");
  return r.contractAddress;
}

// ---- a whole match (local chain or fork) --------------------------------------------------------------------------

export type SmokeGas = { deposit: bigint; openSession: bigint; lock: bigint; settle: bigint; withdraw: bigint };

/**
 * deposit -> session -> lock -> referee settle -> withdraw with dev keys, checking every balance against docs/WAGER.md
 * §3.5. On a fork `fund` gives the players tokens; on a local chain the test token's faucet wallet sends them.
 */
async function smokeMatch(
  url: string, chain: Chain, vault: Address, token: Address, info: TokenInfo, fund: (to: Address, amount: bigint) => Promise<void>, refereeKey: Hex,
): Promise<SmokeGas> {
  const pc = createPublicClient({ chain, transport: http(url) });
  const tc = createTestClient({ chain, mode: "anvil", transport: http(url) });
  const acct = (i: number) => privateKeyToAccount(ANVIL_KEYS[i]);
  const [a, b, ka, kb, relayer] = [acct(ANVIL_ROLES.playerA), acct(ANVIL_ROLES.playerB), acct(ANVIL_ROLES.sessionA), acct(ANVIL_ROLES.sessionB), acct(ANVIL_ROLES.relayer)];
  for (const x of [a, b, relayer]) await tc.setBalance({ address: x.address, value: 10n ** 20n });
  const abi = gameVaultAbiLoose();
  const read = <T>(functionName: string, args: unknown[] = []) => pc.readContract({ address: vault, abi, functionName, args }) as Promise<T>;
  const send = async (from: PrivateKeyAccount, fn: string, args: unknown[], to: Address = vault, useAbi: Abi = abi) => {
    const wc = createWalletClient({ chain, transport: http(url), account: from });
    const hash = await wc.writeContract({ address: to, abi: useAbi, functionName: fn as never, args: args as never, account: from, chain });
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") fail(`${fn} reverted in the smoke match`);
    return r;
  };
  const unit = 10n ** BigInt(info.decimals);
  const deposit = 1_000n * unit;
  const stake = (await read<bigint>("maxStake")) < 100n * unit ? await read<bigint>("maxStake") : 100n * unit;
  const [freeA0, freeB0] = [await read<bigint>("freeOf", [a.address]), await read<bigint>("freeOf", [b.address])];
  const house0 = await read<bigint>("houseAccrued");
  const gas: Partial<SmokeGas> = {};
  for (const p of [a, b]) {
    await fund(p.address, deposit);
    await send(p, "approve", [vault, deposit], token, erc20Abi);
    gas.deposit = (await send(p, "deposit", [deposit])).gasUsed;
  }
  const chainId = chain.id;
  const now = BigInt((await pc.getBlock()).timestamp);
  for (const [p, k] of [[a, ka], [b, kb]] as const) {
    const auth: SessionAuth = { player: p.address, sessionKey: k.address, maxStake: stake, cap: 10n * stake, expiry: now + 3n * 86_400n, nonce: BigInt(await read<bigint>("sessionNonce", [p.address])) };
    const sig = await p.signTypedData(sessionAuthTypedData(chainId, vault, auth));
    gas.openSession = (await send(relayer, "openSession", [auth, sig])).gasUsed;
  }
  const matchId = keccak256(toHex(`smoke:${Date.now()}:${Math.random()}`));
  const rules = keccak256(toHex("radrun-spidertag smoke"));
  const deadline = now + 600n;
  const ea: Entry = { matchId, player: a.address, opponent: b.address, stake, feeCapBps: MAX_FEE_BPS, roundSeconds: 90, rules, deadline };
  const eb: Entry = { matchId, player: b.address, opponent: a.address, stake, feeCapBps: MAX_FEE_BPS, roundSeconds: 90, rules, deadline };
  const sigA = await ka.signTypedData(entryTypedData(chainId, vault, ea));
  const sigB = await kb.signTypedData(entryTypedData(chainId, vault, eb));
  gas.lock = (await send(relayer, "lock", [ea, sigA, eb, sigB])).gasUsed;
  const m = await read<{ feeBps: number; state: number }>("matchOf", [matchId]);
  if (m.state !== 1) fail("the smoke match did not lock");
  const result: Result = { matchId, outcome: OUTCOME_WIN, winner: a.address, feeBps: m.feeBps, logHash: keccak256(toHex("smoke log")) };
  const rsig = await privateKeyToAccount(refereeKey).signTypedData(resultTypedData(chainId, vault, result));
  gas.settle = (await send(relayer, "settle", [result, rsig])).gasUsed;
  const p = payout(stake, m.feeBps);
  const [freeA, freeB] = [await read<bigint>("freeOf", [a.address]), await read<bigint>("freeOf", [b.address])];
  if (freeA - freeA0 !== deposit - stake + p.winner || freeB - freeB0 !== deposit - stake || (await read<bigint>("houseAccrued")) - house0 !== p.fee) {
    fail("smoke match balances are off");
  }
  for (const [pl, f] of [[a, freeA], [b, freeB]] as const) {
    const before = await pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [pl.address] });
    gas.withdraw = (await send(pl, "withdraw", [f])).gasUsed;
    const after = await pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [pl.address] });
    if (after - before !== f) fail("a smoke withdrawal was not exact");
  }
  const liab = await read<bigint>("totalLiabilities");
  const held = await pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
  if (held < liab) fail("the vault is short after the smoke match");
  log(`  smoke match: ${formatUnits(stake, info.decimals)} ${info.symbol} each, fee ${m.feeBps / 100}% -> winner +${formatUnits(p.winner, info.decimals)}, house +${formatUnits(p.fee, info.decimals)}; both withdrew exactly`);
  return gas as SmokeGas;
}

function reportGas(g: SmokeGas): void {
  const row = (k: keyof typeof GAS_TARGETS) => `${k} ${g[k]}${g[k] > GAS_TARGETS[k] ? ` (over the ${GAS_TARGETS[k]} target)` : ""}`;
  log(`  gas (receipts): ${row("deposit")}, ${row("openSession")}, ${row("lock")}, ${row("settle")}, withdraw ${g.withdraw}`);
}

// ---- commands -----------------------------------------------------------------------------------------------------

const toUnits = (s: Settings, decimals: number) => ({ maxStake: parseUnits(s.maxStake, decimals), maxBalance: parseUnits(s.maxBalance, decimals) });

async function deployLocal(args: Args): Promise<void> {
  const d = DEPLOYMENTS.local;
  const rpc = pickRpc(d, args);
  const { keys, settings } = localKeysAndSettings(args);
  checkSettings(settings);
  const chain = chainOf(d, rpc);
  const pc = createPublicClient({ chain, transport: http(rpc) });
  const id = await pc.getChainId().catch(() => fail(`no chain at ${rpc}: start anvil (anvil --port <port> --chain-id 31337)`));
  if (id !== d.chainId) fail(`${rpc} is chain ${id}, not ${d.chainId}`);
  forgeBuild();
  const decimals = settings.token ? (await tokenInfo(pc as PublicClient, settings.token)).decimals : 18;
  const units = toUnits(settings, decimals);
  const out = forgeDeploy(rpc, id, keys.deployerKey, settings, units, false);
  await checkVault(pc as PublicClient, out.vault, settings, out.token, units);
  const info = await tokenInfo(pc as PublicClient, out.token);
  log(`local: ${info.symbol} ${out.token}, GameVault ${out.vault} (block ${out.deployBlock})`);
  log(`  roles: owner/deployer anvil #0, players #1 #2 (session keys #3 #4), faucet #6, house #7, referee #8, relayer #9`);
  if (args.smoke) {
    const faucet = privateKeyToAccount(ANVIL_KEYS[ANVIL_ROLES.faucet]);
    const fund = async (to: Address, amount: bigint) => {
      const wc = createWalletClient({ chain, transport: http(rpc), account: faucet });
      await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: out.token, abi: erc20Abi, functionName: "transfer", args: [to, amount], account: faucet, chain }) });
    };
    reportGas(await smokeMatch(rpc, chain, out.vault, out.token, info, fund, ANVIL_KEYS[ANVIL_ROLES.referee]));
  }
  if (!args["no-write"]) writeDeployment("local", { vault: out.vault, token: out.token, deployBlock: out.deployBlock }, str(args, "out"));
}

/** The RPC a fork reads from: a public one (anvil takes it on its command line, so never a keyed URL). */
function forkRpc(d: Deployment, args: Args): string {
  return str(args, "fork-rpc") ?? str(args, "rpc") ?? d.rpc[0];
}

/** Rehearses a deployment on an anvil fork of the target chain with dev keys: probe, forge script, a whole match. */
async function rehearse(net: WagerNetId, rpc: string, settings: Settings, args: Args): Promise<{ info: TokenInfo | null; units: { maxStake: bigint; maxBalance: bigint } }> {
  const d = DEPLOYMENTS[net];
  const port = Number(str(args, "fork-port") ?? 8546);
  log(`rehearsing on an anvil fork of ${d.chainName} (port ${port}); nothing is sent to ${d.chainName}`);
  const fork = await startAnvil(port, forkRpc(d, args));
  try {
    const chain = chainOf(d, fork.url);
    const pc = createPublicClient({ chain, transport: http(fork.url) }) as PublicClient;
    const tc = createTestClient({ chain, mode: "anvil", transport: http(fork.url) });
    if ((await pc.getChainId()) !== d.chainId) fail(`the fork is not chain ${d.chainId}`);
    const dev = (i: number) => privateKeyToAccount(ANVIL_KEYS[i]);
    for (const i of [ANVIL_ROLES.deployer, ANVIL_ROLES.faucet]) await tc.setBalance({ address: dev(i).address, value: 10n ** 20n });
    const holder = str(args, "holder") ? asAddress(str(args, "holder"), "--holder") : undefined;
    let info: TokenInfo | null = null;
    if (settings.token) {
      info = await tokenInfo(pc, settings.token);
      log(`  token ${info.name} (${info.symbol}), ${info.decimals} decimals, supply ${formatUnits(info.totalSupply, info.decimals)}${info.pons ? ", a pons v2 token" : ""}`);
      if (info.totalSupply > 2n ** 128n - 1n) fail("the token's supply does not fit the vault's 128-bit accounting");
      const pr = await probeToken(fork.url, chain, settings.token, info, holder);
      for (const n of pr.notes) log(`  probe: ${n}`);
      if (!pr.exactUnit || !pr.exactWhole) fail("the token does not move exact amounts (a transfer tax or a hook): the vault rejects it");
      if (!pr.stable) fail("the token's balances move on their own (rebasing): the vault rejects it");
      log("  probe: exact 1-unit and 1-token deposit/withdraw, balance stable across blocks and a day: OK");
    }
    const decimals = info?.decimals ?? 18;
    const units = toUnits(settings, decimals);
    // The rehearsal uses dev roles; the real referee/owner/house are checked on the real deployment.
    const devSettings: Settings = { ...settings, house: dev(ANVIL_ROLES.house).address, owner: dev(ANVIL_ROLES.deployer).address, referee: dev(ANVIL_ROLES.referee).address, faucet: dev(ANVIL_ROLES.faucet).address };
    forgeBuild();
    const out = forgeDeploy(fork.url, d.chainId, ANVIL_KEYS[ANVIL_ROLES.deployer], devSettings, units, true);
    await checkVault(pc, out.vault, devSettings, out.token, units);
    const tinfo = info ?? (await tokenInfo(pc, out.token));
    log(`  forge script: ${out.tokenDeployed ? `TestSpiderTag ${out.token}, ` : ""}GameVault ${out.vault}, ${out.gas} gas`);
    const fund = settings.token
      ? (to: Address, amount: bigint) => fundOnFork(fork.url, chain, out.token, to, amount, holder)
      : async (to: Address, amount: bigint) => {
          const f = dev(ANVIL_ROLES.faucet);
          const wc = createWalletClient({ chain, transport: http(fork.url), account: f });
          await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: out.token, abi: erc20Abi, functionName: "transfer", args: [to, amount], account: f, chain }) });
        };
    reportGas(await smokeMatch(fork.url, chain, out.vault, out.token, tinfo, fund, ANVIL_KEYS[ANVIL_ROLES.referee]));
    const gasPrice = await createPublicClient({ transport: http(rpc) }).getGasPrice().catch(() => null);
    if (gasPrice) log(`  ${d.chainName} gas price now ${formatUnits(gasPrice, 9)} gwei: deploying costs about ${formatUnits(out.gas * gasPrice, 18)} ETH (plus the L1 data fee)`);
    return { info, units };
  } finally {
    fork.stop();
  }
}

function verifySource(net: WagerNetId, chainId: number, what: { name: "GameVault" | "TestSpiderTag"; address: Address; args: Hex }): void {
  for (const v of VERIFIERS[net] ?? []) {
    const cli = ["verify-contract", what.address, `src/${what.name}.sol:${what.name}`, "--chain", String(chainId), "--constructor-args", what.args, "--watch", "--verifier", v.kind];
    if (v.url) cli.push("--verifier-url", v.url);
    const r = spawnSync(foundryBin("forge"), cli, { cwd: CONTRACTS, encoding: "utf8" });
    if (r.status === 0) return log(`  verified ${what.name} on ${v.kind}`);
    log(`  ${v.kind} verification of ${what.name} failed; trying the next verifier`);
  }
  log(`  could not verify ${what.name}: run forge verify-contract by hand (contracts/README.md)`);
}

async function deployRemote(net: "rh-testnet" | "rh-mainnet", args: Args): Promise<void> {
  const d = DEPLOYMENTS[net];
  const mainnet = MAINNET_CHAIN_IDS.includes(d.chainId);
  const sendIt = args["send-it"] === true;
  const forkOnly = args["fork-only"] === true || (mainnet && !sendIt);
  let keys: Keys | null = null;
  let settings: Settings;
  let env: Record<string, string> | undefined;
  if (forkOnly && mainnet) {
    // The dry run needs no key file: the owner's addresses and caps come from flags.
    const token = str(args, "token") ?? fail("--token <the coin's address> is required");
    settings = {
      token: asAddress(token, "--token"), house: asAddress(str(args, "house"), "--house"), owner: asAddress(str(args, "owner"), "--owner"),
      referee: privateKeyToAccount(ANVIL_KEYS[ANVIL_ROLES.referee]).address, faucet: null,
      feeBps: Number(str(args, "fee-bps") ?? DEFAULT_FEE_BPS), holderFeeBps: Number(str(args, "holder-fee-bps") ?? DEFAULT_HOLDER_FEE_BPS),
      maxStake: str(args, "max-stake") ?? fail("--max-stake (whole tokens) is required"), maxBalance: str(args, "max-balance") ?? fail("--max-balance (whole tokens) is required"),
      settleWindow: Number(str(args, "settle-window") ?? 86_400),
    };
  } else {
    const r = fileKeysAndSettings(net, args);
    ({ keys, settings, env } = r);
  }
  checkSettings(settings);
  if (mainnet && !settings.token) fail("a mainnet vault needs the owner's token (--token); the test token is never deployed there");
  const rpc = pickRpc(d, args, env);
  const real = createPublicClient({ chain: chainOf(d, rpc), transport: http(rpc) }) as PublicClient;
  const id = await real.getChainId().catch(() => fail(`cannot reach ${rpc}`));
  if (id !== d.chainId) fail(`${rpc} is chain ${id}, not ${d.chainName} (${d.chainId})`);

  const { units } = await rehearse(net, rpc, settings, args);
  log(`plan for ${d.chainName}:`);
  log(`  token ${settings.token ?? "TestSpiderTag (new; the whole supply to the faucet wallet)"}`);
  log(`  house ${settings.house}, owner ${settings.owner}, referee ${keys ? settings.referee : `from REFEREE_KEY in ${keyFile(net)}`}`);
  log(`  fees ${settings.feeBps} / ${settings.holderFeeBps} bps (holder), caps: stake ${settings.maxStake}, balance ${settings.maxBalance} tokens, settle window ${settings.settleWindow} s`);
  if (forkOnly) {
    log(mainnet ? "dry run only: nothing was signed or sent. Deploying needs the owner's go-ahead: add --send-it." : "fork rehearsal only (--fork-only): nothing was sent.");
    return;
  }
  if (!keys) fail("no keys");
  const bal = await real.getBalance({ address: keys.deployer.address });
  log(`deployer ${keys.deployer.address} holds ${formatUnits(bal, 18)} ETH on ${d.chainName}`);
  if (bal === 0n) fail(`fund the deployer ${keys.deployer.address} with a little ETH on ${d.chainName} first`);
  forgeBuild();
  const out = forgeDeploy(rpc, id, keys.deployerKey, settings, units, mainnet && sendIt);
  await checkVault(real, out.vault, settings, out.token, units);
  log(`deployed on ${d.chainName}: ${out.tokenDeployed ? `TestSpiderTag ${out.token}, ` : ""}GameVault ${out.vault} (block ${out.deployBlock})`);
  const vaultArgs = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint16" }, { type: "uint16" }, { type: "uint128" }, { type: "uint128" }, { type: "uint32" }],
    [out.token, settings.house, settings.referee, settings.owner, settings.feeBps, settings.holderFeeBps, units.maxStake, units.maxBalance, settings.settleWindow],
  );
  verifySource(net, id, { name: "GameVault", address: out.vault, args: vaultArgs });
  if (out.tokenDeployed && settings.faucet) verifySource(net, id, { name: "TestSpiderTag", address: out.token, args: encodeAbiParameters([{ type: "address" }], [settings.faucet]) });
  if (!args["no-write"]) writeDeployment(net, { vault: out.vault, token: out.token, deployBlock: out.deployBlock }, str(args, "out"));
  log("next: deploy the wager relay with its secrets and rebuild the site with VITE_WAGER_NETS (docs/WAGER.md §11)");
}

async function probeCommand(net: WagerNetId, args: Args): Promise<void> {
  const d = DEPLOYMENTS[net];
  const token = asAddress(str(args, "token"), "--token");
  forgeBuild();
  const fork = await startAnvil(Number(str(args, "fork-port") ?? 8546), forkRpc(d, args));
  try {
    const chain = chainOf(d, fork.url);
    const pc = createPublicClient({ chain, transport: http(fork.url) }) as PublicClient;
    const info = await tokenInfo(pc, token);
    log(`${info.name} (${info.symbol}), ${info.decimals} decimals, supply ${formatUnits(info.totalSupply, info.decimals)}${info.pons ? ", a pons v2 token" : ""}`);
    const holder = str(args, "holder") ? asAddress(str(args, "holder"), "--holder") : undefined;
    const r = await probeToken(fork.url, chain, token, info, holder);
    for (const n of r.notes) log(`  ${n}`);
    log(`exact 1 unit: ${r.exactUnit}, exact 1 token: ${r.exactWhole}, no rebasing: ${r.stable}`);
    if (!(r.exactUnit && r.exactWhole && r.stable)) fail("the vault can't take this token");
  } finally {
    fork.stop();
  }
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.abi || args["abi-check"]) return abiCommand(args["abi-check"] === true);
  const net = str(args, "net");
  if (!isWagerNet(net)) fail(`--net must be one of local, rh-testnet, rh-mainnet`);
  if (args["init-keys"]) return initKeys(net);
  if (args.probe) return probeCommand(net, args);
  if (net === "local") return deployLocal(args);
  return deployRemote(net, args);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`wager-deploy: ${e instanceof Error ? e.message : String(e)}`);
    stopAnvils();
    process.exit(1);
  });
}
