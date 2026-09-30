// The wager relay's HTTP surface (src/wager/protocol.ts WAGER_ROUTES), shared by the Worker (worker.ts: the Worker
// routes and gates, the Durable Objects answer) and the Node stand-in (node.ts: one process does both). Requests and
// responses are reduced to small plain shapes so both runtimes adapt them in a few lines.
//
// Gates (docs/WAGER.md §4.1, §4.7): both socket upgrades, POST /faucet and POST /review need an allowed Origin (a
// browser check only: logins are signatures). REGION_BLOCK applies to both upgrades, /faucet and /config's
// regionBlocked. The public reads (/config, /match, /log, /player, /recent) are CORS * and never gated: withdrawing and
// verifying never need this relay anyway.
import type { Hex } from "viem";
import { WAGER_ROUTES, type ReviewRequest } from "../../../src/wager/protocol.ts";
import { verifySeries, roundMatch, type SimAssets } from "../../../src/wager/replay.ts";
import type { SeriesLog } from "../../../src/wager/log.ts";
import { mulberry32 } from "../../../src/sim/math.ts";
import { addr, errMsg, isHex32, json, normId } from "./base.ts";
import type { ChainMatch } from "./chain.ts";
import { LobbyError, type WagerLobbyCore } from "./lobby.ts";
import type { RoomInit, SeriesUpdate, SettleRequest, WagerRoomCore } from "./room.ts";
import { originOk, regionBlocked, type WagerSettings } from "./settings.ts";

export type HttpReq = { method: string; url: URL; header(name: string): string | null; text(): Promise<string> };
export type HttpRes = { status: number; headers: Record<string, string>; body: string | Uint8Array | null };
/** Who is asking (set by the Worker from the connection, never from client headers). */
export type Meta = { ip: string; country: string | null; relayBase: string };

export type Route =
  | { kind: "health" }
  | { kind: "options" }
  | { kind: "lobby-ws" }
  | { kind: "room-ws"; matchId: Hex }
  | { kind: "lobby"; path: string }
  | { kind: "log"; matchId: Hex }
  | { kind: "review" }
  | { kind: "bench" }
  | { kind: "none" };

const matchIdIn = (s: string | null | undefined): Hex | null => (s && isHex32(s) ? normId(s) : null);

export function routeOf(method: string, url: URL, dev: boolean): Route {
  const p = url.pathname;
  if (p === WAGER_ROUTES.health) return { kind: "health" };
  if (method === "OPTIONS") return { kind: "options" };
  if (p === WAGER_ROUTES.lobby) return { kind: "lobby-ws" };
  if (p === WAGER_ROUTES.room) {
    const id = matchIdIn(url.searchParams.get("room"));
    return id ? { kind: "room-ws", matchId: id } : { kind: "none" };
  }
  if (p.startsWith(WAGER_ROUTES.log)) {
    const id = matchIdIn(p.slice(WAGER_ROUTES.log.length));
    return id && method === "GET" ? { kind: "log", matchId: id } : { kind: "none" };
  }
  if (p === WAGER_ROUTES.review && method === "POST") return { kind: "review" };
  if (p === "/dev/bench" && dev && method === "POST") return { kind: "bench" };
  if (p === WAGER_ROUTES.config || p === WAGER_ROUTES.recent || p.startsWith(WAGER_ROUTES.player) || p.startsWith(WAGER_ROUTES.match)) {
    return method === "GET" ? { kind: "lobby", path: p } : { kind: "none" };
  }
  if (p === WAGER_ROUTES.faucet && method === "POST") return { kind: "lobby", path: p };
  return { kind: "none" };
}

export const CORS_PUBLIC = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };

export const text = (status: number, body: string, headers: Record<string, string> = {}): HttpRes =>
  ({ status, headers: { "content-type": "text/plain; charset=utf-8", ...CORS_PUBLIC, ...headers }, body });
export const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}): HttpRes =>
  ({ status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_PUBLIC, ...headers }, body: json(body) });

