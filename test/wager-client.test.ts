// The ?wager client (docs/WAGER.md §7, §9.3) with a mocked chain and relay (test/wager-client-fakes.ts), all in
// process: deployment choice, amounts in the token's decimals, session-key defaults and limits, EIP-6963 discovery,
// the chain add / switch fallback, plain error messages, the ABI against the Solidity interface, the vault reads and
// writes and the event history, the lobby socket's login, the series room client, and the page controller end to end
// (faucet, approve exactly, deposit, session key, create, join, lock, settle, withdraw) including its error states.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ContractFunctionExecutionError, ContractFunctionRevertedError, createPublicClient, createWalletClient, custom, encodeErrorResult, getAddress,
  recoverTypedDataAddress, type Address, type Hex, type PublicClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { applyTuningJson } from "../src/sim/tuning.ts";
import { CityIndex, type CityModel } from "../src/world/cityModel.ts";
import { chooseDeployment, keepParams } from "../src/wager/site.ts";
import { DEPLOYMENTS } from "../src/wager/config.ts";
import { bpsText, clockText, formatAmount, parseAddress, parseAmount, parseHex32, relTime, shortAddress } from "../src/wager/units.ts";
import { SESSION_DEFAULTS, checkSession, liveSession, loadSessionKey, memoryStore, newSessionKey, sessionTerms } from "../src/wager/sessionKey.ts";
import { addChainParams, discoverWallets, ensureChain, viemChain, watchWallets, type Eip1193, type WalletOption } from "../src/wager/wallet.ts";
import { classifyError, isUnknownChain } from "../src/wager/errors.ts";
import { ERC20_ABI, GAME_VAULT_ABI, VAULT_CALL_ABI } from "../src/wager/abi.ts";
import { gameVaultAbi } from "../src/wager/vaultAbi.ts";
import { VaultChain } from "../src/wager/chain.ts";
import { LobbyClient, type WsFactory } from "../src/wager/relay.ts";
import { SeriesClient, type RoomTransport } from "../src/wager/series.ts";
import { WagerApp, useWager } from "../src/wager/app.ts";
import {
  MAX_SESSION_TTL_S, ZERO_ADDRESS, ZERO_HASH, entryFromJson, entryToJson, entryTypedData, loginTypedData, makeRules, newMatchId, rulesHash, resultTypedData,
  type Entry, type Result,
} from "../src/wager/eip712.ts";
import { decodeSettleCode, encodeSettleCode } from "../src/wager/mutual.ts";
import { MSG_PROBE, MSG_PROBE_ECHO, WAGER_PROTOCOL, decodeProbe, encodeProbe, type LobbyServerMsg } from "../src/wager/protocol.ts";
import { simCompat, type SeriesVerdict, type SimAssets } from "../src/wager/replay.ts";
import { matchChecks } from "../src/wager/verifyChecks.ts";
import { seriesLogHash, type SeriesLog } from "../src/wager/log.ts";
import type { MatchEnd } from "../src/wager/chain.ts";
import { sameSim } from "../src/wager/assets.ts";
import { FakeChain, FakeRelay, acct, type Sock } from "./wager-client-fakes.ts";

const E18 = 10n ** 18n;
const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const tuningJson = JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8"));
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const tuning = applyTuningJson(tuningJson).player;
const assets: SimAssets = { model, index: new CityIndex(model), tuning, tag: tuningJson.tag };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(f: () => boolean, what: string, ms = 8000) {
  const t0 = Date.now();
  while (!f()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await tick(5); }
}

// ---- pure pieces ------------------------------------------------------------------------------------------------------

test("deployments: VITE_WAGER_NETS picks what a build offers (unset = off); &net only among them in production; dev overrides", () => {
  assert.equal(chooseDeployment({ nets: undefined, search: "?wager", dev: false }).off, "wager matches aren't switched on for this build");
  const t = chooseDeployment({ nets: "rh-testnet", search: "?wager", dev: false });
  assert.equal(t.dep?.net, "rh-testnet");
  assert.equal(t.dep?.label, "BETA · TESTNET");
  assert.equal(t.relay, DEPLOYMENTS["rh-testnet"].relay);
  assert.deepEqual(t.rpc, DEPLOYMENTS["rh-testnet"].rpc);
  assert.equal(t.off, null);
  // Production: &net can't reach a deployment the build doesn't offer; &relay / &rpc are ignored.
  const p = chooseDeployment({ nets: "rh-testnet", search: "?wager&net=local&relay=http://evil&rpc=http://evil", dev: false });
  assert.equal(p.dep?.net, "rh-testnet");
  assert.equal(p.relay, DEPLOYMENTS["rh-testnet"].relay);
  const two = chooseDeployment({ nets: "rh-mainnet,rh-testnet", search: "?wager&net=rh-testnet", dev: false });
  assert.equal(two.dep?.net, "rh-testnet");
  assert.equal(two.offered.length, 2);
  // The build's relay / RPC overrides apply to the default deployment only.
  const o = chooseDeployment({ nets: "rh-mainnet,rh-testnet", relayEnv: "https://r.example/", rpcEnv: "https://a,https://b", search: "?wager", dev: false });
  assert.equal(o.dep?.net, "rh-mainnet");
  assert.equal(o.relay, "https://r.example");
  assert.deepEqual(o.rpc, ["https://a", "https://b"]);
  assert.equal(chooseDeployment({ nets: "rh-mainnet,rh-testnet", relayEnv: "https://r.example", search: "?wager&net=rh-testnet", dev: false }).relay, DEPLOYMENTS["rh-testnet"].relay);
  // Dev: any deployment, and &relay / &rpc.
  const d = chooseDeployment({ nets: undefined, search: "?wager&net=local&relay=http://127.0.0.1:5422/&rpc=http://127.0.0.1:5421", dev: true });
  assert.equal(d.dep?.net, "local");
  assert.equal(d.relay, "http://127.0.0.1:5422");
  assert.deepEqual(d.rpc, ["http://127.0.0.1:5421"]);
  assert.equal(keepParams("?wager&net=rh-testnet&devwallet=1&x=2", false), "&net=rh-testnet");
  assert.equal(keepParams("?wager&net=local&devwallet=1&x=2", true), "&net=local&devwallet=1");
});

