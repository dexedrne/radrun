// One room of the RadRun relay (multiplayer design §5.3), independent of the runtime: the Cloudflare Durable Object
// (relay/src/worker.ts) and the local Node stand-in (relay/dev.ts) both drive it through a tiny socket interface.
//
// Phase 1: two slots, private rooms. It is the input referee's first half: it stamps each client's slot on the inputs
// it forwards (never trusting the client), checks their step ranges, answers pings with its clock, starts matches on
// a shared clock with a seed, compares the confirmed state hashes both clients report (DESYNC on a mismatch) and the
// final hashes at the horn. Late fills, drops with rejoin and checkpoints are Phase 2. Nothing is persisted and
// nothing is logged beyond counters.
import {
  MAX_INPUT_COUNT, MSG_INPUT, MSG_PING, NET_VERSION, cleanName, decodeInput, decodePing, encodeAck, encodeDesync, encodeJson, encodePong,
  encodeRelayInput, type ClientMsg, type Compat, type PlayerInfo, type RoomConfig, type ServerMsg, type StartMsg,
} from "../../src/net/wire.ts";

export type Sock = { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void };

export type RoomEnv = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  /** Dev latency knob: injected round trip (ms) between the two players (each relay leg gets a quarter each way). */
  lagMs: number;
  random(): number;
};

/** Relay limits (multiplayer design §7 `relay`). */
export const RELAY = { maxPlayers: 2, maxMsgBytes: 1024, maxMsgsPerSec: 90, startDelayMs: 2500, aheadSteps: 600 };
const STEP_MS = 1000 / 120;
const SECONDS_OK = (s: number) => Number.isFinite(s) && s >= 20 && s <= 600;

/** Input delay (steps) for a room from the players' round trips to the relay: see net/session.ts. */
export function inputDelayFor(peerRttMs: number): number {
  return peerRttMs <= 100 ? 2 : peerRttMs <= 130 ? 3 : peerRttMs <= 180 ? 4 : peerRttMs <= 240 ? 5 : 6;
}

type Player = {
  slot: number; sock: Sock; name: string; radbro: string; touch: boolean; easy: boolean; ready: boolean; compat: Compat; token: string;
  rtt: number; msgs: number; msgWindow: number; upTo: number; lastAck: number; ended: { step: number; hash: number } | null;
};

export class RoomCore {
  readonly code: string;
  private readonly env: RoomEnv;
  private readonly players: (Player | null)[] = new Array(RELAY.maxPlayers).fill(null);
  private compat: Compat | null = null;
  config: RoomConfig = { district: "downtown", mode: "tag", seconds: 180, maxPlayers: RELAY.maxPlayers };
  state: "lobby" | "play" | "results" = "lobby";
  private round = 0;
  private startAtMs = 0;
  private inputDelay = 2;
  private endStep = 0;
  /** step -> the hashes reported for it (per slot). */
  private readonly hashes = new Map<number, (number | null)[]>();
  desyncs = 0;
  matches = 0;
  lastActive: number;

  constructor(code: string, env: RoomEnv) {
    this.code = code;
    this.env = env;
    this.lastActive = env.now();
  }

  get size(): number {
    return this.players.filter(p => p).length;
  }

  // ---- lag knob: a quarter of the round trip on the way in, a quarter on the way out ----
  private send(p: Player, m: ServerMsg | Uint8Array): void {
    const data = m instanceof Uint8Array ? m : encodeJson(m);
    const go = () => { try { p.sock.send(data); } catch { /* closed */ } };
    if (this.env.lagMs > 0) this.env.setTimeout(go, this.env.lagMs / 4); else go();
  }
  private each(fn: (p: Player) => void, except = -1): void {
    for (const p of this.players) if (p && p.slot !== except) fn(p);
  }
  private info(): PlayerInfo[] {
    return this.players.filter((p): p is Player => !!p).map(p => ({ slot: p.slot, name: p.name, radbro: p.radbro, touch: p.touch, easy: p.easy, ready: p.ready }));
  }
  private lobby(): void {
    const m: ServerMsg = { t: "lobby", players: this.info(), config: this.config };
    this.each(p => this.send(p, m));
  }