/** The Worker-level checks. null = go on. */
export function gate(r: Route, req: HttpReq, s: WagerSettings, country: string | null): HttpRes | null {
  if (r.kind === "options") return { status: 204, headers: { ...CORS_PUBLIC, "Access-Control-Max-Age": "86400" }, body: null };
  const needsOrigin = r.kind === "lobby-ws" || r.kind === "room-ws" || r.kind === "review" || (r.kind === "lobby" && r.path === WAGER_ROUTES.faucet);
  if (needsOrigin && !originOk(req.header("origin"), s)) return text(403, "origin not allowed");
  const regional = r.kind === "lobby-ws" || r.kind === "room-ws" || (r.kind === "lobby" && r.path === WAGER_ROUTES.faucet);
  if (regional && regionBlocked(country, s)) return jsonRes(403, { error: "not available in your region", code: "region" });
  if ((r.kind === "lobby-ws" || r.kind === "room-ws") && (req.header("upgrade") ?? "").toLowerCase() !== "websocket") return text(426, "expected a websocket");
  return null;
}

/** Best-effort per-IP request limit for the plain HTTP routes (per Worker isolate / Node process). */
export class IpLimiter {
  private readonly hits = new Map<string, { n: number; at: number }>();
  private readonly perWindow: number;
  private readonly windowMs: number;
  constructor(perWindow = 60, windowMs = 10_000) {
    this.perWindow = perWindow;
    this.windowMs = windowMs;
  }
  ok(ip: string, now: number): boolean {
    if (!ip) return true;
    const h = this.hits.get(ip);
    if (!h || now - h.at > this.windowMs) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(ip, { n: 1, at: now });
      return true;
    }
    return ++h.n <= this.perWindow;
  }
}

async function body<T>(req: HttpReq, max = 64_000): Promise<T | null> {
  try {
    const t = await req.text();
    return t.length > max ? null : (JSON.parse(t) as T);
  } catch {
    return null;
  }
}

const reviveMatch = (m: ChainMatch & { stake: bigint | string }): ChainMatch => ({ ...m, stake: BigInt(m.stake) });

// ---- the lobby's routes ---------------------------------------------------------------------------------------------------

export async function lobbyHttp(core: WagerLobbyCore, req: HttpReq, meta: Meta): Promise<HttpRes> {
  const p = req.url.pathname;
  try {
    if (p === WAGER_ROUTES.health) return text(200, "ok", { "x-wager-live": String(core.live()) });
    if (p === WAGER_ROUTES.config) return jsonRes(200, await core.config(meta.country));
    if (p.startsWith(WAGER_ROUTES.player)) {
      const a = addr(p.slice(WAGER_ROUTES.player.length));
      return a ? jsonRes(200, await core.card(a)) : jsonRes(400, { error: "bad address", code: "bad" });
    }
    if (p === WAGER_ROUTES.recent) return jsonRes(200, await core.recent(Number(req.url.searchParams.get("limit") ?? 20)));
    if (p.startsWith(WAGER_ROUTES.match)) {
      const id = matchIdIn(p.slice(WAGER_ROUTES.match.length));
      return id ? jsonRes(200, await core.matchStatus(id)) : jsonRes(400, { error: "bad match id", code: "bad" });
    }
    if (p === WAGER_ROUTES.faucet) {
      const r = await core.faucetClaim(await body(req), meta.ip, meta.country);
      return jsonRes(r.status, r.body);
    }
    // Internal (room -> lobby; the Worker never forwards these paths from outside).
    if (p === "/internal/card") {
      const a = addr(req.url.searchParams.get("a"));
      return a ? jsonRes(200, await core.card(a)) : jsonRes(400, { error: "bad address" });
    }
    if (p === "/internal/update") {
      const u = await body<SeriesUpdate>(req);
      if (!u) return jsonRes(400, { error: "bad update" });
      await core.update(u);
      return jsonRes(200, { ok: true });
    }
    if (p === "/internal/settle") {
      const s = await body<SettleRequest>(req);
      if (!s) return jsonRes(400, { error: "bad settle" });
      await core.settle(s);
      return jsonRes(200, { ok: true });
    }
    return text(404, "not found");
  } catch (e) {
    if (e instanceof LobbyError) return jsonRes(e.code === "gone" ? 503 : 400, { error: e.message, code: e.code });
    return jsonRes(502, { error: errMsg(e), code: "chain" });
  }
}

