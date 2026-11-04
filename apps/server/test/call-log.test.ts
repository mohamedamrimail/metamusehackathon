import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { recentCalls, resetCallLog } from '../src/lib/call-log.ts';
import { clearRuntimeCache } from '../src/lib/settings.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { reset, testDb, testGeo } from './helpers.ts';

// DEMO: the Meta AI calls panel logs demo accounts' calls only, and only demo accounts may read it.

const { db, pool } = testDb();
let app: FastifyInstance;
let deps: ReturnType<typeof createDeps>;

beforeEach(async () => {
  await reset(db);
  await db.execute('truncate settings');
  clearRuntimeCache();
  resetCallLog();
  await app?.close();
  deps = createDeps(db, { geo: testGeo, llm: new DemoLlm(() => new Date('2026-11-02T09:00:00Z')), stt: undefined, demoMode: true, billing: false });
  app = buildApp(deps);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function signUp(email: string, demo: boolean) {
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'Sara' } });
  const cookie = String(reg.headers['set-cookie']).split(';')[0]!;
  const ipersonId = (await app.inject({ method: 'POST', url: '/api/ipersons', headers: { cookie }, payload: { display_name: 'i-Sara', locale: 'en', timezone: 'Europe/Berlin' } })).json().iperson.id as string;
  if (demo) await db.update(users).set({ accountKind: 'demo' }).where(eq(users.email, email));
  return { cookie, ipersonId };
}

const say = async (ipersonId: string, _cookie: string, text: string) =>
  deps.runtime.handleUserMessage({ ipersonId, conversationId: await deps.runtime.conversationFor(ipersonId, 'web'), text });

describe('Meta AI calls panel', () => {
  it('logs a demo account’s model calls and its approval card, with latency', async () => {
    const { cookie, ipersonId } = await signUp('sara@example.com', true);
    const r = await say(ipersonId, cookie, 'Book yoga on Tuesday 6pm');
    expect(r.proposed).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 50));
    const calls = recentCalls();
    const model = calls.find((c) => c.service === 'Muse Spark');
    expect(model).toMatchObject({ meta: true, twin: 'i-Sara', simulated: expect.stringContaining('META_API_KEY') });
    expect(model!.what).toMatch(/^Agent turn: /);
    expect(typeof model!.ms).toBe('number');
    expect(calls.some((c) => c.service === 'Approval gate' && /waiting for a yes/.test(c.what))).toBe(true);
  });

  it('never logs a real user’s calls', async () => {
    const { cookie, ipersonId } = await signUp('real@example.com', false);
    await say(ipersonId, cookie, 'Book yoga on Tuesday 6pm');
    await new Promise((res) => setTimeout(res, 50));
    expect(recentCalls()).toHaveLength(0);
  });

  it('serves the live feed to demo accounts only, and not when switched off', async () => {
    const real = await signUp('real@example.com', false);
    expect((await app.inject({ url: '/api/demo/calls', headers: { cookie: real.cookie } })).statusCode).toBe(404);
    const demo = await signUp('sara@example.com', true);
    expect((await app.inject({ url: '/api/features', headers: { cookie: demo.cookie } })).json().calls_panel).toBe(true);
    await db.execute(`insert into settings (key, value) values ('runtime', '{"showCallsPanel": false}')`);
    clearRuntimeCache();
    expect((await app.inject({ url: '/api/demo/calls', headers: { cookie: demo.cookie } })).statusCode).toBe(404);
    await say(demo.ipersonId, demo.cookie, 'hello');
    await new Promise((res) => setTimeout(res, 50));
    expect(recentCalls()).toHaveLength(0);
  });
});

describe('shared demo accounts', () => {
  it('can’t be deleted, even with the (public) password', async () => {
    const { cookie } = await signUp('sara@example.com', true);
    const r = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie }, payload: { password: 'correct horse' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('demo_account');
  });
});
