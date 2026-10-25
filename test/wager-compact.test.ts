import { test } from "node:test";
import assert from "node:assert/strict";
import { hashMessage, parseSignature, recoverAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { eoaSignature, isSig } from "../relay/wager/src/base.ts";
import { ViemChain } from "../relay/wager/src/chain.ts";

// Deterministic test signer, unrelated to deployment credentials.
const account = privateKeyToAccount(`0x${"12".repeat(32)}`);
function compact(sig: Hex): Hex {
  const { r, s, yParity } = parseSignature(sig);
  return `${r}${(BigInt(s) | (BigInt(yParity) << 255n)).toString(16).padStart(64, "0")}`;
}

test("relay accepts ERC-2098 and expands either parity for local recovery", async () => {
  const parities = new Set<number>();
  for (let i = 0; i < 32; i++) {
    const message = `compact signature ${i}`;
    const sig = await account.signMessage({ message });
    parities.add(parseSignature(sig).yParity);
    const short = compact(sig);
    assert.equal(isSig(short), true);
    assert.equal(short.length, 130);
    assert.equal(eoaSignature(short), sig);
    assert.equal(await recoverAddress({ hash: hashMessage(message), signature: eoaSignature(short) }), account.address);
  }
  assert.equal(parities.size, 2);
});

test("chain adapter verifies compact EOAs without an RPC and preserves the normal form", async () => {
  const chain = new ViemChain({ chainId: 31337, vault: `0x${"34".repeat(20)}`, rpcUrls: ["http://127.0.0.1:1"], timeoutMs: 10 });
  const sig = await account.signMessage({ message: "chain adapter" });
  assert.equal(eoaSignature(sig), sig);
  assert.equal(await chain.verifyHash(account.address, hashMessage("chain adapter"), compact(sig)), true);
  assert.equal(await chain.verifyHash(account.address, hashMessage("chain adapter"), sig), true);
});

test("signature wire filter rejects truncated, odd and oversized values; compact high-s is rejected", () => {
  assert.equal(isSig(`0x${"ab".repeat(63)}`), false);
  assert.equal(isSig(`0x${"ab".repeat(64)}a`), false);
  assert.equal(isSig(`0x${"ab".repeat(4000)}`), false);
  assert.throws(() => eoaSignature(`0x${"00".repeat(32)}7f${"ff".repeat(31)}`), /signature s/);
});
