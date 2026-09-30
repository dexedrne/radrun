// The wager lobby (relay/wager/src/lobby.ts, docs/WAGER.md §4.2-§4.8) on an in-memory vault: logins, offers whose
// every lock check is made before any transaction, joins that pair exactly as lock() would, the relayer's lock and the
// room's start, records and ratings on confirmed settles, the relayer queue's nonces, the faucet and the gates.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex, LocalAccount } from "viem";
import {
  entryFromJson, entryTypedData, loginTypedData, random32, resultTypedData, sessionAuthTypedData, type EntryJson,
} from "../src/wager/eip712.ts";
import { WAGER_PROTOCOL, type LobbyClientMsg, type LobbyServerMsg } from "../src/wager/protocol.ts";
import { WagerLobbyCore, elo, type LobbyConn, type RoomLink } from "../relay/wager/src/lobby.ts";
import { Relayer, TxError } from "../relay/wager/src/relayer.ts";
import { MockRadbroSource, RadbroReader } from "../relay/wager/src/radbro.ts";
import { parseSettings, originOk, regionBlocked, type Vars } from "../relay/wager/src/settings.ts";
import { gate, routeOf, type HttpReq } from "../relay/wager/src/http.ts";
import { nodeSql } from "../relay/wager/src/node.ts";
import { vaultCall } from "../relay/wager/src/chain.ts";
import { FakeClock, FakeVault, SIMS, eventually, flush, newAccount } from "./wager-relay-fakes.ts";

const E18 = 10n ** 18n;
const sim = (await SIMS.district("downtown"))!;

type TConn = LobbyConn & { msgs: LobbyServerMsg[]; closed: string | null };

