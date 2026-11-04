import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { contacts, twinConnections, userIdentifiers, users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { identifierHmac, normalisePhone, refreshIdentifiers } from '../src/twins/identifiers.ts';
import { matchContacts } from '../src/twins/matching.ts';
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

const cookieFor = (userId: string) => `ip_session=${app.jwt.sign({ sub: userId })}`;

describe('§1 matching contacts to i-persons', () => {
  it('stores only keyed hashes of verified identifiers', async () => {
    const { user } = await person(db, { name: 'Sami', phone: '+21655000111' });
    const rows = await db.select().from(userIdentifiers).where(eq(userIdentifiers.userId, user.id));
    expect(rows.map((r) => r.kind).sort()).toEqual(['email', 'phone']);
    const json = JSON.stringify(rows);
    expect(json).not.toContain('21655000111');
    expect(json).not.toContain('sami@example.com');
    expect(rows.find((r) => r.kind === 'phone')!.hmac).toBe(identifierHmac('phone', '+21655000111'));
  });

  it('matches by normalised email or local phone number, and never on unverified identifiers', async () => {
    const me = await person(db, { name: 'Hana', phone: '+21655000001' });
    await person(db, { name: 'Sami', phone: '+21655000111', emailVerified: false });
    await person(db, { name: 'Lea', email: 'lea@example.com', phone: null });
    // Sami's email is unverified (password sign-up) → only his number can match.
    const byEmail = await addContact(db, me.user.id, { name: 'Sami (mail)', emails: ['SAMI@example.com'] });
    const byPhone = await addContact(db, me.user.id, { name: 'Sami', phones: ['55 000 111'] });
    const lea = await addContact(db, me.user.id, { name: 'Lea B', emails: [' Lea@Example.com '] });
    const nobody = await addContact(db, me.user.id, { name: 'Stranger', emails: ['x@y.z'], phones: ['+4915112345678'] });
    expect(normalisePhone('55 000 111', 'TN')).toBe('+21655000111');

    expect(await matchContacts(db, me.user.id)).toBe(2);
    const get = async (id: string) => (await db.select().from(contacts).where(eq(contacts.id, id)))[0]!;
    expect((await get(byEmail.id)).hasIperson).toBe(false);
    expect((await get(byPhone.id)).hasIperson).toBe(true);
    expect((await get(lea.id)).hasIperson).toBe(true);
    expect((await get(nobody.id))).toMatchObject({ hasIperson: false, matchedUserId: null });
    expect((await get(nobody.id)).checkedAt).toBeInstanceOf(Date);
  });

  it('an unlinked number stops matching after the identifiers are refreshed', async () => {
    const me = await person(db, { name: 'Hana' });
    const sami = await person(db, { name: 'Sami', phone: '+21655000111', emailVerified: false });
    const c = await addContact(db, me.user.id, { name: 'Sami', phones: ['+216 55 000 111'] });
    expect(await matchContacts(db, me.user.id)).toBe(1);
    await db.update(users).set({ phoneE164: null }).where(eq(users.id, sami.user.id));
    await refreshIdentifiers(db, sami.user.id);
    expect(await matchContacts(db, me.user.id)).toBe(0);
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0]!.matchedUserId).toBeNull();
  });

  it('"nobody" hides, blocking hides, a user without a twin is not "on i-persons"', async () => {
    const me = await person(db, { name: 'Hana' });
    const sami = await person(db, { name: 'Sami' });
    const lea = await person(db, { name: 'Lea' });
    await person(db, { name: 'Omar', twin: null });
    await addContact(db, me.user.id, { name: 'Sami', emails: ['sami@example.com'] });
    await addContact(db, me.user.id, { name: 'Lea', emails: ['lea@example.com'] });
    await addContact(db, me.user.id, { name: 'Omar', emails: ['omar@example.com'] });
    expect(await matchContacts(db, me.user.id)).toBe(2);

    await db.update(users).set({ discoverability: 'nobody' }).where(eq(users.id, sami.user.id));
    await db.insert(twinConnections).values({ requesterId: lea.user.id, recipientId: me.user.id, status: 'blocked', blockedBy: lea.user.id });
    // Applies at once in what the client sees, even before the next sync…
    const res = await app.inject({ method: 'GET', url: '/api/contacts', headers: { cookie: cookieFor(me.user.id) } });
    expect(res.json().contacts.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([['Lea', 'not_yet'], ['Omar', 'not_yet'], ['Sami', 'not_yet']]);
    // …and in the stored match after it.
    expect(await matchContacts(db, me.user.id)).toBe(0);
  });

  it('the client payload never contains the other user\'s id, email or phone', async () => {
    const me = await person(db, { name: 'Hana' });
    const sami = await person(db, { name: 'Sami', email: 'sami.private@example.com', phone: '+21655000111', avatar: '/api/media/abc-avatar.jpg' });
    await addContact(db, me.user.id, { name: 'My brother', phones: ['+21655000111'], relationship: 'family' });
    await matchContacts(db, me.user.id);
    const res = await app.inject({ method: 'GET', url: '/api/contacts', headers: { cookie: cookieFor(me.user.id) } });
    expect(res.statusCode).toBe(200);
    const [c] = res.json().contacts;
    expect(c).toMatchObject({ name: 'My brother', status: 'on_iperson', twin: { name: 'i-Sami', avatar: expect.stringMatching(/^\/api\/contacts\/[\w-]+\/twin-avatar$/) } });
    const body = res.body;
    for (const secret of [sami.user.id, sami.iperson!.id, 'sami.private@example.com', '21655000111', 'abc-avatar']) expect(body).not.toContain(secret);
    // Other people can't read my contacts or the twin picture through them.
    const other = await app.inject({ method: 'GET', url: `/api/contacts/${c.id}/twin-avatar`, headers: { cookie: cookieFor(sami.user.id) } });
    expect(other.statusCode).toBe(404);
  });

  it('discoverability is a per-user setting', async () => {
    const me = await person(db, { name: 'Hana' });
    const h = { cookie: cookieFor(me.user.id) };
    expect((await app.inject({ method: 'GET', url: '/api/me/discoverability', headers: h })).json()).toEqual({ discoverability: 'contacts' });
    expect((await app.inject({ method: 'PUT', url: '/api/me/discoverability', headers: h, payload: { discoverability: 'everyone' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/me/discoverability', headers: h, payload: { discoverability: 'nobody' } })).json()).toEqual({ discoverability: 'nobody' });
  });
});

describe('finding people who verified before contact matching existed', () => {
  it('start-up backfill makes verified accounts without identifiers matchable, and re-matches contacts', async () => {
    const { backfillIdentifiers } = await import('../src/twins/jobs.ts');
    const { user: me } = await person(db, { name: 'Med', phone: '+21655000111' });
    const { user: karim } = await person(db, { name: 'Karim', phone: '+21655000222', emailVerified: false });
    await db.delete(userIdentifiers).where(eq(userIdentifiers.userId, karim.id)); // verified before matching shipped
    const c = await addContact(db, me.id, { name: 'Karim', phones: ['+216 55 000 222'] });
    await matchContacts(db, me.id);
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0]!.matchedUserId).toBeNull();
    expect(await backfillIdentifiers(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true }))).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0]!.matchedUserId).toBe(karim.id);
  });

  it('adding their WhatsApp number to a contact finds them at once; an unproven email never does', async () => {
    const { user: me } = await person(db, { name: 'Med', phone: '+21655000111' });
    const { user: karim } = await person(db, { name: 'Karim', email: 'karim@example.com', phone: '+21655000222', emailVerified: false });
    await refreshIdentifiers(db, karim.id);
    const c = await addContact(db, me.id, { name: 'Karim', emails: ['karim@example.com'] }); // only his password-sign-up email
    await matchContacts(db, me.id);
    const patch = (body: object) => app.inject({ method: 'PATCH', url: `/api/contacts/${c.id}`, headers: { cookie: cookieFor(me.id) }, payload: body });
    expect((await patch({ add_email: 'karim@example.com' })).json().contact.status).toBe('not_yet');
    expect((await patch({ add_phone: 'not a number' })).statusCode).toBe(400);
    const r = await patch({ add_phone: '55 000 222' }); // read in my own country (TN)
    expect(r.statusCode).toBe(200);
    expect(r.json().contact.status).toBe('on_iperson');
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0]!.phones).toEqual(['+21655000222']);
  });
});
