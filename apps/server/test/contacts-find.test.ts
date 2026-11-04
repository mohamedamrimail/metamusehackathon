import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { contacts, ipersons, twinConnections, users } from '../src/db/schema.ts';
import type { AppDeps } from '../src/http/deps.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { requestConnection, respond } from '../src/twins/connections.ts';
import { backfillIdentifiers } from '../src/twins/jobs.ts';
import { matchContacts } from '../src/twins/matching.ts';
import { reset, testDb, testGeo } from './helpers.ts';
import { addContact, person } from './twins-helpers.ts';

// Finding people without a synced address book: connected twins see each other, search and add by hand.

const { db, pool } = testDb();
let app: FastifyInstance;
let deps: AppDeps;
beforeEach(async () => {
  await reset(db);
  await app?.close();
  deps = createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true, wa: undefined });
  app = buildApp(deps);
  await app.ready();
});
afterAll(async () => { await app.close(); await pool.end(); });

const cookieFor = (userId: string) => `ip_session=${app.jwt.sign({ sub: userId })}`;
const contactOf = async (owner: string, other: string) => (await db.select().from(contacts).where(and(eq(contacts.userId, owner), eq(contacts.matchedUserId, other))))[0];

describe('connected twins are in each other’s contacts', () => {
  it('asking and accepting adds the other side, synced address book or not, and matching keeps the link', async () => {
    const { user: med } = await person(db, { name: 'Med', phone: '+21655000111' });
    const { user: karim } = await person(db, { name: 'Karim', phone: '+21655000222' });
    await addContact(db, med.id, { name: 'Karim', phones: ['+21655000222'] });
    await matchContacts(db, med.id);
    const conn = await requestConnection(deps, med.id, karim.id);
    expect(await contactOf(karim.id, med.id)).toMatchObject({ name: 'Med', hasIperson: true });
    await respond(deps, karim.id, conn.id, 'accept');
    await matchContacts(db, karim.id); // nightly: no identifiers on Karim's row for Med, the link stays
    const r = await app.inject({ url: '/api/contacts', headers: { cookie: cookieFor(karim.id) } });
    expect(r.json().synced).toBe(true);
    expect(r.json().contacts.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([['Med', 'connected']]);
  });

  it('start-up backfill adds the missing side for connections made before', async () => {
    const { user: med } = await person(db, { name: 'Med', phone: '+21655000111' });
    const { user: karim } = await person(db, { name: 'Karim', phone: '+21655000222' });
    await db.insert(twinConnections).values({ requesterId: med.id, recipientId: karim.id, status: 'active', requesterScopes: ['plan'], recipientScopes: ['plan'], requesterFactIds: [], recipientFactIds: [] });
    await backfillIdentifiers(deps);
    expect(await contactOf(karim.id, med.id)).toBeTruthy();
    expect(await contactOf(med.id, karim.id)).toBeTruthy();
  });
});

describe('find someone on i-persons', () => {
  const search = (userId: string, q: string) => app.inject({ url: `/api/contacts/search?q=${encodeURIComponent(q)}`, headers: { cookie: cookieFor(userId) } }).then((r) => r.json());
  const add = (userId: string, body: object) => app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: cookieFor(userId) }, payload: body });

  it('finds by a verified number only if the person allows it; by name only public twins', async () => {
    const { user: med } = await person(db, { name: 'Med', phone: '+21655000111' });
    const { user: karim } = await person(db, { name: 'Karim Akrimi', phone: '+21655000222', emailVerified: false });
    const { user: hidden } = await person(db, { name: 'Lina', phone: '+21655000333' });
    await db.update(users).set({ discoverability: 'nobody' }).where(eq(users.id, hidden.id));
    expect((await search(med.id, '+216 55 000 222')).results).toMatchObject([{ name: 'Karim Akrimi', via: 'number', in_contacts: false }]);
    expect((await search(med.id, '55 000 333')).results).toEqual([]); // "nobody" can't be found
    expect((await search(med.id, 'karim@example.com')).results).toEqual([]); // email not proven
    expect((await search(med.id, 'Karim')).results).toEqual([]); // not public: names are never a directory
    await db.update(ipersons).set({ publicEnabled: true, handle: 'karim' }).where(eq(ipersons.userId, karim.id));
    expect((await search(med.id, 'akrim')).results).toMatchObject([{ name: 'Karim Akrimi', handle: 'karim', via: 'public' }]);
  });

  it('adds by @handle or by number; someone not on i-persons becomes a contact to invite', async () => {
    const { user: med } = await person(db, { name: 'Med', phone: '+21655000111' });
    const { user: karim } = await person(db, { name: 'Karim', phone: '+21655000222' });
    await db.update(ipersons).set({ publicEnabled: true, handle: 'karim' }).where(eq(ipersons.userId, karim.id));
    const viaHandle = await add(med.id, { handle: '@karim', relationship: 'friend' });
    expect(viaHandle.statusCode).toBe(201);
    expect(viaHandle.json().contact).toMatchObject({ name: 'Karim', status: 'on_iperson', relationship: 'friend' });
    await matchContacts(db, med.id);
    expect((await contactOf(med.id, karim.id))?.hasIperson).toBe(true); // kept by the nightly match
    expect((await search(med.id, '+21655000222')).results[0].in_contacts).toBe(true);
    const stranger = await add(med.id, { phone: '+216 55 000 999', name: 'Nour' });
    expect(stranger.json().contact).toMatchObject({ name: 'Nour', status: 'not_yet' });
    expect((await add(med.id, { phone: 'abc' })).statusCode).toBe(400);
    expect((await add(med.id, { handle: 'nobody-here' })).statusCode).toBe(404);
  });
});
