import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { conversations, ipersons, messages, users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { median, metricsSummary } from '../src/lib/metrics.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { reset, testDb, testGeo } from './helpers.ts';

// Jury §7: feedback after the 5th turn, quotable answers for admins, metrics without judges/demo/admins.

const { db, pool } = testDb();
let app: FastifyInstance;
beforeEach(async () => {
  await reset(db);
  await db.execute('truncate feedback');
  await app?.close();
  app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true }));
});
afterAll(async () => { await app.close(); await pool.end(); });

async function person(email: string, turns: number, kind = 'user') {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'Lina Ben Ali' } });
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  const ip = (await app.inject({ method: 'POST', url: '/api/ipersons', headers: { cookie }, payload: { display_name: 'L', locale: 'en', timezone: 'Africa/Tunis' } })).json().iperson;
  await db.update(users).set({ accountKind: kind }).where(eq(users.email, email));
  const [c] = await db.insert(conversations).values({ ipersonId: ip.id, channel: 'web' }).returning();
  for (let i = 0; i < turns; i++) await db.insert(messages).values({ conversationId: c!.id, role: 'user', content: `hi ${i}` });
  return { cookie, ipersonId: ip.id as string };
}

describe('feedback', () => {
  it('is due once after the 5th turn, never for demo accounts', async () => {
    const early = await person('early@example.com', 4);
    expect((await app.inject({ url: '/api/me/feedback/status', headers: { cookie: early.cookie } })).json().due).toBe(false);
    const ready = await person('ready@example.com', 5);
    expect((await app.inject({ url: '/api/me/feedback/status', headers: { cookie: ready.cookie } })).json().due).toBe(true);
    await app.inject({ method: 'POST', url: '/api/me/feedback', headers: { cookie: ready.cookie }, payload: { rating: null, context: 'talk' } }); // "Not now"
    expect((await app.inject({ url: '/api/me/feedback/status', headers: { cookie: ready.cookie } })).json().due).toBe(false);
    const demo = await person('demo@example.com', 9, 'demo');
    expect((await app.inject({ url: '/api/me/feedback/status', headers: { cookie: demo.cookie } })).json().due).toBe(false);
  });

  it('shows admins quotable answers by first name only', async () => {
    const admin = await person('admin@example.com', 0);
    const u = await person('lina@example.com', 5);
    await app.inject({ method: 'POST', url: '/api/me/feedback', headers: { cookie: u.cookie }, payload: { rating: 5, text: 'It booked my padel in one sentence.', quotable: true, context: 'talk' } });
    await app.inject({ method: 'POST', url: '/api/me/feedback', headers: { cookie: u.cookie }, payload: { rating: 4, quotable: true, context: 'twin' } }); // no text: not quotable
    expect((await app.inject({ url: '/api/admin/feedback', headers: { cookie: u.cookie } })).statusCode).toBe(403);
    const list = (await app.inject({ url: '/api/admin/feedback?quotable=1', headers: { cookie: admin.cookie } })).json().feedback;
    expect(list).toEqual([expect.objectContaining({ rating: 5, first_name: 'Lina', quotable: true })]);
    expect(JSON.stringify(list)).not.toContain('lina@example.com');
  });
});

describe('metrics', () => {
  it('counts real users only', async () => {
    await person('real@example.com', 3);
    await person('judge@example.com', 7, 'judge');
    await person('demo@example.com', 7, 'demo');
    await person('admin@example.com', 7);
    const m = await metricsSummary(db);
    expect(m).toMatchObject({ signups: 1, active_users: 1, turns: 3 });
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBe(0);
    void ipersons;
  });
});
