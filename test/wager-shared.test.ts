// SPIDER-TAG wager, the shared interface (docs/WAGER.md): the EIP-712 types match the Solidity interface, the fee
// maths, signatures recover, the series log hash and the authoritative replay of a bot series (and that tampering
// with it is caught), the seed and first-holder rules, the probe codec and the deployments table.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { encodeAbiParameters, hashTypedData, keccak256, recoverTypedDataAddress, toBytes, concat, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { applyTuningJson } from "../src/sim/tuning.ts";
import type { CityModel } from "../src/world/cityModel.ts";
import { TagBot } from "../src/game/tagBot.ts";
import {
  DEFAULT_FEE_BPS, MAX_FEE_BPS, TYPEHASHES, TYPE_STRINGS, VAULT_TYPES, capturedFees, entryDigest, entryFromJson, entryToJson, entryTypedData,
  makeRules, newMatchId, payout, random32, rulesHash, vaultDomain, type Entry,
} from "../src/wager/eip712.ts";
import {
  SERIES, deriveSeed, firstHolderSlot, scoreRounds, seedCommit, seriesLogHash, slotOfAFor, wordsFromBase64, wordsToBase64,
  type RoundLog, type SeriesLog, type Side,
} from "../src/wager/log.ts";
import { endStepFor, roundMatch, roundResult, simCompat, verifySeries, type SimAssets } from "../src/wager/replay.ts";
import { MSG_PROBE, MSG_PROBE_ECHO, decodeProbe, encodeProbe } from "../src/wager/protocol.ts";
import { DEPLOYMENTS, MAINNET_CHAIN_IDS, siteDeployments } from "../src/wager/config.ts";

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);
const tuningJson = JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8"));
const model: CityModel = JSON.parse(fs.readFileSync(lv("city.model.json"), "utf8"));
const assets: SimAssets = { model, tuning: applyTuningJson(tuningJson).player, tag: tuningJson.tag };

// anvil's well-known dev keys (public test keys; never used outside local tests).
const ALICE = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const BOB = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const VAULT: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const CHAIN = 31337;

test("EIP-712: the TS type strings hash to the typehashes, match the Solidity interface and viem's encoding", () => {
  for (const [k, s] of Object.entries(TYPE_STRINGS)) assert.equal(keccak256(toBytes(s)), TYPEHASHES[k as keyof typeof TYPEHASHES], k);
  const sol = fs.readFileSync(new URL("../contracts/src/interfaces/IGameVault.sol", import.meta.url), "utf8");
  const inSol = [...sol.matchAll(/keccak256\(\s*"([^"]+)"\s*\)/g)].map(m => m[1]);
  assert.deepEqual(inSol, [TYPE_STRINGS.SessionAuth, TYPE_STRINGS.Entry, TYPE_STRINGS.Result]);
  // The struct field lists produce the same type strings (viem builds the type string from VAULT_TYPES).
  for (const k of ["SessionAuth", "Entry", "Result"] as const) {
    const fields = VAULT_TYPES[k].map(f => `${f.type} ${f.name}`).join(",");
    assert.equal(`${k}(${fields})`, TYPE_STRINGS[k]);
  }
  // hashTypedData == keccak256(0x1901 · domainSeparator · structHash), computed by hand.
  const e: Entry = {
    matchId: `0x${"11".repeat(32)}`, player: ALICE.address, opponent: "0x0000000000000000000000000000000000000000", stake: 10n ** 21n,
    feeCapBps: 300, roundSeconds: 90, rules: `0x${"22".repeat(32)}`, deadline: 1_900_000_000n,
  };
  const dom = vaultDomain(CHAIN, VAULT);
  const domainSep = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(toBytes(dom.name)), keccak256(toBytes(dom.version)), BigInt(CHAIN), VAULT],
  ));
  const structHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint128" }, { type: "uint16" }, { type: "uint16" }, { type: "bytes32" }, { type: "uint64" }],
    [TYPEHASHES.Entry, e.matchId, e.player, e.opponent, e.stake, e.feeCapBps, e.roundSeconds, e.rules, e.deadline],
  ));
  assert.equal(entryDigest(CHAIN, VAULT, e), keccak256(concat(["0x1901", domainSep, structHash])));
  assert.equal(entryDigest(CHAIN, VAULT, e), hashTypedData(entryTypedData(CHAIN, VAULT, e)));
  assert.deepEqual(entryFromJson(JSON.parse(JSON.stringify(entryToJson(e)))), e);
});

test("EIP-712: a session key's Entry signature recovers to the key, and binds chain + vault", async () => {
  const e: Entry = {
    matchId: newMatchId(), player: BOB.address, opponent: ALICE.address, stake: 5n * 10n ** 18n, feeCapBps: DEFAULT_FEE_BPS, roundSeconds: 90,
    rules: rulesHash(makeRules("downtown", simCompat(assets))), deadline: 2_000_000_000n,
  };
  const sig = await ALICE.signTypedData(entryTypedData(CHAIN, VAULT, e));
  assert.equal(await recoverTypedDataAddress({ ...entryTypedData(CHAIN, VAULT, e), signature: sig }), ALICE.address);
  const other = await recoverTypedDataAddress({ ...entryTypedData(46630, VAULT, e), signature: sig });
  assert.notEqual(other, ALICE.address, "another chain id recovers someone else");
});

