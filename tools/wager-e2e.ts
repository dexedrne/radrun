// SPIDER-TAG wager end to end (docs/WAGER.md §9.4): a local chain, the wager relay, a build:test of the site and two
// headless Chromiums with dev wallets and bots, through faucet -> approve + deposit -> session key -> an open offer found
// in the lobby (the creator's page signs a named Entry for the joiner) -> a best of 3 -> settle 97/3 -> the verify page,
// then an invite link between Radbro holders (the holder rate), a 0% house fee, a cancelled offer (in the lobby and on
// chain), a no-show, a forfeit, a forced hash mismatch held and voided by the owner's review, a flagged sharp bot held
// and settled by the review, a settle both wallets sign with the relay gone, a reclaim + refund after the settle window,
// and both players withdrawing everything.
//
//   npm run wager:e2e                 the real local stack: anvil, tools/wager-deploy.ts, relay/wager/dev.ts
//   npm run wager:e2e -- --fake       the in-process fakes (test/wager-client-fakes.ts) instead of anvil and the relay
//   options: --anvil-port N (8547) · --relay-port N (8820) · --site-port N (5430) · --profiles DIR (<tmp>/chrome-profile-wager-integ)
//            --only cancel,open,invite,fee0,noshow,forfeit,dispute,hold,mutual,refund,withdraw (default: all, in that order)
//            --swgl (software GL; default: the GPU through ANGLE/GL) · --keep (leave the processes up) · --shots DIR
//
// Keys: anvil's public test keys only (owner #0, players #1 and #2, faucet #6, house #7, referee #8, relayer #9); the deploy
// tool and the relay pick them themselves (--anvil), so no key is ever on a command line or in this file's output. Every
// process is stopped by its own PID; ports are taken strictly (a busy port fails the run). Headless Chromium runs with
// throwaway profiles.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ERC20_ABI, GAME_VAULT_ABI } from "../src/wager/abi.ts";

const root = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FAKE = flag("fake");
const PORTS = { rpc: Number(opt("anvil-port", "8547")), relay: Number(opt("relay-port", "8820")), site: Number(opt("site-port", "5430")) };
const ALL = ["cancel", "open", "invite", "fee0", "noshow", "forfeit", "dispute", "hold", "mutual", "refund", "withdraw"];
const ONLY = new Set(opt("only", ALL.join(",")).split(","));
const SHOTS = opt("shots", "");
const PROFILES = opt("profiles", path.join(os.tmpdir(), "chrome-profile-wager-integ"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "radrun-wager-e2e-"));
const E18 = 10n ** 18n;
/** anvil's public dev keys (#0 the vault owner, #1 and #2 the players): local anvil only. */
const ANVIL0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PLAYER = [1, 2].map(i => privateKeyToAccount(([
  "", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
] as Hex[])[i]).address);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---- processes -----------------------------------------------------------------------------------------------------------

const procs: ChildProcess[] = [];
function run(name: string, cmd: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  procs.push(p);
  log(`${name} started (pid ${p.pid})`);
  return p;
}
function stop(p: ChildProcess | null | undefined): void {
  if (p?.pid && p.exitCode === null) { try { process.kill(p.pid, "SIGTERM"); } catch { /* gone */ } }
}
async function waitHttp(url: string, what: string, ms = 60_000, body?: string): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body } : undefined);
      if (r.ok) return;
    } catch { /* not yet */ }
    await sleep(300);
  }
  throw new Error(`${what} didn't come up at ${url}`);
}
const rpcUrl = `http://127.0.0.1:${PORTS.rpc}`;
const relayUrl = `http://127.0.0.1:${PORTS.relay}`;
const siteUrl = `http://127.0.0.1:${PORTS.site}`;

// ---- the chain + relay: real (anvil, deploy tool, relay stand-in) or fake ---------------------------------------------------

type RelayOpts = { hold: boolean; holders?: Address[] };
type Stack = { startRelay(o: RelayOpts): Promise<void>; stopRelay(): Promise<void>; close(): Promise<void> };

/** A port someone else already listens on fails the run (never talk to another process by mistake). */
async function assertFree(port: number, what: string): Promise<void> {
  const busy = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }).then(() => true, e => !/ECONNREFUSED/.test(String((e as { cause?: unknown }).cause ?? e)));
  if (busy) throw new Error(`port ${port} (${what}) is in use: pick another with the --*-port options`);
}

