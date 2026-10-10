import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeBudget, LIMITS, moderatePlayerText, moderatePlayerName } from '../relay/src/moderation.ts';

test('network and daily budgets persist, reset and fall back without a provider call', async () => {
  const values = new Map<string, unknown>();
  const storage = { get: async <T>(key: string) => structuredClone(values.get(key)) as T, put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); } };
  const network = 'a'.repeat(64), now = 1_000;
  for (let n = 0; n < LIMITS.minute; n++) assert.equal(await consumeBudget(storage, network, 10, now), true);
  assert.equal(await consumeBudget(storage, network, 10, now), false);
  assert.equal(await consumeBudget(storage, network, 10, now + 60_000), true);
  const b = values.get('budget') as any; b.calls = LIMITS.calls; values.set('budget', b);
  assert.equal(await consumeBudget(storage, 'b'.repeat(64), 10, now), false);
  assert.equal(await consumeBudget(storage, network, 10, now + 86_400_000), true);
  const fresh = values.get('budget') as any;
  fresh.networks[network].dayCount = LIMITS.networkDay; values.set('budget', fresh);
  assert.equal(await consumeBudget(storage, network, 10, now + 86_400_000 + 60_000), false);
  fresh.units = LIMITS.inputUnits; values.set('budget', fresh);
  assert.equal(await consumeBudget(storage, 'b'.repeat(64), 1, now + 86_400_000), false);
  assert.equal(await consumeBudget(storage, 'spoof', 10, now), false);
  let provider = 0;
  const original = globalThis.fetch; globalThis.fetch = async () => { provider++; throw Error('must not call provider'); };
  try {
    const env = { TYPESAFE_API_KEY: 'recorded-test-key', ROOMS: { idFromName: () => ({}), get: () => ({ fetch: async () => Response.json({ allowed: false }) }) } } as any;
    assert.equal((await moderatePlayerText('fuck yeah', 'chat', env, network)).action, 'allow');
    assert.equal((await moderatePlayerText('n1gg3r', 'name', env, network)).action, 'block');
    assert.equal((await moderatePlayerName('driver....niggerz', env, network)).action, 'block');
    assert.equal(provider, 0);
  } finally { globalThis.fetch = original; }
});
