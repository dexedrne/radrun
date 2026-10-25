import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../relay/src/worker.ts';
import { admit, type AdmissionAction } from '../relay/src/admission.ts';

test('Worker admission applies before room allocation and socket upgrade, across room codes', async () => {
  const buckets = new Map<string, Map<string, unknown>>();
  let claims = 0, sockets = 0;
  const env = {
    ALLOWED_ORIGINS: 'https://spidertag.app',
    ROOMS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: DurableObjectId) => ({ fetch: async (input: string | Request) => {
        const u = new URL(typeof input === 'string' ? input : input.url);
        if (u.pathname === '/admission') {
          let data = buckets.get(id.toString()); if (!data) { data = new Map(); buckets.set(id.toString(), data); }
          const storage = { get: async <T>(k: string) => data!.get(k) as T | undefined, put: async <T>(k: string, v: T) => { data!.set(k, v); } };
          const ok = await admit(storage, u.searchParams.get('action') as AdmissionAction, 1000000);
          return new Response('', { status: ok ? 200 : 429 });
        }
        if (u.pathname === '/claim') { claims++; return new Response('ok'); }
        sockets++; return new Response('upgraded in fake runtime');
      } }),
    },
  };
  const req = (path: string, network?: string) => new Request('https://relay.example' + path, { method: path === '/room' ? 'POST' : 'GET', headers: { Origin: 'https://spidertag.app', ...(network ? { 'CF-Connecting-IP': network } : {}), ...(path.startsWith('/ws') ? { Upgrade: 'websocket' } : {}) } });
  assert.equal((await worker.fetch(req('/room'), env)).status, 403, 'missing trusted network fails closed');
  assert.equal((await worker.fetch(req('/room', 'invalid'), env)).status, 403);
  for (let i = 0; i < 6; i++) assert.equal((await worker.fetch(req('/room', '192.0.2.7'), env)).status, 200);
  const limited = await worker.fetch(req('/room', '192.0.2.7'), env);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '30'); assert.equal(claims, 6);
  for (let i = 0; i < 16; i++) assert.equal((await worker.fetch(req('/ws?room=K7QXM', '192.0.2.7'), env)).status, 200);
  assert.equal((await worker.fetch(req('/ws?room=ABCDE', '192.0.2.7'), env)).status, 429); assert.equal(sockets, 16);
  assert.equal((await worker.fetch(req('/room', '192.0.2.8'), env)).status, 200, 'another network has its own quota');
});

test('room claim survives object eviction without loading simulation assets for admission', async () => {
  const { Room } = await import('../relay/src/worker.ts');
  const data = new Map<string, unknown>(); let initialized = Promise.resolve();
  const storage = { get: async <T>(key: string) => data.get(key) as T | undefined, put: async <T>(key: string, value: T) => { data.set(key, value); } };
  const state = { storage, blockConcurrencyWhile: (fn: () => Promise<void>) => { initialized = fn(); return initialized; }, waitUntil: () => {} } as unknown as DurableObjectState;
  const env = { ROOMS: {} as DurableObjectNamespace };
  const first = new Room(state, env); await initialized;
  assert.equal((await first.fetch(new Request('https://room/claim?code=K7QXM&lag=0', { method: 'POST' }))).status, 200);
  assert.ok(data.has('room-claim'));
  const reloaded = new Room(state, env); await initialized;
  assert.equal((await reloaded.fetch(new Request('https://room/claim?code=K7QXM&lag=0', { method: 'POST' }))).status, 409);
});