async function realStack(): Promise<Stack> {
  for (const f of ["tools/wager-deploy.ts", "relay/wager/dev.ts"]) {
    if (!fs.existsSync(path.join(root, f))) throw new Error(`${f} isn't here: run with --fake`);
  }
  // Foundry's default install path, else whatever `anvil` is on PATH (or $ANVIL).
  const foundry = path.join(os.homedir(), ".foundry/bin/anvil");
  const anvilBin = process.env.ANVIL ?? (fs.existsSync(foundry) ? foundry : "anvil");
  await assertFree(PORTS.rpc, "anvil");
  const anvil = run("anvil", anvilBin, ["--host", "127.0.0.1", "--port", String(PORTS.rpc), "--chain-id", "31337", "--silent"]);
  await waitHttp(rpcUrl, "anvil", 30_000, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
  // The local deploy uses anvil's dev accounts (owner #0, faucet #6, house #7, referee #8, relayer #9) and writes the
  // local deployment into src/wager/deployments.json (the site build below and the relay read it); the file is put
  // back as it was at the end, so a run leaves the tree clean.
  const deployments = path.join(root, "src/wager/deployments.json");
  const original = fs.readFileSync(deployments, "utf8");
  const dep = run("deploy", process.execPath, ["tools/wager-deploy.ts", "--net", "local", "--rpc", rpcUrl]);
  const code = await new Promise<number>(r => dep.on("exit", c => r(c ?? 1)));
  if (code !== 0) { fs.writeFileSync(deployments, original); stop(anvil); throw new Error(`the deploy tool failed (see ${path.join(TMP, "deploy.log")})`); }
  let relay: ChildProcess | null = null;
  return {
    async startRelay(o) {
      await assertFree(PORTS.relay, "the wager relay");
      const db = path.join(TMP, `relay-db-${Date.now()}`);
      fs.mkdirSync(db, { recursive: true });
      relay = run("relay", process.execPath, ["relay/wager/dev.ts", "--port", String(PORTS.relay), "--net", "local", "--anvil", "--db", db], {
        RPC_URLS: rpcUrl, ALLOWED_ORIGINS: siteUrl, ROUND_SECONDS: "20,60,90,120", NEW_ACCOUNT_MAX_STAKE: (1000n * E18).toString(), NEW_ACCOUNT_SERIES: "0",
        JOIN_GRACE_MS: "25000", HOLD_ON_FLAGS: o.hold ? "1" : "0", FAUCET: "1", FAUCET_TOKENS: (10_000n * E18).toString(), FAUCET_ETH: (E18 / 100n).toString(),
        // A mock Radbro collection (no Ethereum reads): nobody holds one unless the scenario says so.
        DEV_RADBRO_HOLDERS: [...(o.holders ?? []).map(a => `${a}=652`), "0x000000000000000000000000000000000000dEaD=652"].join(";"),
      });
      await waitHttp(`${relayUrl}/health`, "the relay");
    },
    async stopRelay() { stop(relay); relay = null; await sleep(800); },
    async close() { stop(relay); stop(anvil); fs.writeFileSync(deployments, original); },
  };
}

async function fakeStack(): Promise<Stack> {
  const { FakeChain, FakeRelay } = await import("../test/wager-client-fakes.ts");
  const { applyTuningJson } = await import("../src/sim/tuning.ts");
  const { CityIndex } = await import("../src/world/cityModel.ts");
  const lv = path.join(root, "public/levels");
  const tj = JSON.parse(fs.readFileSync(path.join(lv, "tuning.json"), "utf8"));
  const model = JSON.parse(fs.readFileSync(path.join(lv, "city.model.json"), "utf8"));
  const assets = { downtown: { model, index: new CityIndex(model), tuning: applyTuningJson(tj).player, tag: tj.tag } };
  const chain = new FakeChain(31337);
  const chainSrv = await chain.serve(PORTS.rpc);
  let relay: InstanceType<typeof FakeRelay> | null = null;
  const stopRelay = async () => {
    await relay?.stop();
    relay = null;
    log("fake relay stopped");
  };
  return {
    async startRelay(o) {
      relay = new FakeRelay({ chain, net: "local", assets, roundSeconds: [20, 60, 90, 120], timing: { joinGraceMs: 25_000, betweenRoundsMs: 5000 }, holdOnFlags: o.hold, forceFlag: o.hold });
      await relay.serve(PORTS.relay);
      log("fake relay up");
    },
    stopRelay,
    async close() {
      await stopRelay();
      chainSrv.closeAllConnections();
      chainSrv.close();
    },
  };
}

// ---- the site: a build:test, served by vite preview -----------------------------------------------------------------------

async function startSite(): Promise<ChildProcess> {
  const out = path.join(TMP, "dist");
  const b = run("build", process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--mode", "test", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { VITE_WAGER_NETS: "local" });
  const code = await new Promise<number>(r => b.on("exit", c => r(c ?? 1)));
  if (code !== 0) throw new Error(`the site build failed (see ${path.join(TMP, "build.log")})`);
  await assertFree(PORTS.site, "the site");
  const p = run("site", process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--outDir", out, "--port", String(PORTS.site), "--strictPort", "--host", "127.0.0.1"]);
  await waitHttp(siteUrl, "the site");
  return p;
}

// ---- browsers -------------------------------------------------------------------------------------------------------------

const browsers: Browser[] = [];
async function browser(tag: string, w: number, h: number): Promise<Browser> {
  const dir = path.join(PROFILES, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const gl = flag("swgl") ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : ["--use-angle=gl", "--ignore-gpu-blocklist", "--enable-gpu"];
  const b = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium", headless: true, userDataDir: dir,
    args: [`--user-data-dir=${dir}`, "--headless=new", ...gl, `--window-size=${w},${h}`, "--no-first-run", "--no-default-browser-check", "--mute-audio"],
    defaultViewport: { width: w, height: h },
  });
  log(`chromium ${tag} (pid ${b.process()?.pid})`);
  browsers.push(b);
  return b;
}
const url = (extra: string) => `${siteUrl}/?wager&net=local&rpc=${encodeURIComponent(rpcUrl)}&relay=${encodeURIComponent(relayUrl)}${extra}`;
/** A page on the site (the browser's other pages are closed first: a stale page keeps rendering and its sockets open). */
async function open(b: Browser, extra: string, keepOthers = false): Promise<Page> {
  if (!keepOthers) for (const q of await b.pages()) await q.close().catch(() => undefined);
  const p = await b.newPage();
  await p.evaluateOnNewDocument(() => { try { localStorage.setItem("rugrun.v1", JSON.stringify({ settings: { quality: "low", qualityChosen: true } })); } catch { /* */ } });
  p.on("pageerror", e => log(`pageerror: ${(e as Error).message}`));
  await p.goto(url(extra), { waitUntil: "load" });
  return p;
}
const sel = (id: string) => `[data-testid="${id}"]`;
/** Scroll an element to the middle of the view first: at the top edge the page's fixed banner would take the click. */
const centre = (p: Page, s: string) => p.$eval(s, e => e.scrollIntoView({ block: "center", inline: "center" })).catch(() => undefined);
async function click(p: Page, id: string, ms = 60_000) {
  await p.waitForSelector(`${sel(id)}:not([disabled])`, { timeout: ms });
  await centre(p, sel(id));
  await p.click(sel(id));
}
async function fill(p: Page, id: string, v: string) {
  await p.waitForSelector(sel(id), { timeout: 30_000 });
  await centre(p, sel(id));
  await p.click(sel(id), { count: 3 });
  await p.type(sel(id), v);
}
const text = (p: Page, id: string) => p.$eval(sel(id), e => (e as HTMLElement).innerText).catch(() => "");
async function waitText(p: Page, id: string, re: RegExp, ms = 60_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const t = await text(p, id); if (re.test(t)) return t; await sleep(250); }
  throw new Error(`${id} never showed ${re} (it says "${(await text(p, id)).slice(0, 200)}")`);
}
/** A screenshot into --shots (`once`: keep the first of a name, for screens every scenario passes through). */
async function shot(p: Page, name: string, once = false) {
  if (!SHOTS) return;
  const f = path.join(SHOTS, `${name}.png`);
  if (once && fs.existsSync(f)) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: f });
}
const matchOfUrl = (p: Page): Hex | null => (new URL(p.url()).searchParams.get("match") as Hex | null);
async function waitMatch(p: Page, ms = 60_000): Promise<Hex> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = matchOfUrl(p); if (m) return m; await sleep(250); }
  throw new Error("the match never locked");
}

