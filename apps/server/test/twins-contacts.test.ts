import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { contacts } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { reset, testDb, testGeo } from './helpers.ts';
import { addContact, person } from './twins-helpers.ts';

const { db, pool } = testDb();
let app: FastifyInstance;

beforeEach(async () => {
  await reset(db);
  await app?.close();
  app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const cookieFor = (userId: string) => ({ cookie: `ip_session=${app.jwt.sign({ sub: userId })}` });

describe('§2 contacts page API', () => {
  it('lists my contacts sorted by name, with an empty state flag when nothing is synced', async () => {
    const me = await person(db, { name: 'Hana' });
    expect((await app.inject({ method: 'GET', url: '/api/contacts', headers: cookieFor(me.user.id) })).json()).toEqual({ contacts: [], requests: [], synced: false });
    await addContact(db, me.user.id, { name: 'zoe', emails: ['zoe@x.tn'], relationship: 'friend' });
    await addContact(db, me.user.id, { name: 'Amel', phones: ['+21655000999'], relationship: 'family' });
    const res = (await app.inject({ method: 'GET', url: '/api/contacts', headers: cookieFor(me.user.id) })).json();
    expect(res.synced).toBe(true);
    expect(res.contacts).toEqual([
      expect.objectContaining({ name: 'Amel', initials: 'A', status: 'not_yet', channels: { email: false, whatsapp: true } }),
      expect.objectContaining({ name: 'zoe', status: 'not_yet', channels: { email: true, whatsapp: false } }),
    ]);
  });

  it('edits relationship and a note of at most 100 characters; removes a contact; all owner-only', async () => {
    const me = await person(db, { name: 'Hana' });
    const other = await person(db, { name: 'Sami' });
    const c = await addContact(db, me.user.id, { name: 'Amel' });
    const url = `/api/contacts/${c.id}`;
    expect((await app.inject({ method: 'PATCH', url, headers: cookieFor(me.user.id), payload: { notes: 'x'.repeat(101) } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'PATCH', url, headers: cookieFor(me.user.id), payload: { relationship: 'friend', notes: 'Likes padel' } });
    expect(ok.json().contact).toMatchObject({ relationship: 'friend', notes: 'Likes padel' });
    expect((await app.inject({ method: 'GET', url, headers: cookieFor(other.user.id) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url, headers: cookieFor(other.user.id), payload: { notes: 'hi' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url, headers: cookieFor(other.user.id) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url, headers: cookieFor(me.user.id) })).json()).toMatchObject({ contact: { name: 'Amel' }, plans: [] });
    expect((await app.inject({ method: 'DELETE', url, headers: cookieFor(me.user.id) })).statusCode).toBe(200);
    expect(await db.select().from(contacts)).toEqual([]);
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/contacts' })).statusCode).toBe(401);
  });
});
