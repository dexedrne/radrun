// One SPIDER-TAG wager series (docs/WAGER.md §4.4, §5, §6), independent of the runtime: the WagerRoom Durable Object
// (worker.ts) and the Node stand-in (node.ts) drive it through small socket / clock / SQL interfaces, like the live
// relay's RoomCore (which this never modifies; it only borrows inputDelayFor).
//
// A room is bound to one vault match: only matchOf(matchId).playerA / playerB get a seat, each proven by a Login
// signature. Before round 1 both must arrive, pick, send their seed share and READY within the join grace (a no-show is
// a void: nobody pays). Each round the relay measures both round trips itself, starts the round on its clock, releases
// inputs sealed (referee.ts), fills missed deadlines and steps the canonical match; the referee's replay is the only
// result. A disconnect after round 1 has started gets a grace, then forfeits the series. At the end the series log is
// stored (GET /log/<id>), flags against the winner hold it for the owner's review, and otherwise the referee signs the
// Result and the lobby's relayer submits settle.
import { hashTypedData, type Address, type Hex } from "viem";
import { MSG_INPUT, MSG_PING, NET_VERSION, decodeInput, decodePing, encodeAck, encodeFill, encodeJson, encodePong, encodeRelayInput } from "../../../src/net/wire.ts";
import { inputDelayFor } from "../../src/room.ts";
import { isRadbroId, RADBROS } from "../../../src/game/radbros.ts";
import {
  OUTCOME_VOID, OUTCOME_WIN, REVIEW_SETTLE, REVIEW_VOID, ZERO_HASH, random32, resultTypedData, reviewTypedData, type Result, type Rules,
} from "../../../src/wager/eip712.ts";
import {
  LOG_FORMAT, deriveSeed, scoreRounds, seedCommit, seriesLogHash, slotOfAFor, type Flag, type RoundLog, type RoundResult, type SeriesLog,
  type SeriesOutcome, type Side,
} from "../../../src/wager/log.ts";
import {
  MSG_PROBE, MSG_PROBE_ECHO, WAGER_LIMITS, WAGER_PROTOCOL, decodeProbe, encodeProbe, type LoginMsg, type PlayerCard, type RadbroPick, type ReviewRequest,
  type RoomClientMsg, type RoomServerMsg, type SeriesPhase, type SeriesState, type Settlement, type WagerErrorCode, type WagerStartMsg,
} from "../../../src/wager/protocol.ts";
import { checkLogin, newChallenge, type Challenge } from "./auth.ts";
import { ZERO, gzip, isHex32, isSig, sameAddr, spend, type Bucket, type Clock, type Logger, type Sock, type Sql } from "./base.ts";
import { MS_LOCKED, MS_SETTLED, MS_VOIDED } from "./abi.ts";
import type { ChainMatch, VaultChain } from "./chain.ts";
import { emptyMetrics, evaluate, mergeFlags, NO_RTT, type SideMetrics } from "./flags.ts";
import type { RadbroReader } from "./radbro.ts";
import { RoundReferee, type Run } from "./referee.ts";
import type { WagerSettings } from "./settings.ts";
import type { DistrictSim, Sims } from "./sims.ts";

/** Signs the series Result with REFEREE_KEY (viem's privateKeyToAccount is one). */
export type RefereeSigner = { address: Address; signTypedData(td: ReturnType<typeof resultTypedData>): Promise<Hex> };

export type SeriesUpdate = {
  matchId: Hex;
  players: [Address, Address];
  stake: string;
  phase: SeriesPhase;
  outcome: SeriesOutcome | null;
  held: boolean;
  /** The players whose flags put the series on hold (their public `held` count). */
  heldSides: Side[];
  lockTx: Hex | null;
};

export type SettleRequest = { matchId: Hex; players: [Address, Address]; stake: string; outcome: SeriesOutcome; settlement: Settlement };

/** What a room needs from the lobby (the WagerLobby DO over internal requests, or a direct call in Node). */
export type LobbyLink = {
  card(a: Address): Promise<PlayerCard>;
  update(u: SeriesUpdate): Promise<void>;
  /** Submit settle(result, sig) through the relayer; the lobby calls settled() back once it is confirmed. */
  settle(req: SettleRequest): Promise<void>;
};

export type RoomInit = { match: ChainMatch; lockTx: Hex | null; cards?: [PlayerCard, PlayerCard] };

export type RoomDeps = {
  matchId: Hex;
  clock: Clock;
  sql: Sql;
  settings: WagerSettings;
  chain: VaultChain;
  sims: Sims;
  radbro: RadbroReader;
  referee: RefereeSigner | null;
  lobby: LobbyLink;
  /** The build this relay bundles (logged with every series). */
  build: string;
  log?: Logger;
  /** Tests only: decide round results another way (to reach draws). */
  judge?: (r: RoundReferee) => RoundResult;
};

type Persist = {
  v: 1;
  matchId: Hex;
  chainId: number;
  vault: Address;
  players: [Address, Address];
  stake: string;
  feeBps: number;
  holderFeeBps: number;
  roundSeconds: number;
  district: string;
  rules: Rules;
  rulesHash: Hex;
  settleBy: number;
  lockedAt: number;
  lockTx: Hex | null;
  relaySecret: Hex;
  seedCommit: Hex;
  shares: [Hex | null, Hex | null];
  picks: [RadbroPick | null, RadbroPick | null];
  cards: [PlayerCard, PlayerCard];
  joinDeadline: number;
  phase: SeriesPhase;
  /** The round being played, or the next one (1-based, draws included). */
  round: number;
  winners: (Side | "draw")[];
  seed1: number | null;
  /** Round 1 has started: from now on leaving forfeits. */
  started: boolean;
  deadlineAt: number | null;
  metrics: [SideMetrics, SideMetrics];
  flags: Flag[];
  outcome: SeriesOutcome | null;
  held: boolean;
  logHash: Hex | null;
  settlement: Settlement | null;
  settleTx: Hex | null;
  /** Why the relay could not referee (never set on a playable series). */
  error: string | null;
};

