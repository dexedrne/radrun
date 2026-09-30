// The Node stand-in for both Durable Objects (docs/WAGER.md §4.1): the same lobby and room cores and the same routes
// and gates on Node's http, the `ws` package and node:sqlite (in memory, or files under dbDir). For tests, the local
// end-to-end and development without any Cloudflare tooling. Binds to 127.0.0.1 only.
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import type { Hex } from "viem";
import { WAGER_LIMITS } from "../../../src/wager/protocol.ts";
import { realClock, type Clock, type Logger, type Sql, type SqlValue } from "./base.ts";
import type { TxRpc, VaultChain } from "./chain.ts";
import { fsLevels } from "./fsLevels.ts";
import { IpLimiter, bench, gate, jsonRes, lobbyHttp, roomHttp, routeOf, text, type HttpReq, type HttpRes, type Meta } from "./http.ts";
import { WagerLobbyCore, type LobbyConn } from "./lobby.ts";
import { RadbroReader, type RadbroSource } from "./radbro.ts";
import { WagerRoomCore } from "./room.ts";
import { makeServices, type Keys, type Services } from "./services.ts";
import type { WagerSettings } from "./settings.ts";
import type { LevelFiles } from "./sims.ts";

export function nodeSql(file = ":memory:"): Sql {
  const db = new DatabaseSync(file);
  return { exec: (q: string, ...p: SqlValue[]) => db.prepare(q).all(...p) as Record<string, SqlValue>[] };
}

export type NodeRelayOptions = {
  port: number;
  host?: string;
  settings: WagerSettings;
  keys: Keys;
  chain?: VaultChain & TxRpc;
  radbroSrc?: RadbroSource;
  levels?: LevelFiles;
  clock?: Clock;
  log?: Logger;
  build?: string;
  /** Persist the lobby and rooms here (one SQLite file each); default: in memory. */
  dbDir?: string | null;
  sleep?: (ms: number) => Promise<void>;
};

export type NodeRelay = {
  url: string;
  services: Services;
  lobby: WagerLobbyCore;
  rooms: Map<Hex, WagerRoomCore>;
  close(): Promise<void>;
};

async function readBody(req: http.IncomingMessage, max = 8_000_000): Promise<string> {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > max) break;
  }
  return s;
}

