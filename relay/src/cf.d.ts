// The few Cloudflare Workers types the relay uses (so the repo needs no extra type package).
interface DurableObjectId { toString(): string }
interface DurableObjectStub { fetch(input: string | Request, init?: RequestInit): Promise<Response> }
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectState { readonly id: DurableObjectId }
interface CfWebSocket {
  accept(): void;
  binaryType: "arraybuffer" | "blob";
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (e: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: "close" | "error", fn: () => void): void;
}
declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } };
interface ResponseInit { webSocket?: CfWebSocket }
