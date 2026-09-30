// The SPIDER-TAG wager relay as a Cloudflare Worker (docs/WAGER.md §4): "radrun-wager-relay", separate from the live
// "radrun-relay" (its own wrangler.toml, classes and deploys; it never imports or changes relay/src beyond
// inputDelayFor). The stateless Worker only routes and gates (Origin, REGION_BLOCK, per-IP limits): it never runs the
// sim, so it stays far inside the free plan's 10 ms. Two Durable Object classes do the work:
//   WagerLobby (idFromName("lobby")): logins, offers, pairing, records, the Radbro cache, the relayer queue, the faucet.
//     Its sockets hibernate, so an idle lobby costs no duration.
//   WagerRoom (idFromName(matchId)): one series (sockets, sealed inputs, deadlines, the referee, the log, signing).
// Routes: src/wager/protocol.ts WAGER_ROUTES. Secrets: REFEREE_KEY, RELAYER_KEY, FAUCET_KEY (test networks),
// RPC_URL_PRIVATE (optional). Vars: relay/wager/wrangler.toml.
import type { Hex } from "viem";
import { BUILD_ID } from "../../../src/net/build.ts";
import { WAGER_LIMITS } from "../../../src/wager/protocol.ts";
import { json, normId, realClock, type Sock, type Sql, type SqlValue } from "./base.ts";
import { IpLimiter, bench, gate, jsonRes, lobbyHttp, roomHttp, routeOf, text, type HttpReq, type HttpRes, type Meta } from "./http.ts";
import { bundledLevels } from "./levels.ts";
import { WagerLobbyCore, type LobbyConn, type LobbyConnState, type RoomLink } from "./lobby.ts";
import { RadbroReader } from "./radbro.ts";
import { WagerRoomCore, type LobbyLink } from "./room.ts";
import { makeServices, type Services } from "./services.ts";
import { parseSettings, type Vars } from "./settings.ts";

export interface Env {
  LOBBY: DurableObjectNamespace;
  ROOMS: DurableObjectNamespace;
  [k: string]: unknown;
}

const vars = (env: Env): Vars => Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Vars;

let svc: Services | null = null;
function services(env: Env): Services {
  if (!svc) {
    const v = vars(env);
    svc = makeServices({
      settings: parseSettings(v), levels: bundledLevels, keys: { referee: v.REFEREE_KEY, relayer: v.RELAYER_KEY, faucet: v.FAUCET_KEY }, log: m => console.log(m),
    });
  }
  return svc;
}

const toHttpReq = (req: Request): HttpReq => ({ method: req.method, url: new URL(req.url), header: n => req.headers.get(n), text: () => req.text() });

function toResponse(r: HttpRes): Response {
  const body = r.status === 204 || r.status === 101 ? null : (r.body as BodyInit | null);
  return new Response(body, { status: r.status, headers: r.headers, ...(r.headers["content-encoding"] ? { encodeBody: "manual" as const } : {}) });
}

function doSql(ctx: DurableObjectState): Sql {
  return {
    exec(q: string, ...p: SqlValue[]) {
      return ctx.storage.sql.exec(q, ...p).toArray().map(r => {
        for (const k of Object.keys(r)) if (r[k] instanceof ArrayBuffer) r[k] = new Uint8Array(r[k] as ArrayBuffer);
        return r as Record<string, SqlValue>;
      });
    },
  };
}

const metaOf = (req: Request): Meta => ({
  ip: req.headers.get("x-wager-ip") ?? "",
  country: req.headers.get("x-wager-country") || null,
  relayBase: req.headers.get("x-wager-base") ?? new URL(req.url).origin,
});

