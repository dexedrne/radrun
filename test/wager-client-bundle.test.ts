// The ?wager chunk in a production build (docs/WAGER.md §7.1, §7.5, §9.3): the wager code and viem live only in the
// lazy WagerPage chunk (the main entry chunk carries only the route), and the dev-only test wallet is compiled out:
// dist/ contains no devWallet, no anvil key and no anvil address. Builds into a temporary directory (never dist/).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL } from "./wager-client-fakes.ts";

const root = path.resolve(import.meta.dirname, "..");

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test("production build: the wager code is its own lazy chunk; no dev wallet, anvil key or anvil address anywhere in it", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "radrun-wager-bundle-"));
  const before = process.env.VITE_WAGER_NETS;
  process.env.VITE_WAGER_NETS = "rh-testnet";
  try {
    await build({ root, mode: "production", logLevel: "error", build: { outDir: out, emptyOutDir: true } });
    const all = files(out).filter(f => /\.(js|html|css|json|map|txt)$/.test(f));
    const text = all.map(f => [path.relative(out, f), fs.readFileSync(f, "utf8")] as const);
    // The module and what it announces (case-sensitive: `&devwallet` is only a URL parameter name the page keeps).
    const code = ["devWallet", "Dev wallet", "local.devwallet", "installDevWallet", "devProvider"];
    const keys = [...ANVIL.map(k => k.slice(2)), ...ANVIL.map(k => privateKeyToAccount(k).address.slice(2))].map(k => k.toLowerCase());
    for (const [name, body] of text) {
      for (const n of code) assert.ok(!body.includes(n), `${name} contains ${n}`);
      const lower = body.toLowerCase();
      for (const k of keys) assert.ok(!lower.includes(k), `${name} contains an anvil key or address`);
    }
    assert.ok(!files(out).some(f => /devWallet/i.test(path.basename(f))), "no dev wallet chunk");
    const js = text.filter(([n]) => n.endsWith(".js"));
    const entry = js.filter(([n]) => /^assets\/index-[\w-]+\.js$/.test(n));
    assert.ok(entry.length >= 1, "an entry chunk");
    const main = entry.reduce((a, b) => (b[1].length > a[1].length ? b : a));
    for (const marker of ["RadRun GameVault", "eip6963:announceProvider", "wallet_switchEthereumChain", "RadRun Wager Relay"]) {
      assert.ok(!main[1].includes(marker), `the main chunk carries ${marker}`);
    }
    const wager = js.find(([n]) => /WagerPage-[\w-]+\.js$/.test(n));
    assert.ok(wager, "a WagerPage chunk");
    assert.ok(wager![1].includes("RadRun GameVault") && wager![1].includes("eip6963:announceProvider"), "the wager code is in its chunk");
    assert.ok(main[1].includes(path.basename(wager![0])), "the main chunk loads it lazily by name");
    console.log(`main chunk ${main[1].length} B, WagerPage chunk ${wager![1].length} B`);
  } finally {
    if (before === undefined) delete process.env.VITE_WAGER_NETS; else process.env.VITE_WAGER_NETS = before;
    fs.rmSync(out, { recursive: true, force: true });
  }
});
