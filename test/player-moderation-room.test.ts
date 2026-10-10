import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomCore } from '../relay/src/room.ts';
import { moderateText, type ModerationState } from '../relay/src/playerModeration.ts';
import { NET_VERSION, type ServerMsg, type ClientMsg } from '../src/net/wire.ts';

const wait = async (f: () => boolean) => { const end = Date.now() + 30_000; while (!f()) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 5)); } };
const compat = { v: NET_VERSION, build: 'moderation-test', link: 6, city: 'c', tuning: 't' };
function peer(core: RoomCore, name: string, token?: string) {
  const got: ServerMsg[] = [], h = core.open({ send: d => { if (typeof d === 'string') got.push(JSON.parse(d)); }, close: () => h.close() });
  const send = (m: ClientMsg) => h.message(JSON.stringify(m));
  send({ t: 'hello', compat, name, radbro: '652', touch: false, easy: false, district: 'downtown', moderationToken: token });
  return { got, h, send, welcome: () => got.find(m => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }> | undefined };
}
test('name admission is private; reports need distinct peers and low-score evidence across restart', async () => {
  const state: ModerationState = {}, env = { now: Date.now, setTimeout: () => 0, lagMs: 0, random: () => .3,
    moderationState: state, moderateName: (name: string) => moderateText(name, 'name') };
  const core = new RoomCore('K7QXM', env), a = peer(core, 'n1gg3r'), b = peer(core, 'fuckyeah');
  await wait(() => !!a.welcome() && !!b.welcome());
  assert.match(a.welcome()!.players.find(p => p.slot === a.welcome()!.slot)!.name, /^Player-/);
  assert.ok(a.got.some(m => m.t === 'error' && m.code === 'name-replaced'));
  assert.equal(b.welcome()!.players.find(p => p.slot === b.welcome()!.slot)!.name, 'fuckyeah');
  b.send({ t: 'report', slot: a.welcome()!.slot }); b.send({ t: 'report', slot: a.welcome()!.slot });
  assert.equal(a.got.some(m => m.t === 'error' && m.code === 'room-muted'), false);
  b.h.close(); const c = peer(core, 'friend'); await wait(() => !!c.welcome());
  c.send({ t: 'report', slot: a.welcome()!.slot });
  assert.ok(a.got.some(m => m.t === 'error' && m.code === 'room-muted'));
  a.h.message(JSON.stringify({ t: 'chat', text: 'n1gg3r' }));
  assert.ok(a.got.some(m => m.t === 'error' && m.message === 'not sent'));
  assert.equal(JSON.stringify(c.got).includes('n1gg3r'), false);
  const token = a.welcome()!.moderationToken!;
  assert.equal(JSON.stringify(state).includes(token), false); assert.equal(JSON.stringify(state).includes('n1gg3r'), false);
  a.h.close(); c.h.close();
  const again = peer(new RoomCore('K7QXM', { ...env, moderationState: structuredClone(state) }), 'friend', token);
  await wait(() => !!again.welcome());
  assert.ok(again.got.some(m => m.t === 'error' && m.code === 'room-muted'));
  again.h.close();
});
test('closed sockets cannot publish a delayed name', async () => {
  let finish!: (d: Awaited<ReturnType<typeof moderateText>>) => void;
  const core = new RoomCore('K7QXM', { now: Date.now, setTimeout: () => 0, lagMs: 0, random: () => .3,
    moderateName: () => new Promise(resolve => { finish = resolve; }) });
  const a = peer(core, 'friend'); a.h.close(); finish(await moderateText('friend', 'name'));
  await new Promise(r => setTimeout(r, 10)); assert.equal(core.size, 0);
});
