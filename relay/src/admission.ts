// Persisted per-network admission. Two fixed keys in each network's Durable Object.
export const ADMISSION = { create: { burst: 6, perMinute: 2 }, join: { burst: 16, perMinute: 8 } } as const;
export type AdmissionAction = keyof typeof ADMISSION;
export async function admit(storage: Pick<DurableObjectStorage, 'get' | 'put'>, action: AdmissionAction, now: number): Promise<boolean> {
  const limit = ADMISSION[action];
  const b = await storage.get<{ credit: number; at: number }>('admission:' + action) ?? { credit: limit.burst, at: now };
  b.credit = Math.min(limit.burst, b.credit + Math.max(0, now - b.at) * limit.perMinute / 60000); b.at = now;
  const ok = b.credit >= 1;
  if (ok) b.credit--;
  await storage.put('admission:' + action, b); return ok;
}
