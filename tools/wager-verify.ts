// Re-verify a SPIDER-TAG wager series from its public log (docs/WAGER.md §5.1): the same replay code the referee and
// the ?wager&verify page run, on this machine. Needs no keys and trusts nothing but the log and, with --chain, the
// vault's own MatchSettled / MatchVoided event.
//
//   npm run wager:verify -- <matchId | log.json> [--net rh-testnet] [--relay URL] [--chain] [--rpc URL] [--json]
//
// A matchId is fetched from the deployment's relay (GET /log/<matchId>). The log must be replayed on the sim it was
// refereed on: when this checkout's sim differs, it says which build to check out. Exit code 0 = verified.
import fs from "node:fs";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { DEPLOYMENTS, isWagerNet, type WagerNetId } from "../src/wager/config.ts";
import type { SeriesLog } from "../src/wager/log.ts";
import { deriveSeed, seedCommit } from "../src/wager/log.ts";
import { simCompat, verifySeries, type SimAssets } from "../src/wager/replay.ts";
import { simId } from "../src/wager/eip712.ts";
import { applyTuningJson } from "../src/sim/tuning.ts";
import type { CityModel } from "../src/world/cityModel.ts";
import { VAULT_ABI } from "../relay/wager/src/abi.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k: string) => argv.includes(k);
const target = argv.find((a, i) => !a.startsWith("--") && !["--net", "--relay", "--rpc"].includes(argv[i - 1] ?? ""));

const lv = (f: string) => new URL(`../public/levels/${f}`, import.meta.url);

/** The district's level files from this checkout. */
export function localAssets(district: string): SimAssets {
  const tuningJson = JSON.parse(fs.readFileSync(lv("tuning.json"), "utf8"));
  const model = JSON.parse(fs.readFileSync(lv(district === "downtown" ? "city.model.json" : `${district}/city.model.json`), "utf8")) as CityModel;
  return { model, tuning: applyTuningJson(tuningJson).player, tag: tuningJson.tag };
}

async function loadLog(t: string, net: WagerNetId): Promise<SeriesLog> {
  if (fs.existsSync(t)) return JSON.parse(fs.readFileSync(t, "utf8")) as SeriesLog;
  if (!/^0x[0-9a-fA-F]{64}$/.test(t)) throw new Error("give a match id (0x + 64 hex) or a log file");
  const relay = (opt("--relay") ?? DEPLOYMENTS[net].relay ?? "").replace(/\/$/, "");
  if (!relay) throw new Error(`no relay for ${net}: pass --relay`);
  const r = await fetch(`${relay}/log/${t.toLowerCase()}`);
  if (!r.ok) throw new Error(`${relay} has no log for that match (${r.status}): it may not be over yet`);
  return (await r.json()) as SeriesLog;
}

/** The logHash the vault recorded for this match (MatchSettled or MatchVoided), or null. */
async function chainLogHash(log: SeriesLog, net: WagerNetId): Promise<{ hash: Hex; event: string } | null> {
  const d = DEPLOYMENTS[net];
  const rpc = opt("--rpc") ?? d.rpc[0];
  const c = createPublicClient({ transport: http(rpc) });
  for (const eventName of ["MatchSettled", "MatchVoided"] as const) {
    const logs = await c.getContractEvents({ address: log.vault as Address, abi: VAULT_ABI, eventName, args: { matchId: log.matchId }, fromBlock: BigInt(d.deployBlock ?? 0) });
    const last = logs[logs.length - 1] as unknown as { args: { logHash: Hex } } | undefined;
    if (last) return { hash: last.args.logHash, event: eventName };
  }
  return null;
}

async function main(): Promise<number> {
  if (!target) {
    console.error("usage: npm run wager:verify -- <matchId | log.json> [--net rh-testnet] [--relay URL] [--chain] [--rpc URL] [--json]");
    return 2;
  }
  const netArg = opt("--net") ?? "rh-testnet";
  if (!isWagerNet(netArg)) throw new Error(`unknown --net ${netArg}`);
  const log = await loadLog(target, netArg);
  const assets = localAssets(log.rules.district);
  const mine = simCompat(assets);
  const out: string[] = [];
  out.push(`match ${log.matchId} on chain ${log.chainId}, vault ${log.vault}`);
  out.push(`players A ${log.players[0]}  B ${log.players[1]}; stake ${log.stake}; fee ${log.feeBps} bps (holder ${log.holderFeeBps}); ${log.rules.district}, ${log.roundSeconds} s rounds`);
  out.push(`refereed on build ${log.compat.build}; this checkout's sim ${simId(mine) === log.rules.simId ? "matches" : "DIFFERS (check out that build to replay it)"}`);
  out.push(`seed commit ${log.seed.commit} ${seedCommit(log.seed.relaySecret) === log.seed.commit ? "= keccak256(revealed secret)" : "DOES NOT MATCH the revealed secret"}`);
  const t0 = performance.now();
  const v = verifySeries(log, assets);
  const ms = performance.now() - t0;
  for (const r of log.rounds) {
    const rep = v.rounds.find(x => x.round === r.round);
    const seedOk = deriveSeed(log.seed.relaySecret, log.seed.shares, r.round) === r.seed;
    const logged = r.result ? `winner ${r.result.winner}, bag ${r.result.bag.join("/")}, hash ${r.result.hash.toString(16)}` : "cut short";
    const replayed = rep?.result ? `winner ${rep.result.winner}, bag ${rep.result.bag.join("/")}, hash ${rep.result.hash.toString(16)}` : rep ? `stops at step ${rep.steps}` : "not replayed";
    out.push(`round ${r.round}: seed ${r.seed}${seedOk ? "" : " (NOT the committed seed)"}, A in slot ${r.slotOfA}, delay ${r.inputDelay}, ${r.lastStep}/${r.endStep} steps, fills ${r.fills.join("/")}`);
    out.push(`   logged   ${logged}`);
    out.push(`   replayed ${replayed}${rep ? ` (${rep.ms.toFixed(0)} ms)` : ""}`);
  }
  const o = log.outcome;
  out.push(`outcome: ${o.kind}${o.winner !== null ? ` for ${o.winner === 0 ? "A" : "B"}` : ""} (${o.reason}${o.forfeit ? `: ${o.forfeit.by === 0 ? "A" : "B"} left in round ${o.forfeit.round}` : ""}), score ${o.score.join("-")}`);
  for (const f of log.flags) out.push(`flag: ${f.side === 0 ? "A" : "B"} ${f.kind} ${f.value} (limit ${f.limit}) round ${f.round}${f.note ? `: ${f.note}` : ""}`);
  let chainOk: boolean | null = null;
  if (flag("--chain")) {
    const c = await chainLogHash(log, netArg);
    chainOk = !!c && c.hash.toLowerCase() === log.logHash.toLowerCase();
    out.push(c ? `on-chain ${c.event} logHash ${c.hash}: ${chainOk ? "matches the log" : "DIFFERS from the log"}` : "no MatchSettled / MatchVoided for this match on-chain yet");
  }
  const ok = v.ok && chainOk !== false;
  out.push(ok ? `VERIFIED: the replay gives the logged result (${ms.toFixed(0)} ms, cold)` : `NOT VERIFIED:\n  ${v.problems.join("\n  ")}`);
  if (flag("--json")) console.log(JSON.stringify({ ok, problems: v.problems, winner: v.winner, score: v.score, ms, chain: chainOk }));
  else console.log(out.join("\n"));
  return ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code), e => { console.error(String((e as Error).message ?? e)); process.exit(2); });
}