test("amounts: parsed and shown in the token's own decimals (18, 6, 0), cut never rounded up", () => {
  assert.equal(parseAmount("1", 18), E18);
  assert.equal(parseAmount("1.5", 18), 15n * 10n ** 17n);
  assert.equal(parseAmount("1,000.25", 6), 1_000_250_000n);
  assert.equal(parseAmount(".5", 6), 500_000n);
  assert.equal(parseAmount("12.", 0), 12n);
  assert.equal(parseAmount("1.0000001", 6), null, "more decimals than the token has");
  assert.equal(parseAmount("abc", 18), null);
  assert.equal(parseAmount("-1", 18), null);
  assert.equal(parseAmount("", 18), null);
  assert.equal(formatAmount(1_094n * E18, 18), "1,094");
  assert.equal(formatAmount(194n * E18 + 999_999n * 10n ** 12n, 18), "194.9999");
  assert.equal(formatAmount(1n, 18), "<0.0001");
  assert.equal(formatAmount(0n, 18), "0");
  assert.equal(formatAmount(1_500_000n, 6, 2), "1.5");
  assert.equal(formatAmount(7n, 0), "7");
  assert.equal(bpsText(300), "3%");
  assert.equal(bpsText(150), "1.5%");
  assert.equal(bpsText(0), "0%");
  assert.equal(shortAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x1234…5678");
  assert.equal(parseAddress(" 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 "), "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  assert.equal(parseAddress("0x123"), null);
  assert.equal(parseHex32(`0x${"Ab".repeat(32)}`), `0x${"ab".repeat(32)}`);
  assert.equal(parseHex32("0x12"), null);
  assert.equal(clockText(65), "1:05");
  assert.equal(relTime(1000 + 7200, 1000), "in 2 h");
  assert.equal(relTime(1000 - 90, 1000), "2 min ago");
});

test("session keys: defaults (cap 3x, 12 hours, clamped to the vault), the limits the vault checks, saved only after signing", () => {
  const now = 1_900_000_000;
  const t = sessionTerms(100n * E18, 1000n * E18, now);
  assert.equal(t.maxStake, 100n * E18);
  assert.equal(t.cap, 300n * E18, "a copied key can lose at most its cap: small by default");
  assert.equal(SESSION_DEFAULTS.capTimes, 3n);
  assert.equal(t.expiry, BigInt(now + 12 * 3600));
  assert.equal(sessionTerms(5000n * E18, 1000n * E18, now).maxStake, 1000n * E18, "clamped to the vault's maxStake");
  assert.ok(sessionTerms(1n, 10n, now, { ttlS: 90 * 86_400 }).expiry < BigInt(now + MAX_SESSION_TTL_S), "never past 30 days");
  assert.throws(() => sessionTerms(0n, 10n, now));
  const u128 = 2n ** 128n - 1n;
  assert.equal(sessionTerms(u128, u128, now).cap, u128, "a vault with no stake cap: the total stays a uint128");
  const key = acct(5).address, other = acct(6).address;
  const on = { key, expiry: BigInt(now + 3600), maxStake: 100n, cap: 300n, used: 250n };
  assert.equal(checkSession(null, key, 10n, now).ok, false);
  assert.deepEqual(checkSession({ ...on, key: "0x0000000000000000000000000000000000000000" }, key, 10n, now), { ok: false, why: "none", text: checkSession(null, key, 1n, now).ok ? "" : (checkSession(null, key, 1n, now) as { text: string }).text });
  assert.equal((checkSession(on, other, 10n, now) as { why: string }).why, "other-key");
  assert.equal((checkSession(on, null, 10n, now) as { why: string }).why, "other-key");
  assert.equal((checkSession({ ...on, expiry: BigInt(now + 60) }, key, 10n, now) as { why: string }).why, "expired");
  assert.equal((checkSession(on, key, 101n, now) as { why: string }).why, "max-stake");
  assert.equal((checkSession(on, key, 51n, now) as { why: string }).why, "cap");
  assert.deepEqual(checkSession(on, key, 50n, now), { ok: true });
  assert.equal(liveSession(on, key, now), true);
  assert.equal(liveSession(on, other, now), false);
  const store = memoryStore(), vault = DEPLOYMENTS.local.rpc[0] ? ("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" as Address) : ("0x" as Address);
  const me = acct(1).address;
  const k = newSessionKey(store, 31337, vault, me);
  assert.equal(loadSessionKey(store, 31337, vault, me), null, "not kept until the wallet signed");
  k.save();
  assert.equal(loadSessionKey(store, 31337, vault, me)?.address, k.account.address);
  assert.equal(loadSessionKey(store, 46630, vault, me), null, "per chain");
});

class Host extends EventTarget { ethereum?: unknown; }
const fakeProvider = (name: string): Eip1193 => ({ request: async () => name });

test("EIP-6963: every announced wallet is listed (late ones too, no duplicates); window.ethereum is the fallback", async () => {
  const h = new Host();
  const pA = fakeProvider("a"), pB = fakeProvider("b");
  h.addEventListener("eip6963:requestProvider", () => {
    h.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u-a", name: "Alpha", icon: "data:,", rdns: "a.test" }, provider: pA } }));
  });
  let seen: WalletOption[] = [];
  const stop = watchWallets(h as never, l => { seen = l; }, 50);
  assert.equal(seen[0]?.info.name, "Alpha");
  h.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u-b", name: "Beta", icon: "", rdns: "b.test" }, provider: pB } }));
  h.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u-a", name: "Alpha", icon: "", rdns: "a.test" }, provider: pA } }));
  h.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "bad" }, provider: {} } }));
  assert.deepEqual(seen.map(w => w.info.name), ["Alpha", "Beta"]);
  stop();
  const bare = new Host();
  bare.ethereum = fakeProvider("injected");
  const l = await discoverWallets(bare as never, 120);
  assert.equal(l.length, 1);
  assert.equal(l[0].info.name, "Browser wallet");
  assert.equal(await l[0].provider.request({ method: "x" }), "injected");
  assert.deepEqual(await discoverWallets(new Host() as never, 80), []);
});

type Call = { method: string; params?: unknown };
function chainWallet(start: number, behaviour: "4902" | "wrapped" | "reject" | "known") {
  let chain = start;
  const calls: Call[] = [];
  const p: Eip1193 = {
    request: async ({ method, params }) => {
      calls.push({ method, params });
      if (method === "eth_chainId") return `0x${chain.toString(16)}`;
      if (method === "wallet_switchEthereumChain") {
        const want = Number.parseInt((params as { chainId: string }[])[0].chainId, 16);
        if (behaviour === "reject") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        if (behaviour !== "known" && !calls.some(c => c.method === "wallet_addEthereumChain")) {
          if (behaviour === "wrapped") throw Object.assign(new Error("Internal"), { code: -32603, data: { originalError: { code: 4902 } } });
          throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
        }
        chain = want;
        return null;
      }
      if (method === "wallet_addEthereumChain") return null; // adds, doesn't switch
      throw new Error(method);
    },
  };
  return { p, calls };
}

test("chain: switch, or add on 4902 (also wrapped in -32603) then switch; a refusal is 'rejected'; already there = no popup", async () => {
  const dep = DEPLOYMENTS["rh-testnet"];
  for (const b of ["4902", "wrapped"] as const) {
    const w = chainWallet(1, b);
    await ensureChain(w.p, dep);
    const ms = w.calls.map(c => c.method).filter(m => m !== "eth_chainId");
    assert.deepEqual(ms, ["wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain"], b);
    const add = w.calls.find(c => c.method === "wallet_addEthereumChain")!.params as ReturnType<typeof addChainParams>[];
    assert.equal(add[0].chainId, "0xb626");
    assert.equal(add[0].chainName, "Robinhood Chain Testnet");
    assert.deepEqual(add[0].nativeCurrency, { name: "Ether", symbol: "ETH", decimals: 18 });
    assert.deepEqual(add[0].blockExplorerUrls, [dep.explorer]);
  }
  const k = chainWallet(1, "known");
  await ensureChain(k.p, dep);
  assert.deepEqual(k.calls.map(c => c.method).filter(m => m !== "eth_chainId"), ["wallet_switchEthereumChain"]);
  const there = chainWallet(46630, "known");
  await ensureChain(there.p, dep);
  assert.deepEqual(there.calls.map(c => c.method), ["eth_chainId"]);
  const r = chainWallet(1, "reject");
  await assert.rejects(ensureChain(r.p, dep), (e: unknown) => classifyError(e).kind === "rejected");
  assert.equal(isUnknownChain({ code: 4902 }), true);
  assert.equal(viemChain(dep).id, 46630);
});

test("errors: wallet refusals, gas, network and the vault's custom errors as one plain sentence", async () => {
  assert.equal(classifyError(Object.assign(new Error("User rejected the request."), { code: 4001 })).kind, "rejected");
  assert.equal(classifyError(new Error("insufficient funds for gas * price + value")).kind, "gas");
  assert.equal(classifyError(new TypeError("Failed to fetch")).kind, "network");
  // A real simulate against the fake vault: its revert data decodes to the error name.
  const fake = new FakeChain();
  const pub = createPublicClient({ chain: viemChain({ chainId: 31337, chainName: "Local anvil", rpc: ["http://x"], explorer: null }), transport: custom(fake.eip1193) });
  const e1 = await pub.simulateContract({ address: fake.vault, abi: GAME_VAULT_ABI, functionName: "withdraw", args: [5n], account: acct(1).address }).catch(e => e);
  assert.deepEqual(classifyError(e1), { kind: "funds", message: "not enough free balance in the vault" });
  const e2 = await pub.simulateContract({ address: fake.vault, abi: VAULT_CALL_ABI, functionName: "deposit", args: [5n], account: acct(1).address }).catch(e => e);
  assert.equal(classifyError(e2).kind, "allowance");
  fake.paused = true;
  const e3 = await pub.simulateContract({ address: fake.vault, abi: GAME_VAULT_ABI, functionName: "deposit", args: [5n], account: acct(1).address }).catch(e => e);
  assert.equal(classifyError(e3).kind, "paused");
});