async function lobbyHarness(vars: Vars = {}) {
  const clock = new FakeClock();
  const fv = new FakeVault(() => Math.floor(clock.now() / 1000));
  const referee = newAccount();
  fv.referee = referee.address;
  fv.maxStake = 1000n * E18;
  const settings = parseSettings({
    DEV: "1", WAGER_NET: "local", ROUND_SECONDS: "20,60,90,120", DISTRICTS: "downtown,docks", NEW_ACCOUNT_MAX_STAKE: (200n * E18).toString(),
    NEW_ACCOUNT_SERIES: "2", FAUCET: "1", ...vars,
  }, { vault: fv.vault, token: fv.token });
  const fast = () => new Promise<void>(r => setImmediate(r));
  const relayerAcct = newAccount();
  const relayer = new Relayer({ rpc: fv, signer: relayerAcct, chainId: fv.chainId, sleep: fast, pollMs: 1, timeoutMs: 2_000 });
  const faucet = settings.faucet ? new Relayer({ rpc: fv, signer: newAccount(), chainId: fv.chainId, sleep: fast, pollMs: 1 }) : null;
  const conns = new Set<TConn>();
  const inits: { id: Hex; lockTx: Hex | null; state: number }[] = [];
  const settled: { id: Hex; tx: Hex | null; state: string }[] = [];
  const rooms: RoomLink = {
    init: async (id, x) => { inits.push({ id, lockTx: x.lockTx, state: x.match.state }); },
    settled: async (id, x) => { settled.push({ id, ...x }); },
    status: async () => null,
    sync: async () => {},
  };
  const holders = new Map<string, number[]>();
  const sql = nodeSql();
  const lobby = new WagerLobbyCore({
    clock, sql, settings, chain: fv, sims: SIMS, radbro: new RadbroReader({ src: new MockRadbroSource(holders), now: () => clock.now(), cacheMs: 1, sql }),
    relayer, faucet, rooms, connections: () => [...conns],
  });
  let n = 1;
  const conn = (ip = "10.0.0.1"): TConn => {
    const c: TConn = {
      state: { id: String(n++), ip, relay: "http://relay.test", hello: false, ch: null, player: null, credit: 180, creditAt: clock.now() },
      send: d => c.msgs.push(JSON.parse(d) as LobbyServerMsg),
      close: (_code, r) => { if (c.closed) return; c.closed = r ?? "closed"; conns.delete(c); lobby.close(c); },
      save: () => {}, msgs: [], closed: null,
    };
    conns.add(c);
    lobby.open(c);
    return c;
  };
  const send = (c: TConn, m: LobbyClientMsg | Record<string, unknown>) => lobby.message(c, JSON.stringify(m));
  const last = <T extends LobbyServerMsg["t"]>(c: TConn, t: T) => [...c.msgs].reverse().find(m => m.t === t) as Extract<LobbyServerMsg, { t: T }> | undefined;
  const loginMsg = async (c: TConn, player: Address, signer: LocalAccount, by: "wallet" | "session" = "wallet") => {
    const ch = last(c, "challenge")!;
    const sig = await signer.signTypedData(loginTypedData(fv.chainId, fv.vault, { player, challenge: ch.challenge, expiry: BigInt(ch.expiry), relay: ch.relay }));
    return { t: "login" as const, player, expiry: ch.expiry, sig, by };
  };
  const hello = (c: TConn) => send(c, { t: "hello", v: WAGER_PROTOCOL, net: "local" });
  /** A funded player with a live session key, logged in on a fresh socket. */
  const player = async (o: { deposit?: bigint; ip?: string; keyMax?: bigint; keyCap?: bigint } = {}) => {
    const acct = newAccount(), key = newAccount();
    fv.deposit(acct.address, o.deposit ?? 1000n * E18);
    fv.setSession(acct.address, key.address, o.keyMax ?? 500n * E18, o.keyCap ?? 5000n * E18, Math.floor(clock.now() / 1000) + 3 * 86_400);
    const c = conn(o.ip);
    await hello(c);
    await send(c, await loginMsg(c, acct.address, key, "session"));
    assert.equal(last(c, "welcome")?.you.address, acct.address);
    return { acct, key, c };
  };
  const entry = (o: Partial<EntryJson> & { player: Address }): EntryJson => ({
    matchId: random32(), opponent: "0x0000000000000000000000000000000000000000", stake: (100n * E18).toString(), feeCapBps: 300, roundSeconds: 90,
    rules: sim.rulesHash, deadline: Math.floor(clock.now() / 1000) + 1800, ...o,
  });
  const sign = (by: LocalAccount, e: EntryJson) => by.signTypedData(entryTypedData(fv.chainId, fv.vault, entryFromJson(e)));
  return { clock, fv, settings, lobby, relayer, relayerAcct, referee, conn, send, last, loginMsg, hello, player, entry, sign, inits, settled, holders, sql };
}

const errOf = (c: TConn) => [...c.msgs].reverse().find(m => m.t === "error") as Extract<LobbyServerMsg, { t: "error" }> | undefined;

