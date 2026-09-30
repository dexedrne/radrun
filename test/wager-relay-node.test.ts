// The wager relay's Node stand-in (relay/wager/src/node.ts) over real HTTP and WebSockets on 127.0.0.1: the public
// routes, the lobby and room sockets with their logins, the gates (Origin, REGION_BLOCK through x-dev-country under
// DEV=1), the faucet, and the stored log served gzipped. The chain is the in-memory fake vault.
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loginTypedData, newMatchId, random32 } from "../src/wager/eip712.ts";
import { WAGER_PROTOCOL, type LobbyServerMsg, type MatchStatus, type PlayerCard, type RelayConfig, type RoomServerMsg } from "../src/wager/protocol.ts";
import { NET_VERSION } from "../src/net/wire.ts";
import { startNodeRelay } from "../relay/wager/src/node.ts";
import { parseSettings } from "../relay/wager/src/settings.ts";
import { FakeClock, FakeVault, SIMS, eventually, newAccount } from "./wager-relay-fakes.ts";

const PORT = 8813;

type Sock = { ws: WebSocket; msgs: (LobbyServerMsg | RoomServerMsg)[]; closed: boolean; err: boolean };
function open(url: string, headers: Record<string, string> = {}): Promise<Sock> {
  return new Promise(resolve => {
    const s: Sock = { ws: new WebSocket(url, { headers } as unknown as string[]), msgs: [], closed: false, err: false };
    s.ws.binaryType = "arraybuffer";
    s.ws.onmessage = e => { if (typeof e.data === "string") s.msgs.push(JSON.parse(e.data)); };
    s.ws.onopen = () => resolve(s);
    s.ws.onerror = () => { s.err = true; resolve(s); };
    s.ws.onclose = () => { s.closed = true; resolve(s); };
  });
}
const lastOf = <T extends string>(s: Sock, t: T) => [...s.msgs].reverse().find(m => m.t === t) as Extract<LobbyServerMsg | RoomServerMsg, { t: T }> | undefined;