  /** A socket opened on this room: it must say hello first. Returns the handler for its messages and its close. */
  open(sock: Sock): { message: (data: string | ArrayBuffer | Uint8Array) => void; close: () => void } {
    let me: Player | null = null;
    const handle = (data: string | ArrayBuffer | Uint8Array) => {
      this.lastActive = this.env.now();
      const size = typeof data === "string" ? data.length : data.byteLength;
      if (size > RELAY.maxMsgBytes) { sock.close(1009, "too big"); return; }
      if (me) {
        const now = this.env.now();
        if (now - me.msgWindow >= 1000) { me.msgWindow = now; me.msgs = 0; }
        if (++me.msgs > RELAY.maxMsgsPerSec) { sock.close(1008, "rate"); return; }
      }
      if (typeof data === "string") {
        let m: ClientMsg;
        try { m = JSON.parse(data) as ClientMsg; } catch { sock.close(1003, "bad json"); return; }
        if (!me) {
          if (m.t !== "hello") { sock.close(1008, "hello first"); return; }
          me = this.join(sock, m);
          return;
        }
        this.control(me, m);
        return;
      }
      if (!me) { sock.close(1008, "hello first"); return; }
      this.binary(me, data instanceof Uint8Array ? data : new Uint8Array(data));
    };
    return {
      message: data => { if (this.env.lagMs > 0) this.env.setTimeout(() => handle(data), this.env.lagMs / 4); else handle(data); },
      close: () => { if (me) this.leave(me); me = null; },
    };
  }

  private join(sock: Sock, h: Extract<ClientMsg, { t: "hello" }>): Player | null {
    const err = (code: "full" | "version" | "bad", message: string) => {
      try { sock.send(encodeJson({ t: "error", code, message })); } catch { /* closed */ }
      sock.close(1008, code);
      return null;
    };
    if (!h.compat || h.compat.v !== NET_VERSION) return err("version", "this game is a different version: reload to update");
    if (this.compat && (h.compat.build !== this.compat.build || h.compat.link !== this.compat.link || h.compat.tuning !== this.compat.tuning)) {
      return err("version", "the room is on another build of the game: reload to update");
    }
    const slot = this.players.findIndex(p => !p);
    if (slot < 0 || this.state === "play") return err("full", this.state === "play" ? "a match is on in this room" : "the room is full");
    if (this.size === 0) {
      this.compat = h.compat;
      this.config = { ...this.config, district: String(h.district || "downtown") };
    } else if (h.compat.city !== this.compat!.city && h.district === this.config.district) {
      return err("version", "the room's city differs from yours: reload to update");
    }
    const now = this.env.now();
    const p: Player = {
      slot, sock, name: cleanName(String(h.name ?? "")), radbro: String(h.radbro ?? "652").slice(0, 8), touch: !!h.touch, easy: !!h.easy, ready: false,
      compat: h.compat, token: Math.floor(this.env.random() * 2 ** 32).toString(36) + Math.floor(this.env.random() * 2 ** 32).toString(36),
      rtt: 0, msgs: 0, msgWindow: now, upTo: 0, lastAck: 0, ended: null,
    };
    this.players[slot] = p;
    this.send(p, { t: "welcome", slot, token: p.token, host: this.hostSlot() === slot, room: this.code, players: this.info(), config: this.config, lag: this.env.lagMs });
    this.lobby();
    return p;
  }

  private hostSlot(): number {
    return this.players.findIndex(p => !!p);
  }

  private control(p: Player, m: ClientMsg): void {
    switch (m.t) {
      case "pick":
        if (this.state !== "play") { p.radbro = String(m.radbro).slice(0, 8); p.ready = false; this.lobby(); }
        return;
      case "config":
        if (p.slot === this.hostSlot() && this.state !== "play" && m.seconds !== undefined && SECONDS_OK(m.seconds)) { this.config = { ...this.config, seconds: Math.round(m.seconds) }; this.lobby(); }
        return;
      case "ready":
        if (this.state === "play") return;
        p.ready = !!m.ready;
        if (typeof m.rtt === "number" && Number.isFinite(m.rtt)) p.rtt = Math.max(0, Math.min(2000, m.rtt));
        this.lobby();
        if (this.size === RELAY.maxPlayers && this.players.every(q => q?.ready)) this.start();
        return;
      case "end":
        if (this.state !== "play" || !Number.isInteger(m.step)) return;
        p.ended = { step: m.step, hash: m.hash >>> 0 };
        if (this.players.every(q => !q || q.ended)) this.finish();
        return;
      default:
        return;
    }
  }

