// SPIDER-TAG wager, the contracts lane's checks that run without Foundry (docs/WAGER.md §9.1): the generated ABI module
// matches the forge build (when one exists) and covers the frozen interface, the Solidity EIP-712 test vectors equal
// what src/wager/eip712.ts computes, and the deploy tool's pure helpers (deployments.json style, settings checks).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gameVaultAbi } from "../src/wager/vaultAbi.ts";
import { entryDigest, entryTypedData, resultDigest, resultTypedData, sessionAuthDigest, sessionAuthTypedData, type Entry, type Result, type SessionAuth } from "../src/wager/eip712.ts";
import { DEPLOYMENTS } from "../src/wager/config.ts";
import {
  ABI_MODULE, CONTRACTS, DEPLOYMENTS_FILE, DeployError, checkSettings, formatDeployments, parseArgs, renderAbiModule, toUnits, withDeployment, type Settings,
} from "../tools/wager-deploy.ts";

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("vaultAbi.ts: matches the forge build (skipped without contracts/out)", t => {
  const artifact = `${CONTRACTS}/out/GameVault.sol/GameVault.json`;
  if (!fs.existsSync(artifact)) return t.skip("no forge build: run npm run wager:contracts");
  const built = JSON.parse(fs.readFileSync(artifact, "utf8")).abi;
  assert.equal(fs.readFileSync(ABI_MODULE, "utf8"), renderAbiModule(built), "run: npm run wager:deploy -- --abi");
  assert.deepEqual(gameVaultAbi, built);
});

test("vaultAbi.ts: every function, event and error of IGameVault.sol is in it", () => {
  const sol = read("../contracts/src/interfaces/IGameVault.sol");
  const names = (kind: string) => [...sol.matchAll(new RegExp(`^\\s*${kind} (\\w+)\\(`, "gm"))].map(m => m[1]);
  const inAbi = (type: string) => new Set<string>(gameVaultAbi.filter(i => i.type === type).map(i => ("name" in i ? i.name : "")));
  for (const [kind, type] of [["function", "function"], ["event", "event"], ["error", "error"]] as const) {
    const want = names(kind);
    assert.ok(want.length > 5, `parsed ${kind}s`);
    for (const n of want) assert.ok(inAbi(type).has(n), `${kind} ${n}`);
  }
  // The owner surface the interface doesn't list, from OpenZeppelin.
  for (const n of ["owner", "pendingOwner", "transferOwnership", "acceptOwnership", "paused", "eip712Domain"]) assert.ok(inAbi("function").has(n), n);
});

test("EIP-712: the Solidity vectors (contracts/test/Eip712Vectors.t.sol) equal eip712.ts", async () => {
  const sol = read("../contracts/test/Eip712Vectors.t.sol");
  const constant = (name: string) => {
    const m = new RegExp(`${name}\\s*=\\s*(?:hex")?(0x)?([0-9a-fA-F]+)"?;`, "m").exec(sol);
    assert.ok(m, name);
    return `0x${m[2].toLowerCase()}`;
  };
  const alice = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const vault = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
  const chain = 31337;
  const e: Entry = {
    matchId: `0x${"11".repeat(32)}`, player: alice.address, opponent: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", stake: 10n ** 21n,
    feeCapBps: 300, roundSeconds: 90, rules: `0x${"22".repeat(32)}`, deadline: 1_900_000_000n,
  };
  const r: Result = { matchId: `0x${"11".repeat(32)}`, outcome: 1, winner: alice.address, feeBps: 150, logHash: `0x${"33".repeat(32)}` };
  const a: SessionAuth = {
    player: alice.address, sessionKey: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", maxStake: 5n * 10n ** 20n, cap: 5n * 10n ** 21n,
    expiry: 1_900_000_000n, nonce: 0n,
  };
  assert.equal(entryDigest(chain, vault, e), constant("VECTOR_ENTRY_DIGEST"));
  assert.equal(resultDigest(chain, vault, r), constant("VECTOR_RESULT_DIGEST"));
  assert.equal(sessionAuthDigest(chain, vault, a), constant("VECTOR_AUTH_DIGEST"));
  assert.equal(await alice.signTypedData(entryTypedData(chain, vault, e)), constant("VECTOR_ENTRY_SIG"));
  assert.equal(await alice.signTypedData(resultTypedData(chain, vault, r)), constant("VECTOR_RESULT_SIG"));
  assert.equal(await alice.signTypedData(sessionAuthTypedData(chain, vault, a)), constant("VECTOR_AUTH_SIG"));
});

test("deploy tool: deployments.json keeps its style, and a deploy changes one network only", () => {
  const text = fs.readFileSync(DEPLOYMENTS_FILE, "utf8");
  const table = JSON.parse(text);
  assert.equal(formatDeployments(table), text, "formatDeployments reproduces the committed file");
  const next = withDeployment(table, "rh-testnet", { vault: "0x00000000000000000000000000000000000000aa", token: "0x00000000000000000000000000000000000000bb", deployBlock: 7 });
  assert.equal(next["rh-testnet"].vault, getAddress("0x00000000000000000000000000000000000000aa"));
  assert.equal(next["rh-testnet"].deployBlock, 7);
  assert.deepEqual(next["rh-testnet"].rpc, DEPLOYMENTS["rh-testnet"].rpc);
  assert.deepEqual(next.local, table.local);
  assert.deepEqual(next["rh-mainnet"], table["rh-mainnet"]);
  const again = JSON.parse(formatDeployments(next));
  assert.deepEqual(again, next);
});

test("deploy tool: argument parsing and settings bounds", () => {
  assert.deepEqual(parseArgs(["--net", "rh-mainnet", "--token=0xabc", "--send-it", "--max-stake", "100"]), {
    net: "rh-mainnet", token: "0xabc", "send-it": true, "max-stake": "100",
  });
  // An inline value keeps every "=" after the first (a keyed RPC URL has them in its query).
  assert.deepEqual(parseArgs(["--rpc=https://rpc.example/v1?key=a=b", "--net=local"]), { rpc: "https://rpc.example/v1?key=a=b", net: "local" });
  const ok: Settings = {
    token: null, house: getAddress("0x00000000000000000000000000000000000000aa"), owner: getAddress("0x00000000000000000000000000000000000000aa"),
    referee: getAddress("0x00000000000000000000000000000000000000aa"), faucet: null, feeBps: 300, holderFeeBps: 150, maxStake: "100", maxBalance: "1000",
    settleWindow: 86_400,
  };
  checkSettings(ok);
  for (const bad of [{ feeBps: 501 }, { holderFeeBps: -1 }, { settleWindow: 60 }, { settleWindow: 8 * 86_400 }, { maxStake: "0" }, { maxBalance: "lots" }]) {
    assert.throws(() => checkSettings({ ...ok, ...bad }), DeployError, JSON.stringify(bad));
  }
  // The caps in base units: nonzero at the token's decimals and within the vault's uint128, before anything deploys.
  assert.deepEqual(toUnits(ok, 6), { maxStake: 100_000_000n, maxBalance: 1_000_000_000n });
  assert.throws(() => toUnits({ ...ok, maxStake: "0.0000001" }, 6), DeployError, "rounds to 0 base units");
  assert.throws(() => toUnits({ ...ok, maxBalance: `1${"0".repeat(30)}` }, 18), DeployError, "past uint128");
  assert.equal(toUnits({ ...ok, maxBalance: (2n ** 128n - 1n).toString() }, 0).maxBalance, 2n ** 128n - 1n);
});