const limiter = new IpLimiter();

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const s = services(env).settings;
    const url = new URL(req.url);
    const route = routeOf(req.method, url, s.dev);
    const cf = (req as unknown as { cf?: { country?: string } }).cf;
    const country = (s.dev ? req.headers.get("x-dev-country") : null) ?? cf?.country ?? null;
    const hr = toHttpReq(req);
    const g = gate(route, hr, s, country);
    if (g) return toResponse(g);
    if (route.kind === "none") return toResponse(text(404, "not found"));
    const ip = req.headers.get("cf-connecting-ip") ?? "";
    const upgrade = route.kind === "lobby-ws" || route.kind === "room-ws";
    if (!upgrade && route.kind !== "health" && !limiter.ok(ip, Date.now())) return toResponse(jsonRes(429, { error: "slow down", code: "rate" }));
    // Who is asking, stamped here (client-sent x-wager-* headers are overwritten).
    const headers = new Headers(req.headers);
    headers.set("x-wager-ip", ip);
    headers.set("x-wager-country", country ?? "");
    headers.set("x-wager-base", url.origin);
    const lobby = () => env.LOBBY.get(env.LOBBY.idFromName("lobby"));
    const room = (id: Hex) => env.ROOMS.get(env.ROOMS.idFromName(id));
    if (route.kind === "health" || route.kind === "lobby" || route.kind === "lobby-ws") return lobby().fetch(new Request(req, { headers }));
    if (route.kind === "room-ws" || route.kind === "log") {
      headers.set("x-wager-match", route.matchId);
      return room(route.matchId).fetch(new Request(req, { headers }));
    }
    if (route.kind === "review") {
      const body = await req.text();
      let id: string | null = null;
      try { id = (JSON.parse(body) as { matchId?: string }).matchId ?? null; } catch { /* bad json */ }
      if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) return toResponse(jsonRes(400, { error: "bad review", code: "bad" }));
      headers.set("x-wager-match", normId(id));
      return room(normId(id)).fetch(new Request(req.url, { method: "POST", headers, body }));
    }
    if (route.kind === "bench") {
      headers.set("x-wager-match", "bench");
      return env.ROOMS.get(env.ROOMS.idFromName("bench")).fetch(new Request(req, { headers }));
    }
    return toResponse(text(404, "not found"));
  },
};

// ---- the lobby -------------------------------------------------------------------------------------------------------

function roomLink(env: Env): RoomLink {
  const call = (id: Hex, path: string, body?: unknown) =>
    env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(`https://room${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "x-wager-match": id, "content-type": "application/json" }, body: body === undefined ? undefined : json(body),
    });
  return {
    init: async (id, o) => { await call(id, "/internal/init", o); },
    settled: async (id, o) => { await call(id, "/internal/settled", o); },
    status: async id => {
      const r = await call(id, "/internal/status");
      return r.ok ? ((await r.json()) as Awaited<ReturnType<RoomLink["status"]>>) : null;
    },
    sync: async id => { await call(id, "/internal/sync", {}); },
  };
}

export class WagerLobby {
  private readonly ctx: DurableObjectState;
  private readonly core: WagerLobbyCore;
  private readonly wraps = new WeakMap<CfWebSocket, LobbyConn>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    const sv = services(env);
    const sql = doSql(ctx);
    this.core = new WagerLobbyCore({
      clock: realClock, sql, settings: sv.settings, chain: sv.chain, sims: sv.sims, radbro: new RadbroReader({ src: sv.radbroSrc, now: Date.now, cacheMs: sv.settings.radbro.cacheMs, sql }),
      relayer: sv.relayer, faucet: sv.faucet, rooms: roomLink(env), connections: () => ctx.getWebSockets().map(ws => this.wrap(ws)), log: m => console.log(m),
    });
    // Keepalive pings are answered without waking the hibernating object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  private wrap(ws: CfWebSocket): LobbyConn {
    let c = this.wraps.get(ws);
    if (!c) {
      const conn: LobbyConn = {
        state: ws.deserializeAttachment() as LobbyConnState,
        send: d => ws.send(d),
        close: (code, reason) => { try { ws.close(code ?? 1000, reason ?? ""); } catch { /* closed */ } },
        save: () => ws.serializeAttachment(conn.state),
      };
      c = conn;
      this.wraps.set(ws, c);
    }
    return c;
  }

  private async arm(): Promise<void> {
    if ((this.core.offerCount() > 0 || this.core.live() > 0) && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url), meta = metaOf(req);
    if (url.pathname === "/lobby") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      const state: LobbyConnState = { id: crypto.randomUUID(), ip: meta.ip, relay: meta.relayBase, hello: false, ch: null, player: null, credit: WAGER_LIMITS.msgBurst, creditAt: Date.now() };
      server.serializeAttachment(state);
      this.core.open(this.wrap(server));
      return new Response(null, { status: 101, webSocket: client });
    }
    const res = await lobbyHttp(this.core, toHttpReq(req), meta);
    await this.arm();
    return toResponse(res);
  }

  async webSocketMessage(ws: CfWebSocket, msg: string | ArrayBuffer): Promise<void> {
    await this.core.message(this.wrap(ws), msg);
    await this.arm();
  }

  async webSocketClose(ws: CfWebSocket): Promise<void> {
    this.core.close(this.wrap(ws));
  }

  async webSocketError(ws: CfWebSocket): Promise<void> {
    this.core.close(this.wrap(ws));
  }

  async alarm(): Promise<void> {
    const next = await this.core.sweep();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}

// ---- a series room ---------------------------------------------------------------------------------------------------

function lobbyLink(env: Env): LobbyLink {
  const stub = () => env.LOBBY.get(env.LOBBY.idFromName("lobby"));
  const post = async (path: string, body: unknown) => {
    const r = await stub().fetch(`https://lobby${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: json(body) });
    if (!r.ok) throw new Error(`lobby ${path}: ${r.status}`);
  };
  return {
    card: async a => (await (await stub().fetch(`https://lobby/internal/card?a=${a}`)).json()) as Awaited<ReturnType<LobbyLink["card"]>>,
    update: u => post("/internal/update", u),
    settle: s => post("/internal/settle", s),
  };
}

