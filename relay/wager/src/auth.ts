// Address proof on both sockets (docs/WAGER.md §4.2): the relay issues a single-use 32-byte challenge bound to its own
// base URL with a 60 s expiry; the client signs an EIP-712 Login under the relay domain with its vault session key
// (the key must be the player's live session key on-chain) or with the wallet itself (EOA, ERC-1271, ERC-6492).
// The challenge is consumed before the signature is even checked, so no Login signature ever works twice.
import { hashTypedData, recoverAddress, type Address, type Hex } from "viem";
import { loginTypedData, random32 } from "../../../src/wager/eip712.ts";
import type { LoginMsg } from "../../../src/wager/protocol.ts";
import { ZERO, addr, isSig, sameAddr } from "./base.ts";
import type { VaultChain } from "./chain.ts";

export type Challenge = { challenge: Hex; expiry: number; relay: string };

export function newChallenge(nowMs: number, relay: string, ttlMs: number): Challenge {
  return { challenge: random32(), expiry: Math.floor((nowMs + ttlMs) / 1000), relay };
}

export type LoginCheck = { ok: true; player: Address; by: "session" | "wallet" } | { ok: false; why: string };

/** Check a login against the challenge this socket was given (the caller has already consumed it). */
export async function checkLogin(chain: VaultChain, ch: Challenge | null, m: LoginMsg, nowMs: number): Promise<LoginCheck> {
  if (!ch) return { ok: false, why: "no challenge: send hello first" };
  const player = addr(m.player);
  if (!player || player === ZERO) return { ok: false, why: "bad player address" };
  if (m.expiry !== ch.expiry) return { ok: false, why: "the login does not match the challenge" };
  if (nowMs / 1000 > ch.expiry) return { ok: false, why: "the challenge expired: log in again" };
  if (!isSig(m.sig)) return { ok: false, why: "bad signature" };
  const digest = hashTypedData(loginTypedData(chain.chainId, chain.vault, { player, challenge: ch.challenge, expiry: BigInt(ch.expiry), relay: ch.relay }));
  if (m.by === "session") {
    if (m.sig.length !== 132) return { ok: false, why: "bad signature" };
    let signer: Address;
    try { signer = await recoverAddress({ hash: digest, signature: m.sig }); } catch { return { ok: false, why: "bad signature" }; }
    const s = await chain.sessionOf(player);
    if (s.key === ZERO || !sameAddr(s.key, signer)) return { ok: false, why: "not this player's session key" };
    if (s.expiry <= nowMs / 1000) return { ok: false, why: "the session key expired: authorise a new one" };
    return { ok: true, player, by: "session" };
  }
  if (m.by === "wallet") {
    return (await chain.verifyHash(player, digest, m.sig)) ? { ok: true, player, by: "wallet" } : { ok: false, why: "bad wallet signature" };
  }
  return { ok: false, why: "login by session or wallet" };
}