type Conn = {
  sock: Sock;
  hello: boolean;
  ch: Challenge | null;
  player: Address | null;
  side: Side | null;
  bucket: Bucket;
  busy: boolean;
  queue: string[];
  closed: boolean;
  lastAck: number;
};

/** After the horn of the deciding round, wait this long for both clients' end hashes (the flags need them). */
const END_WAIT_MS = 5_000;
const PROBE_EVERY_MS = 1_000;
const PLAY_TICK_MS = 25;
const MAX_JSON = 4096;
const DEFAULT_PICKS: [string, string] = ["652", "4764"];

const clampName = (s: string) => s.slice(0, 20);

export class WagerRoomCore {
  readonly matchId: Hex;
  private readonly d: RoomDeps;
  private readonly T: WagerSettings["timing"];
  private p: Persist | null = null;
  private rounds: RoundLog[] = [];
  private sim: DistrictSim | null = null;
  private initChain: Promise<unknown> = Promise.resolve();
  private notLockedAt: number | null = null;
  private readonly seats: [Conn | null, Conn | null] = [null, null];
  private readonly conns = new Set<Conn>();
  private readonly rtts: [number[], number[]] = [[], []];
  private readonly probes = new Map<number, { side: Side; at: number }>();
  private probeId = 1;
  private readonly ready: [boolean, boolean] = [false, false];
  private readonly goneAt: [number | null, number | null] = [null, null];
  private live: RoundReferee | null = null;
  private liveRtt: [number, number] = [0, 0];
  private startMsg: WagerStartMsg | null = null;
  /** The last finished round (its referee hash) and the end hashes the clients reported for it. */
  private lastRound: { round: number; hash: number; ends: [number | null, number | null] } | null = null;
  private tickT: unknown = null;
  private playT: unknown = null;
  private probeT: unknown = null;
  private settleRetryAt: number | null = null;
  private concluding = false;
  /** Stats for the measurements (docs/WAGER.md §4.10). */
  readonly stats = { inputs: 0, inputMs: 0, maxInputMs: 0, sealedSteps: 0, simMs: 0 };

