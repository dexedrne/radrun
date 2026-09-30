// SPIDER-TAG wager client: one series room (docs/WAGER.md §4.4, §7.4). The room socket is the online Transport
// (/ws?room=<matchId>, the relay clock, PING / PONG) with the wager messages on top: hello with this build's sim, the
// login challenge, the Radbro pick, the seed share, READY, then a best of 3 where every `start` builds a fresh
// OnlineSession in wager mode (FILLs and the relay's sealed words are final) for the existing TagGame to run. The
// relay's latency PROBEs are echoed at once. A dropped socket reconnects within the grace and the round restarts from
// the relay's sealed words. Nothing here decides a result: the referee's `round` and `outcome` do.
import type { Address, Hex } from "viem";
import { OnlineSession } from "../net/session.ts";
import { Transport } from "../net/transport.ts";
import type { ClientMsg, Compat } from "../net/wire.ts";
import type { Tuning } from "../sim/tuning.ts";
import type { CityIndex, CityModel } from "../world/cityModel.ts";
import { random32 } from "./eip712.ts";
import type { Side } from "./log.ts";
import {
  MSG_PROBE, MSG_PROBE_ECHO, WAGER_PROTOCOL, WAGER_TIMING, decodeProbe, encodeProbe, type OutcomeMsg, type RoomClientMsg, type RoomServerMsg, type RoundMsg,
  type SeriesState, type Settlement, type WagerErrorCode, type WagerStartMsg,
} from "./protocol.ts";
import { loginMsg, type LoginSigner } from "./relay.ts";

export type RoomConn = "connecting" | "login" | "in" | "reconnecting" | "closed";

export type SeriesEvents = {
  conn(c: RoomConn, why?: string): void;
  series(s: SeriesState): void;
  /** A round starts (or starts again after a reconnect): the session already collects the relay's words. */
  start(m: WagerStartMsg, session: OnlineSession): void;
  round(m: RoundMsg): void;
  drop(side: Side, graceMs: number): void;
  back(side: Side): void;
  outcome(m: OutcomeMsg): void;
  settlement(s: Settlement): void;
  settled(tx: Hex): void;
  voided(tx: Hex | null): void;
  error(code: WagerErrorCode, message: string): void;
};

/** The socket side of the Transport the series uses (tests pass a fake). */
export type RoomTransport = Pick<Transport, "connect" | "sendJson" | "sendBinary" | "relayNow" | "close"> & {
  onJson: (m: never) => void;
  onBinary: (b: Uint8Array) => void;
  onClose: (why: string) => void;
  readonly minRtt: number;
};

export type SeriesSim = { model: CityModel; index: CityIndex; tuning: Tuning };

/** The seed share is sent once per series; it is kept so a reconnect never sends a different one. */
function shareFor(matchId: Hex): { share: Hex; sent: boolean; mark(): void } {
  const k = `radrun.wager.share.${matchId}`;
  let j: { share: Hex; sent: boolean } | null = null;
  try { j = JSON.parse(localStorage.getItem(k) ?? "null"); } catch { /* none */ }
  if (!j?.share) j = { share: random32(), sent: false };
  const save = () => { try { localStorage.setItem(k, JSON.stringify(j)); } catch { /* private mode */ } };
  save();
  return { share: j.share, sent: j.sent, mark: () => { j!.sent = true; save(); } };
}

export type SeriesOptions = {
  base: string; matchId: Hex; chainId: number; vault: Address; signer: LoginSigner; compat: Compat; sim: SeriesSim; ev: SeriesEvents;
  transport?: () => RoomTransport;
  /**
   * Dev / test builds only (`&badhash`): report a wrong final state hash at every round's end, to exercise the
   * referee's dispute path end to end (both players doing it is a result-mismatch: the series is held).
   */
  tamperEndHash?: boolean;
};

export class SeriesClient {
  readonly matchId: Hex;
  state: SeriesState | null = null;
  session: OnlineSession | null = null;
  start: WagerStartMsg | null = null;
  over = false;
  conn: RoomConn = "connecting";
  private t: RoomTransport | null = null;
  private closed = false;
  private tries = 0;
  private droppedAt = 0;
  private seed: ReturnType<typeof shareFor> | null = null;
  private seedSentHere = false;

  private readonly o: SeriesOptions;

  constructor(o: SeriesOptions) {
    this.o = o;
    this.matchId = o.matchId;
  }

  /** My side (0 = the vault's playerA), once the room has said. */
  get you(): Side | null {
    return this.state?.you ?? null;
  }

