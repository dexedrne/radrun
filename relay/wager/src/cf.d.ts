// The Cloudflare Workers types the wager relay uses beyond relay/src/cf.d.ts (global declarations merge with those):
// Durable Object SQLite storage and alarms, hibernatable WebSockets, and the manual body encoding for stored gzip.
interface DurableObjectSqlCursor { toArray(): Record<string, unknown>[] }
interface DurableObjectStorage {
  sql: { exec(query: string, ...bindings: unknown[]): DurableObjectSqlCursor };
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}
interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
interface CfWebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  readonly readyState: number;
}
declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}
interface ResponseInit { encodeBody?: "automatic" | "manual" }