// ---- the chain, read directly ---------------------------------------------------------------------------------------------

const pub = createPublicClient({ transport: http(rpcUrl) });
let VAULT: Address, TOKEN: Address;
async function vaultAddrs() {
  const c = await (await fetch(`${relayUrl}/config`)).json() as { vault: Address; token: Address };
  VAULT = getAddress(c.vault);
  TOKEN = getAddress(c.token);
}
const rv = <T>(fn: string, args: unknown[] = []) => pub.readContract({ address: VAULT, abi: GAME_VAULT_ABI, functionName: fn, args } as never) as Promise<T>;
const free = (a: Address) => rv<bigint>("freeOf", [a]);
const locked = (a: Address) => rv<bigint>("lockedOf", [a]);
const walletBal = (a: Address) => pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
async function solvent() {
  const [liab, bal] = await Promise.all([rv<bigint>("totalLiabilities"), walletBal(VAULT)]);
  expect(liab === bal, `totalLiabilities (${liab}) equals the vault's token balance (${bal})`);
}
function expect(ok: boolean, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  log(`ok: ${what}`);
}

// ---- the page flows ---------------------------------------------------------------------------------------------------------

async function connected(p: Page, who: Address) {
  await p.waitForSelector(sel("wager-page"), { timeout: 90_000 });
  await waitText(p, "wager-banner-wallet", new RegExp(who.slice(0, 6)), 30_000);
}
async function fund(p: Page) {
  await click(p, "wager-faucet");
  await waitText(p, "wager-walletbal", /[1-9]/, 60_000);
  await fill(p, "wager-deposit-amount", "1000");
  await click(p, "wager-deposit");
  await waitText(p, "wager-free", /1,000/, 60_000);
  await authorise(p);
}
/** A session key (cap 3 x 300: every match of the run fits, with the voids giving their stake back). */
async function authorise(p: Page) {
  await fill(p, "wager-session-max", "300");
  await click(p, "wager-authorise");
  await waitText(p, "wager-session", /session key on/, 60_000);
}
/** Create an offer (an invite link, or listed in the open lobby); returns its match id. */
async function create(p: Page, mode: "link" | "listed", secs = 20): Promise<Hex> {
  await click(p, "wager-new");
  await fill(p, "wager-create-stake", "100");
  await click(p, `wager-create-secs-${secs}`);
  await click(p, mode === "link" ? "wager-create-link" : "wager-create-listed");
  await p.waitForSelector(`${sel("wager-create-submit")}:not([disabled])`, { timeout: 60_000 });
  await shot(p, "create-form", true);
  await click(p, "wager-create-submit");
  await p.waitForSelector(`${sel("wager-mine")} ${sel("wager-offer")}`, { timeout: 30_000 });
  return (await p.$eval(`${sel("wager-mine")} ${sel("wager-offer")}`, e => (e as HTMLElement).dataset.match)) as Hex;
}
async function joinByLink(b: Browser, id: Hex, extra: string): Promise<Page> {
  const p = await open(b, `&join=${id}${extra}`);
  await connected(p, PLAYER[1]);
  await p.waitForSelector(sel("wager-join"), { timeout: 30_000 });
  await shot(p, "invite", true);
  await click(p, "wager-offer-join");
  return p;
}
/** Both players READY each round until the outcome shows on `watch`. */
async function playOut(pages: Page[], watch: Page, ms = 600_000) {
  const t0 = Date.now();
  let shotRound = false;
  while (Date.now() - t0 < ms) {
    if (await watch.$(sel("wager-outcome"))) return;
    if (!shotRound && (await watch.$(sel("wager-round-result")))) { shotRound = true; await shot(watch, "between-rounds", true); }
    for (const p of pages) {
      if (p.isClosed()) continue;
      const b = await p.$(`${sel("wager-ready")}:not([disabled])`);
      if (b) { await centre(p, sel("wager-ready")); await b.click().catch(() => undefined); }
    }
    await sleep(1000);
  }
  throw new Error("the series never ended");
}
/** Two pages on a locked series: READY, a round shot, the whole best of 3, both outcomes. */
async function series(pa: Page, pb: Page, tag: string): Promise<void> {
  await pa.waitForSelector(sel("wager-pick"), { timeout: 60_000 });
  await shot(pa, `${tag}-before-round-1`);
  for (const p of [pa, pb]) await click(p, "wager-ready", 60_000);
  await pa.waitForSelector(sel("tag-series"), { timeout: 90_000 });
  await sleep(8000);
  await shot(pa, `${tag}-round`);
  await playOut([pa, pb], pa);
  await pb.waitForSelector(sel("wager-outcome"), { timeout: 60_000 });
}
/** Balances after a played series: the winner +pot-fee-stake, the loser -stake, the house +fee. */
async function paid(before: bigint[], house0: bigint, feeBps: number, what: string): Promise<"A" | "B"> {
  const [fa, fb] = [await free(PLAYER[0]), await free(PLAYER[1])];
  const pot = 200n * E18, fee = (pot * BigInt(feeBps)) / 10_000n;
  const aWon = fa > before[0];
  const [w, l] = aWon ? [fa - before[0], before[1] - fb] : [fb - before[1], before[0] - fa];
  expect(w === pot - fee - 100n * E18 && l === 100n * E18, `${what}: the winner (${aWon ? "A" : "B"}) +${(pot - fee) / E18 - 100n} net (${(pot - fee) / E18} of the 200 pot), the loser -100`);
  expect((await rv<bigint>("houseAccrued")) - house0 === fee, `${what}: the house +${Number(fee) / 1e18} (${feeBps / 100}% of 200)`);
  await solvent();
  return aWon ? "A" : "B";
}
async function lobbyPages(BA: Browser, BB: Browser, extra = ""): Promise<[Page, Page]> {
  const pa = await open(BA, `&devwallet=1&bot=normal${extra}`), pb = await open(BB, `&devwallet=2&bot=normal${extra}`);
  await connected(pa, PLAYER[0]);
  await connected(pb, PLAYER[1]);
  return [pa, pb];
}
/** The vault owner (anvil #0, local only) changes the house fees. */
async function setFees(fee: number, holderFee: number) {
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const w = createWalletClient({ account: privateKeyToAccount(ANVIL0), chain, transport: http(rpcUrl) });
  const h = await w.writeContract({ address: VAULT, abi: GAME_VAULT_ABI, functionName: "setHouseFees", args: [fee, holderFee] } as never);
  await pub.waitForTransactionReceipt({ hash: h });
  expect((await rv<number>("houseFeeBps")) === fee, `the owner set the house fee to ${fee / 100}%`);
}