test("fees: captured = min(house, both caps), holder <= captured; payout rounds the fee down", () => {
  assert.deepEqual(capturedFees(300, 150, 300, 300), { feeBps: 300, holderFeeBps: 150 });
  assert.deepEqual(capturedFees(400, 150, 300, 500), { feeBps: 300, holderFeeBps: 150 });
  assert.deepEqual(capturedFees(0, 150, 300, 300), { feeBps: 0, holderFeeBps: 0 });
  assert.ok(MAX_FEE_BPS === 500);
  const p = payout(10n ** 18n, 300);
  assert.equal(p.pot, 2n * 10n ** 18n);
  assert.equal(p.fee, 6n * 10n ** 16n);
  assert.equal(p.winner + p.fee, p.pot);
  assert.deepEqual(payout(1n, 300), { pot: 2n, fee: 0n, winner: 2n }, "dust: the fee rounds down, the winner keeps it");
  assert.deepEqual(payout(1n, 0), { pot: 2n, fee: 0n, winner: 2n });
});

test("rules: the hash covers the district and the sim", () => {
  const sim = simCompat(assets);
  assert.equal(rulesHash(makeRules("downtown", sim)), rulesHash(makeRules("downtown", { ...sim })));
  assert.notEqual(rulesHash(makeRules("downtown", sim)), rulesHash(makeRules("docks", sim)));
  assert.notEqual(rulesHash(makeRules("downtown", sim)), rulesHash(makeRules("downtown", { ...sim, tuning: "0" })));
});

test("series rules: score, draws, seeds, and round 2 hands the bag to the other player", () => {
  assert.deepEqual(scoreRounds([0, 0]), { score: [2, 0], draws: 0, done: true, winner: 0, void: false });
  assert.deepEqual(scoreRounds([0, 1, 1]), { score: [1, 2], draws: 0, done: true, winner: 1, void: false });
  assert.deepEqual(scoreRounds([0, "draw", 1]), { score: [1, 1], draws: 1, done: false, winner: null, void: false });
  assert.equal(scoreRounds(["draw", "draw", "draw"]).void, true);
  assert.equal(SERIES.maxDraws, 2);
  const secret = random32(), shares: [Hex, Hex] = [random32(), random32()];
  assert.equal(deriveSeed(secret, shares, 1), deriveSeed(secret, shares, 1));
  assert.notEqual(deriveSeed(secret, shares, 1), deriveSeed(secret, shares, 2));
  assert.notEqual(deriveSeed(secret, shares, 1), deriveSeed(secret, [shares[0], random32()], 1), "each share changes the seed");
  for (let i = 0; i < 200; i++) {
    const s1 = deriveSeed(secret, shares, 1) ^ i, s2 = (deriveSeed(secret, shares, 2) + i * 7919) >>> 0;
    const firstR1: Side = firstHolderSlot(s1); // round 1: A is slot 0
    const a2 = slotOfAFor(2, s2, s1);
    const firstR2: Side = firstHolderSlot(s2) === a2 ? 0 : 1;
    assert.notEqual(firstR2, firstR1);
    assert.equal(slotOfAFor(3, s2, s1), 0);
  }
});

test("words: 6-byte base64 round trip", () => {
  const w = [0, 1, 2 ** 41 - 1, 123456789012, 2 ** 32, 2 ** 32 - 1];
  assert.deepEqual([...wordsFromBase64(wordsToBase64(w))], w);
});