test("the Node stand-in: routes, sockets, logins, gates, faucet and the public log", async () => {
  const clock = new FakeClock(Date.now());
  const fv = new FakeVault(() => Math.floor(Date.now() / 1000));
  const refKey = generatePrivateKey();
  fv.referee = privateKeyToAccount(refKey).address;
  const settings = parseSettings({ DEV: "1", WAGER_NET: "local", DISTRICTS: "downtown", ROUND_SECONDS: "20,60", REGION_BLOCK: "US", FAUCET: "1" }, { vault: fv.vault, token: fv.token });
  // On disk, like the local end-to-end (one SQLite file per room).
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "radrun-wager-node-"));
  const r = await startNodeRelay({ port: PORT, settings, dbDir, keys: { referee: refKey, relayer: generatePrivateKey(), faucet: generatePrivateKey() }, chain: fv, clock: { ...clock, now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h as number) } });
  const base = r.url;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(await health.text(), "ok");
    assert.equal(health.headers.get("x-wager-live"), "0");
    const cfg = (await (await fetch(`${base}/config`)).json()) as RelayConfig;
    assert.equal(cfg.chainId, 31337);
    assert.equal(cfg.vault, fv.vault);
    assert.equal(cfg.regionBlocked, false);
    assert.deepEqual(cfg.roundSeconds, [20, 60]);
    assert.equal(((await (await fetch(`${base}/config`, { headers: { "x-dev-country": "US" } })).json()) as RelayConfig).regionBlocked, true);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const unknown = (await (await fetch(`${base}/match/${random32()}`)).json()) as MatchStatus;
    assert.equal(unknown.state, "unknown");
    const a = newAccount();
    const card = (await (await fetch(`${base}/player/${a.address}`)).json()) as PlayerCard;
    assert.equal(card.rating, 1200);

    // The lobby socket: hello, challenge, login by wallet, welcome.
    const l = await open(`${base.replace("http", "ws")}/lobby`);
    l.ws.send(JSON.stringify({ t: "hello", v: WAGER_PROTOCOL, net: "local" }));
    await eventually(() => lastOf(l, "challenge"));
    const ch = lastOf(l, "challenge")!;
    assert.equal(ch.relay, base);
    const sig = await a.signTypedData(loginTypedData(fv.chainId, fv.vault, { player: a.address, challenge: ch.challenge, expiry: BigInt(ch.expiry), relay: ch.relay }));
    l.ws.send(JSON.stringify({ t: "login", player: a.address, expiry: ch.expiry, sig, by: "wallet" }));
    await eventually(() => lastOf(l, "welcome"));
    assert.equal((lastOf(l, "welcome") as Extract<LobbyServerMsg, { t: "welcome" }>).you.address, a.address);
    // Gates on the upgrade.
    const blocked = await open(`${base.replace("http", "ws")}/lobby`, { "x-dev-country": "US" });
    assert.ok(blocked.err || blocked.closed, "region-blocked");
    const foreign = await open(`${base.replace("http", "ws")}/lobby`, { origin: "https://evil.example" });
    assert.ok(foreign.err || foreign.closed, "origin refused");
    assert.equal((await fetch(`${base}/faucet`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403);

    // The faucet.
    const fr = await fetch(`${base}/faucet`, { method: "POST", body: JSON.stringify({ address: a.address }) });
    assert.equal(fr.status, 200);
    assert.ok(((await fr.json()) as { tokenTx: Hex }).tokenTx);

    // A room socket for a locked match: only its players get a seat.
    const b = newAccount();
    fv.deposit(a.address, 10n ** 21n);
    fv.deposit(b.address, 10n ** 21n);
    const sim = (await SIMS.district("downtown"))!;
    const id = newMatchId(a.address);
    fv.forceLock({ matchId: id, a: a.address, b: b.address, stake: 10n ** 20n, rules: sim.rulesHash, roundSeconds: 20 });
    // A lock the lobby never paired gets no room (the vault would take Entries the lobby never vetted).
    const stray = await open(`${base.replace("http", "ws")}/ws?room=${id}`);
    stray.ws.send(JSON.stringify({ t: "hello", v: WAGER_PROTOCOL, matchId: id, compat: { v: NET_VERSION, build: "t", link: 0, city: sim.compat.city, tuning: sim.compat.tuning } }));
    await eventually(() => lastOf(stray, "error") || stray.closed);
    assert.equal((lastOf(stray, "error") as Extract<RoomServerMsg, { t: "error" }> | undefined)?.code, "gone");
    // The lobby's pairing row, as its join would have written it.
    r.lobby["d"].sql.exec("INSERT INTO matches (match_id, state, a, b, stake, lock_tx, settle_tx, ended_at, json) VALUES (?, 'locked', ?, ?, ?, NULL, NULL, NULL, '{}')",
      id, a.address.toLowerCase(), b.address.toLowerCase(), (10n ** 20n).toString());
    await new Promise(res => setTimeout(res, 3_100)); // the room remembers "not locked here" for 3 s
    const room = await open(`${base.replace("http", "ws")}/ws?room=${id}`);
    room.ws.send(JSON.stringify({ t: "hello", v: WAGER_PROTOCOL, matchId: id, compat: { v: NET_VERSION, build: "t", link: 0, city: sim.compat.city, tuning: sim.compat.tuning } }));
    await eventually(() => lastOf(room, "challenge"));
    const rc = lastOf(room, "challenge")!;
    const rsig = await b.signTypedData(loginTypedData(fv.chainId, fv.vault, { player: b.address, challenge: rc.challenge, expiry: BigInt(rc.expiry), relay: rc.relay }));
    room.ws.send(JSON.stringify({ t: "login", player: b.address, expiry: rc.expiry, sig: rsig, by: "wallet" }));
    await eventually(() => lastOf(room, "series"));
    assert.equal((lastOf(room, "series") as Extract<RoomServerMsg, { t: "series" }>).state.you, 1);
    const st = (await (await fetch(`${base}/match/${id}`)).json()) as MatchStatus;
    assert.equal(st.state, "locked");
    assert.equal(st.series?.connected[1], true);
    assert.equal((await fetch(`${base}/log/${id}`)).status, 404, "no log while the series is on");

    // Skip ahead to the join deadline (the room waits at least 20 s): a no-show void, then the public log (fetch
    // undoes the Content-Encoding: gzip the stored log is served with).
    const core = r.rooms.get(id.toLowerCase() as Hex)!;
    (core as unknown as { p: { joinDeadline: number } }).p.joinDeadline = Date.now();
    core.tick();
    await eventually(() => lastOf(room, "voided"), undefined, 10_000);
    const lr = await fetch(`${base}/log/${id}`);
    assert.equal(lr.status, 200);
    assert.equal(lr.headers.get("access-control-allow-origin"), "*");
    assert.match(lr.headers.get("cache-control") ?? "", /max-age=31536000/);
    const log = JSON.parse(Buffer.from(await lr.arrayBuffer()).toString("utf8")) as { matchId: Hex; outcome: { reason: string } };
    assert.equal(log.matchId, id);
    assert.equal(log.outcome.reason, "noshow");
    // A's next match starts with the same address: it gets a room (and a store) of its own, not the last one's.
    const id2 = newMatchId(a.address);
    fv.forceLock({ matchId: id2, a: a.address, b: b.address, stake: 10n ** 20n, rules: sim.rulesHash, roundSeconds: 20 });
    r.lobby["d"].sql.exec("INSERT INTO matches (match_id, state, a, b, stake, lock_tx, settle_tx, ended_at, json) VALUES (?, 'locked', ?, ?, ?, NULL, NULL, NULL, '{}')",
      id2, a.address.toLowerCase(), b.address.toLowerCase(), (10n ** 20n).toString());
    const room2 = await open(`${base.replace("http", "ws")}/ws?room=${id2}`);
    room2.ws.send(JSON.stringify({ t: "hello", v: WAGER_PROTOCOL, matchId: id2, compat: { v: NET_VERSION, build: "t", link: 0, city: sim.compat.city, tuning: sim.compat.tuning } }));
    await eventually(() => lastOf(room2, "challenge"));
    const rc2 = lastOf(room2, "challenge")!;
    room2.ws.send(JSON.stringify({ t: "login", player: b.address, expiry: rc2.expiry, sig: await b.signTypedData(loginTypedData(fv.chainId, fv.vault, { player: b.address, challenge: rc2.challenge, expiry: BigInt(rc2.expiry), relay: rc2.relay })), by: "wallet" }));
    await eventually(() => lastOf(room2, "series"));
    const st2 = (lastOf(room2, "series") as Extract<RoomServerMsg, { t: "series" }>).state;
    assert.deepEqual([st2.matchId, st2.phase], [id2, "waiting"], "a fresh series, not the voided one");
    for (const s of [l, room, room2]) s.ws.close();
  } finally {
    await r.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("POST /review answers with the series' MatchStatus (or the refusal)", async () => {
  const { roomStatus } = await import("../relay/wager/src/http.ts");
  const { roomHarness } = await import("./wager-relay-fakes.ts");
  const h = await roomHarness();
  const st = roomStatus(h.room);
  assert.equal(st.matchId, h.matchId);
  assert.equal(st.state, "locked");
  assert.equal(st.series?.phase, "waiting");
  assert.equal(st.offer, null);
});
