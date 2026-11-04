import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { actions, conversations, users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { call, FakeLlm, makeIperson, reset, say, testDb, testGeo } from './helpers.ts';

// Meta Ray-Ban Display: the /glasses web app works with a paired device token, on /glasses/* only.

const { db, pool } = testDb();
let app: FastifyInstance;
let llm: FakeLlm;
beforeEach(async () => {
  await reset(db);
  await db.execute('truncate glasses_devices');
  await app?.close();
  llm = new FakeLlm([], say('Done.'));
  app = buildApp(createDeps(db, { geo: testGeo, llm, stt: undefined, demoMode: true }));
  await app.ready();
});
afterAll(async () => { await app.close(); await pool.end(); });

const cookieFor = (userId: string) => `ip_session=${app.jwt.sign({ sub: userId })}`;
async function paired(email = 'merry@example.com') {
  const { user, iperson } = await makeIperson(db, { email });
  const r = await app.inject({ method: 'POST', url: '/api/me/glasses', headers: { cookie: cookieFor(user.id) }, payload: {} });
  const url = new URL(r.json().url);
  return { user, iperson, id: r.json().id as string, link: r.json().install_link as string, auth: { authorization: `Bearer ${url.searchParams.get('k')}` } };
}

describe('glasses', () => {
  it('pairs with an install link; the token works on /glasses only and stops when removed', async () => {
    const g = await paired();
    expect(g.link).toMatch(/^fb-viewapp:\/\/web_app_deep_link\?appName=i-persons&appUrl=https%3A%2F%2F.*%2Fglasses%3Fk%3D/);
    const s = await app.inject({ url: '/api/glasses/state', headers: g.auth });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ twin: { name: 'Mimi' }, lines: [], cards: [] });
    expect((await app.inject({ url: '/api/me', headers: g.auth })).statusCode).toBe(401); // not a session
    expect((await app.inject({ url: '/api/glasses/state' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/me/glasses', headers: { cookie: cookieFor(g.user.id) } })).json().devices).toHaveLength(1);
    await app.inject({ method: 'DELETE', url: `/api/me/glasses/${g.id}`, headers: { cookie: cookieFor(g.user.id) } });
    expect((await app.inject({ url: '/api/glasses/state', headers: g.auth })).statusCode).toBe(401);
  });

  it('asks the twin, shows the card, and a tap approves only the owner’s card', async () => {
    const g = await paired();
    llm = new FakeLlm([call('calendar_book', { title: 'Supplier', start: '2026-11-05T10:00:00', end: '2026-11-05T11:00:00' }), say('Ready, confirm?')], say('Booked.'));
    await app.close();
    app = buildApp(createDeps(db, { geo: testGeo, llm, stt: undefined, demoMode: true }));
    await app.ready();
    const said = await app.inject({ method: 'POST', url: '/api/glasses/say', headers: g.auth, payload: { text: 'Book Thursday at ten with the supplier' } });
    expect(said.json()).toMatchObject({ reply: 'Ready, confirm?', proposed: 1 });
    const state = (await app.inject({ url: '/api/glasses/state', headers: g.auth })).json();
    expect(state.lines.map((l: { role: string }) => l.role)).toEqual(['user', 'assistant']);
    expect(state.cards).toHaveLength(1);
    const [conv] = await db.select().from(conversations).where(eq(conversations.ipersonId, g.iperson.id));
    expect(conv!.channel).toBe('web'); // the same conversation Talk shows
    const other = await paired('other@example.com');
    expect((await app.inject({ method: 'POST', url: `/api/glasses/actions/${state.cards[0].id}/confirm`, headers: other.auth, payload: {} })).statusCode).toBe(409);
    const ok = await app.inject({ method: 'POST', url: `/api/glasses/actions/${state.cards[0].id}/confirm`, headers: g.auth, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect((await db.select().from(actions).where(eq(actions.id, state.cards[0].id)))[0]!.status).toBe('done');
  });

  it('at most 3 pairs; an account waiting for beta approval cannot pair glasses', async () => {
    const g = await paired();
    for (let i = 0; i < 2; i++) await app.inject({ method: 'POST', url: '/api/me/glasses', headers: { cookie: cookieFor(g.user.id) }, payload: {} });
    expect((await app.inject({ method: 'POST', url: '/api/me/glasses', headers: { cookie: cookieFor(g.user.id) }, payload: {} })).statusCode).toBe(409);
    const { user: waiting } = await makeIperson(db, { email: 'new@example.com' });
    await db.update(users).set({ pendingApprovalAt: new Date() }).where(eq(users.id, waiting.id));
    const r = await app.inject({ method: 'POST', url: '/api/me/glasses', headers: { cookie: cookieFor(waiting.id) }, payload: {} });
    expect(r.json().error).toBe('pending_approval');
  });
});
