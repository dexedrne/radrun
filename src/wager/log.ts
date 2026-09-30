// SPIDER-TAG wager: the series input log, its hash (the Result's logHash), the seed commit-reveal and the series
// rules (docs/WAGER.md §5.4-5.6). The referee writes the log, the vault stores only its hash, and anyone can replay it
// with the canonical sim (src/wager/replay.ts) to get the same winner. Pure TS; no DOM, no sim state.
import { encodeAbiParameters, encodePacked, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { Rand } from "../sim/math.ts";
import type { Rules, SimCompat } from "./eip712.ts";

export const LOG_FORMAT = "radrun-wager-log/1";
export const STEP_HZ = 120;
/** TagMatch's countdown (TAG_COUNTDOWN_STEPS): a round's horn is at COUNTDOWN_STEPS + roundSeconds * 120. */
export const COUNTDOWN_STEPS = 360;
export const WORD_BYTES = 6;

/** 0 = player A (the vault's playerA: the lock's first Entry), 1 = player B. Never a sim slot. */
export type Side = 0 | 1;

/** Best of 3: first to 2 round wins; an exactly drawn round is replayed, and a 3rd draw voids the series. */
export const SERIES = { bestOf: 3, winsNeeded: 2, maxDraws: 2 } as const;

export type OutcomeReason =
  | "played" // the rounds decided it
  | "forfeit" // a player left (or never readied) mid-series past the grace
  | "noshow" // a player never arrived before round 1: void
  | "draws" // more drawn rounds than SERIES.maxDraws: void
  | "review" // the owner's review voided a held series
  | "error"; // the relay could not finish the series (its own fault): void

export type FlagKind = "reaction" | "aim" | "periodic" | "late-inputs" | "desync" | "result-mismatch" | "rtt"
  /** On the loser: a win by forfeit or over idle play, after a session-key sign-in from a new IP or both seats on one IP. */
  | "session-key";
/** An anti-cheat signal (docs/WAGER.md §6.2). Informational; not in the log hash. */
export type Flag = { side: Side; kind: FlagKind; round: number; value: number; limit: number; note?: string };

/** One round's result, per PLAYER (index = Side). */
export type RoundResult = { winner: Side | "draw"; bag: [number, number]; falls: [number, number]; tags: [number, number]; hash: number };

export type RoundLog = {
  /** 1-based, drawn rounds included. */
  round: number;
  /** u32 match seed: deriveSeed(relaySecret, shares, round). */
  seed: number;
  /** The sim slot player A played in this round (slotOfAFor). */
  slotOfA: 0 | 1;
  /** Steps 1..inputDelay use the empty word 0 for both slots (net/rollback.ts). */
  inputDelay: number;
  /** The horn: COUNTDOWN_STEPS + roundSeconds * 120. */
  endStep: number;
  /** The last step with inputs: endStep, or earlier for a round cut short by a forfeit. */
  lastStep: number;
  /** Per SIM SLOT: base64 of lastStep packed words x 6 bytes little-endian (step 1 first): what the referee used. */
  words: [string, string];
  /** The referee's result (null for a round cut short). */
  result: RoundResult | null;
  /** Informational (not hashed): steps the relay filled per sim slot because a word missed its deadline. */
  fills: [number, number];
};

export type SeriesOutcome = {
  kind: "win" | "void";
  winner: Side | null;
  reason: OutcomeReason;
  score: [number, number];
  forfeit?: { by: Side; round: number; step: number; why: "disconnect" | "not-ready" };
};

/** The public record of one series: served at GET /log/<matchId> once the series is over. */
export type SeriesLog = {
  format: typeof LOG_FORMAT;
  chainId: number;
  vault: Address;
  matchId: Hex;
  /** [playerA, playerB] as locked in the vault. */
  players: [Address, Address];
  /** Token base units (decimal string), and the fees the lock captured. */
  stake: string;
  feeBps: number;
  holderFeeBps: number;
  roundSeconds: number;
  rules: Rules;
  rulesHash: Hex;
  /** The referee's sim (must equal rules.simId) and the site build it was bundled from. */
  compat: SimCompat & { build: string };
  /** Roster Radbro per player (cosmetic: the sim never reads it). */
  radbros: [string, string];
  seed: { commit: Hex; relaySecret: Hex; shares: [Hex, Hex] };
  rounds: RoundLog[];
  outcome: SeriesOutcome;
  flags: Flag[];
  /** seriesLogHash(this): the Result's logHash. */
  logHash: Hex;
};

// ---- words <-> base64 (6 bytes per word, the wire layout of net/wire.ts) -------------------------------------------

const LO = 4294967296;

export function packWords(words: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(words.length * WORD_BYTES);
  const v = new DataView(out.buffer);
  for (let i = 0; i < words.length; i++) {
    const w = words[i], lo = w % LO;
    v.setUint32(i * WORD_BYTES, lo, true);
    v.setUint16(i * WORD_BYTES + 4, (w - lo) / LO, true);
  }
  return out;
}

export function unpackWords(bytes: Uint8Array): Float64Array {
  if (bytes.length % WORD_BYTES !== 0) throw new Error(`word bytes ${bytes.length} not a multiple of ${WORD_BYTES}`);
  const n = bytes.length / WORD_BYTES, out = new Float64Array(n);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = v.getUint16(i * WORD_BYTES + 4, true) * LO + v.getUint32(i * WORD_BYTES, true);
  return out;
}

export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const wordsToBase64 = (words: ArrayLike<number>): string => bytesToBase64(packWords(words));
export const wordsFromBase64 = (s: string): Float64Array => unpackWords(base64ToBytes(s));

// ---- the log hash ---------------------------------------------------------------------------------------------------

type HeaderFields = Pick<SeriesLog, "chainId" | "vault" | "matchId" | "players" | "rulesHash" | "roundSeconds" | "seed">;

/** keccak256(abi.encode(format, chainId, vault, matchId, playerA, playerB, rulesHash, roundSeconds, relaySecret, shareA, shareB)). */
export function headerDigest(l: HeaderFields): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "address" },
        { type: "bytes32" }, { type: "uint16" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      ],
      [LOG_FORMAT, BigInt(l.chainId), l.vault, l.matchId, l.players[0], l.players[1], l.rulesHash, l.roundSeconds, l.seed.relaySecret, l.seed.shares[0], l.seed.shares[1]],
    ),
  );
}

