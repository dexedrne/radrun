// The RadRun relay as a Cloudflare Worker + one Durable Object per room (DESIGN §5). Routes:
//   POST /room          -> {"code": "K7QXM"}   a fresh 5-character room code (claimed in its room object)
//   GET  /ws?room=CODE  -> WebSocket upgrade, forwarded to that room's object (relay/src/room.ts does the rest)
//   GET  /health        -> "ok"
// No secrets and no storage: rooms live in memory and vanish when empty. Origins are checked against ALLOWED_ORIGINS
// (comma-separated; localhost is always allowed when DEV = "1"). DEV_LAG_MS (dev only) injects a round trip.
import { RoomCore, type Sock } from "./room.ts";
import { isRoomCode, roomCode } from "../../src/net/wire.ts";

export interface Env {
  ROOMS: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  DEV?: string;
  DEV_LAG_MS?: string;
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

  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/claim") {
      // A code stays claimed for 10 minutes or while anyone is in the room.
      if ((this.core && this.core.size > 0) || Date.now() - this.claimedAt < 600_000) return new Response("taken", { status: 409 });
      this.claimedAt = Date.now();
      this.lag = Number(url.searchParams.get("lag") ?? 0) || 0;
      this.core = new RoomCore(url.searchParams.get("code") ?? "?????", { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), lagMs: this.lag, random: Math.random });
      return new Response("ok");
    }
    const code = url.searchParams.get("room") ?? "";
    this.core ??= new RoomCore(code, { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), lagMs: this.lag, random: Math.random });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    // Binary frames as ArrayBuffers (newer compatibility dates default to Blob).
    server.binaryType = "arraybuffer";
    const sock: Sock = { send: d => server.send(d), close: (c, r) => { try { server.close(c ?? 1000, r ?? ""); } catch { /* closed */ } } };
    const h = this.core.open(sock);
    server.addEventListener("message", e => h.message(e.data));
    server.addEventListener("close", () => h.close());
    server.addEventListener("error", () => h.close());
    return new Response(null, { status: 101, webSocket: client });
  }
}