  constructor(d: RoomDeps) {
    this.d = d;
    this.matchId = d.matchId;
    this.T = d.settings.timing;
    const sql = d.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS series (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS rounds (round INTEGER PRIMARY KEY, json TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY CHECK (id = 1), gz BLOB NOT NULL, hash TEXT NOT NULL)");
    const row = sql.exec("SELECT json FROM series WHERE id = 1")[0];
    if (row) {
      this.p = JSON.parse(String(row.json)) as Persist;
      this.rounds = sql.exec("SELECT json FROM rounds ORDER BY round").map(r => JSON.parse(String(r.json)) as RoundLog);
    }
  }

  private log(m: string): void {
    this.d.log?.(`[room ${this.matchId.slice(0, 10)}] ${m}`);
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------------

  /** The series phase (null: not initialised). */
  get phase(): SeriesPhase | null {
    return this.p?.phase ?? null;
  }

  /** One initialisation at a time (the lobby's init and players' hellos can race). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.initChain.then(fn, fn);
    this.initChain = p.catch(() => {});
    return p;
  }

  /** Called by the lobby right after the lock confirms (idempotent). */
  init(o: RoomInit): Promise<boolean> {
    return this.serial(async () => {
      if (this.p) {
        if (!this.p.lockTx && o.lockTx) { this.p.lockTx = o.lockTx; this.save(); }
        return this.sim ? !this.p.error : this.resume();
      }
      return this.initFrom(o.match, o.lockTx, o.cards);
    });
  }

  /**
   * Load or initialise from the chain (a player may have submitted the lock themselves). "Not locked" is remembered
   * for a few seconds only: a player can arrive just before the lock confirms.
   */
  ensure(): Promise<boolean> {
    if (this.p && this.sim) return Promise.resolve(!this.p.error);
    return this.serial(async () => {
      if (this.p) return this.sim ? !this.p.error : this.resume();
      const now = this.d.clock.now();
      if (this.notLockedAt !== null && now - this.notLockedAt < 3_000) return false;
      const m = await this.d.chain.matchOf(this.matchId);
      if (m.state !== MS_LOCKED) { this.notLockedAt = now; return false; }
      return this.initFrom(m, null);
    });
  }

  private async resume(): Promise<boolean> {
    const p = this.p!;
    const sim = await this.d.sims.district(p.district);
    if (!sim) { p.error = `district ${p.district} is not refereed here any more`; this.save(); return false; }
    if (this.sim) return !p.error;
    this.sim = sim;
    if (p.phase === "playing") {
      // The round in flight is gone with the old instance: a relay fault never picks a winner (docs/WAGER.md §4.4.8).
      this.log("restarted mid-round: void");
      void this.voidSeries("error");
    } else if (p.phase === "deciding" && p.outcome === null) {
      this.schedule();
    } else if (p.phase === "deciding" && p.outcome && !p.held) {
      void this.sign();
    } else if (p.phase === "signed") {
      this.settleRetryAt = this.d.clock.now();
      this.schedule();
    } else {
      this.schedule();
      this.probeLoop();
    }
    return !p.error;
  }

  private async initFrom(m: ChainMatch, lockTx: Hex | null, cards?: [PlayerCard, PlayerCard]): Promise<boolean> {
    if (m.state !== MS_LOCKED) return false;
    const sim = await this.d.sims.byRules(m.rules);
    if (!sim) {
      this.log("locked with rules this relay does not referee");
      return false;
    }
    this.sim = sim;
    const players: [Address, Address] = [m.playerA, m.playerB];
    cards ??= (await Promise.all(players.map(a => this.d.lobby.card(a)))) as [PlayerCard, PlayerCard];
    const now = this.d.clock.now();
    const secret = random32();
    this.p = {
      v: 1, matchId: this.matchId, chainId: this.d.chain.chainId, vault: this.d.chain.vault, players, stake: m.stake.toString(), feeBps: m.feeBps,
      holderFeeBps: m.holderFeeBps, roundSeconds: m.roundSeconds, district: sim.district, rules: sim.rules, rulesHash: sim.rulesHash, settleBy: m.settleBy,
      lockedAt: m.lockedAt, lockTx, relaySecret: secret, seedCommit: seedCommit(secret), shares: [null, null], picks: [null, null], cards,
      joinDeadline: Math.max(m.lockedAt * 1000 + this.T.joinGraceMs, now + 20_000), phase: "waiting", round: 1, winners: [], seed1: null,
      started: false, deadlineAt: null, metrics: [emptyMetrics(), emptyMetrics()], flags: [], outcome: null, held: false, logHash: null,
      settlement: null, settleTx: null, error: null,
    };
    this.save();
    this.update();
    this.schedule();
    this.probeLoop();
    return true;
  }

  private save(): void {
    if (this.p) this.d.sql.exec("INSERT OR REPLACE INTO series (id, json) VALUES (1, ?)", JSON.stringify(this.p));
  }

  private update(): void {
    const p = this.p;
    if (!p) return;
    const w = p.outcome?.winner ?? null;
    const heldSides: Side[] = p.held && w !== null ? [w] : [];
    this.d.lobby.update({ matchId: this.matchId, players: p.players, stake: p.stake, phase: p.phase, outcome: p.outcome, held: p.held, heldSides, lockTx: p.lockTx })
      .catch(e => this.log(`lobby update failed: ${String(e)}`));
  }

  // ---- sockets ------------------------------------------------------------------------------------------------------

  private send(c: Conn | null, m: RoomServerMsg | Uint8Array): void {
    if (!c || c.closed) return;
    try { c.sock.send(m instanceof Uint8Array ? m : JSON.stringify(m)); } catch { /* closed */ }
  }

  private both(m: RoomServerMsg | Uint8Array): void {
    this.send(this.seats[0], m);
    this.send(this.seats[1], m);
  }

  private error(c: Conn, code: WagerErrorCode, message: string, close = false): void {
    this.send(c, { t: "error", code, message });
    if (close) { c.closed = true; try { c.sock.close(1008, code); } catch { /* closed */ } }
  }

  /** A socket opened on this room (after the Worker's origin and region checks). */
  open(sock: Sock, relayBase: string): { message: (data: string | ArrayBuffer | Uint8Array) => void; close: () => void } {
    const c: Conn = { sock, hello: false, ch: null, player: null, side: null, bucket: { credit: WAGER_LIMITS.msgBurst, at: this.d.clock.now() }, busy: false, queue: [], closed: false, lastAck: 0 };
    this.conns.add(c);
    const handle = (data: string | ArrayBuffer | Uint8Array) => {
      if (c.closed) return;
      const now = this.d.clock.now();
      const size = typeof data === "string" ? data.length : data.byteLength;
      if (size > (typeof data === "string" ? MAX_JSON : WAGER_LIMITS.maxMsgBytes)) { c.closed = true; sock.close(1009, "too big"); this.closed(c); return; }
      if (!spend(c.bucket, now, WAGER_LIMITS.maxMsgsPerSec, WAGER_LIMITS.msgBurst)) { c.closed = true; sock.close(1008, "rate"); this.closed(c); return; }
      if (typeof data !== "string") { this.binary(c, data instanceof Uint8Array ? data : new Uint8Array(data)); return; }
      c.queue.push(data);
      this.drain(c, relayBase);
    };
    return { message: handle, close: () => this.closed(c) };
  }

  /** JSON messages in order: one that waits on the chain holds back the ones after it. */
  private drain(c: Conn, relayBase: string): void {
    while (!c.busy && !c.closed && c.queue.length) this.json(c, c.queue.shift()!, relayBase);
  }

  private json(c: Conn, data: string, relayBase: string): void {
    let m: RoomClientMsg;
    try { m = JSON.parse(data) as RoomClientMsg; } catch { this.error(c, "bad", "bad json", true); return; }
    if (!m || typeof m !== "object") { this.error(c, "bad", "bad message", true); return; }
    const run = (p: Promise<void>) => {
      c.busy = true;
      p.catch(e => { this.log(`error: ${String(e)}`); this.error(c, "busy", "the relay could not check that: try again"); })
        .finally(() => {
          c.busy = false;
          this.drain(c, relayBase);
        });
    };
    if (!c.hello) {
      if (m.t !== "hello") { this.error(c, "bad", "hello first", true); return; }
      run(this.hello(c, m, relayBase));
      return;
    }
    if (m.t === "login") { run(this.login(c, m)); return; }
    if (c.side === null) { this.error(c, "auth", "log in first"); return; }
    switch (m.t) {
      case "pick": run(this.pick(c.side, c, m)); return;
      case "seed": this.seed(c.side, c, m.share); return;
      case "ready": this.onReady(c.side); return;
      case "end": this.onEnd(c.side, m); return;
      default: this.error(c, "bad", "unknown message");
    }
  }

  private async hello(c: Conn, m: Extract<RoomClientMsg, { t: "hello" }>, relayBase: string): Promise<void> {
    if (m.v !== WAGER_PROTOCOL) { this.error(c, "version", "the game changed: reload to update", true); return; }
    if (typeof m.matchId !== "string" || m.matchId.toLowerCase() !== this.matchId) { this.error(c, "bad", "wrong match for this room", true); return; }
    if (!this.d.sims.selfTestOk) { this.error(c, "busy", "the relay's sim failed its self-test, so it does not referee: try later", true); return; }
    const ok = await this.ensure();
    const p = this.p;
    if (!ok || !p || !this.sim) { this.error(c, "gone", p?.error ?? "no such match: it was never locked, or it is over", true); return; }
    const s = this.sim.compat, x = m.compat;
    if (!x || x.v !== NET_VERSION || x.city !== s.city || x.tuning !== s.tuning) {
      this.error(c, "version", "this game is a different version from the match's: reload to update", true);
      return;
    }
    c.hello = true;
    c.ch = newChallenge(this.d.clock.now(), relayBase, this.T.challengeTtlMs);
    this.send(c, { t: "challenge", ...c.ch });
  }

  private async login(c: Conn, m: LoginMsg): Promise<void> {
    const ch = c.ch;
    c.ch = null; // single use, even if the signature is wrong
    const r = await checkLogin(this.d.chain, ch, m, this.d.clock.now());
    if (!r.ok) { this.error(c, "auth", r.why, true); return; }
    const p = this.p!;
    const side = sameAddr(r.player, p.players[0]) ? 0 : sameAddr(r.player, p.players[1]) ? 1 : -1;
    if (side < 0) { this.error(c, "full", "you are not a player in this match", true); return; }
    this.seat(c, side as Side, r.player);
  }

  private seat(c: Conn, side: Side, player: Address): void {
    const p = this.p!;
    const old = this.seats[side];
    if (old && old !== c) { old.side = null; old.closed = true; try { old.sock.close(1000, "replaced"); } catch { /* closed */ } }
    c.player = player;
    c.side = side;
    this.seats[side] = c;
    const back = this.goneAt[side] !== null;
    this.goneAt[side] = null;
    if (back) this.both({ t: "back", side });
    this.broadcast();
    if (p.outcome) {
      this.send(c, { t: "outcome", outcome: p.outcome, logHash: p.logHash ?? ZERO_HASH, held: p.held, flags: p.flags });
      if (p.settlement) this.send(c, { t: "settlement", settlement: p.settlement });
      if (p.settleTx && p.phase === "settled") this.send(c, { t: "settled", tx: p.settleTx });
      if (p.phase === "voided") this.send(c, { t: "voided", tx: p.settleTx });
    } else if (p.phase === "playing" && this.live && this.startMsg) {
      this.send(c, this.startMsg);
      this.catchUp(c, side);
    }
    this.probe(side, 3);
    this.schedule();
    this.maybeStart();
  }

  private closed(c: Conn): void {
    if (!this.conns.delete(c)) return;
    c.closed = true;
    const side = c.side;
    if (side === null || this.seats[side] !== c) return;
    this.seats[side] = null;
    this.ready[side] = false;
    const p = this.p;
    if (p && p.started && (p.phase === "playing" || p.phase === "between")) {
      this.goneAt[side] = this.d.clock.now();
      this.send(this.seats[1 - side], { t: "drop", side, graceMs: this.T.reconnectGraceMs });
    }
    this.broadcast();
    this.schedule();
  }

  // ---- series state -------------------------------------------------------------------------------------------------

  private deadline(): number | null {
    const p = this.p!;
    const gone = this.goneAt.filter((g): g is number => g !== null).map(g => g + this.T.reconnectGraceMs);
    if (p.phase === "waiting") return p.joinDeadline;
    if (gone.length && p.started && (p.phase === "playing" || p.phase === "between")) return Math.min(...gone);
    return p.deadlineAt;
  }

  /** The series as a client sees it (you = its side; null for the public status). */
  state(you: Side | null): SeriesState {
    const p = this.p!;
    const sc = scoreRounds(p.winners);
    return {
      matchId: this.matchId, phase: p.phase, players: p.cards, you, connected: [!!this.seats[0], !!this.seats[1]], ready: [this.ready[0], this.ready[1]],
      picks: p.picks, stake: p.stake, roundSeconds: p.roundSeconds, district: p.district, feeBps: p.feeBps, holderFeeBps: p.holderFeeBps, round: p.round,
      score: sc.score, draws: sc.draws, seedCommit: p.seedCommit, deadlineAt: this.deadline(), settleBy: p.settleBy,
    };
  }

  private broadcast(): void {
    if (!this.p) return;
    for (const side of [0, 1] as const) { const c = this.seats[side]; if (c) this.send(c, { t: "series", state: this.state(side) }); }
  }

  /** Public status for GET /match/<id> (MatchStatus pieces). */
  status(): { series: SeriesState; outcome: SeriesOutcome | null; settlement: Settlement | null; settleTx: Hex | null; lockTx: Hex | null } | null {
    const p = this.p;
    if (!p) return null;
    return { series: this.state(null), outcome: p.outcome, settlement: p.settlement, settleTx: p.settleTx, lockTx: p.lockTx };
  }

  // ---- before a round: picks, seeds, READY, round trips --------------------------------------------------------------

  private async pick(side: Side, c: Conn, m: Extract<RoomClientMsg, { t: "pick" }>): Promise<void> {
    const p = this.p!;
    if (p.phase !== "waiting") { this.error(c, "bad", "picks are made before round 1"); return; }
    if (!isRadbroId(m.radbro)) { this.error(c, "bad", "that Radbro isn't in this game"); return; }
    let own: number | null = null;
    let radbro: string = m.radbro;
    if (m.own !== null && m.own !== undefined) {
      if (!Number.isInteger(m.own) || !(await this.d.radbro.owns(p.players[side], m.own))) {
        this.error(c, "forbidden", `Radbro #${m.own} isn't owned by this wallet on Ethereum`);
        return;
      }
      own = m.own;
      // An owned Radbro that is one of the rigged roster models plays as that model.
      if ((RADBROS as readonly string[]).includes(String(own))) radbro = String(own);
    }
    if (p.phase !== "waiting") return;
    p.picks[side] = { radbro, own };
    this.ready[side] = false;
    this.save();
    this.broadcast();
  }

  private seed(side: Side, c: Conn, share: unknown): void {
    const p = this.p!;
    if (p.phase !== "waiting") { this.error(c, "bad", "seed shares are sent before round 1"); return; }
    if (!isHex32(share)) { this.error(c, "bad", "a seed share is 32 bytes"); return; }
    if (p.shares[side]) { this.error(c, "bad", "your seed share is already in"); return; }
    p.shares[side] = share.toLowerCase() as Hex;
    this.save();
    this.maybeStart();
  }

  private onReady(side: Side): void {
    const p = this.p!;
    if (p.phase !== "waiting" && p.phase !== "between") return;
    if (p.phase === "waiting" && !p.picks[side]) p.picks[side] = { radbro: DEFAULT_PICKS[side], own: null };
    this.ready[side] = true;
    this.probe(side, this.T.probes);
    this.broadcast();
    this.maybeStart();
  }

  /** Relay-measured round trips: a probe now and then while nobody plays, a burst on READY (the minimum counts). */
  private probe(side: Side, n = 1): void {
    const c = this.seats[side];
    if (!c) return;
    for (let i = 0; i < n; i++) {
      const go = () => {
        const s = this.seats[side];
        if (!s) return;
        const id = this.probeId++ >>> 0;
        this.probes.set(id, { side, at: this.d.clock.now() });
        if (this.probes.size > 64) this.probes.delete(this.probes.keys().next().value!);
        this.send(s, encodeProbe(MSG_PROBE, id));
      };
      if (i === 0) go(); else this.d.clock.setTimeout(go, i * 40);
    }
  }

  private probeLoop(): void {
    if (this.probeT !== null) return;
    const loop = () => {
      this.probeT = null;
      const ph = this.p?.phase;
      if (ph !== "waiting" && ph !== "between") return;
      this.probe(0);
      this.probe(1);
      this.probeT = this.d.clock.setTimeout(loop, PROBE_EVERY_MS);
    };
    this.probeT = this.d.clock.setTimeout(loop, PROBE_EVERY_MS);
  }

  private rttOf(side: Side): number {
    const r = this.rtts[side];
    return r.length ? Math.min(...r) : NO_RTT;
  }

  private maybeStart(): void {
    const p = this.p;
    if (!p || this.concluding) return;
    const both = !!this.seats[0] && !!this.seats[1];
    if (p.phase === "waiting") {
      if (both && p.shares[0] && p.shares[1] && this.ready[0] && this.ready[1] && this.rttOf(0) <= this.T.maxRttMs && this.rttOf(1) <= this.T.maxRttMs) this.startRound();
    } else if (p.phase === "between") {
      if (both && ((this.ready[0] && this.ready[1]) || (p.deadlineAt !== null && this.d.clock.now() >= p.deadlineAt))) this.startRound();
    }
  }

  // ---- a round ------------------------------------------------------------------------------------------------------

  private slotOf(side: Side): 0 | 1 {
    const a = this.live?.slotOfA ?? 0;
    return (side === 0 ? a : 1 - a) as 0 | 1;
  }

  private sideOf(slot: number): Side {
    return slot === (this.live?.slotOfA ?? 0) ? 0 : 1;
  }

  private startRound(): void {
    const p = this.p!, sim = this.sim!, T = this.T;
    const r = p.round;
    const shares: [Hex, Hex] = [p.shares[0]!, p.shares[1]!];
    const seed = deriveSeed(p.relaySecret, shares, r);
    if (r === 1) p.seed1 = seed;
    const slotOfA = slotOfAFor(r, seed, p.seed1 ?? seed);
    const rtt: [number, number] = [Math.min(this.rttOf(0), 2 * T.maxOneWayAllowMs), Math.min(this.rttOf(1), 2 * T.maxOneWayAllowMs)];
    const inputDelay = inputDelayFor(rtt[0] + rtt[1]);
    const lateOfSide = (s: Side) => Math.round(T.lateMs + Math.min(rtt[s] / 2, T.maxOneWayAllowMs));
    const sideOfSlot = (slot: number): Side => (slot === slotOfA ? 0 : 1);
    const late: [number, number] = [lateOfSide(sideOfSlot(0)), lateOfSide(sideOfSlot(1))];
    const picks = [p.picks[0] ?? { radbro: DEFAULT_PICKS[0], own: null }, p.picks[1] ?? { radbro: DEFAULT_PICKS[1], own: null }];
    p.picks = [picks[0], picks[1]];
    const bySlot: [string, string] = [picks[sideOfSlot(0)].radbro, picks[sideOfSlot(1)].radbro];
    const startAtMs = this.d.clock.now() + T.startDelayMs;
    this.live = new RoundReferee({
      assets: sim.assets, round: r, seed, slotOfA, roundSeconds: p.roundSeconds, radbros: bySlot, inputDelay, startAtMs, late, aheadSteps: WAGER_LIMITS.aheadSteps,
      oneWay: [rtt[sideOfSlot(0)] / 2, rtt[sideOfSlot(1)] / 2],
    });
    this.liveRtt = rtt;
    const name = (s: Side) => (picks[s].own !== null ? `#${picks[s].own}` : clampName(p.cards[s].name));
    this.startMsg = {
      t: "start", seed, startAtMs, round: r, inputDelay,
      slots: [0, 1].map(slot => ({ slot, name: name(sideOfSlot(slot)), radbro: bySlot[slot], touch: false, easy: false })),
      config: { district: p.district, mode: "tag", seconds: p.roundSeconds, maxPlayers: 2 },
      matchId: this.matchId, slotOfA, score: scoreRounds(p.winners).score, lateMs: late,
    };
    p.phase = "playing";
    p.started = true;
    p.deadlineAt = null;
    this.ready[0] = this.ready[1] = false;
    this.lastRound = null;
    this.save();
    this.both(this.startMsg);
    this.broadcast();
    this.update();
    this.schedule();
    this.playLoop();
    this.log(`round ${r}: seed ${seed}, A in slot ${slotOfA}, delay ${inputDelay}, late ${late.join("/")} ms`);
  }

  private playLoop(): void {
    if (this.playT !== null) return;
    const loop = () => {
      this.playT = null;
      if (this.p?.phase !== "playing" || !this.live) return;
      this.pump();
      if (this.p?.phase === "playing") this.playT = this.d.clock.setTimeout(loop, PLAY_TICK_MS);
    };
    this.playT = this.d.clock.setTimeout(loop, PLAY_TICK_MS);
  }

  private binary(c: Conn, b: Uint8Array): void {
    if (b.length === 0) return;
    const now = this.d.clock.now();
    if (b[0] === MSG_PING) {
      const ms = decodePing(b);
      if (ms !== null) this.send(c, encodePong(ms, now));
      return;
    }
    if (b[0] === MSG_PROBE_ECHO) {
      const e = decodeProbe(b), pr = e && this.probes.get(e.id);
      if (!pr || c.side !== pr.side) return;
      this.probes.delete(e!.id);
      const r = this.rtts[pr.side];
      r.push(now - pr.at);
      if (r.length > this.T.probes) r.shift();
      this.maybeStart();
      return;
    }
    if (b[0] !== MSG_INPUT || c.side === null || this.p?.phase !== "playing" || !this.live) return;
    const m = decodeInput(b);
    if (!m || m.words.length === 0) return;
    const t0 = performance.now();
    const live = this.live, side = c.side, slot = this.slotOf(side);
    live.receive(slot, m.firstStep, m.words, now);
    this.pump();
    if (now - c.lastAck >= 100 && this.live === live) {
      c.lastAck = now;
      this.send(c, encodeAck(Math.max(0, live.relayStep(now)), live.have));
    }
    const dt = performance.now() - t0;
    this.stats.inputs++;
    this.stats.inputMs += dt;
    if (dt > this.stats.maxInputMs) this.stats.maxInputMs = dt;
  }

  /** Fill what is due, release what is sealed, and end the round at the horn. */
  private pump(): void {
    const live = this.live;
    if (!live || this.p?.phase !== "playing") return;
    const now = this.d.clock.now();
    const online: [boolean, boolean] = [!!this.seats[this.sideOf(0)], !!this.seats[this.sideOf(1)]];
    // A late player's own fills go to it at once (its client overwrites its word and rolls back); the opponent gets
    // them with the sealed step.
    for (const run of live.fillDue(now, online)) this.send(this.seats[this.sideOf(run.slot)], encodeFill(run.slot, run.first, run.words.length, run.words[0]));
    const sealed = live.seal(now);
    if (sealed) {
      this.stats.sealedSteps += sealed.to - sealed.from + 1;
      for (let a = sealed.from; a <= sealed.to; a += 128) {
        const b = Math.min(sealed.to, a + 127);
        for (const side of [0, 1] as const) {
          const c = this.seats[side];
          if (c) for (const run of live.runs(1 - this.slotOf(side), a, b)) this.sendRun(c, run);
        }
      }
    }
    if (live.over) this.finishRound();
  }

  private sendRun(c: Conn, run: Run): void {
    this.send(c, run.filled ? encodeFill(run.slot, run.first, run.words.length, run.words[0]) : encodeRelayInput(run.slot, run.first, run.words));
  }

  /** A returning player: every word of its own slot so far and the opponent's sealed words, interleaved by step. */
  private catchUp(c: Conn, side: Side): void {
    const live = this.live!;
    const own = this.slotOf(side), other = 1 - own;
    const end = Math.max(live.top[own], live.sealedTo);
    for (let a = live.inputDelay + 1; a <= end; a += 128) {
      const b = Math.min(end, a + 127);
      for (const run of live.runs(own, a, b)) this.sendRun(c, run);
      if (a <= live.sealedTo) for (const run of live.runs(other, a, Math.min(b, live.sealedTo))) this.sendRun(c, run);
    }
  }

  private finishRound(): void {
    const live = this.live!, p = this.p!;
    const result = this.d.judge ? this.d.judge(live) : live.result();
    this.stats.simMs += live.simMs;
    this.endRound(live, result);
    p.winners.push(result.winner);
    const sc = scoreRounds(p.winners);
    this.lastRound = { round: live.round, hash: result.hash >>> 0, ends: [null, null] };
    this.both({ t: "round", round: live.round, result, score: sc.score, draws: sc.draws });
    p.round = live.round + 1;
    if (sc.done) {
      p.phase = "deciding";
      p.deadlineAt = this.d.clock.now() + END_WAIT_MS;
    } else {
      p.phase = "between";
      p.deadlineAt = this.d.clock.now() + this.T.betweenRoundsMs;
      this.probeLoop();
    }
    this.save();
    this.broadcast();
    this.update();
    this.schedule();
  }

  /** Close the live round into the log (finished, or cut short by a forfeit or a void). */
  private endRound(live: RoundReferee, result: RoundResult | null): void {
    const p = this.p!;
    const rl = live.toLog(result);
    this.rounds.push(rl);
    this.d.sql.exec("INSERT OR REPLACE INTO rounds (round, json) VALUES (?, ?)", rl.round, JSON.stringify(rl));
    for (const side of [0, 1] as const) live.addEvidence(side, p.metrics[side], this.liveRtt[side]);
    p.flags = mergeFlags(p.flags, [...evaluate(0, p.metrics[0], live.round), ...evaluate(1, p.metrics[1], live.round)]);
    this.live = null;
    this.startMsg = null;
    if (this.playT !== null) { this.d.clock.clearTimeout(this.playT); this.playT = null; }
  }

  private onEnd(side: Side, m: Extract<RoomClientMsg, { t: "end" }>): void {
    const lr = this.lastRound, p = this.p!;
    if (!lr || (m.round !== undefined && m.round !== lr.round) || lr.ends[side] !== null) return;
    if (!Number.isInteger(m.step) || typeof m.hash !== "number") return;
    const h = m.hash >>> 0;
    lr.ends[side] = h;
    const met = p.metrics[side];
    if (h !== lr.hash && !met.desync.includes(lr.round)) met.desync.push(lr.round);
    const [a, b] = lr.ends;
    if (a !== null && b !== null && a === b && a !== lr.hash) {
      for (const s of [0, 1] as const) if (!p.metrics[s].mismatch.includes(lr.round)) p.metrics[s].mismatch.push(lr.round);
    }
    p.flags = mergeFlags(p.flags, [...evaluate(0, p.metrics[0], lr.round), ...evaluate(1, p.metrics[1], lr.round)]);
    this.save();
    if (p.phase === "deciding" && !p.outcome && a !== null && b !== null) this.decide();
  }

  // ---- timers -------------------------------------------------------------------------------------------------------

  /**
   * The next moment the series needs attention (the Durable Object keeps an alarm on it). A deadline that has passed
   * but is blocked (the next round waits on a player inside the reconnect grace; one player's grace ran out while the
   * other's is still running) is left to the deadline that unblocks it.
   */
  nextDeadline(): number | null {
    const p = this.p;
    if (!p || p.error) return null;
    const now = this.d.clock.now(), grace = this.T.reconnectGraceMs;
    const c: number[] = [];
    if (p.phase === "waiting") c.push(p.joinDeadline);
    if (p.phase === "deciding" && !p.outcome && p.deadlineAt !== null) c.push(p.deadlineAt);
    if (p.phase === "between" && p.deadlineAt !== null && (p.deadlineAt > now || (this.seats[0] && this.seats[1]))) c.push(p.deadlineAt);
    if (p.started && (p.phase === "playing" || p.phase === "between")) {
      for (const side of [0, 1] as const) {
        const g = this.goneAt[side];
        if (g === null) continue;
        const other = this.goneAt[1 - side];
        if (g + grace > now || other === null || other + grace <= now) c.push(g + grace);
      }
    }
    if (p.phase === "signed" && this.settleRetryAt !== null) c.push(this.settleRetryAt);
    return c.length ? Math.min(...c) : null;
  }

  private schedule(): void {
    if (this.tickT !== null) { this.d.clock.clearTimeout(this.tickT); this.tickT = null; }
    const at = this.nextDeadline();
    if (at === null) return;
    this.tickT = this.d.clock.setTimeout(() => { this.tickT = null; this.tick(); }, Math.max(0, at - this.d.clock.now()));
  }

  /** Handle every deadline that is due (timers, and the Durable Object's alarm after an eviction). */
  tick(): void {
    const p = this.p;
    if (!p || this.concluding) return;
    const now = this.d.clock.now();
    if (p.phase === "playing") this.pump();
    if (p.phase === "waiting" && now >= p.joinDeadline) { void this.voidSeries("noshow"); return; }
    if (p.started && (p.phase === "playing" || p.phase === "between")) {
      const g = this.T.reconnectGraceMs;
      const out = ([0, 1] as const).filter(s => this.goneAt[s] !== null && now - this.goneAt[s]! >= g);
      if (out.length === 2) { void this.voidSeries("error"); return; }
      if (out.length === 1 && this.goneAt[1 - out[0]] === null) { void this.forfeit(out[0]); return; }
    }
    if (p.phase === "between") this.maybeStart();
    if (p.phase === "deciding" && !p.outcome && p.deadlineAt !== null && now >= p.deadlineAt) this.decide();
    if (p.phase === "signed" && this.settleRetryAt !== null && now >= this.settleRetryAt) this.requestSettle();
    this.schedule();
  }

  // ---- the end ------------------------------------------------------------------------------------------------------

  private decide(): void {
    const p = this.p!;
    const sc = scoreRounds(p.winners);
    if (!sc.done) return;
    void this.conclude(sc.void
      ? { kind: "void", winner: null, reason: "draws", score: sc.score }
      : { kind: "win", winner: sc.winner, reason: "played", score: sc.score });
  }

  private async forfeit(by: Side): Promise<void> {
    const p = this.p!;
    const live = this.live;
    const at = live ? { round: live.round, step: live.sealedTo } : { round: p.round, step: 0 };
    if (live) this.endRound(live, null);
    const sc = scoreRounds(p.winners);
    this.log(`side ${by} forfeits (disconnect)`);
    await this.conclude({ kind: "win", winner: (1 - by) as Side, reason: "forfeit", score: sc.score, forfeit: { by, ...at, why: "disconnect" } });
  }

  private async voidSeries(reason: "noshow" | "error"): Promise<void> {
    const p = this.p!;
    // A relay restart loses the round in flight (it is not in the log); both players gone keeps what was sealed.
    if (this.live) this.endRound(this.live, null);
    await this.conclude({ kind: "void", winner: null, reason, score: scoreRounds(p.winners).score });
  }

  /** The public series log (its hash is the Result's logHash). */
  seriesLog(): SeriesLog {
    const p = this.p!, sim = this.sim!;
    const picks = [p.picks[0]?.radbro ?? DEFAULT_PICKS[0], p.picks[1]?.radbro ?? DEFAULT_PICKS[1]] as [string, string];
    const log: SeriesLog = {
      format: LOG_FORMAT, chainId: p.chainId, vault: p.vault, matchId: this.matchId, players: p.players, stake: p.stake, feeBps: p.feeBps,
      holderFeeBps: p.holderFeeBps, roundSeconds: p.roundSeconds, rules: p.rules, rulesHash: p.rulesHash, compat: { ...sim.compat, build: this.d.build },
      radbros: picks, seed: { commit: p.seedCommit, relaySecret: p.relaySecret, shares: [p.shares[0] ?? ZERO_HASH, p.shares[1] ?? ZERO_HASH] },
      rounds: this.rounds, outcome: p.outcome ?? { kind: "void", winner: null, reason: "error", score: [0, 0] }, flags: p.flags, logHash: ZERO_HASH,
    };
    log.logHash = seriesLogHash(log);
    return log;
  }

  private async storeLog(): Promise<Hex> {
    const log = this.seriesLog();
    const gz = await gzip(JSON.stringify(log));
    this.d.sql.exec("INSERT OR REPLACE INTO log (id, gz, hash) VALUES (1, ?, ?)", gz, log.logHash);
    return log.logHash;
  }

  /** The stored log (gzipped JSON), once the series is over. */
  logGz(): Uint8Array | null {
    const row = this.d.sql.exec("SELECT gz FROM log WHERE id = 1")[0];
    return row ? (row.gz as Uint8Array) : null;
  }

  private async conclude(outcome: SeriesOutcome): Promise<void> {
    const p = this.p!;
    if (this.concluding || p.outcome) return;
    this.concluding = true;
    try {
      for (const t of [this.tickT, this.playT, this.probeT]) if (t !== null) this.d.clock.clearTimeout(t);
      this.tickT = this.playT = this.probeT = null;
      this.live = null;
      this.startMsg = null;
      p.outcome = outcome;
      p.deadlineAt = null;
      const w = outcome.kind === "win" ? outcome.winner : null;
      p.held = this.d.settings.holdOnFlags && w !== null && p.flags.some(f => f.side === w || f.kind === "result-mismatch");
      p.phase = p.held ? "held" : "deciding";
      p.logHash = await this.storeLog();
      this.save();
      this.both({ t: "outcome", outcome, logHash: p.logHash, held: p.held, flags: p.flags });
      this.broadcast();
      this.update();
      this.log(`outcome ${outcome.kind} ${outcome.reason} winner ${outcome.winner} score ${outcome.score.join("-")}${p.held ? " HELD" : ""}`);
    } finally {
      this.concluding = false;
    }
    if (!p.held) await this.sign();
  }

  private async sign(): Promise<void> {
    const p = this.p!, o = p.outcome!;
    const ref = this.d.referee;
    if (!ref) { this.log("no referee key: cannot sign (the settle window refunds)"); return; }
    let result: Result = { matchId: this.matchId, outcome: OUTCOME_VOID, winner: ZERO, feeBps: 0, logHash: p.logHash! };
    if (o.kind === "win" && o.winner !== null) {
      const winner = p.players[o.winner];
      // The holder discount for a winner who holds a Radbro right now (a fresh read), within the captured bound.
      const h = await this.d.radbro.holder(winner, 60_000);
      result = { ...result, outcome: OUTCOME_WIN, winner, feeBps: h.holder ? p.holderFeeBps : p.feeBps };
    }
    const sig = await ref.signTypedData(resultTypedData(p.chainId, p.vault, result));
    p.settlement = { result, sig };
    p.phase = "signed";
    this.save();
    this.both({ t: "settlement", settlement: p.settlement });
    this.broadcast();
    this.update();
    this.requestSettle();
  }

  private requestSettle(): void {
    const p = this.p!;
    if (!p.settlement || p.phase !== "signed") return;
    this.settleRetryAt = null;
    const retry = () => {
      if (this.p?.phase !== "signed") return;
      this.settleRetryAt = this.d.clock.now() + 30_000;
      this.schedule();
    };
    this.d.lobby.settle({ matchId: this.matchId, players: p.players, stake: p.stake, outcome: p.outcome!, settlement: p.settlement })
      .then(retry, e => { this.log(`settle request failed: ${String(e)}`); retry(); });
  }

  /** The lobby saw the settle (or void) confirmed on-chain. */
  settled(o: { tx: Hex | null; state: "settled" | "voided" }): void {
    const p = this.p;
    if (!p || p.phase === "settled" || p.phase === "voided") return;
    p.phase = o.state;
    p.settleTx = o.tx;
    this.settleRetryAt = null;
    this.save();
    if (o.state === "settled") this.both({ t: "settled", tx: o.tx ?? ZERO_HASH });
    else this.both({ t: "voided", tx: o.tx });
    this.broadcast();
    this.update();
    this.schedule();
  }

  /**
   * The lobby's periodic check: initialise from the chain if nobody has yet (a lock the lobby lost track of), and
   * notice a match closed without us (a player's own settle, or refundExpired after a stuck series).
   */
  async syncChain(): Promise<void> {
    await this.ensure().catch(() => false);
    const p = this.p;
    if (!p || p.phase === "settled" || p.phase === "voided") return;
    const m = await this.d.chain.matchOf(this.matchId);
    if (m.state === MS_SETTLED || m.state === MS_VOIDED) {
      if (!p.outcome) {
        // Closed without us (refundExpired after a stuck series): record it as a void.
        p.outcome = { kind: "void", winner: null, reason: "error", score: scoreRounds(p.winners).score };
        this.live = null;
      }
      this.settled({ tx: await this.d.chain.settleTxOf(this.matchId), state: m.state === MS_SETTLED ? "settled" : "voided" });
    }
  }

  // ---- review (docs/WAGER.md §4.9) ------------------------------------------------------------------------------

  /** The vault owner's decision on a held series. */
  async review(req: ReviewRequest): Promise<{ ok: true } | { ok: false; status: number; code: WagerErrorCode; message: string }> {
    await this.ensure().catch(() => false);
    const p = this.p;
    if (!p) return { ok: false, status: 404, code: "gone", message: "no such series" };
    if (p.phase !== "held") return { ok: false, status: 409, code: "gone", message: `the series is ${p.phase}, not held` };
    if (req.decision !== REVIEW_SETTLE && req.decision !== REVIEW_VOID) return { ok: false, status: 400, code: "bad", message: "decision 1 (settle) or 2 (void)" };
    if (!isHex32(req.logHash) || req.logHash.toLowerCase() !== p.logHash!.toLowerCase()) return { ok: false, status: 400, code: "bad", message: "that is not this series' log hash" };
    if (!isSig(req.sig)) return { ok: false, status: 400, code: "bad", message: "bad signature" };
    if (this.d.clock.now() / 1000 > p.settleBy) return { ok: false, status: 409, code: "gone", message: "the settle window closed: anyone can refund it" };
    const owner = (await this.d.chain.info(true)).owner;
    const digest = hashTypedData(reviewTypedData(p.chainId, p.vault, { matchId: this.matchId, decision: req.decision, logHash: p.logHash! }));
    if (!(await this.d.chain.verifyHash(owner, digest, req.sig))) return { ok: false, status: 403, code: "forbidden", message: "not signed by the vault owner" };
    if (p.phase !== "held") return { ok: false, status: 409, code: "gone", message: "already reviewed" };
    this.log(`review: ${req.decision === REVIEW_SETTLE ? "settle as replayed" : "void"}`);
    p.held = false;
    p.phase = "deciding";
    if (req.decision === REVIEW_VOID) {
      p.outcome = { kind: "void", winner: null, reason: "review", score: p.outcome!.score };
      await this.storeLog(); // the outcome is not hashed: the log hash stays
    }
    this.save();
    this.both({ t: "outcome", outcome: p.outcome!, logHash: p.logHash!, held: false, flags: p.flags });
    await this.sign();
    return { ok: true };
  }
}