test("ABI: every function, event and error of IGameVault.sol is in the vault ABI the client calls, with the same parameter types", () => {
  const sol = fs.readFileSync(new URL("../contracts/src/interfaces/IGameVault.sol", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  const structs = new Map<string, string>();
  for (const m of sol.matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
    structs.set(m[1], `(${m[2].split(";").map(f => f.trim().split(/\s+/)[0]).filter(Boolean).join(",")})`);
  }
  const norm = (t: string) => { const b = t.trim().split(/\s+/)[0]; return structs.get(b) ?? (b === "MatchState" ? "uint8" : b === "IERC20Metadata" ? "address" : b); };
  const sig = (name: string, args: string) => `${name}(${args.split(",").map(a => a.trim()).filter(Boolean).map(norm).join(",")})`;
  const want = new Set<string>();
  for (const m of sol.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/g)) want.add(`function ${sig(m[1], m[2])}`);
  for (const m of sol.matchAll(/event\s+(\w+)\s*\(([^)]*)\)/g)) want.add(`event ${sig(m[1], m[2].replace(/\bindexed\b/g, ""))}`);
  for (const m of sol.matchAll(/error\s+(\w+)\s*\(([^)]*)\)/g)) want.add(`error ${sig(m[1], m[2])}`);
  const typeOf = (p: { type: string; components?: readonly { type: string; components?: unknown }[] }): string =>
    p.type === "tuple" ? `(${(p.components ?? []).map(c => typeOf(c as never)).join(",")})` : p.type;
  const have = new Set(GAME_VAULT_ABI.filter(e => e.type !== "constructor").map(e => `${e.type} ${e.name}(${e.inputs.map(i => typeOf(i as never)).join(",")})`));
  assert.deepEqual([...want].filter(w => !have.has(w)), [], "missing from the ABI");
  assert.ok(ERC20_ABI.some(e => e.name === "approve"));
});

// ---- the chain -------------------------------------------------------------------------------------------------------

/** An in-process browser wallet for a key on the fake chain (EIP-1193: accounts, chain, typed data, transactions). */
function testWallet(a: PrivateKeyAccount, fake: FakeChain, o: { chainId?: number; reject?: boolean } = {}): Eip1193 & { chain: number } {
  const w = createWalletClient({ account: a, chain: viemChain({ chainId: fake.chainId, chainName: "Local anvil", rpc: ["http://x"], explorer: null }), transport: custom(fake.eip1193) });
  const p = {
    chain: o.chainId ?? fake.chainId,
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const q = (params ?? []) as unknown[];
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return [a.address];
        case "eth_chainId": return `0x${p.chain.toString(16)}`;
        case "wallet_switchEthereumChain": p.chain = Number.parseInt((q[0] as { chainId: string }).chainId, 16); return null;
        case "eth_signTypedData_v4": {
          if (o.reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          const td = JSON.parse(q[1] as string);
          const { EIP712Domain: _d, ...types } = td.types;
          return a.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
        }
        case "eth_sendTransaction": {
          const tx = q[0] as { to: Address; data: Hex };
          return w.sendTransaction({ to: tx.to, data: tx.data } as never);
        }
        default: return fake.request(method, q);
      }
    },
    on() {}, removeListener() {},
  };
  return p;
}

test("chain: vault and token reads, exact approve + deposit, lock, settle, history and how a match ended (tx or scan)", async () => {
  const fake = new FakeChain();
  const chain = viemChain({ chainId: 31337, chainName: "Local anvil", rpc: ["http://x"], explorer: null });
  const pub = createPublicClient({ chain, transport: custom(fake.eip1193) }) as PublicClient;
  const vc = new VaultChain(pub, fake.vault, 0);
  const info = await vc.info();
  assert.deepEqual({ symbol: info.symbol, decimals: info.decimals, house: info.houseFeeBps, holder: info.holderFeeBps }, { symbol: "tSPIDERTAG", decimals: 18, house: 300, holder: 150 });
  const [alice, bob] = [acct(1), acct(2)];
  for (const p of [alice, bob]) fake.transfer(acct(0).address, p.address, 1000n * E18);
  const wa = createWalletClient({ account: alice, chain, transport: custom(fake.eip1193) });
  const wb = createWalletClient({ account: bob, chain, transport: custom(fake.eip1193) });
  for (const w of [wa, wb]) {
    await vc.wait(await vc.approve(w, 500n * E18));
    await vc.wait(await vc.deposit(w, 500n * E18));
  }
  const b = await vc.balances(alice.address);
  assert.deepEqual({ free: b.free, wallet: b.wallet, allowance: b.allowance }, { free: 500n * E18, wallet: 500n * E18, allowance: 0n });
  // A lock with wallet-signed entries, then a referee settle.
  const rules = rulesHash(makeRules("downtown", simCompat(assets)));
  const id77 = `${alice.address.toLowerCase()}${"77".repeat(12)}` as Hex;
  const mk = (p: PrivateKeyAccount, opp: Address) => ({ matchId: id77, player: p.address, opponent: opp, stake: 100n * E18, feeCapBps: 300, roundSeconds: 90, rules, deadline: BigInt(fake.time + 600) });
  const ea = mk(alice, "0x0000000000000000000000000000000000000000"), eb = mk(bob, alice.address);
  const { entryTypedData } = await import("../src/wager/eip712.ts");
  const sa = await alice.signTypedData(entryTypedData(31337, fake.vault, ea)), sb = await bob.signTypedData(entryTypedData(31337, fake.vault, eb));
  await vc.wait(await vc.lock(wa, ea, sa, eb, sb));
  assert.equal((await vc.matchOf(ea.matchId)).state, "locked");
  const r: Result = { matchId: ea.matchId, outcome: 1, winner: alice.address, feeBps: 300, logHash: `0x${"42".repeat(32)}` };
  const sig = await acct(8).signTypedData(resultTypedData(31337, fake.vault, r));
  const tx = await vc.settle(wb, r, sig);
  await vc.wait(tx);
  assert.equal((await vc.balances(alice.address)).free, 400n * E18 + 194n * E18);
  const end = await vc.matchEnd(ea.matchId, tx);
  assert.equal(end?.kind, "settled");
  assert.equal(end && end.kind === "settled" && end.payout, 194n * E18);
  assert.equal(end && end.kind === "settled" && end.fee, 6n * E18);
  assert.equal((await vc.matchEnd(ea.matchId, null))?.logHash, r.logHash, "found by the event scan too");
  const h = await vc.history(alice.address);
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].state, "won");
  assert.equal(h.rows[0].opponent, bob.address);
  assert.equal(h.rows[0].payout, 194n * E18);
  assert.equal((await vc.history(bob.address)).rows[0].state, "lost");
  const lt = VaultChain.withLockTimes(h.rows, 86_400)[0];
  assert.equal(lt.lockedAt, lt.settleBy - 86_400);
  // A settle is refused twice (NotLocked) with a plain message.
  await assert.rejects(vc.settle(wb, r, sig), (e: unknown) => /isn't locked/.test(classifyError(e).message));
});

