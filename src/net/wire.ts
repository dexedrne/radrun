// Online wire format (multiplayer design §4). Pure TS shared by the client, the relay and the tests; no DOM.
//
// One step of one player's input is the ghost record (game/ghost.ts InputRec) packed into a 41-bit "word", kept as a
// plain JS number (an integer below 2^41, so it is exact) and sent as 6 bytes:
//   bits  0-9   yaw          (0..1023, 1024 per turn)
//   bits 10-17  fwd          (int8, 1/64 steps)
//   bits 18-25  right        (int8)
//   bits 26-31  buttons      jump, webPressed, webHeld, zip, slide, slideHeld (the record's bits, ghost FORMAT 4)
//   bits 32-39  pitch        (int8, the pitch sine x 100; round 12's straight zip)
//   bit  40     glideHeld    (held wingsuit, ghost format 6)
// multiplayer design §3.4 planned a 31-bit word; round 12 added pitch and C-held; glide adds the sixth byte.
//
// Binary messages are little-endian, one WebSocket frame each; control messages are JSON text frames.
import type { InputRec } from "../game/ghost.ts";

/** Bumped on any change to the wire format or the online match rules (2: the web-slinger swing changed the sim). */
export const NET_VERSION = 3;

const LO = 4294967296;
/**
 * Button bits that are one-step edges (the ghost record's B_JUMP | B_WEB_PRESSED | B_ZIP | B_SLIDE; test/wire.test.ts
 * checks them): a prediction never repeats them. Spelled out so the relay bundle never pulls in the sim.
 */
export const PRESS_BITS = 1 | 2 | 8 | 16;

const s8 = (v: number) => ((v & 0xff) << 24) >> 24;

export function packWord(r: InputRec): number {
  const lo = ((r.yaw & 0x3ff) | ((r.fwd & 0xff) << 10) | ((r.right & 0xff) << 18) | ((r.bits & 0x3f) << 26)) >>> 0;
  return ((r.pitch & 0xff) | ((r.bits & 64) << 2)) * LO + lo;
}

export function unpackWord(w: number, out: InputRec): InputRec {
  const lo = w % LO, hi = (w - lo) / LO;
  out.yaw = lo & 0x3ff;
  out.fwd = s8(lo >>> 10);
  out.right = s8(lo >>> 18);
  out.bits = ((lo >>> 26) & 0x3f) | ((hi & 256) >>> 2);
  out.pitch = s8(hi);
  return out;
}

/** The prediction for a missing step (§3.4): the last confirmed word with its press bits cleared. */
export function predictWord(w: number): number {
  const lo = w % LO, hi = w - lo;
  return hi + ((lo & ~(PRESS_BITS << 26)) >>> 0);
}

const putWord = (v: DataView, o: number, w: number) => {
  const lo = w % LO;
  v.setUint32(o, lo, true);
  v.setUint16(o + 4, (w - lo) / LO, true);
};
const getWord = (v: DataView, o: number) => v.getUint16(o + 4, true) * LO + v.getUint32(o, true);

// ---- binary messages ------------------------------------------------------------------------------------------

export const MSG_INPUT = 0x01;
export const MSG_PING = 0x04;
export const MSG_SLOTHASH = 0x05;
export const MSG_INPUT_OUT = 0x81;
export const MSG_FILL = 0x82;
export const MSG_ACK = 0x83;
export const MSG_PONG = 0x84;
export const MSG_DESYNC = 0x86;

/**
 * At most this many steps per INPUT message (8 + 128 x 6 + 12 = 788 B, under the relay's 1 KB message cap): a
 * catch-up after a hitch sends a few big INPUTs, never a burst of small ones.
 */
export const MAX_INPUT_COUNT = 128;
export const WORD_BYTES = 6;

export type InputMsg = {
  firstStep: number;
  words: number[];
  /** Highest step of the other players' inputs this client has, contiguous (flag 2). */
  ackStep?: number;
  /** A confirmed state hash (flag 1). */
  hashStep?: number;
  hash?: number;
};

/** INPUT client -> relay: u8 type · u8 flags (1 hash, 2 ack) · u16 count · u32 firstStep · count × 5 B · [u32 ack] · [u32 step · u32 hash]. */
export function encodeInput(m: InputMsg): Uint8Array {
  const n = m.words.length;
  if (n > MAX_INPUT_COUNT) throw new Error(`INPUT count ${n} > ${MAX_INPUT_COUNT}`);
  const ack = m.ackStep !== undefined, hash = m.hashStep !== undefined && m.hash !== undefined;
  const buf = new Uint8Array(8 + n * WORD_BYTES + (ack ? 4 : 0) + (hash ? 8 : 0));
  const v = new DataView(buf.buffer);
  v.setUint8(0, MSG_INPUT);
  v.setUint8(1, (hash ? 1 : 0) | (ack ? 2 : 0));
  v.setUint16(2, n, true);
  v.setUint32(4, m.firstStep, true);
  let o = 8;
  for (const w of m.words) { putWord(v, o, w); o += WORD_BYTES; }
  if (ack) { v.setUint32(o, m.ackStep!, true); o += 4; }
  if (hash) { v.setUint32(o, m.hashStep!, true); v.setUint32(o + 4, m.hash! >>> 0, true); }
  return buf;
}