  private setConn(c: RoomConn, why?: string) {
    this.conn = c;
    this.o.ev.conn(c, why);
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    const t = this.o.transport ? this.o.transport() : (new Transport() as unknown as RoomTransport);
    this.t = t;
    t.onJson = ((m: RoomServerMsg) => { if (this.t === t) void this.onJson(m); }) as never;
    t.onBinary = b => { if (this.t === t) this.onBinary(b); };
    t.onClose = why => { if (this.t === t) this.lost(why); };
    if (this.o.tamperEndHash) {
      const send = t.sendJson.bind(t);
      t.sendJson = ((m: { t?: string; hash?: number }) => send((m.t === "end" && typeof m.hash === "number" ? { ...m, hash: (m.hash ^ 0x5a5a5a5a) >>> 0 } : m) as never)) as never;
    }
    this.setConn(this.tries ? "reconnecting" : "connecting");
    try {
      await t.connect(this.o.base, this.o.matchId);
    } catch (e) {
      if (this.t === t) this.lost(String((e as Error)?.message ?? e));
      return;
    }
    this.seedSentHere = false;
    this.send({ t: "hello", v: WAGER_PROTOCOL, matchId: this.o.matchId, compat: this.o.compat });
  }

  private lost(why: string) {
    this.t = null;
    if (this.closed || this.over) { this.setConn("closed", why); return; }
    if (/^(full|auth|version|region|gone|forbidden)\b/.test(why)) { this.setConn("closed", why); return; }
    // Reconnect within the grace (the relay fills this player's inputs meanwhile, then forfeits past it).
    if (!this.droppedAt) this.droppedAt = Date.now();
    const left = WAGER_TIMING.reconnectGraceMs - (Date.now() - this.droppedAt);
    if (left <= 0 && this.state && this.state.phase !== "waiting") { this.setConn("closed", "the connection was gone too long"); return; }
    const wait = [300, 1000, 2000, 3000][Math.min(this.tries, 3)];
    this.tries++;
    this.setConn("reconnecting", why);
    setTimeout(() => void this.connect(), wait);
  }

  send(m: RoomClientMsg): void {
    this.t?.sendJson(m as unknown as ClientMsg);
  }

  pick(radbro: string, own: number | null): void {
    this.send({ t: "pick", radbro, own });
  }

  ready(): void {
    this.send({ t: "ready" });
  }

  private onBinary(b: Uint8Array): void {
    if (b[0] === MSG_PROBE) {
      const p = decodeProbe(b);
      if (p) this.t?.sendBinary(encodeProbe(MSG_PROBE_ECHO, p.id));
      return;
    }
    this.session?.onBinary(b);
  }

  private async onJson(m: RoomServerMsg): Promise<void> {
    const ev = this.o.ev;
    switch (m.t) {
      case "challenge":
        this.setConn("login");
        try {
          this.send(await loginMsg(this.o.signer, this.o.chainId, this.o.vault, m));
        } catch (e) {
          ev.error("auth", `couldn't sign in to the match: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
        }
        return;
      case "series":
        this.state = m.state;
        if (this.conn !== "in") { this.tries = 0; this.droppedAt = 0; this.setConn("in"); }
        this.maybeSeed(m.state);
        if (m.state.phase === "settled" || m.state.phase === "voided") this.over = true;
        ev.series(m.state);
        return;
      case "start": {
        this.start = m;
        const you = this.state?.you ?? 0;
        const local = you === 0 ? m.slotOfA : 1 - m.slotOfA;
        // A fresh session for every start, a restart after a reconnect included: it catches up from step 0 on the
        // relay's sealed words (docs/WAGER.md §7.4).
        const s = new OnlineSession({ ...this.o.sim, start: m, local, transport: this.t!, wager: true });
        this.session = s;
        ev.start(m, s);
        return;
      }
      case "round": ev.round(m); return;
      case "drop": ev.drop(m.side, m.graceMs); return;
      case "back": ev.back(m.side); return;
      case "outcome": this.over = true; ev.outcome(m); return;
      case "settlement": ev.settlement(m.settlement); return;
      case "settled": this.over = true; ev.settled(m.tx); return;
      case "voided": this.over = true; ev.voided(m.tx); return;
      case "error": ev.error(m.code, m.message); return;
    }
  }

  /** The seed share: once, before round 1, after the relay's commit is on show. */
  private maybeSeed(s: SeriesState): void {
    if (s.you === null || s.round > 1 || (s.phase !== "waiting" && s.phase !== "between") || !s.seedCommit || this.seedSentHere) return;
    // The same share on every connection before round 1 (a reconnect may have lost the first one); never a new one.
    this.seed ??= shareFor(this.o.matchId);
    this.send({ t: "seed", share: this.seed.share });
    this.seed.mark();
    this.seedSentHere = true;
  }

  /** The relay's clock (ms) for the room's deadlines. */
  relayNow(): number {
    return this.t ? this.t.relayNow() : performance.now();
  }

  close(): void {
    this.closed = true;
    this.t?.close();
    this.t = null;
    this.setConn("closed");
  }
}