test("chain: match ids are their creator's, fee caps must cover the fee; cancel; reclaim after settleBy; both wallets settle", async () => {
  const fake = new FakeChain();
  const chain = viemChain({ chainId: 31337, chainName: "Local anvil", rpc: ["http://x"], explorer: null });
  const pub = createPublicClient({ chain, transport: custom(fake.eip1193) }) as PublicClient;
  const vc = new VaultChain(pub, fake.vault, 0);
  await vc.info();
  const [alice, bob] = [acct(1), acct(2)];
  const wc = (a: PrivateKeyAccount) => createWalletClient({ account: a, chain, transport: custom(fake.eip1193) });
  const [wa, wb] = [wc(alice), wc(bob)];
  for (const [p, w] of [[alice, wa], [bob, wb]] as const) {
    fake.transfer(acct(0).address, p.address, 1000n * E18);
    await vc.wait(await vc.approve(w, 500n * E18));
    await vc.wait(await vc.deposit(w, 500n * E18));
  }
  const rules = rulesHash(makeRules("downtown", simCompat(assets)));
  const pair = async (id: Hex, o: Partial<Entry> = {}) => {
    const ea: Entry = { matchId: id, player: alice.address, opponent: ZERO_ADDRESS, stake: 100n * E18, feeCapBps: 300, roundSeconds: 90, rules, deadline: BigInt(fake.time + 600), ...o };
    const eb: Entry = { ...ea, player: bob.address, opponent: alice.address, feeCapBps: 300 };
    return [ea, await alice.signTypedData(entryTypedData(31337, fake.vault, ea)), eb, await bob.signTypedData(entryTypedData(31337, fake.vault, eb))] as const;
  };
  // An id that starts with bob's address can't have alice as player A; a cap under the house fee can't lock.
  const [xa, xsa, xb, xsb] = await pair(newMatchId(bob.address));
  await assert.rejects(vc.lock(wa, xa, xsa, xb, xsb), (e: unknown) => /another player/.test(classifyError(e).message));
  const [ya, ysa, yb, ysb] = await pair(newMatchId(alice.address), { feeCapBps: 150 });
  await assert.rejects(vc.lock(wa, ya, ysa, yb, ysb), (e: unknown) => classifyError(e).kind === "version");
  // A cancelled id never locks, whoever holds its signatures; only its creator can cancel it.
  const cid = newMatchId(alice.address);
  await assert.rejects(vc.cancel(wb, cid), (e: unknown) => /another player/.test(classifyError(e).message));
  await vc.wait(await vc.cancel(wa, cid));
  assert.equal((await vc.matchOf(cid)).state, "cancelled");
  const [ca, csa, cb, csb] = await pair(cid);
  await assert.rejects(vc.lock(wa, ca, csa, cb, csb), (e: unknown) => /already locked/.test(classifyError(e).message));
  // Reclaim: after settleBy each player takes back their own stake alone; the history says so.
  const rid = newMatchId(alice.address);
  const [ra, rsa, rb, rsb] = await pair(rid);
  await vc.wait(await vc.lock(wb, ra, rsa, rb, rsb));
  await assert.rejects(vc.reclaim(wa, rid), (e: unknown) => /still open/.test(classifyError(e).message));
  fake.time += 86_400 + 10;
  await vc.wait(await vc.reclaim(wa, rid));
  assert.equal((await vc.balances(alice.address)).free, 500n * E18);
  assert.equal((await vc.balances(bob.address)).locked, 100n * E18, "bob's stake waits for bob (or a refund)");
  assert.equal((await vc.history(alice.address)).rows[0].state, "reclaimed");
  await vc.wait(await vc.reclaim(wb, rid));
  assert.equal((await vc.matchOf(rid)).state, "voided");
  // Both wallets sign one Result: settleMutual pays it (the full fee: no holder rate without the referee).
  const mid = newMatchId(alice.address);
  const [ma, msa, mb, msb] = await pair(mid);
  await vc.wait(await vc.lock(wb, ma, msa, mb, msb));
  const r: Result = { matchId: mid, outcome: 1, winner: bob.address, feeBps: 300, logHash: ZERO_HASH };
  const td = resultTypedData(31337, fake.vault, r);
  const [sa, sb] = [await alice.signTypedData(td), await bob.signTypedData(td)];
  await assert.rejects(vc.settleMutual(wa, r, sb, sa), (e: unknown) => /signature/.test(classifyError(e).message), "signatures in the wrong seats");
  await vc.wait(await vc.settleMutual(wa, r, sa, sb));
  assert.equal((await vc.balances(bob.address)).free, 500n * E18 + 94n * E18);
  const end = await vc.matchEnd(mid, null);
  assert.ok(end?.kind === "settled" && end.mutual, JSON.stringify(end, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  // The code two pages pass each other for it.
  const code = encodeSettleCode({ r, sig: sa, by: alice.address });
  assert.deepEqual(decodeSettleCode(code), { r, sig: sa, by: alice.address });
  assert.equal(decodeSettleCode("hello"), null);
  assert.equal(decodeSettleCode("radrun-settle:bm9wZQ=="), null);
});

test("named entries: a creator's page signs only its own offer's terms, naming the joiner, with a short deadline", async () => {
  const fake = new FakeChain();
  const relay = new FakeRelay({ chain: fake, net: "local", assets: { downtown: assets } });
  const base = "http://relay.test";
  relay.base = base;
  const restore = relayFetch(relay, base);
  const app = mkApp(fake, relay, base);
  try {
    await app.start();
    await until(() => !!app.lobby, "the lobby");
    const alice = acct(1);
    const said: { id: Hex; sig: Hex | null; why?: string }[] = [];
    const e: Entry = {
      matchId: newMatchId(alice.address), player: alice.address, opponent: ZERO_ADDRESS, stake: 10n * E18, feeCapBps: 300, roundSeconds: 90,
      rules: rulesHash(makeRules("downtown", simCompat(assets))), deadline: BigInt(fake.time + 1800),
    };
    const a = app as unknown as { created: Map<string, { e: Entry; district: string }>; onLobby(m: LobbyServerMsg): void; keyAcct: PrivateKeyAccount | null };
    a.created.set(e.matchId.toLowerCase(), { e, district: "downtown" });
    a.keyAcct = acct(5);
    fake.sessions.set(alice.address.toLowerCase(), { key: acct(5).address, expiry: BigInt(fake.time + 3600), maxStake: 100n * E18, cap: 300n * E18, used: 0n });
    app.lobby!.signed = (id: Hex, sig: Hex | null, why?: string) => { said.push({ id, sig, why }); return true; };
    const bob = relay.card(acct(2).address);
    const ask = async (entry: Entry, joiner = bob) => {
      said.length = 0;
      a.onLobby({ t: "sign", matchId: e.matchId, entry: entryToJson(entry), joiner });
      await until(() => said.length > 0, "an answer");
      return said[0];
    };
    const now = fake.time;
    const good = { ...e, opponent: bob.address, deadline: BigInt(now + 300) };
    assert.equal((await ask({ ...good, stake: 20n * E18 })).sig, null, "another stake");
    assert.equal((await ask({ ...good, feeCapBps: 500 })).sig, null, "another fee cap");
    assert.equal((await ask({ ...good, opponent: acct(3).address })).sig, null, "a name that isn't the joiner's");
    assert.equal((await ask({ ...good, opponent: ZERO_ADDRESS }, { ...bob, address: ZERO_ADDRESS })).sig, null, "an open entry again");
    assert.equal((await ask({ ...good, deadline: BigInt(now + 86_400) })).sig, null, "a long-lived one");
    const ok = await ask(good);
    assert.ok(ok.sig, ok.why ?? "no signature");
    assert.equal(await recoverTypedDataAddress({ ...entryTypedData(31337, fake.vault, good), signature: ok.sig! }), acct(5).address, "signed by the session key: no popup");
    assert.equal((await ask(good)).sig, null, "once: the offer is taken");
  } finally {
    app.stop();
    restore();
  }
});

test("a lock whose receipt is late: 'no receipt yet' is not a failure, and 'locked' after it clears the fallback", async () => {
  const fake = new FakeChain();
  const relay = new FakeRelay({ chain: fake, net: "local", assets: { downtown: assets } });
  const base = "http://relay.test";
  relay.base = base;
  const restore = relayFetch(relay, base);
  const app = mkApp(fake, relay, base);
  try {
    await app.start();
    await until(() => !!app.lobby, "the lobby");
    const a = app as unknown as { onLobby(m: LobbyServerMsg): void };
    const id = newMatchId(acct(1).address), tx = `0x${"ab".repeat(32)}` as Hex;
    const se = { entry: entryToJson({ matchId: id, player: acct(1).address, opponent: acct(2).address, stake: E18, feeCapBps: 300, roundSeconds: 90, rules: ZERO_HASH, deadline: 9n }), sig: "0x" as Hex };
    let locked: Hex | null = null;
    app.onLocked = m => { locked = m; };
    a.onLobby({ t: "matched", matchId: id, a: se, b: se });
    a.onLobby({ t: "tx", kind: "lock", matchId: id, hash: tx, status: "failed", error: "timeout" });
    const st = useWager.getState();
    assert.equal(st.pairing?.failed, "timeout", "the page offers 'lock it yourself' while it waits");
    assert.equal(st.notice?.kind, "info", "a late receipt is not shown as a failed transaction");
    assert.match(st.notice?.text ?? "", /no receipt yet: it may still land/);
    a.onLobby({ t: "locked", matchId: id, tx });
    const after = useWager.getState().pairing;
    assert.equal(after?.lockTx, tx);
    assert.equal(after?.failed, null, "the fallback goes once the lock is known to have landed");
    assert.equal(locked, id, "and the series opens");
    // A real failure after the lock landed changes nothing.
    a.onLobby({ t: "tx", kind: "lock", matchId: id, hash: tx, status: "failed", error: "reverted" });
    assert.equal(useWager.getState().pairing?.failed, null);
  } finally {
    app.stop();
    restore();
  }
});

test("withdraw all with a token that taxes the vault as sender: the most that fits, from the vault's own revert", async () => {
  const vault = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address, me = acct(1).address;
  const free = 1000n * E18;
  let bps = 200n, other: string | null = null;
  const asked: bigint[] = [];
  const revert = (args: readonly unknown[], name: string, eargs: readonly unknown[]) => {
    const data = encodeErrorResult({ abi: VAULT_CALL_ABI, errorName: name, args: eargs } as never);
    const rev = new ContractFunctionRevertedError({ abi: VAULT_CALL_ABI as never, data, functionName: "withdraw" });
    return new ContractFunctionExecutionError(rev, { abi: VAULT_CALL_ABI as never, functionName: "withdraw", args, contractAddress: vault });
  };
  const pub = {
    // The vault's _withdraw: a sender tax beyond the free balance left reverts TransferMismatch(amount, amount + tax).
    simulateContract: async (o: { args: readonly unknown[] }) => {
      const amt = o.args[0] as bigint;
      asked.push(amt);
      if (other) throw revert(o.args, other, [me, 0n, amt]);
      const tax = (amt * bps) / 10_000n;
      if (amt > free) throw revert(o.args, "InsufficientFree", [me, free, amt]);
      if (tax > free - amt) throw revert(o.args, "TransferMismatch", [amt, amt + tax]);
      return { request: {} };
    },
  } as unknown as PublicClient;
  const vc = new VaultChain(pub, vault, 0);
  const got = await vc.withdrawable(me, free);
  assert.ok(got < free && got + (got * bps) / 10_000n <= free, "it fits with its tax");
  assert.ok(free - (got + (got * bps) / 10_000n) < 10n ** 6n, `and leaves only dust (${free - got - (got * bps) / 10_000n})`);
  assert.ok(asked.length <= 3, `in a few tries (${asked.length})`);
  bps = 0n;
  assert.equal(await vc.withdrawable(me, free), free, "an untaxed token: everything");
  bps = 200n;
  other = "InsufficientFree";
  assert.equal(await vc.withdrawable(me, free), free, "another revert: the amount as asked (the real send says why)");
});

// ---- the relay sockets ------------------------------------------------------------------------------------------------

type WsLike = { readyState: number; send(d: string): void; close(): void; onopen: (() => void) | null; onclose: ((e: { code?: number; reason?: string }) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onerror: (() => void) | null };

/** In-process WebSocket pairs into the fake relay's lobby. */
function lobbyWs(relay: FakeRelay, sockets: WsLike[] = []): WsFactory {
  return () => {
    const ws: WsLike = { readyState: 0, onopen: null, onclose: null, onmessage: null, onerror: null, send: d => h.message(d), close: () => { if (ws.readyState === 3) return; ws.readyState = 3; h.close(); ws.onclose?.({ code: 1000, reason: "" }); } };
    const sock: Sock = { send: d => setTimeout(() => ws.readyState === 1 && ws.onmessage?.({ data: d }), 0), close: (code, reason) => { ws.readyState = 3; h.close(); ws.onclose?.({ code, reason }); } };
    const h = relay.openLobby(sock);
    sockets.push(ws);
    setTimeout(() => { if (ws.readyState !== 0) return; ws.readyState = 1; ws.onopen?.(); }, 0);
    return ws as never;
  };
}

function relayFetch(relay: FakeRelay, base: string): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (!String(url).startsWith(base)) return orig(url, init);
    const r = await relay.http(u.pathname + u.search, init?.method ?? "GET", String(init?.body ?? ""));
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : r.text ?? "", { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

test("lobby socket: hello, the challenge signed as a Login (relay domain), welcome; a dropped socket reconnects; a region error stops it", async () => {
  const fake = new FakeChain(), relay = new FakeRelay({ chain: fake, net: "local", assets: { downtown: assets } });
  relay.base = "http://relay.test";
  const a = acct(1);
  const seen: LobbyServerMsg[] = [], states: string[] = [];
  const socks: WsLike[] = [];
  let signed: unknown = null;
  const lc = new LobbyClient("http://relay.test", "local", 31337, fake.vault, {
    player: a.address, by: () => "wallet",
    signTyped: async td => { signed = td; return a.signTypedData(td); },
  }, { state: s => states.push(s), msg: m => seen.push(m), error: e => assert.fail(e.message) }, lobbyWs(relay, socks));
  lc.connect();
  await until(() => seen.some(m => m.t === "welcome"), "welcome");
  const td = signed as ReturnType<typeof loginTypedData>;
  assert.equal(td.domain.name, "RadRun Wager Relay");
  assert.equal(td.message.player, a.address);
  assert.equal(td.message.relay, "http://relay.test");
  assert.equal(lc.state, "online");
  // Drop: it reconnects and logs in again.
  socks[0].close();
  await until(() => seen.filter(m => m.t === "welcome").length >= 2, "second welcome", 5000);
  assert.ok(states.includes("retrying"));
  lc.close();
  assert.equal(lc.state, "closed");
  const n = socks.length;
  await tick(1200);
  assert.equal(socks.length, n, "no reconnect after close()");
});

test("series room client: hello with the sim, login, the seed share (the same one after a reconnect), PROBE echoed, start -> a wager session on the right slot", async () => {
  const sent: unknown[] = [], bins: Uint8Array[] = [];
  type T = RoomTransport & { deliver(m: unknown): void };
  const box: { t: T | null } = { t: null };
  const mkT = () => {
    box.t = {
      onJson: () => {}, onBinary: () => {}, onClose: () => {}, minRtt: 40,
      connect: async () => {}, close: () => {}, relayNow: () => 5000,
      sendJson: (m: unknown) => sent.push(m), sendBinary: (b: Uint8Array) => bins.push(b),
      deliver(m: unknown) { (box.t!.onJson as (x: unknown) => void)(m); },
    } as unknown as T;
    return box.t;
  };
  const a = acct(1);
  const matchId = `0x${"12".repeat(32)}` as Hex;
  const starts: { local: number; wager: boolean }[] = [];
  const store: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
  const sc = new SeriesClient({
    base: "http://relay.test", matchId, chainId: 31337, vault: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    signer: { player: a.address, by: () => "session", signTyped: td => a.signTypedData(td) },
    compat: { v: 3, build: "t", link: 6, city: model.hash, tuning: "x" }, sim: { model, index: new CityIndex(model), tuning },
    ev: { conn() {}, series() {}, start: (_m, s) => starts.push({ local: s.local, wager: s.wager }), round() {}, drop() {}, back() {}, outcome() {}, settlement() {}, settled() {}, voided() {}, error() {} },
    transport: mkT,
  });
  await sc.connect();
  const t = box.t!;
  assert.deepEqual(sent[0], { t: "hello", v: WAGER_PROTOCOL, matchId, compat: { v: 3, build: "t", link: 6, city: model.hash, tuning: "x" } });
  t.deliver({ t: "challenge", challenge: `0x${"34".repeat(32)}`, expiry: 1_900_000_000, relay: "http://relay.test" });
  await until(() => sent.some(m => (m as { t: string }).t === "login"), "login");
  const login = sent.find(m => (m as { t: string }).t === "login") as { by: string; sig: Hex; player: Address };
  assert.equal(login.by, "session");
  assert.equal(await recoverTypedDataAddress({ ...loginTypedData(31337, "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", { player: a.address, challenge: `0x${"34".repeat(32)}`, expiry: 1_900_000_000n, relay: "http://relay.test" }), signature: login.sig }), a.address);
  const state = { matchId, phase: "waiting", players: [], you: 1, connected: [true, true], ready: [false, false], picks: [null, null], stake: "1", roundSeconds: 20, district: "downtown", feeBps: 300, holderFeeBps: 150, round: 1, score: [0, 0], draws: 0, seedCommit: `0x${"56".repeat(32)}`, deadlineAt: 9000, settleBy: 1 };
  t.deliver({ t: "series", state });
  const share1 = (sent.find(m => (m as { t: string }).t === "seed") as { share: Hex }).share;
  assert.match(share1, /^0x[0-9a-f]{64}$/);
  t.deliver({ t: "series", state });
  assert.equal(sent.filter(m => (m as { t: string }).t === "seed").length, 1, "once per connection");
  // PROBE -> PROBE_ECHO with the same id.
  (t.onBinary as (b: Uint8Array) => void)(encodeProbe(MSG_PROBE, 77));
  assert.deepEqual(decodeProbe(bins.at(-1)!), { type: MSG_PROBE_ECHO, id: 77 });
  // start: player B (you = 1) in round 2 with A in slot 1 plays slot 0.
  t.deliver({ t: "start", seed: 5, startAtMs: 9000, round: 2, inputDelay: 3, slots: [{ slot: 0, name: "b", radbro: "652", touch: false, easy: false }, { slot: 1, name: "a", radbro: "4764", touch: false, easy: false }], config: { district: "downtown", mode: "tag", seconds: 20, maxPlayers: 2 }, matchId, slotOfA: 1, score: [1, 0], lateMs: [100, 100] });
  assert.deepEqual(starts, [{ local: 0, wager: true }]);
  // A reconnect sends the same share again (never a new one).
  (t.onClose as (w: string) => void)("connection lost (1006)");
  await until(() => sent.filter(m => (m as { t: string }).t === "hello").length === 2, "reconnect hello", 3000);
  t.deliver({ t: "challenge", challenge: `0x${"35".repeat(32)}`, expiry: 1_900_000_000, relay: "http://relay.test" });
  await until(() => sent.filter(m => (m as { t: string }).t === "login").length === 2, "second login");
  t.deliver({ t: "series", state });
  const shares = sent.filter(m => (m as { t: string }).t === "seed").map(m => (m as { share: Hex }).share);
  assert.deepEqual(shares, [share1, share1]);
  sc.close();
});

// ---- the page controller end to end on the fakes ---------------------------------------------------------------------

function mkApp(fake: FakeChain, relay: FakeRelay, base: string) {
  const dep = { ...DEPLOYMENTS.local, relay: base };
  const pub = createPublicClient({ chain: viemChain(dep), transport: custom(fake.eip1193) }) as PublicClient;
  return new WagerApp({
    dep, base, rpc: ["http://127.0.0.1:5401"], district: "downtown", simFor: async () => simCompat(assets), keys: memoryStore(), pub, ws: lobbyWs(relay),
    now: () => fake.time, trustRelayVault: true,
  });
}
const wallet = (p: Eip1193, n: string): WalletOption => ({ info: { uuid: n, name: n, icon: "", rdns: n }, provider: p });

test("page flow: faucet, exact approve + deposit, session key (no popups after), create, join, lock, settle 97/3, withdraw; history", async () => {
  const fake = new FakeChain(), relay = new FakeRelay({ chain: fake, net: "local", assets: { downtown: assets } });
  const base = "http://relay.test";
  relay.base = base;
  const restore = relayFetch(relay, base);
  (globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const apps: WagerApp[] = [];
  try {
    const [alice, bob] = [acct(1), acct(2)];
    const A = mkApp(fake, relay, base);
    apps.push(A);
    await A.start();
    assert.equal(useWager.getState().fatal, null);
    assert.equal(useWager.getState().info?.symbol, "tSPIDERTAG");
    const pa = testWallet(alice, fake, { chainId: 1 });
    await A.connect(wallet(pa, "alice"));
    const s = () => useWager.getState();
    assert.equal(s().chainOk, false, "wallet on another network");
    // Faucet (to the wallet), then deposit: the page switches the network, approves exactly 1000 and deposits.
    const w0 = s().bal!.wallet;
    await A.faucet();
    assert.equal(s().bal!.wallet, w0 + 10_000n * E18);
    assert.equal(await A.deposit(1000n * E18), true, s().notice?.text ?? "");
    assert.equal(s().chainOk, true);
    assert.equal(s().bal!.free, 1000n * E18);
    assert.equal(s().bal!.allowance, 0n, "approved exactly the amount (nothing left over)");
    assert.equal(s().txs.filter(t => t.status === "confirmed").map(t => t.label).join(","), "deposit,approve tSPIDERTAG");
    assert.equal(await A.deposit(10n ** 30n), false);
    assert.match(s().notice!.text, /not enough tSPIDERTAG in your wallet/);
    // Session key through the relayer: then logins and entries need no wallet.
    assert.equal(await A.authorise(200n * E18), true, s().notice?.text ?? "");
    await until(() => !!s().session && s().session!.key === s().sessionKey, "session registered");
    assert.equal(s().session!.maxStake, 200n * E18);
    assert.equal(s().session!.cap, 600n * E18);
    await until(() => A.lobby?.state === "online", "A in the lobby");
    assert.equal(A.signer()!.by(), "session");
    pa.request = (orig => async (q: { method: string; params?: unknown }) => { if (q.method === "eth_signTypedData_v4") throw new Error("no popup expected"); return orig(q); })(pa.request);
    const aState = { ...s() };
    const id = await A.create({ stake: 100n * E18, roundSeconds: 90, district: "downtown", listed: true, opponent: null, holdersOnly: false, minSeries: 0 });
    assert.ok(id, s().notice?.text ?? "");
    await until(() => relay.offers.size === 1, "offer listed");
    const offer = [...relay.offers.values()][0].offer;
    assert.equal(offer.stake, (100n * E18).toString());
    assert.equal(entryFromJson(offer.entry).feeCapBps, aState.config!.houseFeeBps);
    let aLocked: Hex | null = null;
    A.onLocked = m => { aLocked = m; };

    // Bob: another page (the store is per page: swap it while Bob acts).
    const saved = useWager.getState();
    const B = mkApp(fake, relay, base);
    apps.push(B);
    await B.start();
    const pb = testWallet(bob, fake);
    await B.connect(wallet(pb, "bob"));
    await B.faucet();
    assert.equal(await B.deposit(1000n * E18), true, useWager.getState().notice?.text ?? "");
    await until(() => B.lobby?.state === "online" && useWager.getState().offers.length === 1, "B sees the offer");
    const seen = useWager.getState().offers[0];
    assert.equal(B.joinProblem(seen), null);
    let bLocked: Hex | null = null;
    B.onLocked = m => { bLocked = m; };
    assert.equal(await B.join(seen), true, useWager.getState().notice?.text ?? "");
    await until(() => !!bLocked && !!aLocked, "both locked");
    assert.equal(bLocked, id);
    assert.equal(fake.matches.get(id!.toLowerCase())!.state, 1);
    assert.equal(fake.g(fake.locked, alice.address), 100n * E18);
    assert.equal(fake.g(fake.free, bob.address), 900n * E18);
    // The referee decides (here: A by forfeit) and the relayer settles: 194 to A, 6 to the house.
    const room = relay.rooms.get(id!.toLowerCase())!;
    await (room as unknown as { end(o: unknown): Promise<void> }).end({ kind: "win", winner: 0, reason: "forfeit", score: [0, 0], forfeit: { by: 1, round: 1, step: 0, why: "disconnect" } });
    await until(() => !!room.settleTx, "settled");
    assert.equal(fake.g(fake.free, alice.address), 1094n * E18);
    assert.equal(fake.g(fake.free, bob.address), 900n * E18);
    assert.equal(fake.houseAccrued, 6n * E18);
    assert.equal(fake.totalLiabilities, fake.g(fake.bal, fake.vault));
    // Bob withdraws everything: straight to his wallet.
    await B.refresh();
    assert.equal(await B.withdraw(900n * E18), true, useWager.getState().notice?.text ?? "");
    assert.equal(fake.g(fake.free, bob.address), 0n);
    const hb = await B.chain!.history(bob.address);
    assert.equal(hb.rows[0].state, "lost");
    B.stop();
    useWager.setState(saved);
    await A.refresh();
    assert.equal(s().bal!.free, 1094n * E18);
    const ha = await A.chain!.history(alice.address);
    assert.deepEqual([ha.rows[0].state, ha.rows[0].payout], ["won", 194n * E18]);
  } finally {
    for (const a of apps) a.stop();
    restore();
  }
});

test("page errors: relay down, region blocked, a rejected signature, a join the rules forbid, a stake over the new-account cap", async () => {
  const fake = new FakeChain();
  const base = "http://relay.test";
  let relay = new FakeRelay({ chain: fake, net: "local", assets: { downtown: assets } });
  relay.base = base;
  const xs: WagerApp[] = [];
  // Relay down.
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  try {
    const x = mkApp(fake, relay, base);
    await x.start();
    assert.equal(useWager.getState().fatal?.kind, "relay");
    assert.match(useWager.getState().fatal!.message, /can't reach the wager relay/);
  } finally { globalThis.fetch = orig; }
  // Region blocked: /config says so; the page says withdrawals always work, and opens no lobby.
  relay = new FakeRelay({ chain: fake, net: "local", assets: { downtown: assets }, regionBlocked: true });
  relay.base = base;
  let restore = relayFetch(relay, base);
  try {
    const x = mkApp(fake, relay, base);
    await x.start();
    assert.equal(useWager.getState().fatal?.kind, "region");
    assert.match(useWager.getState().fatal!.message, /withdrawn straight from the contract/);
    assert.equal(x.lobby, null);
    x.stop();
  } finally { restore(); }
  // A rejected signature; holders-only; the new-account cap.
  relay = new FakeRelay({ chain: fake, net: "local", assets: { downtown: assets }, newAccountSeries: 3, newAccountMaxStake: 50n * E18 });
  relay.base = base;
  restore = relayFetch(relay, base);
  try {
    const x = mkApp(fake, relay, base);
    xs.push(x);
    await x.start();
    fake.transfer(acct(0).address, acct(3).address, 500n * E18);
    await x.connect(wallet(testWallet(acct(3), fake, { reject: true }), "rej"));
    await until(() => x.lobby?.state !== "connecting", "lobby");
    assert.equal(await x.authorise(10n * E18), false);
    assert.equal(useWager.getState().notice?.text, "you cancelled it in the wallet");
    useWager.setState({ you: { ...relay.card(acct(3).address) }, bal: { wallet: 0n, allowance: 0n, free: 500n * E18, locked: 0n, eth: 1n } });
    assert.match(x.stakeProblem(60n * E18) ?? "", /new accounts/);
    assert.equal(x.stakeProblem(40n * E18), null);
    const offer = { ...[...relay.offers.values()][0]?.offer, holdersOnly: true, minSeries: 0, creator: relay.card(acct(4).address), opponent: null, deadline: fake.time + 3600, stake: (10n * E18).toString() } as never;
    assert.equal(x.joinProblem(offer), "Radbro holders only");
    assert.equal(x.joinProblem({ ...(offer as object), holdersOnly: false, opponent: acct(5).address } as never), "this invite is for another player");
    // A city the relay doesn't referee: said as such (not "reload to update").
    assert.equal(await x.create({ stake: 10n * E18, roundSeconds: 90, district: "docks", listed: true, opponent: null, holdersOnly: false, minSeries: 0 }), null);
    assert.match(useWager.getState().notice!.text, /aren't played in this city/);
  } finally { for (const x of xs) x.stop(); restore(); }
});

test("sims: the page's sim and the referee's must match (rules hash), or the page says reload", () => {
  const a = simCompat(assets);
  assert.equal(sameSim(a, { ...a }), true);
  assert.equal(sameSim(a, { ...a, city: "other" }), false);
  assert.equal(sameSim(a, undefined), false);
  assert.notEqual(rulesHash(makeRules("downtown", a)), rulesHash(makeRules("downtown", { ...a, tuning: "zz" })));
  assert.equal(getAddress(acct(9).address), acct(9).address);
});

test("clock: entries and session expiries follow the chain's clock, not a device clock that is off by a day", async () => {
  const fake = new FakeChain();
  fake.time += 86_400; // the chain (or this device) is a day off
  const relay = new FakeRelay({ chain: fake, net: "local", assets: { downtown: assets } });
  const base = "http://relay.test";
  relay.base = base;
  const restore = relayFetch(relay, base);
  const dep = { ...DEPLOYMENTS.local, relay: base };
  const pub = createPublicClient({ chain: viemChain(dep), transport: custom(fake.eip1193) }) as PublicClient;
  const app = new WagerApp({ dep, base, rpc: ["http://127.0.0.1:5401"], district: "downtown", simFor: async () => simCompat(assets), keys: memoryStore(), pub, ws: lobbyWs(relay), trustRelayVault: true });
  try {
    await app.start();
    await app.connect(wallet(testWallet(acct(1), fake), "alice"));
    await app.faucet();
    assert.equal(await app.deposit(200n * E18), true);
    assert.equal(await app.authorise(100n * E18), true, useWager.getState().notice?.text ?? "");
    await until(() => !!useWager.getState().session && useWager.getState().session!.key === useWager.getState().sessionKey, "session registered");
    assert.ok(Number(useWager.getState().session!.expiry) > fake.time + 11 * 3600, "the session expiry is 12 hours of chain time");
    await until(() => app.lobby?.state === "online", "lobby");
    const id = await app.create({ stake: 10n * E18, roundSeconds: 90, district: "downtown", listed: true, opponent: null, holdersOnly: false, minSeries: 0 });
    assert.ok(id, useWager.getState().notice?.text ?? "");
    await until(() => relay.offers.size === 1, "offer");
    const dl = Number(entryFromJson([...relay.offers.values()][0].offer.entry).deadline);
    assert.ok(Math.abs(dl - (fake.time + 1800)) < 30, `the deadline (${dl}) is chain time + 30 min (${fake.time + 1800})`);
  } finally {
    app.stop();
    restore();
  }
});

test("ABI: the client calls the vault through the contracts' generated vaultAbi.ts", () => {
  assert.equal(GAME_VAULT_ABI, gameVaultAbi);
  for (const n of ["cancel", "reclaim", "refereeOf", "withdrawHouseTo"]) assert.ok(GAME_VAULT_ABI.some(e => e.type === "function" && e.name === n), n);
});

test("lobby socket: signing in again as the same player keeps the socket (the relay would withdraw that player's offers); another player reconnects", async () => {
  const fake = new FakeChain(), relay = new FakeRelay({ chain: fake, net: "local", assets: { downtown: assets } });
  relay.base = "http://relay.test";
  const [a, b] = [acct(1), acct(2)];
  const signer = (x: PrivateKeyAccount) => ({ player: x.address, by: () => "wallet" as const, signTyped: (td: ReturnType<typeof loginTypedData>) => x.signTypedData(td) });
  const seen: LobbyServerMsg[] = [];
  const socks: WsLike[] = [];
  const lc = new LobbyClient("http://relay.test", "local", 31337, fake.vault, signer(a), { state: () => undefined, msg: m => seen.push(m), error: e => assert.fail(e.message) }, lobbyWs(relay, socks));
  try {
    lc.connect();
    await until(() => seen.some(m => m.t === "welcome"), "welcome");
    // A session key went on (the page calls relogin): the same player, so the signed-in socket stays.
    lc.relogin(signer(a));
    await tick(20);
    assert.equal(socks.length, 1, "no new socket");
    assert.equal(socks[0].readyState, 1, "the first socket is still open");
    assert.equal(lc.state, "online");
    // Another account in the wallet: a new socket signed in as that player.
    lc.relogin(signer(b));
    await until(() => seen.filter(m => m.t === "welcome").length >= 2, "second welcome");
    assert.equal(socks.length, 2);
    assert.equal(socks[0].readyState, 3, "the old socket closed");
    const w = seen.filter(m => m.t === "welcome").at(-1) as Extract<LobbyServerMsg, { t: "welcome" }>;
    assert.equal(w.you.address.toLowerCase(), b.address.toLowerCase());
    // Browsing (no signer) then a wallet: that one must sign in, so it reconnects.
    lc.relogin(null);
    await until(() => lc.state === "online" && socks.length === 3, "browsing");
    lc.relogin(signer(a));
    await until(() => seen.filter(m => m.t === "welcome").length >= 3, "third welcome");
    assert.equal(socks.length, 4);
  } finally {
    lc.close();
  }
});

test("wallet: one accountsChanged / chainChanged listener at a time, whatever the account switches; none after disconnect", async () => {
  const fake = new FakeChain(), relay = new FakeRelay({ chain: fake, net: "local", assets: { downtown: assets } });
  const base = "http://relay.test";
  relay.base = base;
  const restore = relayFetch(relay, base);
  (globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const x = mkApp(fake, relay, base);
  try {
    await x.start();
    const [alice, bob] = [acct(1), acct(2)];
    const ls = new Map<string, Set<(...a: never[]) => void>>();
    const p = Object.assign(testWallet(alice, fake), {
      on(ev: string, fn: (...a: never[]) => void) { if (!ls.has(ev)) ls.set(ev, new Set()); ls.get(ev)!.add(fn); },
      removeListener(ev: string, fn: (...a: never[]) => void) { ls.get(ev)?.delete(fn); },
    });
    const fire = (ev: string, arg: unknown) => { for (const f of [...(ls.get(ev) ?? [])]) (f as (a: unknown) => void)(arg); };
    const n = (ev: string) => ls.get(ev)?.size ?? 0;
    await x.connect(wallet(p, "alice"));
    assert.equal(useWager.getState().address, alice.address);
    assert.deepEqual([n("accountsChanged"), n("chainChanged")], [1, 1]);
    fire("accountsChanged", [bob.address]);
    await until(() => useWager.getState().address === bob.address, "switched to bob");
    assert.deepEqual([n("accountsChanged"), n("chainChanged")], [1, 1], "the old pair came off");
    fire("accountsChanged", [alice.address]);
    await until(() => useWager.getState().address === alice.address, "back to alice");
    assert.deepEqual([n("accountsChanged"), n("chainChanged")], [1, 1]);
    fire("accountsChanged", []);
    assert.equal(useWager.getState().address, null, "disconnected");
    assert.deepEqual([n("accountsChanged"), n("chainChanged")], [0, 0]);
  } finally {
    x.stop();
    restore();
  }
});

test("verify page checks: the log is this match's; a timeout refund stores no log hash; a settle pays the replayed winner", () => {
  const vault = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
  const matchId = `0x${"11".repeat(32)}` as Hex, zero = `0x${"00".repeat(32)}` as Hex, tx = `0x${"33".repeat(32)}` as Hex;
  const [a, b] = [acct(1).address, acct(2).address];
  const head = {
    chainId: 31337, vault, matchId, players: [a, b] as [Address, Address], rulesHash: `0x${"55".repeat(32)}` as Hex, roundSeconds: 90,
    seed: { commit: zero, relaySecret: `0x${"66".repeat(32)}` as Hex, shares: [`0x${"77".repeat(32)}`, `0x${"88".repeat(32)}`] as [Hex, Hex] }, rounds: [],
  };
  const logHash = seriesLogHash(head);
  const log = { ...head, logHash, outcome: { kind: "win", winner: 0, reason: "played", score: [2, 1] } } as unknown as SeriesLog;
  const verdict: SeriesVerdict = { ok: true, problems: [], rounds: [], score: [2, 1], winner: 0 };
  const page = { chainId: 31337, vault, matchId };
  const run = (end: MatchEnd | null | undefined, o: { log?: SeriesLog; page?: typeof page; held?: boolean } = {}) =>
    matchChecks({ log: o.log ?? log, verdict, end, held: !!o.held, page: o.page ?? page });
  const oks = (cs: ReturnType<typeof run>) => cs.map(c => c.ok);
  const settled = (winner: Address, h = logHash): MatchEnd => ({ kind: "settled", winner, loser: winner === a ? b : a, payout: 194n, fee: 6n, feeBps: 300, logHash: h, mutual: false, tx });
  assert.deepEqual(oks(run(settled(a))), [true, true, true, true], "settled to the replayed winner with the log's hash");
  assert.deepEqual(oks(run(settled(b))), [true, true, true, false], "the vault paid the other player");
  assert.deepEqual(oks(run(settled(a, zero))), [true, true, false, true], "another log hash on chain");
  // A log edited after the settle that keeps the old logHash field: the page hashes the contents, so it fails.
  const edited = { ...log, seed: { ...log.seed, relaySecret: `0x${"99".repeat(32)}` } } as SeriesLog;
  assert.deepEqual(oks(run(settled(a), { log: edited })), [true, true, false, true], "the log's contents don't hash to the chain's");
  assert.match(run(settled(a), { log: edited })[2].text, /the log hashes to 0x/);
  assert.deepEqual(oks(run(undefined)), [true, true, null]);
  assert.match(run(null, { held: true }).at(-1)!.text, /held for review/);
  // A held series nobody reviewed, refunded after the settle window: the vault stores no log hash for that.
  const refund = run({ kind: "voided", reason: 3, logHash: zero, tx });
  assert.deepEqual(oks(refund), [true, true, true]);
  assert.match(refund.at(-1)!.text, /refunded after the settle window/);
  // A review that voided it (the referee's void carries the log hash); the log says void too.
  const reviewed = { ...log, outcome: { kind: "void", winner: null, reason: "review", score: [2, 1] } } as unknown as SeriesLog;
  assert.deepEqual(oks(run({ kind: "voided", reason: 1, logHash, tx }, { log: reviewed })), [true, true, true, true]);
  assert.deepEqual(oks(run({ kind: "voided", reason: 1, logHash, tx })), [true, true, true, false], "a void on chain for a log that says won");
  // A log for another match, vault or network is never this match's.
  assert.equal(run(settled(a), { log: { ...log, matchId: `0x${"44".repeat(32)}` } as SeriesLog })[0].ok, false);
  assert.equal(run(settled(a), { log: { ...log, vault: acct(5).address } as SeriesLog })[0].ok, false);
  assert.equal(run(settled(a), { log: { ...log, chainId: 46630 } as SeriesLog })[0].ok, false);
  assert.equal(run(undefined, { page: { ...page, vault: null as never } })[0].ok, true, "the vault not known yet: the rest still checks");
  // Both players settled it themselves (the referee was gone): their signatures decide, not the log.
  const mutual = run({ ...(settled(b, zero) as Extract<MatchEnd, { kind: "settled" }>), mutual: true });
  assert.deepEqual(oks(mutual), [true, true, true]);
  assert.match(mutual.at(-1)!.text, /both players' own wallet signatures/);
  assert.deepEqual(oks(run({ kind: "voided", reason: 2, logHash: zero, tx })), [true, true, true]);
});