// ---- a room's routes ------------------------------------------------------------------------------------------------------

export async function roomHttp(core: WagerRoomCore, req: HttpReq): Promise<HttpRes> {
  const p = req.url.pathname;
  try {
    if (p.startsWith(WAGER_ROUTES.log)) {
      const gz = core.logGz();
      if (!gz) return jsonRes(404, { error: "no log yet: the series is not over", code: "gone" });
      return {
        status: 200,
        headers: { ...CORS_PUBLIC, "content-type": "application/json", "content-encoding": "gzip", "cache-control": "public, max-age=31536000, immutable" },
        body: gz,
      };
    }
    if (p === WAGER_ROUTES.review) {
      const r = await body<ReviewRequest>(req);
      if (!r) return jsonRes(400, { error: "bad review", code: "bad" });
      const out = await core.review(r);
      return out.ok ? jsonRes(200, { ok: true, status: core.status() }) : jsonRes(out.status, { error: out.message, code: out.code });
    }
    if (p === "/internal/init") {
      const b = await body<RoomInit & { match: ChainMatch & { stake: string } }>(req);
      if (!b?.match) return jsonRes(400, { error: "bad init" });
      return jsonRes(200, { ok: await core.init({ ...b, match: reviveMatch(b.match) }) });
    }
    if (p === "/internal/settled") {
      const b = await body<{ tx: Hex | null; state: "settled" | "voided" }>(req);
      if (!b) return jsonRes(400, { error: "bad settled" });
      core.settled(b);
      return jsonRes(200, { ok: true });
    }
    if (p === "/internal/status") return jsonRes(200, core.status());
    if (p === "/internal/sync") {
      await core.syncChain();
      return jsonRes(200, { ok: true });
    }
    return text(404, "not found");
  } catch (e) {
    return jsonRes(502, { error: errMsg(e), code: "chain" });
  }
}

// ---- DEV: CPU measurements in workerd (docs/WAGER.md §4.10) -------------------------------------------------------------

export type BenchReq = { mode: "step" | "verify"; steps?: number; chunk?: number; seconds?: number; seed?: number; log?: SeriesLog };

/**
 * DEV only (POST /dev/bench): run the referee's work so the caller can time it from outside (workerd freezes the
 * clocks inside a request, so the wall time the caller sees is the measurement). "step": the incremental referee, in
 * chunks of `chunk` steps like INPUT messages; "verify": a cold whole-series re-verify of a posted log.
 */
export async function bench(req: HttpReq, assets: (district: string) => Promise<SimAssets | null>): Promise<HttpRes> {
  const b = await body<BenchReq>(req, 8_000_000);
  if (!b) return jsonRes(400, { error: "bad bench" });
  const t0 = performance.now();
  if (b.mode === "verify" && b.log) {
    const a = await assets(b.log.rules.district);
    if (!a) return jsonRes(400, { error: "unknown district" });
    const v = verifySeries(b.log, a);
    return jsonRes(200, { ok: v.ok, problems: v.problems, rounds: v.rounds.map(r => r.steps), ms: performance.now() - t0 });
  }
  const a = await assets("downtown");
  if (!a) return jsonRes(400, { error: "no downtown" });
  const m = roundMatch(a, b.seed ?? 7, b.seconds ?? 90, ["652", "4764"]);
  const r = mulberry32(b.seed ?? 7), steps = Math.min(b.steps ?? m.endStep, m.endStep), chunk = Math.max(1, b.chunk ?? 4);
  const pair = [0, 0];
  let s = 0, msgs = 0;
  while (s < steps) {
    for (let k = 0; k < chunk && s < steps; k++, s++) {
      pair[0] = Math.floor(r() * 2 ** 32);
      pair[1] = Math.floor(r() * 2 ** 32);
      m.stepWords(pair);
    }
    msgs++;
  }
  return jsonRes(200, { steps: s, msgs, hash: m.hash() >>> 0, ms: performance.now() - t0 });
}