test("login: by wallet or session key; a replayed, expired or forged login is refused and a new challenge follows", async () => {
  const h = await lobbyHarness();
  const a = newAccount();
  const c = h.conn();
  await h.hello(c);
  assert.ok(h.last(c, "challenge"));
  assert.ok(h.last(c, "offers"), "the open list shows before login");
  const m = await h.loginMsg(c, a.address, a);
  await h.send(c, m);
  const w = h.last(c, "welcome")!;
  assert.equal(w.you.address, a.address);
  assert.equal(w.you.rating, 1200);
  assert.equal(w.config.tokenSymbol, "tSPIDERTAG");
  assert.equal(w.config.newAccountMaxStake, (200n * E18).toString());
  assert.equal(w.config.sims.downtown.city, sim.compat.city);
  assert.equal(w.config.faucet, true);
  // Replayed on another socket.
  const d = h.conn();
  await h.hello(d);
  await h.send(d, m);
  assert.equal(errOf(d)?.code, "auth");
  assert.equal(d.msgs.filter(x => x.t === "challenge").length, 2, "a fresh challenge to try again");
  // Replayed on the same socket (the challenge was single use).
  await h.send(c, m);
  assert.equal(errOf(c)?.code, "auth");
  // Expired.
  const e = h.conn();
  await h.hello(e);
  h.clock.tick(61_000);
  await h.send(e, await h.loginMsg(e, a.address, a));
  assert.match(errOf(e)!.message, /expired/);
  // Forged: someone else's signature for this address.
  const f = h.conn();
  await h.hello(f);
  await h.send(f, await h.loginMsg(f, a.address, newAccount()));
  assert.equal(errOf(f)?.code, "auth");
  // Session key: live works (the harness's player()), a revoked one is refused.
  const p = await h.player();
  h.fv.sessions.delete(p.acct.address.toLowerCase());
  const g = h.conn();
  await h.hello(g);
  await h.send(g, await h.loginMsg(g, p.acct.address, p.key, "session"));
  assert.equal(errOf(g)?.code, "auth");
  // Wrong protocol or network.
  const v = h.conn();
  await h.send(v, { t: "hello", v: WAGER_PROTOCOL + 1, net: "local" });
  assert.equal(errOf(v)?.code, "version");
  const n = h.conn();
  await h.send(n, { t: "hello", v: WAGER_PROTOCOL, net: "rh-mainnet" });
  assert.equal(errOf(n)?.code, "version");
});

test("session: the relayer submits a wallet-signed openSession (gasless); a bad signature costs no gas", async () => {
  const h = await lobbyHarness();
  const a = newAccount(), key = newAccount();
  const c = h.conn();
  await h.hello(c);
  const auth = { player: a.address, sessionKey: key.address, maxStake: 50n * E18, cap: 500n * E18, expiry: BigInt(Math.floor(h.clock.now() / 1000) + 86_400), nonce: 0n };
  const json = { ...auth, maxStake: auth.maxStake.toString(), cap: auth.cap.toString(), expiry: Number(auth.expiry), nonce: 0 };
  await h.send(c, { t: "session", auth: json, sig: await newAccount().signTypedData(sessionAuthTypedData(h.fv.chainId, h.fv.vault, auth)) });
  assert.equal(errOf(c)?.code, "auth");
  assert.equal(h.fv.sent.length, 0);
  await h.send(c, { t: "session", auth: json, sig: await a.signTypedData(sessionAuthTypedData(h.fv.chainId, h.fv.vault, auth)) });
  await eventually(() => c.msgs.some(m => m.t === "tx" && m.status === "confirmed"));
  assert.deepEqual(c.msgs.filter(m => m.t === "tx").map(m => (m as { status: string }).status), ["sent", "confirmed"]);
  assert.equal((await h.fv.sessionOf(a.address)).key, key.address);
});

