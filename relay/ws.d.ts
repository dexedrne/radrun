// Minimal types for the `ws` package (a pinned devDependency) as relay/dev.ts uses it, instead of a separate @types package.
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
