// Local stand-in for the relay Worker: the same routes and the same room logic (relay/src/room.ts) on Node's http +
// the `ws` package (a devDependency), for development and headless checks without any Cloudflare tooling or sign-in.
//   node relay/dev.ts [--port 8787] [--lag 150]      (npm run relay)
// --lag = injected round trip between the two players, ms (each relay leg gets a quarter each way); POST /room?lag=N
// sets it per room. Localhost origins only.
import { mulberry32 } from "../src/sim/math.ts";
import { receiptSigner } from "./src/receipt.ts";
import { Quotas } from "./src/guard.ts";
import { ADMISSION } from "./src/admission.ts";
import { loadReferee } from "./src/referee.ts";
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { RoomCore } from "./src/room.ts";
import { isRoomCode, roomCode } from "../src/net/wire.ts";
import { moderatePlayerName } from './src/moderation.ts';

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const PORT = arg("--port", 8787);
const LAG = arg("--lag", 0);
const REVIEW_SEED = arg("--seed", NaN);
const factories = new Map(await Promise.all(["downtown", "market", "docks", "towers", "vertigo"].map(async d => [d, await loadReferee(d)] as const)));
const signReceipt = process.env.RECEIPT_PRIVATE_KEY ? await receiptSigner(process.env.RECEIPT_PRIVATE_KEY) : undefined;
const quotas = new Quotas();
const rooms = new Map<string, RoomCore>();
const env = (lag: number) => ({ signReceipt, referee: (s: import("../src/net/wire.ts").StartMsg) => factories.get(s.config.district)!(s), log: (event: unknown) => console.warn(JSON.stringify({ event: "relay-detection", detail: event })), now: () => Date.now(), setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), lagMs: lag, random: Number.isFinite(REVIEW_SEED) ? mulberry32(REVIEW_SEED) : Math.random,
  moderateName: (name: string) => moderatePlayerName(name, { ROOMS: {} as DurableObjectNamespace }) });
const localOrigin = (o: string | undefined) => !o || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin;
  const cors = { "Access-Control-Allow-Origin": origin ?? "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
  if (url.pathname === "/health") { res.end("ok"); return; }
  if (!localOrigin(origin)) { res.writeHead(403); res.end("origin not allowed"); return; }
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (url.pathname === "/room" && req.method === "POST") {
    const limit = ADMISSION.create;
    if (!quotas.take("create:" + req.socket.remoteAddress, Date.now(), limit.burst, limit.perMinute)) { res.writeHead(429, { ...cors, "Retry-After": "30" }); res.end("rate"); return; }
    if (rooms.size >= 512) { res.writeHead(503, cors); res.end("busy"); return; }
    let code = roomCode(Math.random);
    while (rooms.has(code)) code = roomCode(Math.random);
    const lag = Math.max(0, Math.min(1000, Number(url.searchParams.get("lag") ?? LAG) || 0));
    const created = new RoomCore(code, env(lag));
    rooms.set(code, created);
    const expiry = setTimeout(() => { if (created.size === 0 && rooms.get(code) === created) rooms.delete(code); }, 600000); expiry.unref();
    console.log(`[relay] room ${code} (lag ${lag} ms)`);
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ code }));
    return;
  }
  res.writeHead(404); res.end("not found");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const code = url.searchParams.get("room") ?? "";
  if (url.pathname !== "/ws" || !isRoomCode(code) || !localOrigin(req.headers.origin)) { socket.destroy(); return; }
  const limit = ADMISSION.join;
  if (!quotas.take("join:" + req.socket.remoteAddress, Date.now(), limit.burst, limit.perMinute)) { socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); return; }
  if (!rooms.has(code)) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    let room = rooms.get(code);
    if (!room) { room = new RoomCore(code, env(LAG)); rooms.set(code, room); }
    const h = room.open({ send: d => ws.send(d), close: (c, r) => ws.close(c ?? 1000, r ?? "") });
    ws.on("message", (data: Buffer, isBinary: boolean) => h.message(isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.toString("utf8")));
    ws.on("close", () => {
      h.close();
      const r = rooms.get(code);
      if (r && r.size === 0) setTimeout(() => { if (r.size === 0 && rooms.get(code) === r) { rooms.delete(code); console.log(`[relay] room ${code} closed (matches ${r.matches}, desyncs ${r.desyncs})`); } }, 30_000);
    });
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[relay] listening on http://127.0.0.1:${PORT} (lag ${LAG} ms)`));
