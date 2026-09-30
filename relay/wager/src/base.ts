// SPIDER-TAG wager relay: the runtime-independent plumbing the cores (lobby.ts, room.ts) run on. The Durable Objects
// (worker.ts) and the Node stand-in (node.ts) supply sockets, a clock and SQLite through these small interfaces, so
// both runtimes execute exactly the same logic (docs/WAGER.md §4.1).
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

/** One client socket, as the cores see it. */
export type Sock = { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void };

/** Relay time (ms) and timers: Date.now / setTimeout in both runtimes, a fake in the tests. */
export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type SqlValue = string | number | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;
/** Synchronous SQLite: Durable Object `ctx.storage.sql` or `node:sqlite` (one statement per call). */
export interface Sql {
  exec(query: string, ...params: SqlValue[]): SqlRow[];
}

/** Log lines (never keys, signatures or anything secret). */
export type Logger = (msg: string) => void;

export const HEX32 = /^0x[0-9a-fA-F]{64}$/;
export const isHex32 = (v: unknown): v is Hex => typeof v === "string" && HEX32.test(v);
/**
 * A match id for logs: its random tail (a match id starts with its creator's address, so the head is the same for every
 * match one player creates).
 */
export const idTag = (id: string): string => `…${id.slice(-10)}`;
/** A matchId as the relay keys it (lowercase). */
export const normId = (v: string): Hex => v.toLowerCase() as Hex;

export function addr(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null;
}
export const sameAddr = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** Signature bytes: 65-byte ECDSA, or a longer ERC-1271 / ERC-6492 blob (bounded). */
export const isSig = (v: unknown): v is Hex => typeof v === "string" && isHex(v) && v.length >= 132 && v.length <= 8_000;

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** The message rate bucket of one socket (the live relay's numbers, protocol.ts WAGER_LIMITS). */
export type Bucket = { credit: number; at: number };
export function spend(b: Bucket, now: number, perSec: number, burst: number): boolean {
  b.credit = Math.min(burst, b.credit + ((now - b.at) * perSec) / 1000);
  b.at = now;
  if (b.credit < 1) return false;
  b.credit -= 1;
  return true;
}

/** gzip / gunzip with the web streams both runtimes have. */
export async function gzip(text: string): Promise<Uint8Array> {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function gunzip(b: Uint8Array): Promise<string> {
  const s = new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(s).text();
}

/** A short address for display: "0x1234…abcd". */
export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** JSON with bigint as decimal strings. */
export const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return m.split("\n")[0].slice(0, 200);
}