/** keccak256(u8 round · u32 seed · u8 slotOfA · u8 inputDelay · u32 endStep · u32 lastStep · slot-0 word bytes · slot-1 word bytes), big-endian ints. */
export function roundDigest(r: Pick<RoundLog, "round" | "seed" | "slotOfA" | "inputDelay" | "endStep" | "lastStep" | "words">): Hex {
  const w0 = base64ToBytes(r.words[0]), w1 = base64ToBytes(r.words[1]);
  const need = r.lastStep * WORD_BYTES;
  if (w0.length !== need || w1.length !== need) throw new Error(`round ${r.round}: words must be ${r.lastStep} steps per slot`);
  const head = hexToBytes(
    encodePacked(["uint8", "uint32", "uint8", "uint8", "uint32", "uint32"], [r.round, r.seed >>> 0, r.slotOfA, r.inputDelay, r.endStep, r.lastStep]),
  );
  const buf = new Uint8Array(head.length + w0.length + w1.length);
  buf.set(head, 0);
  buf.set(w0, head.length);
  buf.set(w1, head.length + w0.length);
  return keccak256(buf);
}

/** The Result's logHash: keccak256(headerDigest · roundDigest(1) · ... · roundDigest(n)). A series with no rounds hashes the header alone. */
export function seriesLogHash(l: HeaderFields & { rounds: RoundLog[] }): Hex {
  const parts = [headerDigest(l), ...l.rounds.map(roundDigest)].map(h => hexToBytes(h));
  const buf = new Uint8Array(32 * parts.length);
  parts.forEach((p, i) => buf.set(p, 32 * i));
  return keccak256(buf);
}

// ---- seeds: relay commit, then one share from each player -----------------------------------------------------------

/** What the relay shows both players before they send their shares. */
export const seedCommit = (relaySecret: Hex): Hex => keccak256(relaySecret);

/** Round r's u32 seed: the first 4 bytes of keccak256(abi.encodePacked("radrun-seed", relaySecret, shareA, shareB, uint8 r)). */
export function deriveSeed(relaySecret: Hex, shares: [Hex, Hex], round: number): number {
  const h = keccak256(encodePacked(["string", "bytes32", "bytes32", "bytes32", "uint8"], ["radrun-seed", relaySecret, shares[0], shares[1], round]));
  return Number.parseInt(h.slice(2, 10), 16) >>> 0;
}

/** The sim slot that starts with the bag for a 1v1 seed (TagMatch: floor(Rand(seed).next() * 2)). */
export const firstHolderSlot = (seed: number): 0 | 1 => (Math.floor(new Rand(seed).next() * 2) as 0 | 1);

/**
 * Which sim slot player A takes in round r. Round 2 gives the bag first to whoever did not start with it in round 1;
 * every other round keeps A in slot 0 (the seed decides who starts). `round1Seed` is round 1's seed.
 */
export function slotOfAFor(round: number, seed: number, round1Seed: number): 0 | 1 {
  if (round !== 2) return 0;
  const firstInRound1: Side = firstHolderSlot(round1Seed); // round 1: A in slot 0, so slot index = side
  const want: Side = firstInRound1 === 0 ? 1 : 0;
  const fh = firstHolderSlot(seed);
  return (want === 0 ? fh : 1 - fh) as 0 | 1;
}

/** Sim slot -> side for a round. */
export const sideOfSlot = (slot: number, slotOfA: 0 | 1): Side => (slot === slotOfA ? 0 : 1);

// ---- the series score -------------------------------------------------------------------------------------------------

export type Score = { score: [number, number]; draws: number; done: boolean; winner: Side | null; void: boolean };

export function scoreRounds(winners: (Side | "draw")[]): Score {
  const score: [number, number] = [0, 0];
  let draws = 0;
  for (const w of winners) {
    if (w === "draw") {
      if (++draws > SERIES.maxDraws) return { score, draws, done: true, winner: null, void: true };
    } else if (++score[w] >= SERIES.winsNeeded) {
      return { score, draws, done: true, winner: w, void: false };
    }
  }
  return { score, draws, done: false, winner: null, void: false };
}