test("create: every check a lock makes is made before any transaction", async () => {
  const h = await lobbyHarness();
  const p = await h.player();
  const me = p.acct.address;
  const tryCreate = async (e: EntryJson, signer: LocalAccount = p.key, extra: Record<string, unknown> = {}) => {
    const before = p.c.msgs.length;
    await h.send(p.c, { t: "create", entry: e, sig: await h.sign(signer, e), listed: true, ...extra });
    return p.c.msgs.slice(before).find(m => m.t === "error" || m.t === "offer") as LobbyServerMsg;
  };
  const code = (m: LobbyServerMsg) => (m.t === "error" ? m.code : "ok");
  assert.equal(code(await tryCreate(h.entry({ player: me, stake: (1001n * E18).toString() }))), "stake", "above the vault's maxStake");
  assert.equal(code(await tryCreate(h.entry({ player: me, stake: (300n * E18).toString() }))), "stake", "above the new-account cap");
  assert.equal(code(await tryCreate(h.entry({ player: me, roundSeconds: 45 }))), "terms");
  assert.equal(code(await tryCreate(h.entry({ player: me, rules: random32() }))), "terms", "rules for another district or sim");
  assert.equal(code(await tryCreate(h.entry({ player: me, deadline: Math.floor(h.clock.now() / 1000) + 30 }))), "terms");
  assert.equal(code(await tryCreate(h.entry({ player: newAccount().address }))), "terms", "an entry for someone else");
  assert.equal(code(await tryCreate(h.entry({ player: me, opponent: me }))), "terms");
  assert.equal(code(await tryCreate(h.entry({ player: me }), newAccount())), "session", "not signed by the session key or the wallet");
  const small = await h.player({ keyMax: 10n * E18 });
  const e = h.entry({ player: small.acct.address });
  await h.send(small.c, { t: "create", entry: e, sig: await h.sign(small.key, e), listed: true });
  assert.equal(errOf(small.c)?.code, "session", "above the session key's per-match limit");
  const poor = await h.player({ deposit: 10n * E18 });
  const pe = h.entry({ player: poor.acct.address });
  await h.send(poor.c, { t: "create", entry: pe, sig: await h.sign(poor.key, pe), listed: true });
  assert.equal(errOf(poor.c)?.code, "balance");
  // A good one: the open list gets it; the wallet itself may sign too.
  const other = await h.player();
  assert.equal(code(await tryCreate(h.entry({ player: me }))), "ok");
  assert.equal(code(await tryCreate(h.entry({ player: me }), p.acct)), "ok");
  assert.ok(h.last(other.c, "offer"), "listed offers go to everyone");
  const unlisted = h.entry({ player: me });
  await h.send(p.c, { t: "create", entry: unlisted, sig: await h.sign(p.key, unlisted), listed: false });
  assert.notEqual(h.last(other.c, "offer")?.offer.matchId, unlisted.matchId, "an unlisted offer only goes to its creator");
  assert.equal(code(await tryCreate(h.entry({ player: me }))), "rate", "at most 3 open offers each");
  assert.equal(h.fv.sent.length, 0, "no transaction for any of it");
});

test("join: named invites, holders-only and min-series; the pair locks through the relayer and the room starts; busy players can't join again", async () => {
  const h = await lobbyHarness();
  const A = await h.player(), B = await h.player(), C = await h.player();
  const mk = async (by: typeof A, o: Partial<EntryJson> = {}, extra: Record<string, unknown> = {}) => {
    const e = h.entry({ player: by.acct.address, ...o });
    await h.send(by.c, { t: "create", entry: e, sig: await h.sign(by.key, e), listed: true, ...extra });
    assert.equal(errOf(by.c)?.message, undefined);
    return e;
  };
  const join = async (by: typeof A, a: EntryJson, o: Partial<EntryJson> = {}) => {
    const b = h.entry({ player: by.acct.address, matchId: a.matchId, opponent: a.player, stake: a.stake, roundSeconds: a.roundSeconds, rules: a.rules, ...o });
    const before = by.c.msgs.length;
    await h.send(by.c, { t: "join", entry: b, sig: await h.sign(by.key, b) });
    return by.c.msgs.slice(before);
  };
  const invite = await mk(A, { opponent: C.acct.address });
  assert.equal((await join(B, invite)).find(m => m.t === "error")?.code, "forbidden");
  const listed = await mk(A);
  assert.equal((await join(B, listed, { opponent: "0x0000000000000000000000000000000000000000" })).find(m => m.t === "error")?.code, "terms", "the joiner must name the creator");
  assert.equal((await join(B, listed, { stake: (99n * E18).toString() })).find(m => m.t === "error")?.code, "terms");
  const holders = await mk(A, {}, { holdersOnly: true });
  assert.equal((await join(B, holders)).find(m => m.t === "error")?.code, "forbidden");
  // (A third open offer would be refused; the holders-only one is cancelled to make room.)
  await h.send(A.c, { t: "cancel", matchId: holders.matchId });
  assert.equal(h.last(B.c, "unoffer")?.reason, "cancelled");
  const vets = await mk(A, {}, { minSeries: 1 });
  assert.equal((await join(B, vets)).find(m => m.t === "error")?.code, "forbidden");
  await h.send(A.c, { t: "cancel", matchId: vets.matchId });
  // The good join: matched to both, lock sent and confirmed, locked, the room initialised, stakes moved.
  const freeA = h.fv.freeOfSync(A.acct.address);
  await join(B, listed);
  const matched = h.last(A.c, "matched")!;
  assert.equal(matched.matchId, listed.matchId);
  assert.deepEqual([matched.a.entry.player, matched.b.entry.player], [A.acct.address, B.acct.address]);
  await eventually(() => h.last(B.c, "locked"));
  assert.equal(h.last(A.c, "locked")?.matchId, listed.matchId);
  assert.equal(h.last(C.c, "unoffer")?.reason, "matched");
  assert.deepEqual(h.inits.map(i => [i.id, i.state]), [[listed.matchId, 1]]);
  assert.equal(h.fv.freeOfSync(A.acct.address), freeA - 100n * E18);
  assert.equal(h.fv.lockedOfSync(B.acct.address), 100n * E18);
  assert.equal(h.lobby.live(), 1);
  // A is in an unsettled series: C can't pair with A now.
  const more = await mk(A);
  assert.equal((await join(C, more)).find(m => m.t === "error")?.code, "busy");
  assert.deepEqual(h.fv.sent, ["lock"]);
});

