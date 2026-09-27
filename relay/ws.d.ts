// Minimal types for the `ws` package (already installed with the headless-browser tooling) used by relay/dev.ts.
declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";
  export interface WebSocket {
    send(data: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
    on(ev: "message", fn: (data: Buffer, isBinary: boolean) => void): void;
    on(ev: "close" | "error", fn: () => void): void;
  }
  export class WebSocketServer {
    constructor(o: { noServer: boolean; maxPayload?: number });
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocket) => void): void;
  }
}