// ---- scenarios ----------------------------------------------------------------------------------------------------------

async function main() {
  const stack = FAKE ? await fakeStack() : await realStack();
  let site: ChildProcess | null = null;
  try {
    await stack.startRelay({ hold: false });
    await vaultAddrs();
    site = await startSite();
    const [BA, BB] = [await browser("a", 1024, 640), await browser("b", 1024, 640)];
    const [A, B] = PLAYER;
    // Funding (both players, once).
    let [pa, pb] = await lobbyPages(BA, BB);
    await shot(pa, "lobby-no-funds");
    await fund(pa);
    await fund(pb);
    await shot(pa, "wallet-funded");
    const f0 = [await free(A), await free(B)];
    expect(f0[0] === 1000n * E18 && f0[1] === 1000n * E18, "both deposited 1,000 through approve (exactly) + deposit");

    if (ONLY.has("cancel")) {
      log("--- cancelled offers never lock: withdrawn in the lobby, and killed on chain");
      const id = await create(pa, "listed");
      await pb.waitForSelector(`[data-match="${id}"]`, { timeout: 30_000 });
      await shot(pb, "lobby-offer");
      await click(pa, "wager-offer-cancel");
      await pb.waitForSelector(`[data-match="${id}"]`, { hidden: true, timeout: 30_000 });
      expect((await rv<{ state: number }>("matchOf", [id])).state === 0, "a cancelled offer has no match on chain");
      const id2 = await create(pa, "listed");
      await pb.waitForSelector(`[data-match="${id2}"]`, { timeout: 30_000 });
      await click(pa, "wager-offer-cancel-chain");
      await pb.waitForSelector(`[data-match="${id2}"]`, { hidden: true, timeout: 30_000 });
      const t0 = Date.now();
      while ((await rv<{ state: number }>("matchOf", [id2])).state !== 4 && Date.now() - t0 < 30_000) await sleep(300);
      expect((await rv<{ state: number }>("matchOf", [id2])).state === 4, "cancelled on chain: its id can never lock (state Cancelled)");
    }

    if (ONLY.has("open")) {
      log("--- an open offer found in the lobby: the creator signs a named Entry for the joiner; best of 3; settle 97/3; verify");
      [pa, pb] = await lobbyPages(BA, BB);
      const before = [await free(A), await free(B)], house0 = await rv<bigint>("houseAccrued");
      const id = await create(pa, "listed");
      const row = `${sel("wager-offers")} [data-match="${id}"]`;
      await pb.waitForSelector(row, { timeout: 30_000 });
      await shot(pb, "lobby-open-offers");
      await pb.waitForSelector(`${row} ${sel("wager-offer-join")}:not([disabled])`, { timeout: 30_000 });
      await centre(pb, `${row} ${sel("wager-offer-join")}`);
      await pb.click(`${row} ${sel("wager-offer-join")}`);
      await waitMatch(pb);
      await waitMatch(pa);
      expect((await locked(A)) === 100n * E18 && (await locked(B)) === 100n * E18, "the lock took both stakes");
      await series(pa, pb, "open");
      await waitText(pa, "wager-settle-state", /settled/, 90_000);
      await shot(pa, "outcome-a");
      await shot(pb, "outcome-b");
      await paid(before, house0, 300, "open offer");
      // The public match page: replayed in the browser, the same winner, the hash on chain.
      const v = await open(BB, `&verify=${id}`);
      await waitText(v, "wager-verdict", /VERIFIED|DOESN'T/, 180_000);
      expect((await v.$eval(sel("wager-verdict"), e => (e as HTMLElement).dataset.ok)) === "1", "the verify page says VERIFIED (replay, log hash on chain, the paid winner)");
      await shot(v, "verify");
      // The player's history, from the vault's events.
      pa = await open(BA, "&devwallet=1");
      await connected(pa, A);
      await click(pa, "wager-tab-history");
      await pa.waitForSelector(sel("wager-history-row"), { timeout: 60_000 });
      await shot(pa, "history");
    }

    if (ONLY.has("invite")) {
      // Both hold a Radbro, so whoever wins pays the holder rate (the open offer above, with no holders, paid 3%).
      log("--- an invite link between two Radbro holders: the winner pays the holder rate, 1.5%");
      await stack.stopRelay();
      await stack.startRelay({ hold: false, holders: [A, B] });
      [pa, pb] = await lobbyPages(BA, BB);
      await pa.waitForSelector(`${sel("wager-banner-wallet")}`, { timeout: 30_000 });
      const before = [await free(A), await free(B)], house0 = await rv<bigint>("houseAccrued");
      const id = await create(pa, "link");
      await shot(pa, "my-offers");
      const jb = await joinByLink(BB, id, "&devwallet=2&bot=normal");
      await waitMatch(jb);
      await waitMatch(pa);
      await series(pa, jb, "invite");
      await waitText(pa, "wager-settle-state", /settled/, 90_000);
      await paid(before, house0, 150, "invite, a holder won");
      await shot(pa, "outcome-holder-rate");
      await stack.stopRelay();
      await stack.startRelay({ hold: false });
    }

    if (ONLY.has("fee0")) {
      log("--- a 0% house fee: the winner takes the whole pot");
      await setFees(0, 0);
      await stack.stopRelay();
      await stack.startRelay({ hold: false });
      [pa, pb] = await lobbyPages(BA, BB);
      const before = [await free(A), await free(B)], house0 = await rv<bigint>("houseAccrued");
      const id = await create(pa, "link");
      const jb = await joinByLink(BB, id, "&devwallet=2&bot=normal");
      await waitMatch(jb);
      await waitMatch(pa);
      await series(pa, jb, "fee0");
      await waitText(pa, "wager-settle-state", /settled/, 90_000);
      await paid(before, house0, 0, "0% fee");
      await setFees(300, 150);
      await stack.stopRelay();
      await stack.startRelay({ hold: false });
    }

    if (ONLY.has("noshow")) {
      log("--- B never connects to the series: void, stakes back");
      [pa, pb] = await lobbyPages(BA, BB);
      const before = [await free(A), await free(B)];
      const id = await create(pa, "link");
      const jb = await joinByLink(BB, id, "&devwallet=2&bot=normal");
      await waitMatch(jb);
      await jb.close();
      await waitMatch(pa);
      expect((await locked(A)) === 100n * E18, "the lock took A's stake");
      await pa.waitForSelector(sel("wager-outcome"), { timeout: 120_000 });
      await waitText(pa, "wager-outcome", /VOID/);
      await waitText(pa, "wager-settle-state", /refunded|settled/, 60_000);
      await shot(pa, "noshow");
      expect((await free(A)) === before[0] && (await free(B)) === before[1], "a no-show voids the series and both stakes come back");
      void id;
    }

    if (ONLY.has("forfeit")) {
      log("--- B closes the tab mid-series: forfeit after the grace");
      [pa, pb] = await lobbyPages(BA, BB);
      const before = [await free(A), await free(B)];
      const id = await create(pa, "link");
      const jb = await joinByLink(BB, id, "&devwallet=2&bot=normal");
      await waitMatch(jb);
      await waitMatch(pa);
      for (const p of [pa, jb]) await click(p, "wager-ready", 60_000);
      await pa.waitForSelector(sel("tag-series"), { timeout: 90_000 });
      await sleep(6000);
      await jb.close();
      await pa.waitForSelector(sel("wager-outcome"), { timeout: 120_000 });
      const o = await waitText(pa, "wager-outcome", /YOU WIN/);
      expect(/forfeit|left/.test(o), "the outcome says the opponent left (forfeit)");
      await waitText(pa, "wager-settle-state", /settled/, 60_000);
      await shot(pa, "forfeit");
      expect((await free(A)) === before[0] + 94n * E18 && (await free(B)) === before[1] - 100n * E18, "the forfeit pays A 194 (A +94, B -100)");
      void id;
    }

    if (ONLY.has("dispute")) {
      log("--- both clients report a final hash the referee's replay doesn't give: held for review, voided, both refunded");
      await stack.stopRelay();
      await stack.startRelay({ hold: true });
      [pa, pb] = await lobbyPages(BA, BB, "&badhash");
      const before = [await free(A), await free(B)];
      const id = await create(pa, "link");
      const jb = await joinByLink(BB, id, "&devwallet=2&bot=normal&badhash");
      await waitMatch(jb);
      await waitMatch(pa);
      await series(pa, jb, "dispute");
      await pa.waitForSelector(sel("wager-held"), { timeout: 60_000 });
      const lg = await (await fetch(`${relayUrl}/log/${id}`)).json() as { flags?: { kind: string }[] };
      expect(!!lg.flags?.some(f => f.kind === "result-mismatch"), "the referee flagged result-mismatch (both clients agree with each other, not with the replay)");
      await shot(pa, "held-dispute");
      expect((await locked(A)) === 100n * E18 && (await locked(B)) === 100n * E18, "a held series keeps both stakes locked");
      const owner = await open(BB, `&review=${id}&devwallet=0`);
      await owner.waitForSelector(sel("wager-review-void"), { timeout: 180_000 });
      await shot(owner, "review");
      await click(owner, "wager-review-void", 120_000);
      await waitText(pa, "wager-settle-state", /refunded/, 90_000);
      await shot(pa, "dispute-refunded");
      expect((await free(A)) === before[0] && (await free(B)) === before[1], "the review voided it: both stakes back, no fee");
      const v = await open(BB, `&verify=${id}`);
      await waitText(v, "wager-verdict", /VERIFIED|DOESN'T/, 180_000);
      expect((await v.$eval(sel("wager-verdict"), e => (e as HTMLElement).dataset.ok)) === "1", "the verify page accepts the review's void (the log says void too)");
      await stack.stopRelay();
      await stack.startRelay({ hold: false });
    }

    if (ONLY.has("hold")) {
      log("--- a flagged winner: held for review, then the owner's review settles it");
      await stack.stopRelay();
      await stack.startRelay({ hold: true });
      // Both players are the sharp bot, so whoever wins is one: only flags against the winner hold a series. The
      // rounds are 60 s: the referee's flags need a few Yoinks and chases per player (docs/WAGER.md §6.2), which
      // three 20 s rounds between bots often don't give.
      const sharp = FAKE ? "normal" : "sharp";
      pa = await open(BA, `&devwallet=1&bot=${sharp}`);
      pb = await open(BB, `&devwallet=2&bot=${sharp}`);
      await connected(pa, A);
      await connected(pb, B);
      const before = [await free(A), await free(B)];
      const id = await create(pa, "link", FAKE ? 20 : 60);
      const jb = await joinByLink(BB, id, `&devwallet=2&bot=${sharp}`);
      await waitMatch(jb);
      await waitMatch(pa);
      for (const p of [pa, jb]) await click(p, "wager-ready", 60_000);
      await playOut([pa, jb], pa, 600_000);
      await pa.waitForSelector(sel("wager-held"), { timeout: 60_000 }).catch(async () => {
        // Say why: the relay's log has the outcome and every flag it raised.
        const lg = await (await fetch(`${relayUrl}/log/${id}`)).json().catch(() => null) as { outcome?: unknown; flags?: unknown } | null;
        throw new Error(`the series wasn't held: outcome ${JSON.stringify(lg?.outcome)}, flags ${JSON.stringify(lg?.flags)}`);
      });
      await shot(pa, "held-flags");
      expect((await locked(A)) === 100n * E18, "a held series keeps both stakes locked");
      const owner = await open(BB, `&review=${id}&devwallet=0`);
      await click(owner, "wager-review-settle", 180_000);
      await waitText(pa, "wager-settle-state", /settled/, 90_000);
      const won = (await free(A)) > before[0];
      expect(((await free(A)) + (await free(B))) === before[0] + before[1] - 6n * E18, `the review settled it (${won ? "A" : "B"} won; the house took 6)`);
      await stack.stopRelay();
      await stack.startRelay({ hold: false });
    }

    if (ONLY.has("mutual")) {
      log("--- the relay is gone after the lock: both wallets sign the same result and the vault pays it (settleMutual)");
      [pa, pb] = await lobbyPages(BA, BB);
      const before = [await free(A), await free(B)], house0 = await rv<bigint>("houseAccrued");
      const id = await create(pa, "link");
      const jb = await joinByLink(BB, id, "&devwallet=2&bot=normal");
      await waitMatch(jb);
      await waitMatch(pa);
      await stack.stopRelay();
      await pa.goto(url(`&match=${id}&devwallet=1`), { waitUntil: "load" });
      await jb.goto(url(`&match=${id}&devwallet=2`), { waitUntil: "load" });
      await click(pa, "wager-mutual-open", 90_000);
      await click(pa, "wager-mutual-me");
      await pa.waitForSelector(sel("wager-mutual-code"), { timeout: 60_000 });
      const code = await pa.$eval(sel("wager-mutual-code"), e => (e as HTMLTextAreaElement).value);
      await shot(pa, "mutual-code");
      await click(jb, "wager-mutual-open", 90_000);
      await centre(jb, sel("wager-mutual-paste"));
      await jb.click(sel("wager-mutual-paste"));
      await jb.type(sel("wager-mutual-paste"), code, { delay: 0 });
      await jb.waitForSelector(sel("wager-mutual-submit"), { timeout: 30_000 });
      await shot(jb, "mutual-check");
      await click(jb, "wager-mutual-submit");
      await waitText(jb, "wager-chain-state", /settled/, 60_000);
      await paid(before, house0, 300, "a both-wallets settle (A won, as both signed)");
      expect((await free(A)) > before[0], "A is the winner both wallets signed");
      await stack.startRelay({ hold: false });
    }

    if (ONLY.has("refund")) {
      log("--- the relay dies after the lock: after settleBy A takes back its own stake, then anyone refunds the rest");
      [pa, pb] = await lobbyPages(BA, BB);
      const before = [await free(A), await free(B)];
      const id = await create(pa, "link");
      const jb = await joinByLink(BB, id, "&devwallet=2&bot=normal");
      await waitMatch(jb);
      await waitMatch(pa);
      await stack.stopRelay();
      await jb.close();
      const window = await rv<number>("settleWindow");
      await pub.request({ method: "evm_increaseTime" as never, params: [Number(window) + 120] as never });
      await pub.request({ method: "evm_mine" as never, params: [] as never });
      await pa.goto(url(`&match=${id}&devwallet=1`), { waitUntil: "load" });
      await click(pa, "wager-reclaim", 90_000);
      const t0 = Date.now();
      while ((await free(A)) !== before[0] && Date.now() - t0 < 60_000) await sleep(300);
      expect((await free(A)) === before[0] && (await locked(B)) === 100n * E18, "A took back only its own stake (a transaction naming only A)");
      await click(pa, "wager-refund", 60_000);
      await waitText(pa, "wager-chain-state", /refunded/, 60_000);
      await shot(pa, "refund");
      expect((await free(A)) === before[0] && (await free(B)) === before[1], "refundExpired released B's stake too, with the relay down");
      await stack.startRelay({ hold: false });
    }

    if (ONLY.has("withdraw")) {
      log("--- both withdraw everything, straight to their wallets");
      for (const [b, who, n] of [[BA, A, 1], [BB, B, 2]] as const) {
        const w0 = await walletBal(who), f = await free(who);
        const q = await open(b, `&devwallet=${n}`);
        await connected(q, who);
        // MAX fills in the free balance once the page has read it.
        await waitText(q, "wager-free", /[1-9]/, 60_000);
        await click(q, "wager-withdraw-amount-max");
        await q.waitForFunction(s => !!(document.querySelector(s) as HTMLInputElement | null)?.value, { timeout: 30_000 }, sel("wager-withdraw-amount"));
        await click(q, "wager-withdraw");
        await waitText(q, "wager-free", /^0 /, 60_000);
        expect((await walletBal(who)) === w0 + f && (await free(who)) === 0n, `${who === A ? "A" : "B"} withdrew ${f / E18} to the wallet`);
        if (who === A) await shot(q, "withdrawn");
      }
      await solvent();
    }
    log("ALL PASSED");
  } catch (e) {
    if (SHOTS) {
      let i = 0;
      for (const b of browsers) for (const p of await b.pages().catch(() => [])) { await shot(p, `fail-${i++}`).catch(() => undefined); log(`fail-${i - 1}: ${p.url()}`); }
    }
    throw e;
  } finally {
    for (const b of browsers) await b.close().catch(() => undefined);
    if (!flag("keep")) {
      stop(site);
      await stack.close();
      for (const p of procs) stop(p);
      log(`logs in ${TMP}`);
    } else log(`--keep: processes left up (pids ${procs.map(p => p.pid).join(" ")}); logs in ${TMP}`);
  }
}

main().then(() => process.exit(0), e => { console.error(String((e as Error).stack ?? e)); for (const p of procs) stop(p); process.exit(1); });
