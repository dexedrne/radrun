// Online wire format (src/net/wire.ts; DESIGN §4): the 40-bit input word is the ghost record bit for bit, the
// prediction clears only the press bits, and every binary message round-trips.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  B_JUMP, B_SLIDE, B_SLIDE_HELD, B_WEB_HELD, B_WEB_PRESSED, B_ZIP, PITCH_RES, YAW_RES, emptyRec, type InputRec,
} from "../src/game/ghost.ts";
import {
  CODE_ALPHABET, cleanName, decodeAck, decodeDesync, decodeFill, decodeInput, decodePing, decodePong, decodeRelayInput, decodeSlotHash,
  encodeAck, encodeDesync, encodeFill, encodeInput, encodePing, encodePong, encodeRelayInput, encodeSlotHash, isRoomCode, packWord,
  predictWord, roomCode, unpackWord, MAX_INPUT_COUNT, PRESS_BITS,
} from "../src/net/wire.ts";
import { mulberry32 } from "../src/sim/math.ts";

const rec = (yaw: number, fwd: number, right: number, bits: number, pitch: number): InputRec => ({ yaw, fwd, right, bits, pitch });

test("word: every record field round-trips, extremes included", () => {
  const rand = mulberry32(3);
  const cases = [rec(0, 0, 0, 0, 0), rec(YAW_RES - 1, 127, -127, 63, PITCH_RES), rec(512, -64, 64, B_SLIDE_HELD, -PITCH_RES), rec(1, -1, 1, B_JUMP | B_ZIP, -1)];
  for (let i = 0; i < 2000; i++) {
    cases.push(rec(Math.floor(rand() * YAW_RES), Math.floor(rand() * 255) - 127, Math.floor(rand() * 255) - 127, Math.floor(rand() * 64), Math.floor(rand() * 201) - 100));
  }
  const out = emptyRec();
  for (const c of cases) {
    const w = packWord(c);
    assert.ok(Number.isInteger(w) && w >= 0 && w < 2 ** 40);
    assert.deepEqual(unpackWord(w, out), c);
  }
});

test("the press bits are the ghost record's edge buttons", () => {
  assert.equal(PRESS_BITS, B_JUMP | B_WEB_PRESSED | B_ZIP | B_SLIDE);
});

test("prediction: clears jump / web press / zip / slide press, keeps web held, C held, aim and move", () => {
  const all = B_JUMP | B_WEB_PRESSED | B_WEB_HELD | B_ZIP | B_SLIDE | B_SLIDE_HELD;
  const c = rec(700, -30, 90, all, -42);
  const p = unpackWord(predictWord(packWord(c)), emptyRec());
  assert.deepEqual(p, rec(700, -30, 90, B_WEB_HELD | B_SLIDE_HELD, -42));
  assert.equal(predictWord(predictWord(packWord(c))), predictWord(packWord(c)));
});

test("messages round-trip", () => {
  const words = [0, 1, 2 ** 40 - 1, packWord(rec(3, -5, 7, 9, -11))];
  assert.deepEqual(decodeInput(encodeInput({ firstStep: 123456, words })), { firstStep: 123456, words });
  assert.deepEqual(decodeInput(encodeInput({ firstStep: 9, words, ackStep: 4, hashStep: 60, hash: 0xdeadbeef })), { firstStep: 9, words, ackStep: 4, hashStep: 60, hash: 0xdeadbeef });
  assert.throws(() => encodeInput({ firstStep: 0, words: new Array(MAX_INPUT_COUNT + 1).fill(0) }));
  assert.equal(decodeInput(encodeInput({ firstStep: 1, words }).subarray(0, 10)), null);
  assert.deepEqual(decodeRelayInput(encodeRelayInput(3, 77, words)), { slot: 3, firstStep: 77, words });
  assert.deepEqual(decodeFill(encodeFill(1, 50, 30, words[3])), { slot: 1, firstStep: 50, count: 30, word: words[3] });
  assert.deepEqual(decodeAck(encodeAck(1000, [990, 995])), { relayStep: 1000, upTo: [990, 995] });
  assert.equal(decodePing(encodePing(4294967295)), 4294967295);
  assert.deepEqual(decodePong(encodePong(12, 1727400000123.5)), { clientMs: 12, relayMs: 1727400000123.5 });
  assert.equal(decodeDesync(encodeDesync(600)), 600);
  assert.deepEqual(decodeSlotHash(encodeSlotHash(600, [1, 0xffffffff])), { step: 600, hashes: [1, 0xffffffff] });
  // Wrong type bytes are rejected.
  assert.equal(decodeRelayInput(encodeInput({ firstStep: 1, words })), null);
  assert.equal(decodePong(encodePing(1)), null);
});

test("room codes and names", () => {
  assert.equal(CODE_ALPHABET.length, 31);
  for (const bad of "ILO01") assert.ok(!CODE_ALPHABET.includes(bad));
  const rand = mulberry32(9);
  for (let i = 0; i < 100; i++) assert.ok(isRoomCode(roomCode(rand)));
  assert.ok(!isRoomCode("ABCD") && !isRoomCode("ABCDI") && !isRoomCode("abcde"));
  assert.equal(cleanName("dex edrne!"), "dexedrne");
  assert.equal(cleanName("x"), "radbrox");
  assert.equal(cleanName("a".repeat(40)).length, 16);
});