export function decodeInput(buf: Uint8Array): InputMsg | null {
  if (buf.length < 8 || buf[0] !== MSG_INPUT) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = v.getUint8(1), n = v.getUint16(2, true);
  const need = 8 + n * WORD_BYTES + (flags & 2 ? 4 : 0) + (flags & 1 ? 8 : 0);
  if (n > MAX_INPUT_COUNT || buf.length !== need) return null;
  const m: InputMsg = { firstStep: v.getUint32(4, true), words: [] };
  let o = 8;
  for (let i = 0; i < n; i++) { m.words.push(getWord(v, o)); o += WORD_BYTES; }
  if (flags & 2) { m.ackStep = v.getUint32(o, true); o += 4; }
  if (flags & 1) { m.hashStep = v.getUint32(o, true); m.hash = v.getUint32(o + 4, true); }
  return m;
}

export type RelayInput = { slot: number; firstStep: number; words: number[] };

/** INPUT relay -> client: u8 type · u8 slot (stamped by the relay from the socket) · u16 count · u32 firstStep · count × 5 B. */
export function encodeRelayInput(slot: number, firstStep: number, words: ArrayLike<number>): Uint8Array {
  const n = words.length;
  const buf = new Uint8Array(8 + n * WORD_BYTES);
  const v = new DataView(buf.buffer);
  v.setUint8(0, MSG_INPUT_OUT);
  v.setUint8(1, slot);
  v.setUint16(2, n, true);
  v.setUint32(4, firstStep, true);
  for (let i = 0; i < n; i++) putWord(v, 8 + i * WORD_BYTES, words[i]);
  return buf;
}

export function decodeRelayInput(buf: Uint8Array): RelayInput | null {
  if (buf.length < 8 || buf[0] !== MSG_INPUT_OUT) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = v.getUint16(2, true);
  if (buf.length !== 8 + n * WORD_BYTES) return null;
  const words: number[] = [];
  for (let i = 0; i < n; i++) words.push(getWord(v, 8 + i * WORD_BYTES));
  return { slot: v.getUint8(1), firstStep: v.getUint32(4, true), words };
}

/** FILL relay -> client (Phase 2): the relay's stand-in word for `count` steps of a late / dropped slot. */
export function encodeFill(slot: number, firstStep: number, count: number, word: number): Uint8Array {
  const buf = new Uint8Array(8 + WORD_BYTES);
  const v = new DataView(buf.buffer);
  v.setUint8(0, MSG_FILL); v.setUint8(1, slot); v.setUint16(2, count, true); v.setUint32(4, firstStep, true);
  putWord(v, 8, word);
  return buf;
}

export function decodeFill(buf: Uint8Array): { slot: number; firstStep: number; count: number; word: number } | null {
  if (buf.length !== 8 + WORD_BYTES || buf[0] !== MSG_FILL) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { slot: v.getUint8(1), count: v.getUint16(2, true), firstStep: v.getUint32(4, true), word: getWord(v, 8) };
}

/** ACK relay -> client: u8 type · u8 n · u16 pad · u32 relayStep · u32 × n (per slot: accepted up to). */
export function encodeAck(relayStep: number, upTo: ArrayLike<number>): Uint8Array {
  const n = upTo.length;
  const buf = new Uint8Array(8 + 4 * n);
  const v = new DataView(buf.buffer);
  v.setUint8(0, MSG_ACK); v.setUint8(1, n); v.setUint32(4, relayStep >>> 0, true);
  for (let i = 0; i < n; i++) v.setUint32(8 + 4 * i, upTo[i] >>> 0, true);
  return buf;
}

export function decodeAck(buf: Uint8Array): { relayStep: number; upTo: number[] } | null {
  if (buf.length < 8 || buf[0] !== MSG_ACK) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = v.getUint8(1);
  if (buf.length !== 8 + 4 * n) return null;
  const upTo: number[] = [];
  for (let i = 0; i < n; i++) upTo.push(v.getUint32(8 + 4 * i, true));
  return { relayStep: v.getUint32(4, true), upTo };
}

/** PING client -> relay: u8 type · u32 client ms (echoed). */
export function encodePing(clientMs: number): Uint8Array {
  const buf = new Uint8Array(5);
  new DataView(buf.buffer).setUint32(1, clientMs >>> 0, true);
  buf[0] = MSG_PING;
  return buf;
}