test("offers leave with their creator; expired offers are swept", async () => {
  const h = await lobbyHarness();
  const A = await h.player(), B = await h.player();
  const e = h.entry({ player: A.acct.address, deadline: Math.floor(h.clock.now() / 1000) + 120 });
  await h.send(A.c, { t: "create", entry: e, sig: await h.sign(A.key, e), listed: true });
  assert.equal(h.lobby.offerCount(), 1);
  h.clock.tick(110_000);
  await h.lobby.sweep();
  assert.equal(h.last(B.c, "unoffer")?.reason, "expired");
  const f = h.entry({ player: A.acct.address });
  await h.send(A.c, { t: "create", entry: f, sig: await h.sign(A.key, f), listed: true });
  A.c.close();
  assert.equal(h.last(B.c, "unoffer")?.reason, "creator-left");
  assert.equal(h.lobby.offerCount(), 0);
});

test("records: a confirmed settle updates wins, losses, forfeits and Elo; a void counts for both", async () => {
  const h = await lobbyHarness();
  const A = await h.player(), B = await h.player();
  const lockPair = async () => {
    const a = h.entry({ player: A.acct.address });
    await h.send(A.c, { t: "create", entry: a, sig: await h.sign(A.key, a), listed: true });
    const b = h.entry({ player: B.acct.address, matchId: a.matchId, opponent: A.acct.address });
    await h.send(B.c, { t: "join", entry: b, sig: await h.sign(B.key, b) });
    await eventually(() => h.last(B.c, "locked")?.matchId === a.matchId);
    return a.matchId;
  };
  const settle = async (id: Hex, outcome: "win" | "forfeit" | "void") => {
    const result = outcome === "void"
      ? { matchId: id, outcome: 2, winner: "0x0000000000000000000000000000000000000000" as Address, feeBps: 0, logHash: random32() }
      : { matchId: id, outcome: 1, winner: A.acct.address, feeBps: 300, logHash: random32() };
    const sig = await h.referee.signTypedData(resultTypedData(h.fv.chainId, h.fv.vault, result));
    await h.lobby.settle({
      matchId: id, players: [A.acct.address, B.acct.address], stake: (100n * E18).toString(), settlement: { result, sig },
      outcome: outcome === "void" ? { kind: "void", winner: null, reason: "noshow", score: [0, 0] }
        : { kind: "win", winner: 0, reason: outcome === "forfeit" ? "forfeit" : "played", score: [1, 0], ...(outcome === "forfeit" ? { forfeit: { by: 1, round: 2, step: 99, why: "disconnect" as const } } : {}) },
    });
    await eventually(() => h.settled.some(s => s.id === id));
  };
  await settle(await lockPair(), "win");
  let a = await h.lobby.card(A.acct.address), b = await h.lobby.card(B.acct.address);
  assert.deepEqual([a.wins, a.losses, b.wins, b.losses], [1, 0, 0, 1]);
  const [ra, rb] = elo(1200, 1200);
  assert.deepEqual([a.rating, b.rating], [Math.round(ra), Math.round(rb)]);
  assert.equal(a.rating, 1216);
  await settle(await lockPair(), "forfeit");
  b = await h.lobby.card(B.acct.address);
  assert.deepEqual([b.losses, b.forfeits], [2, 1]);
  await settle(await lockPair(), "void");
  a = await h.lobby.card(A.acct.address);
  assert.equal(a.voids, 1);
  const recent = await h.lobby.recent(10);
  assert.equal(recent.length, 3);
  assert.equal(recent[0].outcome.kind, "void");
  assert.equal(h.settled.length, 3);
  // A settle someone else already submitted: the lobby notices from the chain and still records it.
  const id = await lockPair();
  const result = { matchId: id, outcome: 2, winner: "0x0000000000000000000000000000000000000000" as Address, feeBps: 0, logHash: random32() };
  const sig = await h.referee.signTypedData(resultTypedData(h.fv.chainId, h.fv.vault, result));
  assert.equal(await h.fv.exec(B.acct.address, vaultCall(h.fv.vault, "settle", [result, sig])), null);
  await h.lobby.settle({ matchId: id, players: [A.acct.address, B.acct.address], stake: "1", settlement: { result, sig }, outcome: { kind: "void", winner: null, reason: "noshow", score: [0, 0] } });
  await eventually(() => h.settled.some(s => s.id === id));
  assert.equal((await h.lobby.card(B.acct.address)).voids, 2);
  assert.equal(h.lobby.live(), 0);
});