  private start(): void {
    const ps = this.players.filter((q): q is Player => !!q);
    // The peers' round trip ~ the sum of both players' round trips to the relay (plus the lag knob, already in them).
    const peerRtt = ps.reduce((a, q) => a + q.rtt, 0);
    this.inputDelay = inputDelayFor(peerRtt);
    this.state = "play";
    this.round++;
    this.matches++;
    this.hashes.clear();
    this.startAtMs = this.env.now() + RELAY.startDelayMs + this.env.lagMs;
    this.endStep = 360 + Math.round(this.config.seconds * 120);
    for (const q of ps) { q.upTo = this.inputDelay; q.ended = null; q.ready = false; }
    const m: StartMsg = {
      t: "start", seed: Math.floor(this.env.random() * 2 ** 32) >>> 0, startAtMs: this.startAtMs, round: this.round, config: this.config,
      slots: ps.map(q => ({ slot: q.slot, name: q.name, radbro: q.radbro, touch: q.touch, easy: q.easy })), inputDelay: this.inputDelay,
    };
    this.each(q => this.send(q, m));
  }

  private finish(): void {
    const hashes = this.players.map(q => (q && q.ended ? q.ended.hash : null));
    const got = hashes.filter((h): h is number => h !== null);
    const ok = got.length === this.size && got.every(h => h === got[0]);
    if (!ok) this.desyncs++;
    this.state = "results";
    const m: ServerMsg = { t: "result", round: this.round, ok, hashes };
    this.each(q => this.send(q, m));
    this.lobby();
  }

  private binary(p: Player, buf: Uint8Array): void {
    if (buf.length === 0) return;
    if (buf[0] === MSG_PING) {
      const c = decodePing(buf);
      if (c !== null) this.send(p, encodePong(c, this.env.now()));
      return;
    }
    if (buf[0] !== MSG_INPUT || this.state !== "play") return;
    const m = decodeInput(buf);
    if (!m || m.words.length === 0 || m.words.length > MAX_INPUT_COUNT) return;
    // Contiguous from the step after the last accepted one, never past the horn, never far ahead of the relay clock.
    const relayStep = Math.floor((this.env.now() - this.startAtMs) / STEP_MS);
    const last = m.firstStep + m.words.length - 1;
    if (m.firstStep !== p.upTo + 1 || last > this.endStep || last > relayStep + RELAY.aheadSteps) { p.sock.close(1008, "bad steps"); return; }
    p.upTo = last;
    const out = encodeRelayInput(p.slot, m.firstStep, m.words);
    this.each(q => this.send(q, out), p.slot);
    if (m.hashStep !== undefined && m.hash !== undefined && m.hashStep <= p.upTo) this.hash(p.slot, m.hashStep, m.hash);
    const now = this.env.now();
    if (now - p.lastAck >= 100) {
      p.lastAck = now;
      this.send(p, encodeAck(Math.max(0, relayStep), this.players.map(q => (q ? q.upTo : 0))));
    }
  }

  private hash(slot: number, step: number, h: number): void {
    let row = this.hashes.get(step);
    if (!row) { row = new Array(RELAY.maxPlayers).fill(null); this.hashes.set(step, row); }
    row[slot] = h >>> 0;
    const got = this.players.map((q, i) => (q ? row![i] : -1));
    if (got.some(x => x === null)) return;
    const vals = got.filter((x): x is number => x !== -1);
    if (!vals.every(v => v === vals[0])) {
      this.desyncs++;
      const d = encodeDesync(step);
      this.each(q => this.send(q, d));
    }
    this.hashes.delete(step);
  }

  private leave(p: Player): void {
    if (this.players[p.slot] !== p) return;
    this.players[p.slot] = null;
    if (this.state === "play") {
      this.state = "lobby";
      this.each(q => { q.ready = false; this.send(q, { t: "drop", slot: p.slot }); });
    }
    if (this.size === 0) { this.compat = null; this.state = "lobby"; }
    this.lobby();
  }
}