export async function startNodeRelay(o: NodeRelayOptions): Promise<NodeRelay> {
  const host = o.host ?? "127.0.0.1";
  const clock = o.clock ?? realClock;
  const log = o.log ?? (() => {});
  const sv = makeServices({ settings: o.settings, levels: o.levels ?? fsLevels, keys: o.keys, chain: o.chain, radbroSrc: o.radbroSrc, sleep: o.sleep, log });
  const s = sv.settings;
  const sqlFor = (name: string) => nodeSql(o.dbDir ? path.join(o.dbDir, `${name}.sqlite`) : ":memory:");
  const conns = new Set<LobbyConn>();
  const rooms = new Map<Hex, WagerRoomCore>();
  let nextId = 1;

  const lobbySql = sqlFor("lobby");
  const lobby: WagerLobbyCore = new WagerLobbyCore({
    clock, sql: lobbySql, settings: s, chain: sv.chain, sims: sv.sims, referee: sv.referee?.address ?? null,
    radbro: new RadbroReader({ src: sv.radbroSrc, now: () => clock.now(), cacheMs: s.radbro.cacheMs, sql: lobbySql }),
    relayer: sv.relayer, faucet: sv.faucet, connections: () => [...conns], log,
    rooms: {
      init: async (id, x) => { await room(id).init(x); },
      settled: async (id, x) => { room(id).settled(x); },
      status: async id => rooms.get(id)?.status() ?? null,
      sync: async id => { await room(id).syncChain(); },
    },
  });
  const room = (id: Hex): WagerRoomCore => {
    let r = rooms.get(id);
    if (!r) {
      r = new WagerRoomCore({
        matchId: id, clock, sql: sqlFor(`room-${id.slice(2, 18)}`), settings: s, chain: sv.chain, sims: sv.sims,
        radbro: new RadbroReader({ src: sv.radbroSrc, now: () => clock.now(), cacheMs: s.radbro.cacheMs }), referee: sv.referee, build: o.build ?? "dev", log,
        lobby: { card: a => lobby.card(a), update: u => lobby.update(u), settle: x => lobby.settle(x) },
      });
      rooms.set(id, r);
    }
    return r;
  };

  const limiter = new IpLimiter(600, 10_000);
  const roomLimiter = new IpLimiter(300, 10_000);
  const country = (req: http.IncomingMessage) => (s.dev ? String(req.headers["x-dev-country"] ?? "") || null : null);
  const toReq = (req: http.IncomingMessage, url: URL): HttpReq => ({
    method: req.method ?? "GET", url, header: n => { const v = req.headers[n.toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v[0] : v; }, text: () => readBody(req),
  });
  const base = () => `http://${host}:${(server.address() as { port: number }).port}`;
  const meta = (req: http.IncomingMessage): Meta => ({ ip: req.socket.remoteAddress ?? "", country: country(req), relayBase: base() });
  const write = (res: http.ServerResponse, r: HttpRes) => {
    res.writeHead(r.status, r.headers);
    res.end(r.body ?? undefined);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = routeOf(req.method ?? "GET", url, s.dev);
      const hr = toReq(req, url);
      const g = gate(route, hr, s, country(req));
      if (g) return write(res, g);
      if (route.kind !== "health" && !limiter.ok(req.socket.remoteAddress ?? "", clock.now())) return write(res, jsonRes(429, { error: "slow down", message: "slow down", code: "rate" }));
      if (route.kind === "health" || route.kind === "lobby") return write(res, await lobbyHttp(lobby, hr, meta(req)));
      if (route.kind === "log") return write(res, await roomHttp(room(route.matchId), hr));
      if (route.kind === "review") {
        const b = await readBody(req);
        let id: string | null = null;
        try { id = (JSON.parse(b) as { matchId?: string }).matchId ?? null; } catch { /* bad */ }
        if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) return write(res, jsonRes(400, { error: "bad review", message: "bad review", code: "bad" }));
        return write(res, await roomHttp(room(id.toLowerCase() as Hex), { ...hr, url: new URL("/review", url), text: async () => b }));
      }
      if (route.kind === "bench") return write(res, await bench(hr, async d => (await sv.sims.district(d))?.assets ?? null));
      write(res, text(404, "not found"));
    })().catch(e => { try { write(res, jsonRes(500, { error: String(e) })); } catch { /* sent */ } });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const sockets = new Set<WebSocket>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routeOf("GET", url, s.dev);
    const hr = toReq(req, url);
    if ((route.kind !== "lobby-ws" && route.kind !== "room-ws") || gate(route, hr, s, country(req))) { socket.destroy(); return; }
    if (route.kind === "room-ws" && !roomLimiter.ok(req.socket.remoteAddress ?? "", clock.now())) { socket.destroy(); return; }
    const m = meta(req);
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      if (route.kind === "lobby-ws") {
        const c: LobbyConn = {
          state: { id: String(nextId++), ip: m.ip, relay: m.relayBase, hello: false, ch: null, player: null, credit: WAGER_LIMITS.msgBurst, creditAt: clock.now() },
          send: d => ws.send(d), close: (code, r) => ws.close(code ?? 1000, r ?? ""), save: () => {},
        };
        conns.add(c);
        lobby.open(c);
        ws.on("message", (data: Buffer, isBinary: boolean) => { if (!isBinary) void lobby.message(c, data.toString("utf8")); });
        ws.on("close", () => { conns.delete(c); lobby.close(c); });
        return;
      }
      const h = room(route.matchId).open({ send: d => ws.send(d), close: (code, r) => ws.close(code ?? 1000, r ?? "") }, m.relayBase);
      ws.on("message", (data: Buffer, isBinary: boolean) => h.message(isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.toString("utf8")));
      ws.on("close", () => h.close());
    });
  });

  const sweep = setInterval(() => { void lobby.sweep().catch(() => {}); }, 30_000);
  sweep.unref?.();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, host, () => resolve());
  });
  return {
    url: base(), services: sv, lobby, rooms,
    close: () => new Promise<void>(r => {
      clearInterval(sweep);
      for (const c of sockets) { try { c.close(1001, "going away"); } catch { /* closed */ } }
      server.close(() => r());
    }),
  };
}
