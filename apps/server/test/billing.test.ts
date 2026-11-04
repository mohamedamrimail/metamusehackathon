import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, NO_CREDIT_REPLY } from '../src/agent/runtime.ts';
import { charge, hasCredit, metaCostMicros } from '../src/billing/credits.ts';
import { aiUsage, users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { call, FakeLlm, makeIperson, reset, say, testDb, testGeo } from './helpers.ts';

const { db, pool } = testDb();
beforeEach(() => reset(db));
afterAll(() => pool.end());

const credit = async (userId: string) => (await db.select().from(users).where(eq(users.id, userId)))[0]!.aiCreditMicros;
const setCredit = (userId: string, micros: number) => db.update(users).set({ aiCreditMicros: micros }).where(eq(users.id, userId));

describe('Meta prices', () => {
  it('match the list prices', () => {
    expect(metaCostMicros({ kind: 'llm', model: 'm', usage: { input: 1_000_000, cachedInput: 0, output: 0 } })).toBe(1_250_000);
    expect(metaCostMicros({ kind: 'llm', model: 'm', usage: { input: 1_000_000, cachedInput: 1_000_000, output: 0 } })).toBe(150_000);
    expect(metaCostMicros({ kind: 'llm', model: 'm', usage: { input: 0, cachedInput: 0, output: 1_000_000 } })).toBe(4_250_000);
    expect(metaCostMicros({ kind: 'stt', model: 'm', seconds: 3600 })).toBe(180_000);
    expect(metaCostMicros({ kind: 'stt', model: 'm', seconds: 0.2 })).toBe(50); // whole seconds, rounded up
    expect(metaCostMicros({ kind: 'image', model: 'm', images: 2 })).toBe(20_000);
    expect(metaCostMicros({ kind: 'sam', model: 'm', images: 1 })).toBe(2_500);
  });
});

describe('AI credit', () => {
  it('takes the Meta cost plus the same again as platform fee', async () => {
    const { user } = await makeIperson(db);
    await setCredit(user.id, 5_000_000);
    expect(await charge(db, user.id, { kind: 'image', model: 'muse-image-1.0', images: 1 })).toBe(20_000);
    expect(await credit(user.id)).toBe(4_980_000);
    const [row] = await db.select().from(aiUsage);
    expect(row).toMatchObject({ kind: 'image', metaCostMicros: 10_000, feeMicros: 10_000, units: { images: 1 } });
  });

  it('$2.50 of Meta usage uses up the $5 free credit', async () => {
    const { user } = await makeIperson(db);
    await setCredit(user.id, 5_000_000);
    await charge(db, user.id, { kind: 'image', model: 'muse-image-1.0', images: 250 }); // 250 × $0.01
    expect(await credit(user.id)).toBe(0);
    expect(await hasCredit(db, user.id)).toBe(false);
  });

  it('charges every model call of a turn, and stops when the credit is gone', async () => {
    const { user, iperson } = await makeIperson(db);
    await setCredit(user.id, 5_000_000);
    const usage = { input: 2_000, cachedInput: 0, output: 1_000 }; // 0.0025 + 0.00425 = $0.00675 Meta
    const llm = new FakeLlm([
      { ...call('remember_fact', { category: 'preference', key: 'sport', value: 'table tennis' }), usage },
      { ...say('Noted.'), usage },
    ]);
    const runtime = new AgentRuntime({ db, llm, credits: { model: 'muse-spark-1.3' } });
    const conversationId = await runtime.conversationFor(iperson.id, 'web');
    expect((await runtime.handleUserMessage({ ipersonId: iperson.id, conversationId, text: 'I love table tennis' })).reply).toBe('Noted.');
    expect(await credit(user.id)).toBe(5_000_000 - 2 * 2 * 6_750);
    expect(await db.select().from(aiUsage)).toHaveLength(2);

    await setCredit(user.id, 0);
    const res = await runtime.handleUserMessage({ ipersonId: iperson.id, conversationId, text: 'hello?' });
    expect(res.reply).toBe(NO_CREDIT_REPLY);
    expect(llm.calls).toHaveLength(2); // no model call without credit
  });

  it('is not charged in demo mode', async () => {
    const { user, iperson } = await makeIperson(db);
    const runtime = new AgentRuntime({ db, llm: new FakeLlm([say('hi')]) });
    const conversationId = await runtime.conversationFor(iperson.id, 'web');
    expect((await runtime.handleUserMessage({ ipersonId: iperson.id, conversationId, text: 'hi' })).reply).toBe('hi');
    expect(await credit(user.id)).toBe(0);
  });

  it('new accounts start with the free credit, and see what they spent', async () => {
    const app = buildApp(createDeps(db, { geo: testGeo, llm: new FakeLlm([]), stt: undefined, demoMode: false, billing: true }));
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'new@example.com', password: 'correct horse', name: 'New' } });
    expect(reg.json().user.ai_credit_usd).toBe(5);
    const cookie = String(reg.headers['set-cookie']).split(';')[0]!;
    await charge(db, reg.json().user.id, { kind: 'stt', model: 'muse-voice-transcribe-1.0', seconds: 3600 });
    const summary = (await app.inject({ url: '/api/me/credit', headers: { cookie } })).json();
    expect(summary).toMatchObject({ balance_usd: 4.64, free_usd: 5, fee_ratio: 1, billing: true, by_kind: [{ kind: 'stt', calls: 1, meta_usd: 0.18, fee_usd: 0.18 }] });
    await app.close();
  });
});