test("the relayer queue serialises nonces, and a failed send resyncs from pending", async () => {
  const h = await lobbyHarness();
  const to = newAccount().address;
  const calls = Array.from({ length: 6 }, () => h.relayer.submit({ to, data: "0x", value: 1n }));
  const sent = await Promise.all(calls);
  assert.equal(new Set(sent.map(s => s.hash)).size, 6);
  assert.equal(await h.fv.nonce(h.relayerAcct.address), 6, "0..5 in order (the fake vault refuses any other nonce)");
  h.fv.failSends = 1;
  await assert.rejects(h.relayer.submit({ to, data: "0x", value: 1n }), TxError);
  assert.equal(h.relayer.resyncs, 1);
  // Someone else used the relayer's next nonce meanwhile: the resync picks up the chain's pending count.
  h.fv.acctNonce.set(h.relayerAcct.address.toLowerCase(), 9);
  const ok = await h.relayer.submit({ to, data: "0x", value: 1n });
  assert.equal((await ok.done).status, "success");
  assert.equal(await h.fv.nonce(h.relayerAcct.address), 10);
  // A transaction that would revert is refused before it is signed: no nonce used.
  await assert.rejects(h.relayer.submit(vaultCall(h.fv.vault, "refundExpired", [random32()])), /NotLocked/);
  assert.equal(await h.fv.nonce(h.relayerAcct.address), 10);
});

