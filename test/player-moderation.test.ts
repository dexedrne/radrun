import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moderateText, normalizeText, RoomModeration, neutralName, moderationRequest } from '../relay/src/playerModeration.ts';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/player-moderation.json', import.meta.url), 'utf8'));
test('recorded categories and confidence route with profanity and adult banter always allowed', async () => {
  for (const sample of recorded.samples) {
    const result = await moderateText(sample.text, 'chat', async () => sample.answers);
    assert.equal(result.action, sample.action, sample.label);
    assert.equal(result.category, sample.category, sample.label);
  }
});
test('normalization catches case, leetspeak, spacing, repeats, accents and homoglyphs without substring matches', async () => {
  assert.equal(normalizeText('ＦＵＣＫ  yeah'), 'fuck yeah');
  for (const text of ['N1GG3R', 'n i g g e r', 'n.i.g.g.e.r', 'nіggеr', 'niiiiiggggger', '!n1gg3r!', 'n!gger!you', 'nіgg3r!', 'n1gg3r123', 'n1663r', 'n1993r']) {
    const result = await moderateText(text, 'chat', async () => { throw Error('must not call provider'); });
    assert.equal(result.action, 'block', text); assert.equal(result.category, 'slur');
  }
  for (const text of ['fuck shit cunt motherfucker', 'Scunthorpe raccoon', 'Niger', 'kill you next round', '69 is my car number', '1998 180000 4500', 'rev it 8000 6000 5000 rpm', '1234567890 is my score'])
    assert.equal((await moderateText(text, 'chat', async () => { throw Error('offline'); })).action, 'allow', text);
});
test('offline, spent budget and malformed provider responses use plain code and never log the input', async () => {
  const text = 'phone: 212-555-0199';
  for (const evaluate of [async () => null, async () => { throw Error(text); }, async () => ({ safety: { score: NaN } })]) {
    assert.equal((await moderateText(text, 'chat', evaluate)).action, 'block');
    assert.equal((await moderateText('ordinary banter', 'chat', evaluate)).action, 'allow');
  }
  let calls = 0;
  assert.equal((await moderateText('x'.repeat(121), 'chat', async () => { calls++; })).action, 'block');
  assert.equal((await moderateText('x'.repeat(25), 'name', async () => { calls++; })).action, 'block');
  assert.equal(calls, 0);
  const request = moderationRequest('fuck yeah', 'chat');
  assert.equal(request.questions.safety.type, 'score'); assert.equal(request.questions.category.type, 'choice');
  assert.equal(request.questions.category.criteria.sexual.includes('minor'), true);
});
test('only low safety evidence plus two distinct peers mutes; duplicate, self and harmless reports do not', async () => {
  let now = 1000; const state = {}, room = new RoomModeration(state, () => now);
  const sample = recorded.samples.find((s: any) => s.category === 'harassment');
  const uncertain = structuredClone(sample.answers); uncertain.safety.score = .8; uncertain.safety.confidence = .4; uncertain.category.confidence = .4;
  const decision = await moderateText(sample.text, 'chat', async () => uncertain);
  assert.equal(room.observe('target', decision).action, 'hold');
  assert.equal(room.report('target', 'target'), false);
  assert.equal(room.report('target', 'peer1'), false); assert.equal(room.report('target', 'peer1'), false);
  assert.equal(room.report('target', 'peer2'), true); assert.equal(room.muted('target'), true);
  const restored = new RoomModeration(JSON.parse(JSON.stringify(state)), () => now);
  assert.equal(restored.muted('target'), true); now += 300001; assert.equal(restored.muted('target'), false);
  assert.equal(JSON.stringify(state).includes(sample.text), false);
  const clean = await moderateText('fuck yeah', 'name', async () => null);
  room.observe('clean', clean); room.report('clean', 'peer1'); assert.equal(room.report('clean', 'peer2'), false);
  assert.match(neutralName('a'.repeat(32)), /^Player-[a-f0-9]{6}$/);
});
test('repeat suspicious text is a second signal, room records are bounded and chat flooding is caught', async () => {
  let now = 1000; const state = {}, room = new RoomModeration(state, () => now);
  const sample = recorded.samples.find((s: any) => s.category === 'harassment');
  const uncertain = structuredClone(sample.answers); uncertain.safety.score = .8; uncertain.safety.confidence = .4; uncertain.category.confidence = .4;
  const decision = await moderateText(sample.text, 'chat', async () => uncertain);
  room.observe('target', decision); now += 2100; assert.equal(room.observe('target', decision).action, 'block');
  assert.equal(room.chatAllowed('flood'), true); assert.equal(room.chatAllowed('flood'), true); assert.equal(room.chatAllowed('flood'), true); assert.equal(room.chatAllowed('flood'), false);
  for(let n=0;n<70;n++)for(let j=0;j<3;j++)room.observe('actor'+n,{...decision,action:'block'});
  assert.equal(Object.keys(state).length,64);
});