export function decodePing(buf: Uint8Array): number | null {
  if (buf.length !== 5 || buf[0] !== MSG_PING) return null;
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, true);
}

/** PONG relay -> client: u8 type · u32 client ms · f64 relay ms. */
export function encodePong(clientMs: number, relayMs: number): Uint8Array {
  const buf = new Uint8Array(13);
  const v = new DataView(buf.buffer);
  v.setUint8(0, MSG_PONG); v.setUint32(1, clientMs >>> 0, true); v.setFloat64(5, relayMs, true);
  return buf;
}

export function decodePong(buf: Uint8Array): { clientMs: number; relayMs: number } | null {
  if (buf.length !== 13 || buf[0] !== MSG_PONG) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { clientMs: v.getUint32(1, true), relayMs: v.getFloat64(5, true) };
}

/** DESYNC relay -> client: u8 type · u32 step. */
export function encodeDesync(step: number): Uint8Array {
  const buf = new Uint8Array(5);
  new DataView(buf.buffer).setUint32(1, step >>> 0, true);
  buf[0] = MSG_DESYNC;
  return buf;
}

export function decodeDesync(buf: Uint8Array): number | null {
  if (buf.length !== 5 || buf[0] !== MSG_DESYNC) return null;
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, true);
}

/** SLOTHASH client -> relay (after a DESYNC): u8 type · u32 step · u8 n · u32 × n per-slot body hashes. */
export function encodeSlotHash(step: number, hashes: ArrayLike<number>): Uint8Array {
  const n = hashes.length;
  const buf = new Uint8Array(6 + 4 * n);
  const v = new DataView(buf.buffer);
  v.setUint8(0, MSG_SLOTHASH); v.setUint32(1, step >>> 0, true); v.setUint8(5, n);
  for (let i = 0; i < n; i++) v.setUint32(6 + 4 * i, hashes[i] >>> 0, true);
  return buf;
}

export function decodeSlotHash(buf: Uint8Array): { step: number; hashes: number[] } | null {
  if (buf.length < 6 || buf[0] !== MSG_SLOTHASH) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = v.getUint8(5);
  if (buf.length !== 6 + 4 * n) return null;
  const hashes: number[] = [];
  for (let i = 0; i < n; i++) hashes.push(v.getUint32(6 + 4 * i, true));
  return { step: v.getUint32(1, true), hashes };
}

// ---- JSON control messages ------------------------------------------------------------------------------------

/** What a client must share with the room to play in it (multiplayer design §3.6): mismatches get "reload to update". */
export type Compat = { v: number; build: string; link: number; city: string; tuning: string };

export type PlayerInfo = { slot: number; name: string; radbro: string; touch: boolean; easy: boolean; ready: boolean };

export type RoomConfig = { district: string; mode: "tag"; seconds: number; maxPlayers: number };

export type ClientMsg =
  | { t: "hello"; compat: Compat; name: string; radbro: string; touch: boolean; easy: boolean; district: string; token?: string }
  | { t: "pick"; radbro: string }
  | { t: "config"; seconds?: number }
  | { t: "ready"; ready: boolean; rtt?: number }
  | { t: "end"; step: number; hash: number; bag: number[] };

export type StartMsg = {
  t: "start";
  seed: number;
  /** Relay time (ms) at which step 0 of the match begins. */
  startAtMs: number;
  slots: { slot: number; name: string; radbro: string; touch: boolean; easy: boolean }[];
  config: RoomConfig;
  round: number;
  /** Steps of input delay for everyone in this match (from the players' round trips). */
  inputDelay: number;
};

export type ServerMsg =
  | { t: "welcome"; slot: number; token: string; host: boolean; room: string; players: PlayerInfo[]; config: RoomConfig; lag: number }
  | { t: "lobby"; players: PlayerInfo[]; config: RoomConfig }
  | StartMsg
  | { t: "drop"; slot: number }
  | { t: "result"; round: number; ok: boolean; hashes: (number | null)[] }
  | { t: "error"; code: "full" | "version" | "room" | "bad" | "busy" | "rate"; message: string };

export const encodeJson = (m: ClientMsg | ServerMsg): string => JSON.stringify(m);

/** Room codes (§2.4): 5 characters from an alphabet without I, L, O, 0 or 1. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LEN = 5;
export const isRoomCode = (s: string): boolean => s.length === CODE_LEN && [...s].every(c => CODE_ALPHABET.includes(c));
export function roomCode(rand: () => number): string {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

/** Names (§6): 3-16 characters from A-Z a-z 0-9 _ - . ; anything else is replaced. */
export function cleanName(s: string): string {
  const t = s.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 16);
  return t.length >= 3 ? t : `radbro${t}`.slice(0, 16);
}