/** Plays a whole best-of-3 between two bots with the referee's round construction and returns its log. */
function botSeries(roundSeconds: number): SeriesLog {
  const secret = random32(), shares: [Hex, Hex] = [random32(), random32()];
  const rules = makeRules("downtown", simCompat(assets));
  const rounds: RoundLog[] = [];
  const winners: (Side | "draw")[] = [];
  let seed1 = 0;
  for (let round = 1; !scoreRounds(winners).done; round++) {
    const seed = deriveSeed(secret, shares, round);
    if (round === 1) seed1 = seed;
    const slotOfA = slotOfAFor(round, seed, seed1);
    const m = roundMatch(assets, seed, roundSeconds, ["652", "4764"]);
    const bots = [new TagBot(m, 0, 100 + round, "normal"), new TagBot(m, 1, 200 + round, "normal")];
    const w: [number[], number[]] = [[], []];
    for (let s = 1; !m.over; s++) {
      const pair = bots.map(b => b.next(m));
      if (s <= 2) pair[0] = pair[1] = 0; // inputDelay 2: steps 1..2 are empty for everyone
      w[0].push(pair[0]); w[1].push(pair[1]);
      m.stepWords(pair);
      for (const b of bots) b.after();
    }
    const result = roundResult(m, slotOfA);
    winners.push(result.winner);
    rounds.push({ round, seed, slotOfA, inputDelay: 2, endStep: m.endStep, lastStep: m.endStep, words: [wordsToBase64(w[0]), wordsToBase64(w[1])], result, fills: [0, 0] });
  }
  const sc = scoreRounds(winners);
  const log: SeriesLog = {
    format: "radrun-wager-log/1", chainId: CHAIN, vault: VAULT, matchId: newMatchId(), players: [ALICE.address, BOB.address],
    stake: (10n ** 18n).toString(), feeBps: 300, holderFeeBps: 150, roundSeconds, rules, rulesHash: rulesHash(rules),
    compat: { ...simCompat(assets), build: "test" }, radbros: ["652", "4764"], seed: { commit: seedCommit(secret), relaySecret: secret, shares },
    rounds, outcome: { kind: sc.void ? "void" : "win", winner: sc.winner, reason: sc.void ? "draws" : "played", score: sc.score }, flags: [],
    logHash: `0x${"00".repeat(32)}`,
  };
  log.logHash = seriesLogHash(log);
  return log;
}

test("replay: a bot series verifies from its published log; tampering is caught", () => {
  const log = botSeries(20);
  assert.ok(log.rounds.length >= 2 && log.rounds.length <= 5);
  assert.equal(log.rounds[0].endStep, endStepFor(20));
  const json: SeriesLog = JSON.parse(JSON.stringify(log));
  const v = verifySeries(json, { ...assets, index: undefined });
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.equal(v.winner, log.outcome.winner);

  // A held series the owner's review voided (the relay rewrites the outcome; it isn't hashed): still verifies.
  const reviewed: SeriesLog = JSON.parse(JSON.stringify(log));
  reviewed.outcome = { kind: "void", winner: null, reason: "review", score: log.outcome.score };
  assert.deepEqual(verifySeries(reviewed, assets).problems, []);
  // A "review" that hands out a win is not one.
  const badReview: SeriesLog = JSON.parse(JSON.stringify(log));
  badReview.outcome = { ...log.outcome, reason: "review" };
  assert.ok(verifySeries(badReview, assets).problems.some(p => p.includes("review")));

  // A changed word: the log hash breaks (and the round most likely replays differently).
  const bad: SeriesLog = JSON.parse(JSON.stringify(log));
  const w = wordsFromBase64(bad.rounds[0].words[1]);
  for (let s = 400; s < 1400; s++) w[s] = 0;
  bad.rounds[0].words[1] = wordsToBase64(w);
  assert.ok(verifySeries(bad, assets).problems.some(p => p.includes("log hash")));
  // Rehashing does not help: the replay no longer gives the logged final state.
  bad.logHash = seriesLogHash(bad);
  assert.ok(verifySeries(bad, assets).problems.some(p => p.includes("hash")));

  // A claimed winner the rounds do not support.
  const liar: SeriesLog = JSON.parse(JSON.stringify(log));
  liar.outcome.winner = log.outcome.winner === 0 ? 1 : 0;
  assert.ok(verifySeries(liar, assets).problems.some(p => p.includes("outcome")));

  // A seed that is not the committed one.
  const reseed: SeriesLog = JSON.parse(JSON.stringify(log));
  reseed.seed.shares[1] = random32();
  reseed.logHash = seriesLogHash(reseed);
  assert.ok(verifySeries(reseed, assets).problems.some(p => p.includes("seed")));
});

test("probe codec and the deployments table", () => {
  assert.deepEqual(decodeProbe(encodeProbe(MSG_PROBE, 0xdeadbeef)), { type: MSG_PROBE, id: 0xdeadbeef });
  assert.deepEqual(decodeProbe(encodeProbe(MSG_PROBE_ECHO, 7)), { type: MSG_PROBE_ECHO, id: 7 });
  assert.equal(decodeProbe(new Uint8Array([0x01, 0, 0, 0, 0])), null);
  assert.equal(DEPLOYMENTS["rh-testnet"].chainId, 46630);
  assert.equal(DEPLOYMENTS["rh-mainnet"].chainId, 4663);
  assert.ok(MAINNET_CHAIN_IDS.includes(DEPLOYMENTS["rh-mainnet"].chainId));
  assert.ok(!MAINNET_CHAIN_IDS.includes(DEPLOYMENTS["rh-testnet"].chainId));
  assert.deepEqual(siteDeployments(" rh-testnet, nope ,local").map(d => d.net), ["rh-testnet", "local"]);
  assert.deepEqual(siteDeployments(undefined), []);
  for (const d of Object.values(DEPLOYMENTS)) assert.ok(!/\bhood chain\b|robinhood eth/i.test(d.chainName), "brand: Robinhood Chain in full");
});