test("faucet: test networks only; once per address a day, three per IP a day; region-blocked callers are refused", async () => {
  const h = await lobbyHarness({ REGION_BLOCK: "US, kp" });
  const claim = (a: Address, ip = "7.7.7.7", country: string | null = "DE") => h.lobby.faucetClaim({ address: a }, ip, country);
  const a = newAccount().address;
  const r = await claim(a);
  assert.equal(r.status, 200);
  assert.equal((r.body as { tokens: string }).tokens, (1000n * E18).toString());
  assert.ok((r.body as { ethTx: Hex | null }).ethTx, "gas for a wallet with none");
  await flush();
  assert.equal(h.fv.tokenOut[0]?.to, a);
  assert.equal((await claim(a)).status, 429, "once per address per day");
  assert.equal((await claim(newAccount().address)).status, 200);
  assert.equal((await claim(newAccount().address)).status, 200);
  assert.equal((await claim(newAccount().address)).status, 429, "three per IP per day");
  assert.equal((await claim(newAccount().address, "8.8.8.8", "US")).status, 403);
  assert.equal((await claim(newAccount().address, "8.8.8.8", "KP")).status, 403);
  h.clock.tick(86_400_001);
  assert.equal((await claim(a)).status, 200, "a day later");
  // Never on a mainnet chain id, whatever FAUCET says.
  const main = parseSettings({ WAGER_NET: "rh-mainnet", FAUCET: "1" });
  assert.equal(main.faucet, false);
  assert.equal(parseSettings({ WAGER_NET: "rh-testnet", FAUCET: "1" }).faucet, true);
  const off = await lobbyHarness({ FAUCET: "0" });
  assert.equal((await off.lobby.faucetClaim({ address: a }, "1.1.1.1", null)).status, 404);
});

test("gates: origins for sockets and posts, the region block (off by default), public reads open to all", () => {
  const s = parseSettings({ ALLOWED_ORIGINS: "https://radrun.vyvanse.beer", DEV: "0", REGION_BLOCK: "" });
  const req = (method: string, path: string, headers: Record<string, string> = {}): [ReturnType<typeof routeOf>, HttpReq] => {
    const url = new URL(`https://relay.example${path}`);
    return [routeOf(method, url, false), { method, url, header: n => headers[n.toLowerCase()] ?? null, text: async () => "" }];
  };
  const up = { upgrade: "websocket", origin: "https://radrun.vyvanse.beer" };
  let [r, q] = req("GET", "/lobby", up);
  assert.equal(gate(r, q, s, "US"), null, "no region block by default");
  [r, q] = req("GET", "/lobby", { ...up, origin: "https://evil.example" });
  assert.equal(gate(r, q, s, null)?.status, 403);
  [r, q] = req("GET", `/ws?room=${random32()}`, up);
  assert.equal(r.kind, "room-ws");
  assert.equal(gate(r, q, s, null), null);
  [r, q] = req("GET", "/ws?room=K7QXM", up);
  assert.equal(r.kind, "none", "a live-relay room code is not a wager room");
  [r, q] = req("GET", "/config", { origin: "https://evil.example" });
  assert.equal(gate(r, q, s, null), null, "public reads are open");
  [r, q] = req("POST", "/faucet", { origin: "https://evil.example" });
  assert.equal(gate(r, q, s, null)?.status, 403);
  const blocked = parseSettings({ ALLOWED_ORIGINS: "https://radrun.vyvanse.beer", REGION_BLOCK: "us,ir" });
  [r, q] = req("GET", "/lobby", up);
  assert.equal(gate(r, q, blocked, "US")?.status, 403);
  assert.equal(gate(r, q, blocked, "DE"), null);
  assert.equal(regionBlocked("ir", blocked), true);
  assert.equal(originOk(null, { dev: false, allowedOrigins: [] }), false);
  assert.equal(originOk("http://localhost:5403", { dev: true, allowedOrigins: [] }), true);
  assert.equal(originOk("http://localhost:5403", { dev: false, allowedOrigins: [] }), false);
  [r] = req("POST", "/dev/bench");
  assert.equal(r.kind, "none", "the bench is DEV only");
});
