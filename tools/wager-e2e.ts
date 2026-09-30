// SPIDER-TAG wager end to end (docs/WAGER.md §9.4): a local chain, the wager relay, a build:test of the site and two
// headless Chromiums with dev wallets and bots, through faucet -> approve + deposit -> session key -> invite ->
// join -> a best of 3 -> settle -> withdraw -> the verify page, plus the other paths: a cancelled offer, a no-show,
// a refund after the settle window with the relay stopped, a forfeit, and a held series settled by the owner's review.
//
//   npm run wager:e2e                 the real local stack: anvil, tools/wager-deploy.ts, relay/wager/dev.ts
//   npm run wager:e2e -- --fake       the in-process fakes (test/wager-client-fakes.ts) instead of anvil and the relay
//   options: --port-base N (anvil N+1, relay N+2, site N+3; default 5400) · --only main,cancel,noshow,refund,forfeit,hold
//            --swgl (software GL; default: the GPU through ANGLE/GL) · --keep (leave the processes up) · --shots DIR
//
// Keys: anvil's public test keys only (deployer / faucet #0, house #7, referee #8, relayer #9; players #1 and #2), passed
// to child processes in the environment, never on a command line. Every process is stopped by its own PID. Headless
// Chromium runs with throwaway profiles.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ERC20_ABI, GAME_VAULT_ABI } from "../src/wager/abi.ts";

const root = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FAKE = flag("fake");
const base = Number(opt("port-base", "5400"));
const PORTS = { rpc: base + 1, relay: base + 2, site: base + 3 };
const ONLY = new Set(opt("only", "cancel,noshow,refund,forfeit,hold,main").split(","));
const SHOTS = opt("shots", "");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "radrun-wager-e2e-"));
const E18 = 10n ** 18n;
const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  house: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  referee: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  relayer: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
} as const;
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

type Stack = { startRelay(o: { hold: boolean }): Promise<void>; stopRelay(): Promise<void>; close(): Promise<void> };