export class WagerRoom {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private core: WagerRoomCore | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    // A room that already holds a series rebuilds itself (for the alarm after an eviction).
    try {
      const row = doSql(ctx).exec("SELECT json FROM series WHERE id = 1")[0];
      if (row) this.build((JSON.parse(String(row.json)) as { matchId: Hex }).matchId);
    } catch { /* no table yet */ }
  }

  private build(matchId: Hex): WagerRoomCore {
    if (!this.core) {
      const sv = services(this.env);
      this.core = new WagerRoomCore({
        matchId: normId(matchId), clock: realClock, sql: doSql(this.ctx), settings: sv.settings, chain: sv.chain, sims: sv.sims,
        radbro: new RadbroReader({ src: sv.radbroSrc, now: Date.now, cacheMs: sv.settings.radbro.cacheMs }), referee: sv.referee, lobby: lobbyLink(this.env),
        build: BUILD_ID, log: m => console.log(m),
      });
    }
    return this.core;
  }

  private async arm(): Promise<void> {
    const at = this.core?.nextDeadline() ?? null;
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at + 250);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url), meta = metaOf(req);
    const id = req.headers.get("x-wager-match") ?? "";
    if (url.pathname === "/dev/bench") {
      const sims = services(this.env).sims;
      return toResponse(await bench(toHttpReq(req), async d => (await sims.district(d)) ?.assets ?? null));
    }
    if (!/^0x[0-9a-f]{64}$/.test(id)) return toResponse(text(400, "bad match"));
    const core = this.build(id as Hex);
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      server.binaryType = "arraybuffer";
      const sock: Sock = { send: d => server.send(d), close: (c, r) => { try { server.close(c ?? 1000, r ?? ""); } catch { /* closed */ } } };
      const h = core.open(sock, meta.relayBase);
      server.addEventListener("message", e => {
        h.message(e.data);
        if (typeof e.data === "string") void this.arm();
      });
      server.addEventListener("close", () => { h.close(); void this.arm(); });
      server.addEventListener("error", () => { h.close(); void this.arm(); });
      return new Response(null, { status: 101, webSocket: client });
    }
    const res = await roomHttp(core, toHttpReq(req));
    await this.arm();
    return toResponse(res);
  }

  async alarm(): Promise<void> {
    if (!this.core) return;
    await this.core.ensure().catch(() => false);
    this.core.tick();
    await this.arm();
  }
}
