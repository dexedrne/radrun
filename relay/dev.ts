// Local stand-in for the relay Worker: the same routes and the same room logic (relay/src/room.ts) on Node's http +
// the `ws` package (a devDependency), for development and headless checks without any Cloudflare tooling or sign-in.
//   node relay/dev.ts [--port 8787] [--lag 150]      (npm run relay)
// --lag = injected round trip between the two players, ms (each relay leg gets a quarter each way); POST /room?lag=N
// sets it per room. Localhost origins only.
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { RoomCore } from "./src/room.ts";
import { isRoomCode, roomCode } from "../src/net/wire.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const PORT = arg("--port", 8787);
const LAG = arg("--lag", 0);
const rooms = new Map<string, RoomCore>();
const env = (lag: number) => ({ now: () => Date.now(), setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), lagMs: lag, random: Math.random });
const localOrigin = (o: string | undefined) => !o || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin;
  const cors = { "Access-Control-Allow-Origin": origin ?? "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
  if (url.pathname === "/health") { res.end("ok"); return; }
  if (!localOrigin(origin)) { res.writeHead(403); res.end("origin not allowed"); return; }
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (url.pathname === "/room" && req.method === "POST") {
    let code = roomCode(Math.random);
    while (rooms.has(code)) code = roomCode(Math.random);
    const lag = Math.max(0, Math.min(1000, Number(url.searchParams.get("lag") ?? LAG) || 0));
    rooms.set(code, new RoomCore(code, env(lag)));
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
