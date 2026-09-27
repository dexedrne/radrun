// The client side of the relay (multiplayer design §4-§5): room creation over HTTP, one WebSocket per room, JSON control and
// binary input frames, and the relay clock (PING / PONG every 0.5 s; the offset comes from the lowest round trip of
// the last 8 samples). Part of the lazy online chunk.
import { MSG_PONG, decodePong, encodeJson, encodePing, type ClientMsg, type ServerMsg } from "./wire.ts";

/** The relay base URL: ?relay= (dev / test builds), else VITE_RELAY_URL, else (dev) this host on port 8787; null = none. */
export function relayBase(): string | null {
  const dev = import.meta.env.MODE !== "production";
  const q = new URLSearchParams(location.search).get("relay");
  if (dev && q) return q.replace(/\/$/, "");
  const env = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (env) return env.replace(/\/$/, "");
  return dev ? `${location.protocol}//${location.hostname}:8787` : null;
}

export async function createRoom(base: string, lag = 0): Promise<string> {
  const r = await fetch(`${base}/room${lag > 0 ? `?lag=${lag}` : ""}`, { method: "POST" });
  if (!r.ok) throw new Error(r.status === 503 ? "the relay is busy, try again" : `the relay said ${r.status}`);
  const j = (await r.json()) as { code?: string };
  if (!j.code) throw new Error("the relay gave no room code");
  return j.code;
}

export class Transport {
  private ws: WebSocket | null = null;
  onJson: (m: ServerMsg) => void = () => {};
  onBinary: (b: Uint8Array) => void = () => {};
  onClose: (why: string) => void = () => {};
  private readonly samples: { rtt: number; offset: number }[] = [];
  private timer = 0;
  /** Relay ms - local ms (from the best recent sample). */
  offset = 0;
  /** Lowest recent round trip to the relay, ms (the clock offset's sample). */
  rtt = 0;
  /** Lowest round trip since connecting (the input delay choice; a busy main thread only ever inflates a sample). */
  minRtt = Infinity;
  sentBytes = 0;
  recvBytes = 0;

  connect(base: string, code: string): Promise<void> {
    const url = `${base.replace(/^http/, "ws")}/ws?room=${encodeURIComponent(code)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let open = false;
      ws.onopen = () => {
        open = true;
        // A burst of pings for a first clock estimate, then every 0.5 s.
        for (let i = 0; i < 4; i++) setTimeout(() => this.ping(), i * 60);
        this.timer = window.setInterval(() => this.ping(), 500);
        resolve();
      };
      ws.onerror = () => { if (!open) reject(new Error("can't reach the relay")); };
      ws.onclose = e => {
        clearInterval(this.timer);
        this.ws = null;
        if (open) this.onClose(e.reason || (e.code === 1000 ? "closed" : `connection lost (${e.code})`));
        else reject(new Error("can't reach the relay"));
      };
      ws.onmessage = e => {
        if (typeof e.data === "string") {
          this.recvBytes += e.data.length;
          let m: ServerMsg;
          try { m = JSON.parse(e.data) as ServerMsg; } catch { return; }
          this.onJson(m);
          return;
        }
        const b = new Uint8Array(e.data as ArrayBuffer);
        this.recvBytes += b.length;
        if (b[0] === MSG_PONG) { this.pong(b); return; }
        this.onBinary(b);
      };
    });
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendJson(m: ClientMsg): void {
    if (!this.open) return;
    const s = encodeJson(m);
    this.sentBytes += s.length;
    this.ws!.send(s);
  }

  sendBinary(b: Uint8Array): void {
    if (!this.open) return;
    this.sentBytes += b.length;
    this.ws!.send(b as Uint8Array<ArrayBuffer>);
  }

  /** The relay's clock now (ms). */
  relayNow(): number {
    return performance.now() + this.offset;
  }

  close(): void {
    clearInterval(this.timer);
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; try { ws.close(1000, "bye"); } catch { /* closed */ } }
  }

  private ping(): void {
    this.sendBinary(encodePing(Math.floor(performance.now()) >>> 0));
  }

  private pong(b: Uint8Array): void {
    const p = decodePong(b);
    if (!p) return;
    const now = performance.now();
    // The u32 client ms wraps every 49 days; unwrap against now.
    const sent = now - ((((Math.floor(now) >>> 0) - p.clientMs) >>> 0));
    const rtt = now - sent;
    if (rtt < 0 || rtt > 10_000) return;
    this.samples.push({ rtt, offset: p.relayMs - (sent + rtt / 2) });
    if (this.samples.length > 8) this.samples.shift();
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.rtt = best.rtt;
    if (rtt < this.minRtt) this.minRtt = rtt;
  }
}
