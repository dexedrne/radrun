// The RadRun relay as a Cloudflare Worker + one Durable Object per room (multiplayer design §5). Routes:
//   POST /room          -> {"code": "K7QXM"}   a fresh 5-character room code (claimed in its room object)
//   GET  /ws?room=CODE  -> WebSocket upgrade, forwarded to that room's object (relay/src/room.ts does the rest)
//   GET  /health        -> "ok"
// Matches live in memory. Room claims and admission budgets persist; RECEIPT_PRIVATE_KEY optionally signs results.
// Origins are checked against ALLOWED_ORIGINS
// (comma-separated; localhost is always allowed when DEV = "1"). DEV_LAG_MS (dev only) injects a round trip.
import { receiptSigner } from "./receipt.ts";
import { admit } from "./admission.ts";
import { loadReferee } from "./referee.ts";
import { RoomCore, type Sock } from "./room.ts";
import { isRoomCode, roomCode } from "../../src/net/wire.ts";
import { consumeBudget, moderatePlayerName } from './moderation.ts';
import { networkBucket } from './network.ts';
import type { ModerationState } from './playerModeration.ts';

export interface Env {
  ROOMS: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  DEV?: string;
  DEV_LAG_MS?: string;
  TYPESAFE_API_KEY?: string;
  RECEIPT_PRIVATE_KEY?: string;
}

const originOk = (req: Request, env: Env): boolean => {
  const o = req.headers.get("Origin");
  if (!o) return env.DEV === "1";
  if (env.DEV === "1" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;
  return (env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean).includes(o);
};

const cors = (req: Request): Record<string, string> => ({
  "Access-Control-Allow-Origin": req.headers.get("Origin") ?? "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  Vary: "Origin",
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (!originOk(req, env)) return new Response("origin not allowed", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    if ((url.pathname === "/room" && req.method === "POST") || url.pathname === "/ws") {
      const network = await networkBucket(req, env.DEV === "1", env.TYPESAFE_API_KEY ?? "");
      if (!network) return new Response("network identity unavailable", { status: 403, headers: cors(req) });
      const action = url.pathname === "/room" ? "create" : "join";
      const gate = await env.ROOMS.get(env.ROOMS.idFromName("admission:" + network)).fetch(`https://room/admission?action=${action}`, { method: "POST" });
      if (!gate.ok) { console.warn(JSON.stringify({ event: "relay-detection", rule: "admission-" + action })); return new Response("too many requests; try again shortly", { status: 429, headers: { ...cors(req), "Retry-After": "30" } }); }
    }
    if (url.pathname === "/room" && req.method === "POST") {
      const lag = env.DEV === "1" ? Math.max(0, Math.min(1000, Number(url.searchParams.get("lag") ?? env.DEV_LAG_MS ?? 0) || 0)) : 0;
      for (let i = 0; i < 6; i++) {
        const code = roomCode(Math.random);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const r = await stub.fetch(`https://room/claim?code=${code}&lag=${lag}`, { method: "POST" });
        if (r.ok) return Response.json({ code }, { headers: cors(req) });
      }
      return new Response("busy", { status: 503, headers: cors(req) });
    }
    if (url.pathname === "/ws") {
      const code = url.searchParams.get("room") ?? "";
      if (!isRoomCode(code)) return new Response("bad room", { status: 400 });
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};

/** One room. Plain (non-hibernating) sockets: a room only lives while players are in it. */
export class Room {
  private core: RoomCore | null = null;
  private claimedAt = 0;
  private lag = 0;
  private readonly state: DurableObjectState;
  private readonly binding: Env;
  private moderation: ModerationState = {};
  private signer: Awaited<ReturnType<typeof receiptSigner>> | undefined;
  private factories: Map<string, Awaited<ReturnType<typeof loadReferee>>> | null = null;
  private async prepare() {
    if (!this.signer && this.binding.RECEIPT_PRIVATE_KEY) this.signer = await receiptSigner(this.binding.RECEIPT_PRIVATE_KEY);
    this.factories ??= new Map(await Promise.all(["downtown", "market", "docks", "towers", "vertigo"].map(async d => [d, await loadReferee(d)] as const)));
  }

  constructor(state: DurableObjectState, env: Env) {
    this.state = state; this.binding = env;
    void state.blockConcurrencyWhile(async () => {
      this.moderation = await state.storage.get<ModerationState>('moderation') ?? {};
      const claim = await state.storage.get<{ at: number; lag: number }>('room-claim');
      if (claim) { this.claimedAt = claim.at; this.lag = claim.lag; }
    });
  }
  private env() {
    return {
      // A room is claimed before prepare loads the key. Resolve the signer when the result is issued.
      signReceipt: this.binding.RECEIPT_PRIVATE_KEY ? (payload: string) => this.signer!(payload) : undefined, referee: (s: import("../../src/net/wire.ts").StartMsg) => this.factories!.get(s.config.district)!(s),
      log: (event: { rule: string; room: string; slot: number }) => console.warn(JSON.stringify({ event: "relay-detection", ...event })), now: Date.now, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), lagMs: this.lag, random: Math.random,
      moderateName: (name: string, network?: string) => moderatePlayerName(name, this.binding, network), moderationState: this.moderation,
      onModeration: () => this.state.waitUntil(this.state.storage.put('moderation', this.moderation)) };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/admission" && req.method === "POST") {
      const action = url.searchParams.get("action");
      if (action !== "create" && action !== "join") return new Response("bad action", { status: 400 });
      const ok = await this.state.storage.transaction(s => admit(s, action, Date.now()));
      return new Response(ok ? "ok" : "rate", { status: ok ? 200 : 429 });
    }
    if (url.pathname === '/budget' && req.method === 'POST') {
      const x = await req.json().catch(() => null) as { network?: string; units?: number } | null;
      if (!x) return new Response('bad budget', { status: 400 });
      const allowed = await this.state.storage.transaction(s => consumeBudget(s, x.network ?? '', x.units ?? 0));
      return Response.json({ allowed });
    }
    if (url.pathname === "/claim") {
      // A code stays claimed for 10 minutes or while anyone is in the room.
      if ((this.core && this.core.size > 0) || Date.now() - this.claimedAt < 600_000) return new Response("taken", { status: 409 });
      this.claimedAt = Date.now();
      this.lag = Number(url.searchParams.get("lag") ?? 0) || 0;
      await this.state.storage.put("room-claim", { at: this.claimedAt, lag: this.lag });
      this.core = new RoomCore(url.searchParams.get("code") ?? "?????", this.env());
      return new Response("ok");
    }
    if (!this.claimedAt || (Date.now() - this.claimedAt >= 600000 && !this.core?.size)) return new Response("room expired", { status: 404 });
    await this.prepare();
    const code = url.searchParams.get("room") ?? "";
    const network = await networkBucket(req, this.binding.DEV === '1', this.binding.TYPESAFE_API_KEY ?? '') ?? undefined;
    this.core ??= new RoomCore(code, this.env());
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    // Binary frames as ArrayBuffers (newer compatibility dates default to Blob).
    server.binaryType = "arraybuffer";
    const sock: Sock = { send: d => server.send(d), close: (c, r) => { try { server.close(c ?? 1000, r ?? ""); } catch { /* closed */ } } };
    const h = this.core.open(sock, { network });
    server.addEventListener("message", e => h.message(e.data));
    server.addEventListener("close", () => h.close());
    server.addEventListener("error", () => h.close());
    return new Response(null, { status: 101, webSocket: client });
  }
}
