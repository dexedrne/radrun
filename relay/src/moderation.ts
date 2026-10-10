import { moderateText, type TextKind } from './playerModeration.ts';
import { cleanName } from '../../src/net/wire.ts';
import { RADBROS, charFile } from '../../src/game/radbros.ts';
const authoredNames = new Set(RADBROS.map(charFile));

export const LIMITS = { minute: 30, networkDay: 600, calls: 4000, inputUnits: 8_000_000 };
type Budget = { day: number; calls: number; units: number; networks: Record<string, { minute: number; count: number; dayCount: number }> };
type Store = Pick<DurableObjectStorage, 'get' | 'put'>;
type Env = { TYPESAFE_API_KEY?: string; ROOMS: DurableObjectNamespace };

/** The budget DO transacts this read/write; network buckets contain keyed hashes, never addresses. */
export async function consumeBudget(storage: Store, network: string, units: number, now = Date.now()): Promise<boolean> {
  if (!/^(?:network:)?[a-f0-9]{64}$/.test(network) || !Number.isSafeInteger(units) || units < 1 || units > LIMITS.inputUnits) return false;
  const day = Math.floor(now / 86_400_000), minute = Math.floor(now / 60_000);
  let b = await storage.get<Budget>('budget');
  if (b?.day !== day) b = { day, calls: 0, units: 0, networks: {} };
  const n = b.networks[network] ?? { minute, count: 0, dayCount: 0 };
  if (n.minute !== minute) { n.minute = minute; n.count = 0; }
  if (b.calls >= LIMITS.calls || b.units + units > LIMITS.inputUnits || n.count >= LIMITS.minute || n.dayCount >= LIMITS.networkDay) return false;
  n.count++; n.dayCount++; b.calls++; b.units += units; b.networks[network] = n;
  await storage.put('budget', b); return true;
}

/** All rooms share the durable daily spend cap. */
export function budgetedFetch(env: Env, network?: string): typeof fetch {
  return async (url, init) => {
    if (!env.TYPESAFE_API_KEY || !network || typeof init?.body !== 'string') return new Response(null, { status: 503 });
    try {
      const units = new TextEncoder().encode(init.body).byteLength + 1024;
      const response = await env.ROOMS.get(env.ROOMS.idFromName('jev-budget')).fetch('https://room/budget', {
        method: 'POST', body: JSON.stringify({ network, units }),
      });
      if (!response.ok || (await response.json() as { allowed?: boolean }).allowed !== true) return new Response(null, { status: 429 });
      return await fetch(url, init);
    } catch { return new Response(null, { status: 503 }); }
  };
}

export async function moderatePlayerText(text: string, kind: TextKind, env: Env, network?: string) {
  return moderateText(text, kind, async payload => {
  const r = await budgetedFetch(env, network)('https://api.typesafe.ai/v1/systemone', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.TYPESAFE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
  });
  return r.ok ? (await r.json() as { answers?: unknown }).answers : null;
  });
}

/** Inspect both the submitted name and the exact name that will be displayed. */
export async function moderatePlayerName(text: string, env: Env, network?: string, display = cleanName(text)) {
  const raw = await moderateText(text, 'name');
  return raw.action === 'block' ? raw : authoredNames.has(display) ? moderateText(display, 'name') : moderatePlayerText(display, 'name', env, network);
}