async function realStack(): Promise<Stack> {
  for (const f of ["tools/wager-deploy.ts", "relay/wager/dev.ts"]) {
    if (!fs.existsSync(path.join(root, f))) throw new Error(`${f} isn't here yet (the contracts and relay lanes add it): run with --fake, or after the lanes merge`);
  }
  const anvil = run("anvil", path.join(os.homedir(), ".foundry/bin/anvil"), ["--host", "127.0.0.1", "--port", String(PORTS.rpc), "--chain-id", "31337", "--silent"]);
  await waitHttp(rpcUrl, "anvil", 30_000, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
  const keyEnv = { DEPLOYER_KEY: ANVIL_KEYS.deployer, REFEREE_KEY: ANVIL_KEYS.referee, RELAYER_KEY: ANVIL_KEYS.relayer, FAUCET_KEY: ANVIL_KEYS.deployer };
  const addr = (k: Hex) => privateKeyToAccount(k).address;
  const dep = run("deploy", process.execPath, ["tools/wager-deploy.ts", "--net", "local"], {
    ...keyEnv, RPC_URL_PRIVATE: rpcUrl, WAGER_OWNER: addr(ANVIL_KEYS.deployer), WAGER_HOUSE: addr(ANVIL_KEYS.house),
    WAGER_FEE_BPS: "300", WAGER_HOLDER_FEE_BPS: "150", WAGER_MAX_STAKE: (1000n * E18).toString(), WAGER_MAX_BALANCE: (100_000n * E18).toString(), WAGER_SETTLE_WINDOW: "86400",
  });
  const code = await new Promise<number>(r => dep.on("exit", c => r(c ?? 1)));
  if (code !== 0) throw new Error(`the deploy tool failed (see ${path.join(TMP, "deploy.log")})`);
  let relay: ChildProcess | null = null;
  return {
    async startRelay(o) {
      relay = run("relay", process.execPath, ["relay/wager/dev.ts", "--port", String(PORTS.relay)], {
        ...keyEnv, WAGER_NET: "local", DEV: "1", ALLOWED_ORIGINS: siteUrl, RPC_URLS: rpcUrl, ETH_RPC_URLS: "http://127.0.0.1:1", ROUND_SECONDS: "20,60,90,120",
        DISTRICTS: "downtown", NEW_ACCOUNT_MAX_STAKE: (1000n * E18).toString(), NEW_ACCOUNT_SERIES: "0", JOIN_GRACE_MS: "25000", HOLD_ON_FLAGS: o.hold ? "1" : "0",
        FAUCET: "1", FAUCET_TOKENS: (10_000n * E18).toString(), FAUCET_ETH: (E18 / 100n).toString(),
      });
      await waitHttp(`${relayUrl}/health`, "the relay");
    },
    async stopRelay() { stop(relay); relay = null; await sleep(500); },
    async close() { stop(relay); stop(anvil); },
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
  const p = run("site", process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--outDir", out, "--port", String(PORTS.site), "--strictPort", "--host", "127.0.0.1"]);
  await waitHttp(siteUrl, "the site");
  return p;
}

// ---- browsers -------------------------------------------------------------------------------------------------------------

const browsers: Browser[] = [];
async function browser(tag: string, w: number, h: number): Promise<Browser> {
  const dir = path.join(os.tmpdir(), `chrome-profile-wager-e2e-${tag}`);
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
async function click(p: Page, id: string, ms = 60_000) { await p.waitForSelector(`${sel(id)}:not([disabled])`, { timeout: ms }); await p.click(sel(id)); }
async function fill(p: Page, id: string, v: string) { await p.waitForSelector(sel(id), { timeout: 30_000 }); await p.click(sel(id), { count: 3 }); await p.type(sel(id), v); }
const text = (p: Page, id: string) => p.$eval(sel(id), e => (e as HTMLElement).innerText).catch(() => "");
async function waitText(p: Page, id: string, re: RegExp, ms = 60_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const t = await text(p, id); if (re.test(t)) return t; await sleep(250); }
  throw new Error(`${id} never showed ${re} (it says "${(await text(p, id)).slice(0, 200)}")`);
}
async function shot(p: Page, name: string) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } }
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
  await fill(p, "wager-session-max", "200");
  await click(p, "wager-authorise");
  await waitText(p, "wager-session", /session key on/, 60_000);
}
/** Create an offer (an invite link, or listed); returns its match id. */
async function create(p: Page, mode: "link" | "listed"): Promise<Hex> {
  await click(p, "wager-new");
  await fill(p, "wager-create-stake", "100");
  await click(p, "wager-create-secs-20");
  await click(p, mode === "link" ? "wager-create-link" : "wager-create-listed");
  await click(p, "wager-create-submit");
  await p.waitForSelector(`${sel("wager-mine")} ${sel("wager-offer")}`, { timeout: 30_000 });
  return (await p.$eval(`${sel("wager-mine")} ${sel("wager-offer")}`, e => (e as HTMLElement).dataset.match)) as Hex;
}
async function joinByLink(b: Browser, id: Hex, extra: string): Promise<Page> {
  const p = await open(b, `&join=${id}${extra}`);
  await connected(p, PLAYER[1]);
  await click(p, "wager-offer-join");
  return p;
}
/** Both players READY each round until the outcome shows on `watch`. */
async function playOut(pages: Page[], watch: Page, ms = 600_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await watch.$(sel("wager-outcome"))) return;
    for (const p of pages) { if (p.isClosed()) continue; const b = await p.$(`${sel("wager-ready")}:not([disabled])`); if (b) await b.click().catch(() => undefined); }
    await sleep(1000);
  }
  throw new Error("the series never ended");
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
    let pa = await open(BA, "&devwallet=1&bot=normal");
    let pb = await open(BB, "&devwallet=2&bot=normal");
    await connected(pa, A);
    await connected(pb, B);
    await fund(pa);
    await fund(pb);
    await shot(pa, "funded");
    const f0 = [await free(A), await free(B)];
    expect(f0[0] === 1000n * E18 && f0[1] === 1000n * E18, "both deposited 1,000 through approve (exactly) + deposit");

    if (ONLY.has("cancel")) {
      log("--- a cancelled offer never locks");
      const id = await create(pa, "listed");
      await pb.waitForSelector(`[data-match="${id}"]`, { timeout: 30_000 });
      await click(pa, "wager-offer-cancel");
      await pb.waitForSelector(`[data-match="${id}"]`, { hidden: true, timeout: 30_000 });
      expect((await rv<{ state: number }>("matchOf", [id])).state === 0, "the cancelled offer has no match on chain");
    }

    if (ONLY.has("noshow")) {
      log("--- B never connects to the series: void, stakes back");
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
      pa = await open(BA, "&devwallet=1&bot=normal");
      await connected(pa, A);
    }

    if (ONLY.has("refund")) {
      log("--- the relay dies after the lock: after settleBy anyone refunds, no relay needed");
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
      await click(pa, "wager-refund", 90_000);
      await waitText(pa, "wager-chain-state", /refunded/, 60_000);
      await shot(pa, "refund");
      expect((await free(A)) === before[0] && (await free(B)) === before[1], "refundExpired after settleBy restores both balances with the relay down");
      await stack.startRelay({ hold: false });
      pa = await open(BA, "&devwallet=1&bot=normal");
      pb = await open(BB, "&devwallet=2&bot=normal");
      await connected(pa, A);
      await connected(pb, B);
    }

    if (ONLY.has("forfeit")) {
      log("--- B closes the tab mid-series: forfeit after the grace");
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
      expect(/forfeit/.test(o), "the outcome says forfeit");
      await waitText(pa, "wager-settle-state", /settled/, 60_000);
      await shot(pa, "forfeit");
      expect((await free(A)) === before[0] + 94n * E18 && (await free(B)) === before[1] - 100n * E18, "the forfeit pays A 194 (A +94, B -100)");
      pa = await open(BA, "&devwallet=1&bot=normal");
      await connected(pa, A);
    }

    if (ONLY.has("hold")) {
      log("--- a flagged winner: held for review, then the owner's review settles it");
      await stack.stopRelay();
      await stack.startRelay({ hold: true });
      pa = await open(BA, `&devwallet=1&bot=${FAKE ? "normal" : "sharp"}`);
      pb = await open(BB, "&devwallet=2&bot=normal");
      await connected(pa, A);
      await connected(pb, B);
      const before = [await free(A), await free(B)];
      const id = await create(pa, "link");
      const jb = await joinByLink(BB, id, "&devwallet=2&bot=normal");
      await waitMatch(jb);
      await waitMatch(pa);
      for (const p of [pa, jb]) await click(p, "wager-ready", 60_000);
      await playOut([pa, jb], pa, 600_000);
      await pa.waitForSelector(sel("wager-held"), { timeout: 60_000 });
      await shot(pa, "held");
      expect((await locked(A)) === 100n * E18, "a held series keeps both stakes locked");
      const owner = await open(BB, `&review=${id}&devwallet=0`);
      await click(owner, "wager-review-settle", 120_000);
      await waitText(pa, "wager-settle-state", /settled/, 90_000);
      await shot(owner, "review");
      const won = (await free(A)) > before[0];
      expect(((await free(A)) + (await free(B))) === before[0] + before[1] - 6n * E18, `the review settled it (${won ? "A" : "B"} won; the house took 6)`);
      await stack.stopRelay();
      await stack.startRelay({ hold: false });
      pa = await open(BA, "&devwallet=1&bot=normal");
      pb = await open(BB, "&devwallet=2&bot=normal");
      await connected(pa, A);
      await connected(pb, B);
    }

    if (ONLY.has("main")) {
      log("--- the main flow: invite, best of 3, settle 97/3, verify, withdraw");
      const before = [await free(A), await free(B)];
      const house0 = await rv<bigint>("houseAccrued");
      const id = await create(pa, "link");
      const jb = await joinByLink(BB, id, "&devwallet=2&bot=normal");
      await waitMatch(jb);
      await waitMatch(pa);
      for (const p of [pa, jb]) await click(p, "wager-ready", 60_000);
      await pa.waitForSelector(sel("tag-series"), { timeout: 90_000 });
      await sleep(8000);
      await shot(pa, "round");
      await playOut([pa, jb], pa);
      await waitText(pa, "wager-settle-state", /settled/, 90_000);
      await jb.waitForSelector(sel("wager-outcome"), { timeout: 60_000 });
      await shot(pa, "outcome-a");
      await shot(jb, "outcome-b");
      const fa = await free(A), fb = await free(B);
      const aWon = fa > before[0];
      expect((aWon ? fa - before[0] : fb - before[1]) === 94n * E18 && (aWon ? before[1] - fb : before[0] - fa) === 100n * E18, `the winner (${aWon ? "A" : "B"}) +94 net (194 of the 200 pot), the loser -100`);
      expect((await rv<bigint>("houseAccrued")) - house0 === 6n * E18, "the house +6 (3% of 200)");
      await solvent();
      // The public match page: replayed in the browser, the same winner, the hash on chain.
      const v = await open(BB, `&verify=${id}`);
      await waitText(v, "wager-verdict", /VERIFIED|DOESN'T/, 180_000);
      expect((await v.$eval(sel("wager-verdict"), e => (e as HTMLElement).dataset.ok)) === "1", "the verify page says VERIFIED (replay, log hash on chain, the paid winner)");
      await shot(v, "verify");
      // Both withdraw everything, straight to their wallets.
      for (const [p, who] of [[pa, A], [pb, B]] as const) {
        const w0 = await walletBal(who), f = await free(who);
        const q = await open(p === pa ? BA : BB, `&devwallet=${who === A ? 1 : 2}`);
        await connected(q, who);
        await click(q, "wager-withdraw-amount-max");
        await click(q, "wager-withdraw");
        await waitText(q, "wager-free", /^0 /, 60_000);
        expect((await walletBal(who)) === w0 + f && (await free(who)) === 0n, `${who === A ? "A" : "B"} withdrew ${f / E18} to the wallet`);
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
